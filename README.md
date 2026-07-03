# modelpipe

A passthrough **Anthropic-format** model router. Point an Anthropic-format client
at one local endpoint and modelpipe forwards each request to a chosen backend based
on the model id in the request body — route different model ids to different backends,
all behind a single `ANTHROPIC_BASE_URL`.

It is **Claude-Code-first and standalone**: it needs no protocol, no wrapper, and no
account beyond the backend keys you already have. Start it, point Claude Code at it,
and your `sonnet`/`opus`/`haiku` aliases land on whichever providers you choose.

## Quick start

```sh
npx modelpipe routes.json            # run with no install
# or: npm i -g modelpipe && modelpipe routes.json
```

Requires Node.js >= 18, no dependencies (Node built-ins only). It prints the listen
URL to stderr and runs until killed (Ctrl-C). Then point your client at it:

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
```

For Claude Code specifically — including the model-alias env recipe and the
**restart caveat** — read the next section. For any other Anthropic-format client,
setting `ANTHROPIC_BASE_URL` is usually all you need (see [Other clients](#other-clients)).

Write your route table by copying [`routes.example.json`](routes.example.json) and
filling in the env-var names it references; provider endpoints come from
[`providers.json`](providers.json).

## Claude Code setup

This is the load-bearing part. Claude Code decides **which model id it sends** from a
handful of environment variables; modelpipe decides **where that id goes**. Set the env
once, restart Claude Code, and every alias routes through the proxy.

### The env recipe

| Variable | Set it to | What it does |
| --- | --- | --- |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:8787` | Sends every Claude Code request to modelpipe instead of `api.anthropic.com`. |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | your backend's model id for the `sonnet` alias | Resolves `sonnet` to this id, which becomes the `body.model` modelpipe routes on. |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | your backend's model id for the `haiku` alias **and** background calls | Resolves `haiku` **and** Claude Code's background/auxiliary calls to this id. |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | your backend's model id for the `opus` alias | Resolves `opus` (and `opusplan` in Plan Mode) to this id. |
| `CLAUDE_CONFIG_DIR` | a separate dir, e.g. `~/.claude-modelpipe` | Keeps this routed profile from disturbing your normal Claude Code config. |

The chain for one request is:

```
Claude Code alias (sonnet/haiku/opus)
  → ANTHROPIC_DEFAULT_*_MODEL resolves it to a concrete model id
  → that id is sent as body.model
  → modelpipe matches body.model against your routes and forwards to the backend
```

So the **id you put in `ANTHROPIC_DEFAULT_*_MODEL` must be one your routes target** —
see [The routing model](#the-routing-model) below.

**The guard / background model.** Claude Code makes background calls (titles, small
auxiliary tasks) on its `haiku` alias, which resolves via `ANTHROPIC_DEFAULT_HAIKU_MODEL`.
Set that variable so those calls route to a backend you chose; leave it unset and they
fall to wherever the default `haiku` id lands. (`ANTHROPIC_SMALL_FAST_MODEL` was the old
name for this and is deprecated in favour of `ANTHROPIC_DEFAULT_HAIKU_MODEL` — use the
new one.)

> **Why the env vars take effect here.** Claude Code applies the `ANTHROPIC_DEFAULT_*_MODEL`
> aliases when `ANTHROPIC_BASE_URL` points at a gateway (which modelpipe is) — not when
> talking directly to `api.anthropic.com`. Pointing at modelpipe is exactly the condition
> that turns them on.

### Setting the env — two ways, both read at startup

**(a) `.claude/settings.json` `env` block** — declarative, no wrapper. Claude Code
applies this block to every session and subprocess it spawns:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-chat",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-chat",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-8"
  }
}
```

**(b) A launch wrapper** — export, then exec `claude`:

```sh
#!/bin/sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-chat
export ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-chat
export ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-8
export CLAUDE_CONFIG_DIR="$HOME/.claude-modelpipe"
exec claude "$@"
```

### ⚠️ MUST restart Claude Code for any change to take effect

Claude Code reads `ANTHROPIC_BASE_URL` and the model env vars **only at startup**.
Changing them — in `settings.json` or in your shell — does **not** affect a session
that is already running. **You must start a new Claude Code session for any change to
apply.**

There is no way to point an already-running session at the proxy: a `SessionStart` hook
fires *after* the API client has already bound to its base URL, and `settings.json` is
read once at launch. Edit the env, then quit and relaunch.

## The routing model

modelpipe matches the **literal `body.model`** of each request against each route's
`match` glob (only `*` is a wildcard), and forwards to the **first** route that matches.
It does **not** alias or translate — it rewrites `body.model` ONLY on two scoped
reroute hops: the vision fallback (rewrites to `forImagesModel`), and the failover
reroute (rewrites to a backup model id). Every other byte of the body passes through
unchanged.

The practical rule follows directly: a route's `match` must target the id that actually
**arrives** — the id Claude Code resolved, not the alias you typed. For a Claude backend
that is a `claude-*` id; for a cross-provider backend it is that provider's concrete id
(e.g. `deepseek-chat`, or an OpenRouter `vendor/model`). Put specific routes before broad
ones, since first-match wins.

## Routes config

A config is JSON: an optional `listen` block, optional dashboard flags, and a `routes`
array. Each route has a `match` glob over the model id, a backend `base_url`, and an
`auth` rule.

```json
{
  "listen": { "host": "127.0.0.1", "port": 8787 },
  "dashboard": true,
  "glmPlan": "pro",
  "routes": [
    { "match": "claude-*", "base_url": "https://api.anthropic.com", "auth": "passthrough" },
    { "match": "deepseek-*", "base_url": "https://api.deepseek.com/anthropic",
      "auth": { "header": "x-api-key", "keyEnv": "DEEPSEEK_API_KEY" } },
    { "match": "vision-*", "base_url": "https://openrouter.ai/api", "forImages": true,
      "forImagesModel": "google/gemini-2.5-flash-lite",
      "auth": { "header": "Authorization", "scheme": "Bearer", "keyEnv": "OPENROUTER_API_KEY" } }
  ]
}
```

The full route shape — `match`, `base_url`, `auth` (`passthrough` vs the
`{ header, keyEnv, scheme? }` key-swap), `forImages` / `forImagesModel`, and the `vision`
flag — is documented field-by-field in **[`routes.example.json`](routes.example.json)**
(runnable, commented). **[`providers.json`](providers.json)** is a catalog of known
Anthropic-format backends (anthropic, deepseek, z.ai GLM, openrouter) with their
`base_url` and `auth` filled in — copy a provider's values into a route instead of
looking them up. **Keys live in environment variables, never in the config** — the
config only names the env var, read at request time and never logged.

### Config fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `listen` | `{host, port}` | `127.0.0.1:8787` | Bind address and port. |
| `maxBodyBytes` | number | `26214400` (25 MB) | Request body size cap; 413 if exceeded. |
| `dashboard` | boolean | `false` | Enable the monitoring dashboard, stats collection, and management endpoints. |
| `glmPlan` | `"lite"` `"pro"` `"max"` | `"pro"` | GLM Coding Plan tier for quota bars. Only used when `dashboard: true`. |
| `anthropicPlan` | `"pro"` `"max"` `"team"` | — | Anthropic subscription tier for plan-vs-API cost comparison. Only used when `dashboard: true`. |
| `plans` | `{provider: price}` | — | Per-provider monthly subscription price (USD). E.g. `{"anthropic": 100, "glm": 64.80}`. Overrides default tier prices for effective-cost display. Only used when `dashboard: true`. |
| `tokenPrices` | `{modelGlob: {input, output}}` | — | Per-model API token price overrides ($ per 1M tokens). Keys can use `*` globs. Falls back to built-in `PRICE_MAP` in `src/stats.mjs`. |
| `failover` | `{modelGlob: backupModel}` | — | Model failover pairs. When a primary model's backend returns a retryable error (rate-limit, overloaded, account/org issues), modelpipe rewrites `body.model` to the backup id and reroutes. Supports chain failover (depth-guarded at 5 hops). |
| `failoverRecoveryIntervalMs` | number | `60000` | Minimum ms between recovery probes to a failed-over primary. Background pinger probes primaries; also, after the cooldown elapses the next real request tries the primary. Must be >= 1000. |
| `proxyUrl` | string | — | Public URL of this proxy, surfaced in `modelpipe --list` output. |
| `routes[]` | array | required | Route entries (see below). |

### Route fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `match` | string | **required** | Glob pattern over the model id (`*` is the only wildcard). First match wins — order specific before broad. |
| `base_url` | string (URL) | **required** | Backend origin. The client's `/v1/messages` path is appended. |
| `auth` | string or object | **required** | `"passthrough"` forwards the client's auth header unchanged. Object `{header, keyEnv, scheme?}` swaps in a backend key: `header` is the header name (e.g. `x-api-key`), `keyEnv` is the **name** of the env var holding the key (never the key value), `scheme` is an optional prefix (e.g. `"Bearer"` → `Authorization: Bearer <key>`). |
| `vision` | boolean | `true` | `false` declares this backend has no vision. Image-bearing requests skip straight to the `forImages` target — needed when a backend doesn't 400 on images (soft-200 refusal, server-side image tool). Text-only calls route normally. |
| `forImages` | boolean | — | Set `true` on **exactly one** route to mark it the vision fallback target. |
| `forImagesModel` | string | **required** if `forImages` | The model id the vision backend expects. On reroute, `body.model` is rewritten to this (the only passthrough exception). |

### Vision routing

A model-bearing turn can carry an image. modelpipe handles three cases:

- **Reactive 400 fallback.** When a backend rejects an image-bearing request with an
  image-unsupported `400`, modelpipe reroutes that same request to the route flagged
  `forImages: true`. Any other 400 is relayed verbatim.
- **`forImagesModel` cross-provider rewrite.** The `forImages` route **requires**
  `forImagesModel` — the id the vision backend expects. On reroute, modelpipe rewrites
  **only** `body.model` to it (the image bytes are untouched), because that hop crosses
  to a different provider whose model ids differ. This is the one scoped exception to
  passthrough; omitting it is a config error caught at startup (fail-closed).
- **`vision: false` pre-route.** Some backends don't 400 on an image — they soft-refuse
  with a 200, or invoke their own server-side image tool, neither of which the reactive
  catch-400 path can detect. Set `vision: false` on a route to declare its backend
  non-vision: an image-bearing request matched by it goes **straight** to the `forImages`
  target (with the `forImagesModel` rewrite), never to that backend first. Text-only
  turns route normally; default is `true`.

## Inspecting a config — `--list`

Discover what a config is wired for without starting the server:

```sh
modelpipe routes.json --list
```

It prints a **safe JSON summary** of the route table to stdout and exits — no network,
no server. Each route shows its `match`, `base_url`, the auth header/scheme, the key
env-var **name** (never a key value), and the `forImages` / `forImagesModel` / `vision`
flags. Useful for a setup dialog or a quick sanity check.

### `GET /v1/models` — the network-facing, stricter view

`GET /v1/models` (or the bare `GET /models`) returns the same route table over HTTP as a
model listing — the network-facing counterpart to `--list`, but **stricter**: it exposes
only each route's `match` glob, backend `host`, auth **mode** (`"passthrough"` or `"key"`),
and vision flags. No key env-var name, no auth header, no base path is ever sent over the
wire (a network endpoint is reachable by any client, so it must leak less than the
localhost `--list`). Handy for a setup probe against a running router.

## Verifying routing — `MODEL_ROUTER_LOG`

```sh
MODEL_ROUTER_LOG=1 modelpipe routes.json
```

Prints one `model -> host` line per request to stderr (`[model-router] <model> -> <host>`)
so you can confirm exactly which id arrived and where it routed — never a key, body, or
header. Off by default.

## Dashboard

When `"dashboard": true` is set in the config, modelpipe collects per-request usage data
and serves a live monitoring page at `http://127.0.0.1:8787/dashboard`. No installation
required — the page is embedded in the proxy process.

**What it shows:**

- **Session bar** — total cost, requests, tokens, start time.
- **Model cards** — each model with its provider, API pricing ($X/$Y per 1M in/out),
  tokens consumed, and dollar cost. Models sorted by spend.
- **Token chart** — cumulative tokens per model over time (last 200 requests).
- **Quotas** — DeepSeek balance, OpenRouter daily credits, Anthropic RPM/TPM rate limits
  (captured from response headers; for the Rate Limits API, set `ANTHROPIC_API_KEY` in
  `.env` even if the traffic route stays passthrough).
- **GLM Coding Plan** — artificial 5-hour and weekly quota bars estimated from token
  counts × API pricing. The plan–vs–raw-API comparison shows whether the subscription
  pays off. Displays the current peak/off-peak multiplier in local time.
- **Request log** — last 50 requests with timestamp, model, tokens in/out, cost,
  duration (ms).
- **Session management** — "New Session" button resets counters and archives the current
  session; history dropdown selects any of the last 20 sessions. Sessions persist to
  `~/.modelpipe/sessions.json` across proxy restarts.

**Pricing catalog.** Built-in prices for `claude-*`, `deepseek-*`, `glm-*`, and
`google/gemini-*` models. Unknown models show `price —` in the card and $0.00 cost
(they still count tokens and appear in the chart). The catalog lives in `src/stats.mjs`
(`PRICE_MAP`) — add entries there for models not yet covered. Override per-model prices
at runtime via the Settings panel (⚙ → API token prices) or `config.tokenPrices`.

**API endpoints** (only when `dashboard: true`):

| Endpoint | Returns |
| --- | --- |
| `GET /v1/stats` | Per-model usage, session totals, timeline (last 200), GLM quota estimation. |
| `GET /v1/quotas` | External quota snapshot: DeepSeek balance, OpenRouter credits, Anthropic rate limits. |
| `GET /v1/sessions` | Archived session history (up to 20). |
| `GET /v1/models` | Secret-free route listing: model globs, hosts, auth mode, vision flags. |
| `GET /v1/failover` | Current failover config and active failover state. |
| `POST /v1/sessions/reset` | Archives current session and starts a new one. |
| `POST /v1/plans` | Updates subscription prices (`plans`) and API token prices (`tokenPrices`) in-memory. |
| `POST /v1/failover` | Merges failover pairs and/or cooldown interval in-memory. |
| `POST /v1/failover/reset` | Clears all (or one, via `?model=X`) active failover state. |

All endpoints are JSON, secret-free (no keys, no env-var names, only aggregated counts),
served only on localhost.

## Model failover

When `failover` is set in the config, modelpipe automatically switches to a backup model
when a primary backend returns a retryable error:

```json
"failover": {
  "claude-opus-*": "glm-5.1",
  "glm-5.1": "deepseek-v4-pro"
}
```

**How it works:**

- **Reactive trigger.** When a backend returns an error that looks retryable — 429 (rate
  limit), 529 (overloaded), or any 4xx/5xx whose body mentions rate-limit / quota /
  capacity / credit / account / organisation keywords — modelpipe rewrites `body.model` to
  the backup id and reroutes.
- **Pre-route.** Once a model enters failover, subsequent requests within the cooldown
  period skip the primary and go straight to the backup.
- **Chain failover.** If the backup also fails and has its own failover pair, the router
  follows the chain (depth-guarded at 5 hops).
- **Recovery.** A background pinger periodically probes failed-over primaries. When a
  primary responds normally, the failover is cleared and routing reverts. For passthrough
  routes (no backend key), the cooldown-based retry on the next real request serves as
  the recovery path.

Pairs can be updated at runtime via the dashboard (⚙ → Failover) or the `POST /v1/failover`
endpoint — no restart required. Active failover state is visible in the dashboard and can
be manually reset.

## Security posture

- Backend keys come only from the named env vars — never inline in the config, never
  logged.
- The client's incoming auth header is **stripped** before forwarding on a key-swap
  route, so a front-key never leaks to a backend or reaches the wrong provider.
- **Fail-closed:** a request with no model, a model no route matches, or a route whose
  key env is unset is a 4xx/5xx error — never silently sent to a default backend.
- No secret / body / header logging. Binds to **localhost** by default.

## Other clients

modelpipe works with **any Anthropic-format client** — the Anthropic SDK, Cline,
Cursor's Anthropic mode, and others — anything that speaks the Messages API and honours
`ANTHROPIC_BASE_URL`. It is not Claude-Code-only by design; Claude Code just gets the
richest routing because it emits a distinct model id per tier (and per subagent). For
those clients, set `ANTHROPIC_BASE_URL` to the proxy and route on whatever model ids the
client sends. The spotlight stays on Claude Code because that is where the alias→model
env recipe above is load-bearing.

> **Not a translator.** Anthropic Messages API format only, forever — both ends speak it,
> so there is nothing to translate. OpenAI-shaped providers are out of scope by design.

## Development

```sh
npm test
```

The suite uses stub upstream servers on localhost (no network, no real keys) and exercises
the router through its real HTTP path: routing, the auth swap, body and streamed response
passthrough, fail-closed behaviour, the vision fallback, and log safety.

## License

MIT © 2026 Alexander Degtyarev
