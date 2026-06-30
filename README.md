# modelpipe

A passthrough **Anthropic-format** model router. Point any Anthropic-format client
at one local endpoint, and modelpipe forwards each request to a chosen backend based
on the model id in the request body — different model tiers to different providers,
under one `ANTHROPIC_BASE_URL`.

**Passthrough, no translator.** Both ends speak the Anthropic Messages API, so there is
nothing to translate — modelpipe chooses a backend and swaps the auth header. The request
body is forwarded as-is, with **one** scoped exception: on a vision-fallback reroute the
body's `model` field is rewritten to the target route's `forImagesModel` (see below),
because that hop crosses to a different provider. No format translation, ever.

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

Discover what a config is wired for without starting the router:

```sh
modelpipe routes.json --list   # safe JSON summary of the route table to stdout
```

It prints each route's `match`, `base_url`, auth header/scheme and the key env-var
**name** (never a key value), plus the `forImages`/`vision` flags — no network, no server.

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
    { "match": "vision-*", "base_url": "https://openrouter.ai/api", "forImages": true,
      "forImagesModel": "google/gemini-2.5-flash-lite",
      "auth": { "header": "Authorization", "scheme": "Bearer", "keyEnv": "OPENROUTER_API_KEY" } }
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

### `forImages` / `forImagesModel`

Set `forImages: true` on **exactly one** route to make it the vision fallback target.
When a backend rejects an image-bearing request with an image-unsupported 400, the
request is rerouted there.

`forImagesModel` is **required** on that route — the model id the vision backend expects
(e.g. an OpenRouter `vendor/model` id like `google/gemini-2.5-flash-lite`). On reroute,
modelpipe rewrites **only** the body's `model` field to it; the rest of the body (the
image bytes) is untouched. This is the **one scoped exception** to passthrough: the
reroute crosses to a *different* provider, whose model ids differ from the source
backend's, so the client's original id would be rejected there. Omitting it is a config
error caught at startup (fail-closed), not a silent runtime 400.

### `vision` (declare a backend non-vision)

The reroute above is **reactive** — it waits for a `400` "image not supported". But not
every backend 400s on an image: some **soft-refuse with a 200** ("I can't see images"),
some invoke their **own server-side image tool** — neither of which the catch-400 path can
detect. Set **`vision: false`** on a route to declare its backend non-vision: an
image-bearing request matched by that route is then sent **straight to the `forImages`
target** (with the `forImagesModel` rewrite), never to that backend first — no reliance on
a wire signal. Text-only turns are unaffected (they route normally). Default is `true`
(assume vision-capable; the reactive 400 fallback still applies). Requires a `forImages`
route to route to; with none configured the flag is inert.

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
