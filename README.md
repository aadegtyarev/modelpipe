# modelpipe

A passthrough **Anthropic-format** model router. Point an Anthropic-format client
at one local endpoint and modelpipe forwards each request to a chosen backend based
on the model id in the request body — route different model ids to different backends,
all behind a single `ANTHROPIC_BASE_URL`.

It is **Claude-Code-first and standalone**: it needs no protocol, no wrapper, and no
account beyond the backend keys you already have. Start it, point Claude Code at it,
and your `sonnet`/`opus`/`haiku` aliases land on whichever providers you choose.

## Quick start

modelpipe is a single Node script with **zero dependencies** — nothing to build, nothing to
`npm install`. You need **Node.js ≥ 18**.

**1. Get it.**

```sh
git clone https://github.com/aadegtyarev/modelpipe.git
cd modelpipe
```

**2. Write your routes.** Copy the worked example and edit it — it maps model ids to
backends. Keys are referenced by env-var **name** only, never pasted into the file.

```sh
cp routes.example.json routes.json
$EDITOR routes.json        # see "Routes config" below
```

**3. Add your keys.** Copy the env template and fill in the keys your routes use.

```sh
cp .env.example .env
$EDITOR .env
```

modelpipe **auto-loads `.env`** from your config's folder on start (or pass
`--env-file <path>`). A shell `export` or a systemd `EnvironmentFile` still wins over it, and
keys are only ever read at request time — never written to the config or logged.

**4. Run it.**

```sh
node bin/modelpipe.mjs routes.json
```

It prints the listen URL to stderr and runs until you stop it (Ctrl-C). Want a `modelpipe`
command on your PATH? `npm link` in the repo. Want it always-on? See
[Run in the background](#run-in-the-background-systemd).

**5. Point your client at it.**

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
```

For Claude Code specifically — including the model-alias env recipe and the
**restart caveat** — read the next section. For any other Anthropic-format client,
setting `ANTHROPIC_BASE_URL` is usually all you need (see [Other clients](#other-clients)).
Provider endpoints/auth to copy into routes come from [`providers.json`](providers.json).

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
  "routes": [
    { "match": "claude-*", "base_url": "https://api.anthropic.com", "auth": "passthrough", "billing": "subscription" },
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
| `dashboard` | boolean | `false` | Enable the monitoring dashboard, stats collection, and management endpoints. The live session and dashboard-set overrides persist under `~/.modelpipe/` across restarts. |
| `tokenPrices` | `{modelGlob: {input, output}}` | — | Per-model **metered** API token price overrides ($ per 1M tokens). Keys can use `*` globs. Falls back to built-in `PRICE_MAP` in `src/stats.mjs`. Editable at runtime (⚙) and persisted. |
| `failover` | `{modelGlob: backupModel}` | — | Model failover pairs. When a primary model's backend returns a retryable error (rate-limit, overloaded, account/org issues), modelpipe rewrites `body.model` to the backup id and reroutes. Supports chain failover (depth-guarded at 5 hops). |
| `failoverGroups` | `[{ladder, mode?}]` | — | Coordinated group failover. `mode: "shift"` (default) moves the whole ladder down one when its head tier fails; `mode: "cascade"` walks per-request. See [Model failover](#model-failover). |
| `failoverRecoveryIntervalMs` | number | `60000` | Minimum ms between recovery probes to a failed-over primary (and group wind-back re-probes). After the cooldown elapses the next real request also tries the primary. Must be >= 1000. |
| `proxyUrl` | string | — | Public URL of this proxy, surfaced in `modelpipe --list` output. |
| `routes[]` | array | required | Route entries (see below). |

### Route fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `match` | string | **required** | Glob pattern over the model id (`*` is the only wildcard). First match wins — order specific before broad. |
| `base_url` | string (URL) | **required** | Backend origin. The client's `/v1/messages` path is appended. |
| `auth` | string or object | **required** | `"passthrough"` forwards the client's auth header unchanged. Object `{header, keyEnv, scheme?, fallback?}` swaps in a backend key: `header` is the header name (e.g. `x-api-key`), `keyEnv` is the **name** of the env var holding the key (never the key value), `scheme` is an optional prefix (e.g. `"Bearer"` → `Authorization: Bearer <key>`). `fallback: true` = **use the client's own token if it flew, else inject `keyEnv`** (see [Fallback auth](#fallback-auth-use-the-clients-token-else-the-proxys)). |
| `billing` | `"metered"` `"subscription"` | derived | How the dashboard reports money. `metered` = pay-as-you-go (real per-token $). `subscription` = flat plan (tokens + "flat plan" label, no fabricated $). Default: passthrough ⇒ subscription, key-swap ⇒ metered. |
| `accounts` | `[{label, auth, base_url?}]` | — | Multiple accounts (keys) for the **same** model — the router rotates to the next when one hits its limit. Each has a `label` (shown per-account in the dashboard), its own `auth`, and an optional `base_url`. When present, route-level `auth` is optional. See [Account pools](#account-pools-multiple-keys-per-model). |
| `strategy` | `"failover"` `"round-robin"` | `"failover"` | Only with `accounts`. `failover` drains account #1, moves to #2 on a limit, snaps back when #1 recovers. `round-robin` spreads requests across accounts. |
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

## Fallback auth: use the client's token, else the proxy's

There are three ways a route can authenticate to its backend:

- **`"passthrough"`** — always forward the client's own auth header (a subscription/OAuth
  session with no backend key).
- **key-swap `{header, keyEnv}`** — always strip the client's auth and inject the proxy's key.
- **fallback `{header, keyEnv, fallback: true}`** — **the token that flies wins.** If the
  client sent its own auth (`x-api-key` or `Authorization`), forward it unchanged; only when
  the client sent none does the proxy inject `keyEnv`. Lets Claude Code pass its own token
  through while the proxy's key covers clients that send nothing.

```json
{ "match": "claude-*", "base_url": "https://api.anthropic.com",
  "auth": { "header": "x-api-key", "keyEnv": "ANTHROPIC_API_KEY", "fallback": true } }
```

The injected header respects `scheme`, so a Bearer token works too:
`{ "header": "Authorization", "scheme": "Bearer", "keyEnv": "ANTHROPIC_OAUTH_TOKEN", "fallback": true }`.

> **⚠️ API key vs subscription OAuth token — they are different.** An **API key**
> (`sk-ant-api…`, sent as `x-api-key`) is long-lived — perfect for `fallback`/key-swap: set
> it once. A **subscription OAuth token** (`sk-ant-oat…`, sent as `Authorization: Bearer`)
> is **short-lived and auto-refreshed by Claude Code** — pasting a static one into the proxy
> env works only until it expires (hours), then breaks. For a subscription, prefer plain
> **`"passthrough"`**: Claude Code flies its fresh token every request and the proxy just
> forwards it — nothing to store, nothing to refresh. Use `fallback` with a real API key.

## Inspecting a config — `--list`

Discover what a config is wired for without starting the server:

```sh
node bin/modelpipe.mjs routes.json --list
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
MODEL_ROUTER_LOG=1 node bin/modelpipe.mjs routes.json
```

Prints one `model -> host` line per request to stderr (`[model-router] <model> -> <host>`)
so you can confirm exactly which id arrived and where it routed — never a key, body, or
header. Off by default.

## Run in the background (systemd)

To keep modelpipe always-on as a **user** service (no root), point it at your config and
`.env` with absolute paths:

```ini
# ~/.config/systemd/user/modelpipe.service
[Unit]
Description=modelpipe — Anthropic-format model router
After=network-online.target

[Service]
ExecStart=/usr/bin/node %h/modelpipe/bin/modelpipe.mjs %h/modelpipe/routes.json --env-file %h/modelpipe/.env
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now modelpipe
systemctl --user status modelpipe          # check it's running
journalctl --user -u modelpipe -f          # follow logs
```

Update after a `git pull` with `systemctl --user restart modelpipe` (graceful — it won't
hang on open connections). `loginctl enable-linger $USER` keeps it running when you're
logged out.

## Dashboard

When `"dashboard": true` is set in the config, modelpipe collects per-request usage data
and serves a live monitoring page at `http://127.0.0.1:8787/dashboard`. No installation
required — the page is embedded in the proxy process.

**Honesty rule.** The dashboard shows only measured data. Money appears **only where it is
real**: per-token cost for `metered` (pay-as-you-go) providers and real provider balances.
For `subscription` (flat-plan) providers — a GLM Coding Plan, an Anthropic subscription —
per-token dollars are meaningless, so the dashboard shows **tokens + a "flat plan" label**,
never a fabricated cost. There are no invented quota bars, no subscription-cost proration,
and no "plan vs API saves $X" verdicts.

**What it shows:**

- **Session bar** — metered API cost (subscription providers contribute nothing), requests,
  tokens, start time.
- **Model cards** — each model with its provider, a `metered`/`flat plan` tag, tokens, and
  requests. Dollar cost is shown only for metered models; flat-plan models show `—`.
- **Token chart** — cumulative tokens per model over time (last 200 requests).
- **Provider cards** — real data only: DeepSeek balance, OpenRouter credits, Anthropic
  RPM/ITPM/OTPM (from live response headers), and per-provider session tokens/requests. GLM
  links to the z.ai console for its real Coding-Plan quota.
- **Request log** — last 50 requests with timestamp, model, tokens in/out, cost (metered
  only), duration (ms).
- **Session management** — "New session" archives the current session and starts fresh;
  history dropdown selects any of the last 20 sessions.
- **Settings (⚙)** — edit metered token prices and failover pairs at runtime; view failover
  groups and active shift state.

**Persistence.** The live session (per-model/provider totals + timeline) is flushed to
`~/.modelpipe/state.json` every 10 s and on shutdown, and **resumed on startup** — a crash
loses at most a few seconds. Archived sessions live in `~/.modelpipe/sessions.json`, and
dashboard-set token prices / failover pairs in `~/.modelpipe/overrides.json`. The config
file stays the immutable source of truth; overrides are merged on top. (Override the base
dir with `MODELPIPE_DIR`.)

**Pricing catalog.** Built-in metered prices for `claude-*`, `deepseek-*`, `glm-*`, and
`google/gemini-*` models in `src/stats.mjs` (`PRICE_MAP`). Unknown models show `price —` and
$0 cost (they still count tokens and chart). Override per-model prices at runtime via
Settings (⚙) or `config.tokenPrices`.

**API endpoints** (only when `dashboard: true`):

| Endpoint | Returns |
| --- | --- |
| `GET /v1/stats` | Per-model usage, session totals, timeline (last 200). |
| `GET /v1/quotas` | Real provider balances: DeepSeek balance, OpenRouter credits. |
| `GET /v1/sessions` | Archived session history (up to 20). |
| `GET /v1/models` | Secret-free route listing: model globs, hosts, auth mode, vision + billing flags. |
| `GET /v1/failover` | Failover pairs, active reactive state, and group ladders/offsets/effective tiers. |
| `GET /v1/accounts` | Per-route account-pool state: labels, strategy, and per-account cooldown. |
| `POST /v1/accounts/reset` | Clears account cooldowns (all, or one via `?label=X`) — no restart. |
| `POST /v1/sessions/reset` | Archives current session and starts a new one. |
| `POST /v1/token-prices` | Updates metered API token prices in-memory + persists them. |
| `POST /v1/failover` | Sets failover pairs (authoritative) and/or cooldown; persists them. |
| `POST /v1/failover/reset` | No restart needed. No param → clear all pair state + wind every group offset back. `?model=X` → clear one model's pair state. `?group=N` → wind group #N's offset back (unsticks a rare double-shift). |

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
endpoint — no restart required, and edits persist. Active failover state is visible in the
dashboard and can be manually reset.

### Group failover — shift the whole ladder at once

A plain `failover` pair reroutes only the **one** model that erred. Sometimes you want a
**coordinated shift**: when a provider goes down, move a whole tier ladder down together so
the next tier isn't doubly loaded. That's `failoverGroups`:

```json
"failoverGroups": [
  { "ladder": ["claude-opus-*", "glm-5.1", "deepseek-v4-pro"], "mode": "shift" }
]
```

- **`mode: "shift"` (default)** — the ladder rides a shared offset. When the **head** tier
  fails (e.g. Anthropic is down), the offset moves the whole ladder down one: `opus → glm`
  **and glm's own traffic → deepseek at the same time**. A background probe of the tier you
  shifted past winds the offset back up when it recovers.
- **`mode: "cascade"`** — no coordinated shift; each request just walks the ladder on error
  (the same shape as a `failover` chain, expressed as one ordered list).
- The **head** (index 0) may be a glob; every lower tier is a rewrite target and **must be a
  concrete model id**. Each tier needs a matching route. Groups take precedence over
  `failover` pairs for any model on a ladder.
- **Recovery** works even for a passthrough/glob head (which the background pinger can't
  probe): after the cooldown, the next head request is sent to the real head with its real
  model id, and a healthy reply winds the whole ladder back one.
- **Limitation:** the shift is a single scalar offset, so it can't wind back *past* a still-
  down middle tier — if both the head and a middle tier fail (offset 2) and only the head
  later recovers, head traffic stays on the lower tier until the middle recovers too. Rare
  (double failure), self-limiting, and fixable without a restart via
  `POST /v1/failover/reset?group=N`.

**Routing to other providers.** A backup (pair value or ladder tier) can target any provider
— including OpenRouter — as long as a route matches its id. To fail opus over to Claude via
OpenRouter, add a route and reference the id:

```json
"routes": [
  { "match": "anthropic/*", "base_url": "https://openrouter.ai/api",
    "auth": { "header": "Authorization", "scheme": "Bearer", "keyEnv": "OPENROUTER_API_KEY" } }
],
"failover": { "claude-opus-*": "anthropic/claude-sonnet-4.6" }
```

(Order the OpenRouter `*/*`-style route **last** — first match wins.)

## Account pools: multiple keys per model

Sometimes you have **several accounts on the same provider** — e.g. two GLM Coding Plan
subscriptions, or a few Anthropic API keys — and want to roll onto the next when one runs
out of quota. That's an `accounts` pool on a route:

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

- Each account has a **`label`** (shown as its own card in the dashboard), its own **`auth`**
  (key), and an optional **`base_url`** (a different host/org). When `accounts` is set, the
  route-level `auth` is optional.
- This is **key/backend-level** rotation — the model id is **not** rewritten (unlike failover
  pairs/groups). The same `glm-5.1` request just goes out under a different key.
- **On a limit** (429/529/quota/credit/org error) the active account is parked for the
  `failoverRecoveryIntervalMs` cooldown and the request retries on the next eligible account.
  When the cooldown elapses the account is tried again automatically (`failover` snaps back to
  the primary; `round-robin` folds it back into rotation).
- **`strategy`**: `"failover"` (default) drains the primary and only moves down on a limit;
  `"round-robin"` spreads requests to stretch total quota across accounts.
- **Works for any provider** — GLM, Anthropic (several API keys), DeepSeek, OpenRouter.
- **Not everywhere** — a route without `accounts` behaves exactly as before. Pools are opt-in.
- **Dashboard/state:** `GET /v1/accounts` shows each pool's labels + cooldown state;
  `POST /v1/accounts/reset` (optionally `?label=X`) clears cooldowns without a restart.

Account rotation is the innermost layer: it happens **within** a route first; only when a
pool has no live account left does model-level `failover`/`failoverGroups` kick in.

> **Note on GLM/Anthropic subscription tokens:** a Coding-Plan token or an Anthropic OAuth
> token is short-lived (see [Fallback auth](#fallback-auth-use-the-clients-token-else-the-proxys)).
> Account pools are most robust with **long-lived API keys**. For OAuth subscriptions the token
> in the env will expire and need refreshing.

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
