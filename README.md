# modelpipe

A passthrough **Anthropic-format** model router. Point any Anthropic-format client
at one local endpoint, and modelpipe forwards each request to a chosen backend based
on the model id in the request body — different model tiers to different providers,
under one `ANTHROPIC_BASE_URL`.

**Passthrough, no translator.** The request body is never transformed; both ends speak
the Anthropic Messages API, so there is nothing to translate. modelpipe only chooses a
backend and swaps the auth header.

## What it does

modelpipe routes **any model-bearing call a client makes** to a chosen Anthropic-format
backend:

- **The model tiers across different providers** — send `opus`/`sonnet`/`haiku`-class
  ids to whichever backend you want for each (e.g. Anthropic for one tier, DeepSeek or
  z.ai GLM for another), all behind a single endpoint.
- **A guard / auxiliary model** — opt-in; any model id your client emits can get its own
  route. Ids you do not route are simply left untouched.
- **An image-turn vision fallback** — when a backend rejects an image-bearing request with
  an "image not supported" 400, modelpipe reroutes that same request to a configured
  `forImages` vision backend (reactive catch-400). Any other 400 is relayed verbatim.

It works with **any Anthropic-format client** — the Anthropic SDK, Cline, Cursor's
Anthropic mode, Claude Code, anything that speaks the Messages API. It is **not**
Claude-Code-specific. The routing **richness scales with how many distinct model-ids the
client emits**: a client that only ever sends one model gets one route; a client that
emits a rich set of ids (Claude Code does) gets the richest routing.

### What modelpipe is NOT

- **Not a translator.** Anthropic Messages API format only, forever. OpenAI-shaped
  providers are out of scope by design.
- **Not per-role automatic cross-model review.** Routing *by model id* is all modelpipe
  does. Automatically running, say, a reviewer agent on a *different* model from the
  builder is a **separate upstream protocol's** job — that orchestration decides which
  role gets which model id and is layered *on top of* modelpipe as the transport.
  modelpipe just carries whatever ids it is handed to the right backend.

## Install

Run it directly with no install:

```sh
npx modelpipe routes.json
```

Or install globally:

```sh
npm i -g modelpipe
modelpipe routes.json
```

Requires Node.js >= 18. No dependencies (Node built-ins only).

## Usage

1. Write a routes config (see below), e.g. `routes.json`.
2. Start the router:

   ```sh
   modelpipe routes.json            # uses the config's listen.host/port
   modelpipe routes.json --port 8800   # override the port
   ```

   It prints the listen URL to stderr and runs until killed (Ctrl-C).
3. Point your Anthropic-format client at it:

   ```sh
   export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
   ```

Optional: set `MODEL_ROUTER_LOG=1` for a safe `model -> host` routing line on stderr
(never a key, body, or header).

### Claude Code users — leave `CLAUDE_CODE_SUBAGENT_MODEL` unset

modelpipe routes on the model id in each request. Claude Code emits a distinct model id
per subagent (that is what lets modelpipe route them to different backends). If you set
`CLAUDE_CODE_SUBAGENT_MODEL`, Claude Code collapses subagent calls onto that one id and
modelpipe can no longer tell them apart — so **keep `CLAUDE_CODE_SUBAGENT_MODEL` unset**
and let Claude Code emit its natural per-subagent ids.

## Writing a routes config

A config is JSON: an optional `listen` block and a `routes` array. Each route has a
`match` glob over the model id, a backend `base_url`, and an `auth` rule. The first route
whose `match` matches the request's model wins, so **order specific routes before broad
ones**.

```json
{
  "listen": { "host": "127.0.0.1", "port": 8787 },
  "routes": [
    { "match": "claude-*", "base_url": "https://api.anthropic.com", "auth": "passthrough" },
    { "match": "deepseek-*", "base_url": "https://api.deepseek.com/anthropic",
      "auth": { "header": "x-api-key", "keyEnv": "DEEPSEEK_API_KEY" } },
    { "match": "vision-*", "base_url": "https://api.anthropic.com", "forImages": true,
      "auth": { "header": "x-api-key", "keyEnv": "ANTHROPIC_API_KEY" } }
  ]
}
```

See **`routes.example.json`** for a runnable, commented version, and **`providers.json`**
for a catalog of known Anthropic-format backends (anthropic, deepseek, z.ai GLM,
openrouter) with their `base_url` and `auth` already filled in — copy a provider's values
into a route instead of looking them up.

### `auth`

- `"passthrough"` — forward the client's own auth header unchanged. Use for a
  subscription / OAuth session that needs no separate backend key (only providers that
  support a keyless session).
- `{ "header": "...", "keyEnv": "...", "scheme": "..." }` — swap in a backend key. `header`
  is where the key goes (`x-api-key`, or `Authorization`); `keyEnv` is the **name of an
  environment variable** holding the key (read at request time, never logged); `scheme`
  (optional, e.g. `"Bearer"`) is prepended (`Authorization: Bearer <key>`).

**Keys live in environment variables, never in the config file** — the config only names
the env var.

### `forImages`

Set `forImages: true` on **exactly one** route to make it the vision fallback target.
When a backend rejects an image-bearing request with an image-unsupported 400, the same
request is rerouted there.

## Security posture

- Backend keys come only from the named env vars — never inline in the config, never
  logged.
- The client's incoming auth header is stripped before forwarding on a key-swap route, so
  a front-key never leaks to a backend or reaches the wrong provider.
- **Fail-closed:** a request with no model, a model no route matches, or a route whose key
  env is unset is a 4xx/5xx error — never silently sent to a default backend.
- No secret / body / header logging. Binds to localhost by default.

## Development

```sh
npm test
```

The test suite uses stub upstream servers on localhost (no network, no real keys) and
exercises the router through its real HTTP path: routing, the auth swap, body and streamed
response passthrough, fail-closed behaviour, the vision fallback, and log safety.

## License

MIT © 2026 Alexander Degtyarev
