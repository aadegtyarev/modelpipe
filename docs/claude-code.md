# Claude Code setup

Claude Code decides **which model id it sends** from a handful of environment variables;
modelpipe decides **where that id goes**. Set the env once, restart Claude Code, and every
alias routes through the proxy.

`modelpipe init` prints a suggested recipe for the providers you chose. The reference:

## The env recipe

| Variable | Set it to | What it does |
| --- | --- | --- |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:8787` | Sends every Claude Code request to modelpipe instead of `api.anthropic.com`. |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | your backend's model id for the `sonnet` alias | Resolves `sonnet` to this id, which becomes the `body.model` modelpipe routes on. |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | your backend's model id for the `haiku` alias **and** background calls | Resolves `haiku` **and** Claude Code's background/auxiliary calls to this id. |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | your backend's model id for the `opus` alias | Resolves `opus` (and `opusplan` in Plan Mode) to this id. |
| `CLAUDE_CONFIG_DIR` | a separate dir, e.g. `~/.claude-modelpipe` | Keeps this routed profile from disturbing your normal Claude Code config. |

The chain for one request:

```
Claude Code alias (sonnet/haiku/opus)
  → ANTHROPIC_DEFAULT_*_MODEL resolves it to a concrete model id
  → that id is sent as body.model
  → modelpipe matches body.model against your routes and forwards to the backend
```

So the **id you put in `ANTHROPIC_DEFAULT_*_MODEL` must be one your routes target** (see
[The routing model](#the-routing-model)).

**The guard / background model.** Claude Code makes background calls (titles, small auxiliary
tasks) on its `haiku` alias via `ANTHROPIC_DEFAULT_HAIKU_MODEL`. Set it so those route to a
backend you chose. (`ANTHROPIC_SMALL_FAST_MODEL` was the old name and is deprecated.)

> Claude Code applies the `ANTHROPIC_DEFAULT_*_MODEL` aliases only when `ANTHROPIC_BASE_URL`
> points at a gateway (which modelpipe is) — pointing at modelpipe is what turns them on.

## Setting the env — two ways, both read at startup

**(a) `.claude/settings.json` `env` block** — declarative, no wrapper:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "glm-5.2",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-chat",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-8"
  }
}
```

**(b) A launch wrapper** — export, then exec `claude`:

```sh
#!/bin/sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.2
export ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-chat
export ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-8
export CLAUDE_CONFIG_DIR="$HOME/.claude-modelpipe"
exec claude "$@"
```

## ⚠️ Restart Claude Code for any change to take effect

Claude Code reads `ANTHROPIC_BASE_URL` and the model env vars **only at startup**. Changing
them — in `settings.json` or your shell — does **not** affect a running session. Quit and
relaunch. (A `SessionStart` hook fires *after* the API client has bound its base URL, so it
can't retrofit a running session either.)

## The routing model

modelpipe matches the **literal `body.model`** of each request against each route's `match`
glob (only `*` is a wildcard), and forwards to the **first** route that matches. It does
**not** alias or translate — it rewrites `body.model` only on two scoped reroute hops (the
vision fallback and the failover reroute). Every other byte of the body passes through
unchanged.

So a route's `match` must target the id that actually **arrives** — the id Claude Code
resolved, not the alias you typed. For a Claude backend that's a `claude-*` id; for a
cross-provider backend it's that provider's concrete id (`deepseek-chat`, an OpenRouter
`vendor/model`, …). Put specific routes before broad ones — first match wins.

## Other clients

modelpipe works with **any Anthropic-format client** — the Anthropic SDK, Cline, Cursor's
Anthropic mode, and others that speak the Messages API and honour `ANTHROPIC_BASE_URL`. Point
the client at the proxy and route on whatever model ids it sends. Claude Code just gets the
richest routing because it emits a distinct model id per tier (and per subagent).

> **Not a translator.** Anthropic Messages API format only — both ends speak it, so there is
> nothing to translate. OpenAI-shaped providers are out of scope by design.
