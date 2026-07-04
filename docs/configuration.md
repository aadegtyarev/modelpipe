# Configuration

A config is JSON: an optional `listen` block, optional dashboard/failover fields, and a
`routes` array. Each route has a `match` glob over the model id, a backend `base_url`, and an
`auth` rule.

```json
{
  "listen": { "host": "127.0.0.1", "port": 8787 },
  "dashboard": true,
  "routes": [
    { "match": "claude-*", "base_url": "https://api.anthropic.com", "auth": "passthrough" },
    { "match": "deepseek-*", "base_url": "https://api.deepseek.com/anthropic",
      "auth": { "header": "x-api-key", "keyEnv": "DEEPSEEK_API_KEY" } },
    { "match": "google/*", "base_url": "https://openrouter.ai/api", "forImages": true,
      "forImagesModel": "google/gemini-2.5-flash-lite",
      "auth": { "header": "Authorization", "scheme": "Bearer", "keyEnv": "OPENROUTER_API_KEY" } }
  ]
}
```

The fastest way to write one is `modelpipe init`. The field-by-field reference lives in the
runnable, commented [`routes.example.json`](../routes.example.json), and known backends with
their `base_url`/`auth` filled in are in [`providers.json`](../providers.json).

**Keys live in environment variables, never in the config** — the config only names the env
var, read at request time and never logged.

## Keys & `.env`

modelpipe auto-loads a `.env` from the config's folder on start (or pass `--env-file <path>`).
A shell `export` or a systemd `EnvironmentFile` still wins over it. Copy
[`.env.example`](../.env.example) to `.env` and fill in the env-var names your routes use.

## Config fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `listen` | `{host, port}` | `127.0.0.1:8787` | Bind address and port. |
| `maxBodyBytes` | number | `26214400` (25 MB) | Request body size cap; 413 if exceeded. |
| `dashboard` | boolean | `false` | Enable the monitoring [dashboard](dashboard.md), stats, and management endpoints. |
| `tokenPrices` | `{modelGlob: {input, output}}` | — | Per-model **metered** API price overrides ($ per 1M tokens); `*` globs allowed. Editable at runtime (⚙) and persisted. |
| `failover` | `{modelGlob: backupModel}` | — | Model [failover](failover.md) pairs (retryable-error → backup model, chain-guarded at 5 hops). |
| `failoverGroups` | `[{ladder, mode?}]` | — | Coordinated [group failover](failover.md#group-failover). |
| `failoverRecoveryIntervalMs` | number | `60000` | Min ms between recovery probes / account cooldown. Must be ≥ 1000. |
| `proxyUrl` | string | — | Public URL of this proxy, surfaced in `--list`. |
| `routes[]` | array | required | Route entries (below). |

## Route fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `match` | string | **required** | Glob over the model id (`*` only). First match wins — order specific before broad. |
| `base_url` | string (URL) | **required** | Backend origin. The client's `/v1/messages` path is appended. |
| `auth` | string or object | **required** | `"passthrough"`, or a key-swap `{header, keyEnv, scheme?, fallback?}` (see [Auth](#auth)). |
| `billing` | `"metered"` `"subscription"` | derived | How the [dashboard](dashboard.md) reports money. Default: passthrough & z.ai/GLM ⇒ subscription, other key-swap ⇒ metered. |
| `accounts` | `[{label, auth, base_url?}]` | — | Multiple keys for the same model, rotating on a limit — see [account pools](failover.md#account-pools). Makes route-level `auth` optional. |
| `strategy` | `"failover"` `"round-robin"` | `"failover"` | Only with `accounts`. |
| `vision` | boolean | `true` | `false` = backend has no vision; image requests skip straight to the `forImages` target. |
| `forImages` | boolean | — | Set `true` on **exactly one** route — the vision fallback target. |
| `forImagesModel` | string | **required** if `forImages` | The model id the vision backend expects; `body.model` is rewritten to it on reroute. |

## Auth

- **`"passthrough"`** — forward the client's own auth header unchanged (a subscription/OAuth
  session with no backend key).
- **key-swap `{header, keyEnv, scheme?}`** — strip the client's auth and inject the proxy's
  key. `header` is the header name, `keyEnv` is the env-var **name** (never the value),
  `scheme` is an optional prefix (`"Bearer"` → `Authorization: Bearer <key>`).
- **fallback `{…, fallback: true}`** — **the token that flies wins.** Forward the client's own
  auth when it sent one (`x-api-key` or `Authorization`); inject `keyEnv` only when it didn't.

```json
{ "match": "claude-*", "base_url": "https://api.anthropic.com",
  "auth": { "header": "x-api-key", "keyEnv": "ANTHROPIC_API_KEY", "fallback": true } }
```

> **⚠️ API key vs subscription OAuth token — different things.** An **API key**
> (`sk-ant-api…`, `x-api-key`) is long-lived — great for `fallback`/key-swap. A **subscription
> OAuth token** (`sk-ant-oat…`, `Authorization: Bearer`) is short-lived and auto-refreshed by
> Claude Code — a static copy in the proxy env expires within hours. For a subscription, use
> plain **`"passthrough"`** (Claude Code flies its fresh token; nothing to store).

## Vision routing

A model-bearing turn can carry an image. modelpipe handles three cases:

- **Reactive 400 fallback** — a backend that rejects an image with an image-unsupported `400`
  gets the same request rerouted to the `forImages: true` route. Any other 400 is relayed as-is.
- **`forImagesModel` rewrite** — the reroute crosses to a different provider, so `body.model`
  (only) is rewritten to `forImagesModel` (image bytes untouched). Omitting it is a startup error.
- **`vision: false` pre-route** — for a backend that *doesn't* 400 on images (soft-200 refusal
  or a server-side image tool): image requests matched by it go **straight** to the `forImages`
  target. Text-only turns route normally.

## Inspecting a config — `--list`

```sh
node bin/modelpipe.mjs routes.json --list
```

Prints a **safe JSON summary** of the route table to stdout and exits — no network, no server.
Shows each route's `match`, `base_url`, the auth header/scheme, and the key env-var **name**
(never a value). `GET /v1/models` on a running router is the network-facing, stricter view
(host + auth *mode* only — no env name, header, or base path).

## Verifying routing — `MODEL_ROUTER_LOG`

```sh
MODEL_ROUTER_LOG=1 node bin/modelpipe.mjs routes.json
```

Prints one `[model-router] <model> -> <host>` line per request to stderr — never a key, body,
or header. Off by default.

## Run in the background (systemd)

Keep modelpipe always-on as a **user** service (no root):

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
systemctl --user status modelpipe          # running?
journalctl --user -u modelpipe -f          # follow logs
```

Update after a `git pull` with `systemctl --user restart modelpipe` (graceful — it won't hang
on open connections). `loginctl enable-linger $USER` keeps it running when you're logged out.

## Security posture

- Backend keys come only from the named env vars — never inline in the config, never logged.
- On a key-swap route the client's incoming auth header is **stripped** before forwarding, so
  a front-key never leaks to a backend or reaches the wrong provider.
- **Fail-closed:** no model, no matching route, or an unset key env → a 4xx/5xx error, never
  silently sent to a default backend.
- No secret / body / header logging. Binds to **localhost** by default.
