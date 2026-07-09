# Account pools & concurrency limiting

Model-level failover — routing a failing model to a backup, or shifting a whole tier ladder
together on an outage — is handled by **routing profiles** (`config.profiles`/`auto`), not by
this document. See [profiles.md](profiles.md) for that: the active profile, `auto.steps`
(best→fallback), `auto.retry` (same-target retry before a hop), `auto.recover`, and
`auto.schedules`. (Older `failover`/`failoverGroups`/`schedules` top-level fields are gone —
`modelpipe migrate <config.json>` rewrites an old config into `profiles`/`auto` in place.)

This document covers the two mechanisms that sit **below** the profile ladder, per route:

1. **Account pools** — rotate between several keys for the *same* model.
2. **Concurrency limiting** — cap simultaneous in-flight requests per `(provider, model)`.

Both are opt-in per route and independent of each other and of profiles.

## Account pools

Several accounts on the **same** provider — e.g. two GLM Coding Plan subscriptions, or a few
Anthropic API keys — rolling onto the next when one runs out of quota:

```json
{
  "match": "glm-*",
  "base_url": "https://api.z.ai/api/anthropic",
  "billing": "subscription",
  "strategy": "failover",
  "accounts": [
    { "label": "glm-main",   "auth": { "header": "Authorization", "scheme": "Bearer", "keyEnv": "ZAI_KEY_1" } },
    { "label": "glm-backup", "auth": { "header": "Authorization", "scheme": "Bearer", "keyEnv": "ZAI_KEY_2" } }
  ]
}
```

- Each account has a **`label`** (its own dashboard card), its own **`auth`**, and an optional
  **`base_url`**. With `accounts` set, route-level `auth` is optional.
- **Key/backend-level** rotation — the model id is **not** rewritten. The same request just goes
  out under a different key.
- **On a limit** the active account is parked and the request retries on the next eligible
  account; the parked one becomes eligible again once its cooldown elapses. The park is
  **progressive** — it climbs the same `failoverRecoveryBackoffMs` ladder (1→5→10 min) the
  profile ladder rides, so a persistently rate-limited key is re-probed ever less often instead
  of every 60s. The ladder resets to its first rung the moment the account serves a request
  cleanly. (With no `failoverRecoveryBackoffMs` set, it falls back to a flat
  `failoverRecoveryIntervalMs`.)
- **`strategy`** — `"failover"` (default) drains the primary and moves down on a limit;
  `"round-robin"` spreads requests to stretch total quota.
- Works for any provider; opt-in per route.
- **State:** `GET /v1/accounts` shows labels, cooldowns, `cooldownRemainingMs`, and each
  account's `attempts` (how far up the cooldown ladder it has climbed); `POST /v1/accounts/reset`
  (optionally `?label=X`) clears both without a restart.

Account rotation is the **innermost** layer: it happens **within** a route first; only when a
pool has no live account left does the profile ladder (`auto.steps`) step down.

> **Subscription tokens expire.** A GLM Coding-Plan token or an Anthropic OAuth token is
> short-lived — account pools are most robust with **long-lived API keys**.

## Concurrency limiting

Some providers cap **simultaneous** requests per subscription/key — e.g. the z.ai GLM Coding
Plan only allows a few `glm-5.2` requests in flight at once. Firing the N+1th just earns a
limit-`429`, which failover then "fixes" by degrading to a weaker backup model. That's the wrong
cure: the model isn't down, it's momentarily busy.

`concurrency` holds the overflow in a **FIFO queue** until an in-flight slot frees, so the
client keeps the strong model — it just waits a moment:

```json
"concurrency": { "glm-5.2": 3, "glm-*": 8 },
"concurrencyQueueTimeoutMs": 45000,
"concurrencyRecoveryIntervalMs": 30000
```

- **First match wins** (like `compact.window`) — order specific ids before broad globs
  (`glm-5.2` before `glm-*`). An unmatched model is **unlimited** (zero overhead — the gate is
  opt-in per model, never a global throttle).
- **Per account/key.** The limit is keyed by `(providerId, model)`, and for a pooled route
  `providerId` is the account label — so a pool of two keys carries **2× the limit** at once,
  matching how a provider meters the cap (per subscription).
- **Held for the whole response.** A slot is occupied until the backend finishes sending
  (streamed SSE included), matching the provider's own in-flight accounting.

### Empirical self-throttle

The configured limit is a ceiling, not necessarily the backend's *real* capacity right now. A
plain rate-limit/overload `429`/5xx on a limited model (never a **hard**, long-duration
exhaustion — a weekly/monthly plan quota, a disabled org/account, payment required — those go
straight to the profile ladder instead) doesn't bounce through account rotation or a profile
step. Instead:

1. The effective ceiling for that `(provider, model)` key is **learned one lower** (floored at 1
   — never fully blocks a model).
2. The **same** request is requeued through the **same** limiter key — its own concurrency gate
   then naturally holds it until a slot opens under the new, lower ceiling. No blind fixed
   delay: the queue itself is the backoff.
3. Bounded at **3** requeue attempts per request; beyond that it falls through to the normal
   failover cascade (`auto.retry` → account rotation → a profile step).
4. A key that's stayed quiet (no further hit) for `concurrencyRecoveryIntervalMs` (default 30s)
   creeps its ceiling back up by 1 toward the configured limit — the same "ease off the brake"
   shape as the account-pool cooldown ladder above, so a transient burst doesn't leave a model
   throttled forever.

**Wait, self-throttle, then failover.** A request that can't get a slot within
`concurrencyQueueTimeoutMs` (default 45s) — including while requeued under a lowered ceiling —
is treated as a backend `429` → account rotation → a profile step. So the queue (with its own
self-correcting ceiling) is the primary mechanism and failover is the safety valve underneath it.

**State & runtime edits.** `GET /v1/concurrency` returns the configured limits plus the live
queue state per key — `active`, `limit` (configured), `effLimit` (the current, possibly
self-throttled ceiling — equals `limit` unless a hit has learned it lower), and `queued` (never
a fabricated number). `POST /v1/concurrency` replaces the map (and optionally
`queueTimeoutMs`), validated like the file and persisted. The dashboard's **Concurrency** panel
(⚙ Settings) edits the same map and shows the same live state.
