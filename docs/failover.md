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
- **On a limit** the active account is parked for `failoverRecoveryIntervalMs`; the request
  retries on the next eligible account, and the parked one is retried automatically once the
  cooldown elapses.
- **`strategy`** — `"failover"` (default) drains the primary and moves down on a limit;
  `"round-robin"` spreads requests to stretch total quota.
- Works for any provider; opt-in per route.
- **State:** `GET /v1/accounts` shows labels + cooldowns; `POST /v1/accounts/reset` (optionally
  `?label=X`) clears cooldowns without a restart.

Account rotation is the innermost layer: it happens **within** a route first; only when a pool
has no live account left does model-level `failover`/`failoverGroups` take over.

> **Subscription tokens expire.** A GLM Coding-Plan token or an Anthropic OAuth token is
> short-lived — account pools are most robust with **long-lived API keys**.
