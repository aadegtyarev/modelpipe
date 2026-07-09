# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.12.0] - 2026-07-09

### Added
- **One-shot vision routing** (`dropProcessedImages`, default on): the image-fallback reroute now
  keys on the **current turn** (an image after the last assistant reply), not the whole
  transcript. Once the model has answered an image, follow-up turns are no longer forced to the
  vision model — the historical image is stripped to an `[image omitted]` placeholder before a
  non-vision backend sees it (a vision-capable backend keeps its images). Fixes the failure where
  one image in the conversation pinned every later turn to the vision model for the life of the
  image. Set `dropProcessedImages: false` to restore the legacy any-image-in-transcript behaviour.

### Fixed
- **Output-token over-count for providers that stream multiple `message_delta` events**: usage
  `output_tokens` is CUMULATIVE per the Messages API, so it is now taken as the latest (max)
  rather than summed. No change for the common single-delta case (Anthropic, DeepSeek, z.ai).

## [0.11.0] - 2026-07-08

### Added
- **Client identity in the routing trace**: the dashboard log now has a **Client** column —
  the caller's user-agent product token plus a short fingerprint of its auth token
  (`user-agent·<6hex>`), so you can see **which** client sent each request and tell apps /
  sessions / keys apart. The fingerprint is a sha256 slice — the token itself is never stored
  or logged.

### Changed
- **Trace `returned` model is now always shown** (was: only on a mismatch). Dim when the
  provider returned exactly what we routed to (confirmed faithful), **orange** when it differs
  (a provider-side redirect). Empty only means the provider reported no model (e.g. an error) —
  no longer ambiguous with "captured but matched".

## [0.10.0] - 2026-07-08

### Added
- **Request routing trace** in the dashboard log: each row now shows **what the client sent →
  what we routed it to `[provider]` → what the provider echoed back** (`message_start.message.model`
  / the JSON body's `model`). The client alias appears only when a profile rewrote it; the
  returned model only when it differs from what we asked (a **provider-side redirect**, shown in
  orange). Lets you verify at a glance that the client passes the right tier, the right profile
  substitution happens, and the provider actually serves it — not a silent swap.

## [0.9.0] - 2026-07-08

### Fixed
- **Cost was undercounted for prompt-cached requests**: `createUsageTracker` only read
  `usage.input_tokens`, ignoring the Anthropic-shape `cache_creation_input_tokens` /
  `cache_read_input_tokens` fields — so an agentic session where most of the growing
  context comes back as cache reads recorded near-zero input tokens per request (and
  cost with it), even though the upstream provider bills those tokens too. Cache
  creation now folds into `inputTokens` (billed at the input rate); cache reads are
  tracked separately as `cacheReadTokens` and billed at the new optional
  `tokenPrices.<model>.cacheRead` rate, falling back to the input rate when a model has
  no configured cache rate (conservative — never silently drops cost, only tokenPrices
  or PRICE_MAP a config was missing detail on for). Dashboard token totals (session,
  per-model cards, request log, chart) now include `cacheReadTokens`.
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
- **Missing metered prices → $0 cost**: OpenRouter models absent from the price catalog
  (e.g. `qwen/qwen3-coder-next`) resolved to a null price, so their per-response cost showed
  `$0.000`. Added the Qwen coder family + `minimax/minimax-m3` to the built-in catalog (any
  other model is still overridable via `tokenPrices`).

### Added
- **Routing profiles** (`profiles` + `auto`, see [docs/profiles.md](docs/profiles.md)): a single
  concept replacing `failover`, `failoverGroups`, `schedules`, and dashboard model-overrides. A
  client sends a stable alias (e.g. `glm-5.2`); the **active profile** decides what it resolves
  to. The active profile is chosen by **manual pin > error-shift > schedule > default**; a manual
  pin never silences the safety net (a failover error clears the pin and the auto chain steps on).
  The dashboard banner shows the active profile and **which alias went where** (`alias → target`,
  provider→provider), with an inline pin/clear control. A **Profiles & routing editor** in the
  dashboard settings creates/edits profiles (alias→target bindings), the default, the switching
  chain (`auto.steps` with per-step `limit`/`5xx` conditions + `recover`), and schedules — saved
  via `POST /v1/profiles/config`, validated and **hot-applied without a restart** (persisted as an
  authoritative override, like `compact`/`concurrency`). `modelpipe migrate` rewrites an old config
  (merging the live `~/.modelpipe/overrides.json`) into profiles, traffic-preserving.
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
