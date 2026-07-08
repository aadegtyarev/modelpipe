# modelpipe

A passthrough **Anthropic-format** model router. Point any Anthropic-format client (Claude
Code, the Anthropic SDK, Cline, …) at one local endpoint, and modelpipe forwards each request
to a chosen backend based on the model id — different model ids to different providers, all
behind a single `ANTHROPIC_BASE_URL`.

No protocol, no wrapper, no account beyond the backend keys you already have. Single Node
script, **zero dependencies**, Node.js ≥ 18. It's a router, **not a translator** — both ends
speak the Messages API, so the request body passes through untouched.

![modelpipe dashboard](docs/dashboard.png)

## Install

A guided wizard asks a few questions and writes your `routes.json` + `.env` — runnable
straight from GitHub, nothing installed globally:

```sh
npx github:aadegtyarev/modelpipe init          # config wizard → routes.json + .env
npx github:aadegtyarev/modelpipe routes.json   # run the proxy
```

Or install persistently (clone into `~/modelpipe`, then run the wizard):

```sh
curl -fsSL https://raw.githubusercontent.com/aadegtyarev/modelpipe/main/install.sh | bash
```

## By hand

```sh
git clone https://github.com/aadegtyarev/modelpipe.git && cd modelpipe
cp routes.example.json routes.json     # map model ids → backends (or run: node bin/modelpipe.mjs init)
cp .env.example .env                   # fill in the keys your routes use
node bin/modelpipe.mjs routes.json     # runs until Ctrl-C; auto-loads .env next to the config
```

Then point your client at it:

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
```

For **Claude Code**, also set the `ANTHROPIC_DEFAULT_*_MODEL` aliases so each tier routes where
you want — see **[docs/claude-code.md](docs/claude-code.md)** (`modelpipe init` prints a recipe
for the providers you picked). Any other client: setting `ANTHROPIC_BASE_URL` is usually enough.

## What it does

- **Model routing** — first route whose `match` glob hits `body.model` wins; per-backend key
  swap. Keys live in env vars, never in the config, never logged.
- **[Routing profiles](docs/profiles.md)** — one active profile decides where each alias goes;
  **pin** it, **schedule** it, or let it **step to a backup** on a rate-limit (the auto chain),
  plus rotate between **multiple accounts/keys** for one model.
- **Fallback auth** — forward the client's own token when it sends one, else inject the proxy's
  key. ([configuration.md#auth](docs/configuration.md#auth))
- **Vision fallback** — reroute image-bearing requests a backend can't handle to a vision model.
- **[Honest dashboard](docs/dashboard.md)** — real per-token cost for pay-as-you-go providers,
  tokens + a "flat plan" label for subscriptions (never a fabricated cost), live quotas, and a
  request log. Enable with `"dashboard": true`.

## Docs

- **[Configuration](docs/configuration.md)** — routes, auth, fields, `.env`, `--list`, systemd,
  security.
- **[Claude Code setup](docs/claude-code.md)** — the alias env recipe and the restart caveat.
- **[Routing profiles](docs/profiles.md)** — profiles, the auto switching chain (pin / schedule / on-error step), and account pools.
- **[Dashboard](docs/dashboard.md)** — what it shows, honesty rule, endpoints, persistence.
- **[`routes.example.json`](routes.example.json)** — the runnable, field-by-field config example.
- **[`providers.json`](providers.json)** — known backends (Anthropic, DeepSeek, z.ai GLM, OpenRouter).

## Security

Localhost-only by default · fail-closed (no model / no route / unset key → error, never a wrong
backend) · keys from env vars only · client auth stripped on key-swap routes · no secret/body/
header logging. Details in [configuration.md](docs/configuration.md#security-posture).

## Development

```sh
npm test
```

Stub upstream servers on localhost (no network, no real keys) exercise the router through its
real HTTP path: routing, auth swap, streamed passthrough, fail-closed behaviour, vision
fallback, profile routing, account pools, and log safety.

## License

MIT © 2026 Alexander Degtyarev
