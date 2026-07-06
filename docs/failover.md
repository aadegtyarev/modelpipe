# Failover & account pools

Three independent mechanisms, innermost first:

1. **Account pools** — rotate between several keys for the *same* model.
2. **Failover pairs** — reroute a failing model to a *backup model*.
3. **Failover groups** — shift a whole tier ladder together.

## Failover pairs

When `failover` is set, modelpipe switches to a backup model when a primary backend returns a
retryable error:

```json
"failover": {
  "claude-opus-*": "glm-5.1",
  "glm-5.1": "deepseek-v4-pro"
}
```

- **Reactive trigger** — 429 (rate limit), 529 (overloaded), or any 4xx/5xx whose body
  mentions rate-limit / quota / capacity / credit / account / organisation → rewrite
  `body.model` to the backup and reroute.
- **Pre-route** — once a model is in failover, requests within the cooldown skip the primary.
- **Chain** — if the backup also fails and has its own pair, follow the chain (guarded at 5 hops).
- **Recovery** — a background pinger probes failed-over primaries; on a normal response the
  failover clears. For passthrough routes, the next real request after the cooldown is the probe.

Editable at runtime via the dashboard (⚙ → Failover) or `POST /v1/failover` — no restart, and
edits persist.

## Group failover

A plain pair reroutes only the **one** model that erred. A group performs a **coordinated
shift**: when a provider goes down, move a whole ladder down together so the next tier isn't
doubly loaded.

```json
"failoverGroups": [
  { "ladder": ["claude-opus-*", "glm-5.1", "deepseek-v4-pro"], "mode": "shift" }
]
```

- **`mode: "shift"` (default)** — the ladder rides a shared offset. When the **head** tier fails
  (e.g. Anthropic is down), the offset moves the whole ladder down one: `opus → glm` **and glm's
  own traffic → deepseek at the same time**. It winds back when the head recovers.
- **`mode: "cascade"`** — no coordinated shift; each request walks the ladder on error.
- The **head** (index 0) may be a glob; every lower tier is a rewrite target and **must be a
  concrete model id**. Each tier needs a matching route. Groups take precedence over pairs.
- **Recovery** works even for a passthrough/glob head the pinger can't probe: after the
  cooldown, the next head request tries the real head with its real model id and, on success,
  winds the ladder back.
- **Limitation** — the shift is a single scalar offset, so it can't wind back *past* a still-down
  middle tier (double failure). Rare, self-limiting, and fixable without a restart via
  `POST /v1/failover/reset?group=N`.

**Routing to other providers.** A backup (pair value or ladder tier) can target any provider —
including OpenRouter — as long as a route matches its id:

```json
"routes": [
  { "match": "anthropic/*", "base_url": "https://openrouter.ai/api",
    "auth": { "header": "Authorization", "scheme": "Bearer", "keyEnv": "OPENROUTER_API_KEY" } }
],
"failover": { "claude-opus-*": "anthropic/claude-sonnet-4.6" }
```

(Order the OpenRouter `*/*`-style route **last** — first match wins.)

## The `effective` head signal

`GET /v1/failover` returns an `effective` object — a ready-to-consume view of what the **head
slot** resolves to *right now*, so an external consumer reads one field instead of re-deriving
`groups[].effective[offset]` and keeping its own model→window table:

```jsonc
"effective": {
  "believed": "glm-5.2",   // the configured head (offset 0) — what the client still thinks it's on
  "head":     "glm-5.1",   // the model actually serving the head now (after any shift)
  "window":   200000,      // head's effective context window — from resolveWindow, not the client
  "shifted":  true,        // offset > 0 (fast branch)
  "recoversInSec": 240,    // ETA to the next head-recovery probe window; null when healthy
  "accountCooldown": null  // secs until the head's account pool has a live key again, else null
}
```

- **`window`** is the single source of truth — `effectiveWindow`/`resolveWindow`, min'd with any
  learned ceiling. No consumer needs to hardcode a model→window table.
- **Healthy head** (offset 0): `head === believed`, `shifted:false`, `recoversInSec:null`.
- **`null`** when no failover group is configured (plain pairs reroute per-model; there's no
  coordinated head to report). With multiple groups it reflects the **first** group.
- Built for an **out-of-harness compaction trigger**: Claude Code doesn't auto-compact on a
  downshift (its window is static, it doesn't know the head dropped), so an external loop that
  reads `effective.window` is the way to fit the shrunk window. A statusline is a simpler
  consumer of the same field.

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
  **progressive** — it climbs the same `failoverRecoveryBackoffMs` ladder (1→5→10 min) model
  failover rides, so a persistently rate-limited key is re-probed ever less often instead of
  every 60s. The ladder resets to its first rung the moment the account serves a request
  cleanly. (With no `failoverRecoveryBackoffMs` set, it falls back to a flat
  `failoverRecoveryIntervalMs`.)
- **`strategy`** — `"failover"` (default) drains the primary and moves down on a limit;
  `"round-robin"` spreads requests to stretch total quota.
- Works for any provider; opt-in per route.
- **State:** `GET /v1/accounts` shows labels, cooldowns, `cooldownRemainingMs`, and each
  account's `attempts` (how far up the cooldown ladder it has climbed); `POST /v1/accounts/reset`
  (optionally `?label=X`) clears both without a restart.

Account rotation is the innermost layer: it happens **within** a route first; only when a pool
has no live account left does model-level `failover`/`failoverGroups` take over.

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
"concurrencyQueueTimeoutMs": 45000
```

- **First match wins** (like `compact.window`) — order specific ids before broad globs
  (`glm-5.2` before `glm-*`). An unmatched model is **unlimited** (zero overhead — the gate is
  opt-in per model, never a global throttle).
- **Per account/key.** The limit is keyed by `(providerId, model)`, and for a pooled route
  `providerId` is the account label — so a pool of two keys carries **2× the limit** at once,
  matching how a provider meters the cap (per subscription).
- **Held for the whole response.** A slot is occupied until the backend finishes sending
  (streamed SSE included), matching the provider's own in-flight accounting.
- **Wait, then failover.** A request that can't get a slot within `concurrencyQueueTimeoutMs`
  (default 45s) is treated as a backend `429` → account rotation → model failover. So the queue
  is the primary mechanism and failover is the safety valve; and any `429` that *does* get
  through is a genuine limit (quota/overload), where failover is the right response. The two
  compose cleanly.

**State & runtime edits.** `GET /v1/concurrency` returns the configured limits plus the live
queue (real `active`/`queued` counts per key — never a fabricated number). `POST /v1/concurrency`
replaces the map (and optionally `queueTimeoutMs`), validated like the file and persisted.
