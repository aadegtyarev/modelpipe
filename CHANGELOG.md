# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- **Account-pool cooldown is now progressive** (was a flat 60s): when an account in a pool
  hits a rate-limit it is parked on the SAME `failoverRecoveryBackoffMs` ladder (1→5→10 min)
  that model failover already rode — instead of re-probing a still-limited primary every 60s
  and eating a wasted `primary -> backup` round-trip on each request. The counter climbs the
  ladder on each repeat park and resets to the first rung the moment the account serves a
  request cleanly. `GET /v1/accounts` now surfaces each account's `attempts` and
  `cooldownRemainingMs`; `POST /v1/accounts/reset` clears both.
- **GLM billing honesty**: the z.ai GLM Anthropic endpoint is the Coding Plan (a flat
  subscription), but a key-swap route defaulted to `metered` — so GLM usage showed a
  fabricated per-token $. `routeBilling` now defaults z.ai/GLM to `subscription`.
- **Account-pool stats under the right label** (issue #15): the success (streaming) path
  computed `providerId` from the route URL, so per-account dashboard cards showed zero
  tokens while all usage piled under the URL-derived id. `proxyToRoute` now takes the
  account label through from `dispatch`/rotation, matching the error path.

### Added
- **`effective` downshift signal** on `GET /v1/failover` (issue #18): a ready-to-consume,
  machine-readable view of what the **head slot** resolves to right now — `{ believed, head,
  window, shifted, recoversInSec, accountCooldown }` — so an external consumer (statusline, an
  out-of-harness compaction trigger, the dashboard) reads one field instead of re-deriving
  `effective[offset]` and keeping its own model→window table. `window` comes from the same
  `resolveWindow`/`effectiveWindow` the router uses (min'd with any learned ceiling), never the
  client's size. Healthy head (offset 0) reports `head === believed`, `shifted:false`,
  `recoversInSec:null`; `null` when no failover group is configured.
- **Concurrency limiter** (`concurrency` config + `GET`/`POST /v1/concurrency`): some providers
  cap **simultaneous** requests per subscription/key (e.g. the z.ai GLM Coding Plan allows only
  a few glm-5.2 in flight at once). Firing the N+1th just earns a limit-429, which failover then
  "fixes" by degrading to a weaker model. Instead, `concurrency` (a `{ modelGlob: maxConcurrent }`
  map, first-match-wins like `compact.window`) holds the overflow in a **FIFO queue** until an
  in-flight slot frees, so the client keeps the strong model — it just waits. The limit is per
  `(providerId, model)`, so with an **account pool** each key carries its own budget (2 keys ⇒
  2× concurrent). A queued request that isn't served within `concurrencyQueueTimeoutMs`
  (default 45s) is treated as a backend 429 → account rotation → model failover (the "wait, then
  failover" safety valve). Any 429 that still gets through is therefore a *real* limit, so the
  limiter and failover compose cleanly. Unlimited models are a zero-overhead no-op. Editable at
  runtime and persisted.
- **Context fitting** (`compact` config + ⚙ Settings → *Context fitting*, **on by default**):
  a safety net for the **failover downshift** — when a request running against a 1M-window
  model fails over to a smaller-window backup (e.g. 256K), the grown conversation no longer
  fits and the backup would reject it. The client can't prevent this (it still thinks it's on
  the 1M model); only the proxy knows it rerouted. On a hop to a smaller-window model, the
  request is mechanically trimmed to fit — dropping older turns to a **stable checkpoint** with
  `tool_use`/`tool_result` pairs kept intact (never a dangling-pair 400). If a backend still
  rejects a request as too long, the real window is **learned** (parsed from the error, else
  ~90% of what was sent) and persisted per model, then the request is hard-trimmed and retried
  (`maxOverflowRetries`). No summarizer, no per-session state, zero added latency on the normal
  path. Steady-state compaction is left to the harness (Claude Code's native auto-compact).
  Per-model windows via `compact.window`.
- **Scheduled routing** (`schedules` config + ⚙ Settings → *Scheduled routing*): proactively
  rewrite a model glob to a cheaper target during set wall-clock windows — e.g. dodge z.ai's
  peak-hours quota multiplier (GLM-5.2 / GLM-5-Turbo cost 3× during 14:00–18:00 UTC+8) by
  dropping to a no-multiplier tier for those hours and staying on the flat Coding Plan.
  Windows are expressed in a fixed UTC offset and evaluated against the system clock via the
  UTC epoch (correct regardless of the host timezone). Editable in the dashboard and persisted
  (`GET`/`POST /v1/schedules`); a calm green banner shows when a schedule is saving quota.
- **Per-provider console links** in the dashboard (Anthropic / z.ai / DeepSeek / OpenRouter),
  not just z.ai.
- **Billing override in Settings** (`POST /v1/billing`, persisted): flip any provider between
  metered / flat plan / auto when the derived default guesses wrong.
- **Wizard: custom providers** — `modelpipe init` now has an "add a custom provider" loop
  (label, model glob, base_url, auth header/scheme/keyEnv/key, billing) for any
  Anthropic-format API beyond the built-in presets.
- Dashboard screenshot in the README (`docs/dashboard.png`).
- **`modelpipe init` setup wizard** (`src/setup.mjs`): a guided, zero-dep prompt that asks
  which backends to route, which keys, port, and dashboard, then writes a validated
  `routes.json` + `.env`. Runnable straight from GitHub — `npx github:aadegtyarev/modelpipe init`
  — with no global install. Guards an existing `routes.json` (asks before overwrite) and only
  appends missing keys to an existing `.env` (never clobbers secrets).
- **`install.sh`** one-liner (`curl … | bash`) that clones into `~/modelpipe` and runs the
  wizard (reads the terminal via `/dev/tty` so it works under `curl | bash`).

## [0.8.0] - 2026-07-04

### Added
- **`.env` auto-loading**: modelpipe now loads a `.env` from the config's folder on start
  (or `--env-file <path>`), so a plain `node bin/modelpipe.mjs routes.json` "just works" with
  keys — no shell export or systemd required. Never overrides vars already in the environment;
  keys are still only read at request time and never logged. Added `.env.example`.
- **Account pools** (`route.accounts` + `route.strategy`): multiple accounts/keys for the
  same model, rotating on a rate-limit. Each account has a `label` (its own dashboard card
  + per-label stats), its own `auth`, and an optional `base_url`; route-level `auth` becomes
  optional. `strategy: "failover"` (default) drains the primary and moves down on a limit,
  snapping back on recovery; `"round-robin"` spreads requests across accounts. Backend/key-
  level rotation (no model-id rewrite), innermost to failover pairs/groups; cooldown-based
  auto-recovery. New endpoints `GET /v1/accounts` and `POST /v1/accounts/reset` (`?label=`).
  `GET /v1/models` exposes per-account labels/hosts/billing. New pure exports
  `pickAccountIndex`, `accountEligible`.

### Fixed
- Graceful shutdown no longer hangs on keep-alive connections (`systemctl restart` was
  getting stuck "deactivating"): shutdown now frees idle sockets immediately and hard-closes
  anything lingering after 3s.

## [0.7.0] - 2026-07-04

### Added
- **Fallback auth** (`auth.fallback: true` on a key-swap route): forward the client's own
  auth header when it sent one, and inject `keyEnv` only when it didn't ("the token that
  flies wins, else the proxy's"). Works for `x-api-key` and `Authorization: Bearer` (via
  `scheme`). New pure exports `isFallbackAuth`, `clientHasAuth`.
- `POST /v1/failover/reset?group=N` winds a single group's shift offset back without a
  restart (unsticks a rare double-shift). Also fixed the reset endpoint to match its path
  when a query string is present (`?model=`/`?group=` previously fell through and 404'd).
- **Failover groups** (`failoverGroups`): an ordered ladder multiple models ride together.
  In `mode: "shift"` (default), a failing HEAD tier shifts the WHOLE ladder down one — e.g.
  ladder `["claude-opus-*", "glm-5.1", "deepseek-v4-pro"]`: when Anthropic errors, `opus→glm`
  AND glm's own traffic `→deepseek` at the same time, winding back when the head recovers.
  `mode: "cascade"` walks the ladder per-request without the coordinated shift. Groups take
  precedence over `failover` pairs. New pure exports `ladderPosition`, `effectiveLadderModel`,
  `resolveGroup`; `GET /v1/failover` now reports group ladders, offsets, and effective tiers.
- **Live-session persistence**: the current session (per-model/provider totals, timeline) is
  flushed to `~/.modelpipe/state.json` every 10 s and on shutdown, and resumed on startup — a
  crash now loses at most a few seconds instead of the whole session.
- **Persisted dashboard overrides**: token prices and failover pairs set in the dashboard are
  saved to `~/.modelpipe/overrides.json` and re-applied on restart (the config file stays the
  immutable source of truth). Failover edits are authoritative, so removing a pair in the UI
  sticks. `POST /v1/failover` now validates globs the same way startup does.
- **Per-route `billing` flag** (`"metered"` | `"subscription"`, default derived from auth):
  drives honest cost reporting in the dashboard and is surfaced in `GET /v1/models`.
- `POST /v1/token-prices` (supersedes the old `POST /v1/plans`, which stays as an alias) for
  updating metered API prices at runtime.
- `test/stats.test.mjs` — the previously-untested `stats.mjs` now has a suite (pricing, SSE
  token parsing, live-session persistence, provider identification).

### Changed
- **Honest dashboard**: removed all fabricated indicators — the subscription "effective cost"
  proration, the "plan vs API saves $X/mo" verdict, and the artificial GLM 5-hour/weekly quota
  bars + peak multiplier. Money is now shown only where it is real: per-token cost for metered
  providers (DeepSeek, OpenRouter) and real provider balances/limits; subscription/flat-plan
  providers show tokens + a "flat plan" label (GLM links to the z.ai console for the real quota,
  Anthropic shows its live rate-limit headers). Removed the `plans`, `glmPlan`, and
  `anthropicPlan` config fields and `computeGlmQuota`/`glmMultiplier` code.
- Dashboard HTML moved out of `src/stats.mjs` into an editable `public/dashboard.html`
  (read at startup); fixed a duplicate `<div id="models">`.

### Fixed
- SSE usage tracker no longer accumulates the full response in memory for its fallback path
  (capped at 256 KB) — restoring the module's zero-buffer promise for large streams.
- Removed a dead poll of a non-existent Anthropic `GET /v1/rate_limits` endpoint (its limits
  come from live response headers, which were already captured).

## [0.6.0] - 2026-07-01

### Added
- **Dashboard** (`dashboard: true`): a live monitoring page at `/dashboard` plus `/v1/stats`,
  `/v1/quotas`, `/v1/sessions` — per-model tokens/requests/cost, a token chart, a request log,
  session history (persisted to `~/.modelpipe/sessions.json`), and real provider balances
  (DeepSeek, OpenRouter). Usage is parsed from the SSE stream with zero buffering.
- **Model failover** (`failover`): per-model backup on a retryable upstream error (429/529 or a
  rate-limit/quota/capacity/credit/account-keyword body), with pre-route while failed over,
  chain failover (depth-guarded at 5 hops), and a background recovery pinger.
- `tokenPrices` config + runtime override for per-model API prices.

## [0.5.0] - 2026-07-01

### Added
- `GET /v1/models` (and the bare `GET /models`) returns the configured routes as a
  **secret-free** model listing over HTTP: each route's `match` glob (as `id`), backend
  `host`, auth **mode** (`"passthrough"` | `"key"`), and vision flags. It is the
  network-facing, **stricter** counterpart to `--list` (which is localhost/operator scope
  and exposes the key env-var name): over the wire it never leaks a key value, a key
  env-var name, an auth header, or a base path. Exposed as the exported pure function
  `listModels(config)` — a projection of `listConfig` (one source of truth) — and
  intercepted before body reading/routing, so it needs no request body and never reaches a
  backend. `POST /v1/messages`, passthrough, and the vision-reroute are unchanged.
- `CHANGELOG.md` (this file), seeded with the prior release history.

## [0.4.0] - 2026-06-30

### Added
- `--list` CLI mode: prints a safe JSON summary of the route table to stdout and exits
  (no server, no network) — for a setup dialog or sanity check. Backed by the exported
  `listConfig(config)`.

## [0.3.0] - 2026-06-30

### Added
- Per-route `vision` flag (default `true`): a route declared `vision: false` has its
  image-bearing requests pre-routed to the `forImages` target without trying the backend
  first — reliable where a backend does not 400 on an image (a soft-refusal 200, or its
  own server-side image tool).

## [0.1.0] - 2026-06-30

### Added
- Standalone passthrough Anthropic-format model router: model-id routing, per-backend
  auth swap (key-swap and `passthrough`), reactive `forImages` vision fallback,
  fail-closed error handling, and log safety. No dependencies (Node built-ins only).
