# Dashboard

With `"dashboard": true`, modelpipe serves a live monitoring page at
`http://127.0.0.1:8787/dashboard` (served from the proxy process, no install).

![modelpipe dashboard](dashboard.png)

## Honesty rule

The dashboard shows only **measured** data. Money appears **only where it is real**: a
per-token cost for `metered` (pay-as-you-go) providers and real provider balances. For
`subscription` (flat-plan) providers — a GLM Coding Plan, an Anthropic subscription — per-token
dollars are meaningless, so it shows **tokens + a "flat plan" label**, never a fabricated cost.
No invented quota bars, no subscription-cost proration, no "plan vs API saves $X" verdicts.

The `billing` mode is derived per route (passthrough & z.ai/GLM ⇒ subscription, other key-swap
⇒ metered) and can be overridden per provider in **Settings → Billing** (or `POST /v1/billing`).

## What it shows

- **Session bar** — metered API cost (subscription providers contribute nothing), requests,
  tokens, start time.
- **Model cards** — provider, a `metered`/`flat plan` tag, tokens, requests; `$` only for
  metered models (flat-plan shows `—`).
- **Token chart** — cumulative tokens per model over the last 200 requests.
- **Provider cards** — real data only: DeepSeek balance, OpenRouter credits, Anthropic
  RPM/ITPM/OTPM (from live response headers), per-provider session totals, and a **console ↗**
  link to each provider.
- **Request log** — last 50 requests (time, model, tokens in/out, cost, duration).
- **Sessions** — "New session" archives + starts fresh; history dropdown holds the last 20.
- **Settings (⚙)** — metered token prices, failover pairs, account-pool state, and the billing
  override.

## Persistence

The live session (per-model/provider totals + timeline) is flushed to `~/.modelpipe/state.json`
every 10 s and on shutdown, and **resumed on startup** — a crash loses at most a few seconds.
Archived sessions live in `~/.modelpipe/sessions.json`; dashboard-set token prices / failover
pairs / billing overrides in `~/.modelpipe/overrides.json`. The config file stays the immutable
source of truth; overrides merge on top. (Override the base dir with `MODELPIPE_DIR`.)

## Pricing catalog

Built-in metered prices for `claude-*`, `deepseek-*`, `glm-*`, and `google/gemini-*` in
`src/stats.mjs` (`PRICE_MAP`). Unknown models show `price —` and $0 (they still count tokens).
Override per-model at runtime via Settings (⚙) or `config.tokenPrices`.

## API endpoints (only when `dashboard: true`)

| Endpoint | Returns / does |
| --- | --- |
| `GET /v1/stats` | Per-model usage, session totals, timeline. |
| `GET /v1/quotas` | Real provider balances (DeepSeek, OpenRouter). |
| `GET /v1/sessions` | Archived session history (up to 20). |
| `GET /v1/models` | Secret-free route listing (globs, hosts, auth mode, vision + billing). |
| `GET /v1/failover` | Failover pairs, active state, group ladders/offsets. |
| `GET /v1/accounts` | Account-pool state: labels, strategy, per-account cooldown. |
| `POST /v1/sessions/reset` | Archive the current session, start a new one. |
| `POST /v1/token-prices` | Update metered token prices (persisted). |
| `POST /v1/billing` | Override a provider's billing mode: `{provider, mode: metered\|subscription\|auto}`. |
| `POST /v1/failover` | Set failover pairs and/or cooldown (persisted). |
| `POST /v1/failover/reset` | Clear failover state. `?model=X` one pair · `?group=N` one group's shift. |
| `POST /v1/accounts/reset` | Clear account cooldowns (`?label=X` for one). |

All endpoints are JSON, secret-free (no keys, no env-var names), served only on localhost.
