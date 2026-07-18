# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.17.0] - 2026-07-18

### Added

- **`rewriteServerToolUse` route option — info-preserving cross-provider routing.** Sibling to
  `stripServerToolUse` with the same trigger (a foreign `server_tool_use.id` or a misplaced
  `tool_result`), but instead of dropping the poisoned pair it rewrites the tool's RESULT into a
  labelled `text` block, so later turns keep what the tool returned. The CALL block (bad id,
  unrepairable) is still dropped; its name + query fold into the label. Bookkeeping the model
  doesn't need — the provider's opaque `encrypted_content` blob, the foreign id, an image carried
  in the result — is discarded; only the signal survives (search titles + urls, a vision tool's
  description). Takes precedence over `stripServerToolUse` when both are set. Motivated by z.ai/GLM
  web_search and the `analyze_image` MCP tool both minting `server_tool_use` blocks with `call_…`
  ids: plain strip lost the result for every subsequent turn, rewrite keeps it.

## [0.16.2] - 2026-07-18

### Fixed
- **`errorReason` no longer goes silent on an unrecognized error body.** It only ever extracted
  `error.message` / `error.type` / `message` from a JSON body — a body that parses but carries
  none of those (e.g. an OAuth-style `{error, error_description}` shape from a gateway/edge layer
  in front of the real API), or isn't JSON at all (a plain-text or HTML error page), produced
  `undefined`, which the dashboard then rendered as a bare status code with no reason at all. Now
  falls back to the RAW body text (whitespace-collapsed to one line, still capped at 200 chars)
  when no nice field is found — an ugly reason beats no reason when a red row needs explaining.

## [0.16.1] - 2026-07-18

### Fixed
- **`stripServerToolUse` also strips a misplaced plain `tool_result`.** 0.16.0 only handled a
  `server_tool_use.id` shape mismatch; live traffic through the same cross-provider route then
  hit a second, distinct 400 on the SAME kind of history: `messages.N: \`tool_result\` blocks can
  only be in \`user\` messages`. Some providers' Anthropic-shims fold the client
  tool_use/tool_result round-trip into a single assistant turn (unlike Anthropic's own two-message
  dance) — replayed against real Anthropic, that placement is rejected outright. `stripServerToolUse`
  now also drops a plain `tool_result` block sitting in a non-`user` message, plus its paired
  `tool_use` wherever it lives, using the same "poisoned id → drop both halves" approach as the
  original fix. Named server-tool result types (`web_search_tool_result`, etc.) legitimately live
  inline in an assistant turn and are left untouched — only the generic `tool_result` type is
  placement-checked.

## [0.16.0] - 2026-07-18

### Added
- **`stripServerToolUse` route option — schema-safe cross-provider routing.** A strict,
  schema-validating backend (real Anthropic) rejects the WHOLE request with `400
  invalid_request_error: messages.N.content.M.server_tool_use.id: String should match pattern
  '^srvtoolu_[a-zA-Z0-9_]+$'` when the transcript carries a `server_tool_use` block whose id was
  minted by a different provider's Anthropic-shim (e.g. z.ai/GLM's own web-search tool-call id)
  and replayed here after a model rewrite or cross-provider profile hop — the same failure mode
  `stripThinking` already covers for thinking-block signatures. Set `"stripServerToolUse": true`
  on the route pointing at the strict backend to drop every `server_tool_use` block whose id
  doesn't match Anthropic's own shape (plus any paired `*_tool_result` block, so nothing dangles)
  from the request's history before forwarding. Only a block that actually violates the pattern
  is touched — a genuine Anthropic id passes through untouched. A turn whose only content is the
  dropped block(s) is kept intact so the strip never produces an empty content array.

## [0.15.0] - 2026-07-14

### Added
- **`stripThinking` route option — signature-safe cross-provider routing.** A signature-validating
  backend (real Anthropic) rejects the WHOLE request with `400 invalid_request_error: Invalid
  \`signature\` in \`thinking\` block` when the transcript carries an extended-thinking block whose
  signature it can't verify — e.g. one minted by a different provider's Anthropic-shim (z.ai/GLM,
  whose thinking blocks carry signatures that aren't real Anthropic signatures) and replayed here
  after a model rewrite, or a block carried across a cross-provider profile hop. The signature
  can't be repaired — the Messages API rejects a *modified* thinking block just as it does an
  invalid one, and stripping only the `signature` field turns "invalid" into "missing" — so the
  only edit the API accepts is dropping the whole block. Set `"stripThinking": true` on the route
  pointing at the strict backend to drop every `thinking`/`redacted_thinking` block from the
  request's history before forwarding. Opt-in (the target loses that turn's reasoning trace); a
  turn whose only content is a thinking block is kept intact so the strip never produces an empty
  content array.

### Fixed
- **Compressed upstream error bodies were invisible to the classifiers.** Anthropic (and others)
  can return the `{ error: { message } }` JSON gzip/br-encoded. The reroute path buffered those
  raw compressed bytes and every classifier (`isContextOverflow`, `isFailoverTrigger`,
  `isImageUnsupported400`, `errorReason`, …) `JSON.parse`d them, silently failed, and fell through
  to relay-verbatim — so a compressed "prompt is too long" (context overflow), rate-limit, or
  image-unsupported error was never caught, never failed over, and showed up on the dashboard as a
  bare status with no message. The buffered error body is now decompressed once (new
  `decompressBuffer`) before classification; on success `content-encoding`/`content-length` are
  dropped so the verbatim relay still sends honest headers. Fail-safe: an undecodable body is left
  exactly as before.

## [0.14.3] - 2026-07-13

### Fixed
- **Dashboard trace showed the WRONG account for a pooled route.** The "sent → routed
  [provider] → returned" row for a model rewound to whichever account happened to serve that
  model's very FIRST request ever recorded, because the trace read `models[model].providerId` (a
  per-model aggregate set once and never updated) instead of the row's own `providerId`. Once a
  pooled route's account rotated (e.g. primary → backup), every later row for that model kept
  showing the original account forever, even while traffic had long since moved on — looking
  like the rotation itself was broken when it wasn't. Both the per-model aggregate (`stats.mjs`)
  and the trace row (`dashboard.html`) now track/read the actual account that served each
  request.
- **"Tokens over time" chart could assign two different models the SAME line color.** The
  palette-index counter that hands out a new color was a per-render local, reset to 0 every
  redraw; a model already holding a cached color doesn't consume a slot on a later render, so a
  DIFFERENT model appearing for the first time in that render could be handed an already-claimed
  color. The counter is now persistent across redraws, like the color cache itself.

## [0.14.2] - 2026-07-13

### Fixed
- **Account-pool HARD exhaustion (weekly/monthly quota, disabled org/account, payment
  required) no longer parks on the short rate-limit ladder.** It's a genuine multi-day block in
  practice, so re-probing it every 1-30 minutes (the ladder used for ordinary rate-limit blips)
  just burns requests against a dead account for days. When the backend's own error message
  quotes an explicit reset time, the account is now parked directly against it (sanity-capped at
  3 days in case of a malformed/absurd timestamp); otherwise it falls back to that same 3-day
  cap. The consecutive-hit counter (`attempts`) is left untouched on a hard hit, so a later
  GENUINE transient rate-limit on the same account still starts the ordinary ladder at its first
  rung instead of inheriting an inflated count.
- **Silent dead-end in profile failover.** When the account pool for a route had no eligible
  account left AND the active profile had nowhere different to send the request (or no
  profile/auto ladder was configured at all), the router gave up with no log line and relayed
  the raw upstream error straight to the client — even when a snapshot of "no eligible account"
  could be stale (a concurrent request may have parked/un-parked an account moments earlier).
  It now takes one last-resort attempt on the least-recently-parked OTHER account (ignoring its
  cooldown) before giving up, capped at exactly one extra hop per request so a genuinely dead
  pool still fails out cleanly instead of ping-ponging. The give-up path is also logged now.

## [0.14.1] - 2026-07-09

### Fixed
- Dashboard token-price editor silently dropped the `cacheRead` field on save,
  causing cache-hit tokens to be billed at the full input rate (120× overcharge
  for `deepseek-v4-pro`). The editor now renders and preserves a `cache` field.
- `modelPrice()` now merges dashboard overrides with built-in `PRICE_MAP` entries
  so that a field missing from the override (e.g. `cacheRead`) falls back to the
  known price instead of the full input rate.
- Added `cacheRead: 0.0028` for `deepseek-v4-flash` (verified against DeepSeek
  billing data).

## [0.14.0] - 2026-07-09

### Added
- **Empirical concurrency self-throttle**: a 429/5xx on a model with a configured concurrency
  limit (not a hard weekly/monthly exhaustion) no longer bounces straight through account
  rotation / a profile step — it LEARNS a lower effective ceiling and requeues the same request
  through the same limiter, so the queue itself is the backoff (no blind fixed delay) and no
  request is silently dropped. The learned ceiling creeps back up by 1 every
  `concurrencyRecoveryIntervalMs` (default 30s) of quiet, mirroring the account-pool cooldown
  ladder's "ease off the brake" shape. Bounded at 3 requeue attempts before falling through to
  the normal failover cascade.
- **Concurrency panel in the dashboard**: Settings now has a "Concurrency limits" section to
  view/edit the per-model `{ glob: max }` map and see the live state (active / queued / learned
  ceiling when self-throttled) — previously only reachable via `GET/POST /v1/concurrency`.

### Fixed
- **A 400 with a completely EMPTY response body was never treated as a failover-worthy
  signal** — the Messages API always returns a structured `{ error: { message } }` on a real
  rejection, so a zero-byte 400 looks like an HTTP/network-level break (a dropped/reset
  connection) rather than a genuine validation error. It's now classified the same as a 429/529
  instead of being relayed to the client as an opaque, silent failure.

## [0.13.0] - 2026-07-09

### Added
- **Same-target retry before failover** (`auto.retry: { attempts, delayMs? }`, off by default):
  on a failover-candidate error, retry the identical request against the SAME backend/account up
  to `attempts` times before spending a failover hop (account rotation or a profile step) — a
  one-off blip no longer immediately burns the cascade. Gated by a new `isRetryWorthy` classifier:
  a HARD, long-duration exhaustion (a weekly/monthly plan quota, a disabled org/account, payment
  required) is **never** retried — it will fail again regardless — and goes straight to failover;
  a plain rate-limit/overload/5xx blip, or the router's own concurrency-queue-timeout, remains
  retry-worthy. Editable in the dashboard next to "Switching rules (auto chain)", or via
  `POST /v1/profiles/config`.
- **Dashboard profile pin — commit on select** (was staged in a `<select>` + a separate "Pin"
  button that the 2s auto-refresh could clobber before it was clicked, making the control feel
  like it "wouldn't stick"): pinning now commits immediately on change, matching the
  Default-profile select; an "— auto —" option replaces the separate Clear button.

### Fixed
- **Error rows in the dashboard trace were orphaned**: a failed hop's stat record (account
  rotation, a profile step, the final relay) never carried `client`/`clientModel`, so a red row
  showed a bare backend model with no "who sent it" / "what alias it started as" — and no reason
  for the error at all. Every error record now carries the same trace as a successful one, plus a
  short human-readable reason extracted from the backend's own error body (shown inline on the
  row and in its tooltip).

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
