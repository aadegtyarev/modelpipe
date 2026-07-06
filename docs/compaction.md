# Context fitting

A **safety net**, not steady-state compaction. Keeping a session under its model's context
window is the client's job — Claude Code's native auto-compaction does that fine, including
against non-Anthropic backends (set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` to the model's real window
so it triggers at the right size through a gateway). modelpipe does **not** duplicate that.

What only the proxy can handle is the **failover downshift**: a request is running against a
1M-window model, that model fails (429/529/5xx), and the [failover](failover.md) ladder reroutes
it to a smaller-window backup (say 256K). The conversation grew to fit 1M — it does not fit
256K, so the backup rejects it. The client can't prevent this: it still thinks it's talking to
the 1M model and has no idea the effective window just dropped. Only the proxy knows, because
only the proxy did the reroute.

Enabled by default. Deterministic, no summarizer, no per-session state — zero added latency on
the normal path (a request that already fits is never touched).

## What it does

1. **Downshift trim (proactive).** On any hop that routes to a model whose window is *smaller*
   than the client's original model, the request is trimmed to fit the target window before it
   is sent: the older turns are dropped to the newest **stable checkpoint** — a real user-prompt
   boundary with every `tool_use`/`tool_result` pair intact (cutting elsewhere leaves a dangling
   pair, which is an API 400). A single un-cuttable oversized turn falls back to capping its
   largest blocks. The primary hop (same/larger window) is never touched.

2. **Overflow retry (reactive, self-calibrating).** If a backend still rejects a request as too
   long (our window estimate was too high, or the model's real window is smaller than
   configured), the proxy: (a) **learns** the real window — parsed from the error message when
   it states one (e.g. *"…> 200000 maximum"*), else ~90% of what was sent — and persists it per
   model, so future requests fit it up front; (b) **hard-trims** and **retries**, shrinking the
   target each attempt so it converges; (c) after `maxOverflowRetries`, relays the error.

The full transcript on disk (client-side) is untouched — this only changes what a given backend
*receives* on a downshift.

## Config

```json
{
  "compact": {
    "enabled": true,
    "safetyPct": 0.95,
    "windowDefault": 200000,
    "window": { "glm-5.2": 1000000, "glm-*": 200000, "deepseek-v4-pro": 1000000, "claude-opus-*": 1000000 },
    "maxOverflowRetries": 2
  }
}
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Master on/off. |
| `safetyPct` | number (0,1] | `0.95` | Trim to this fraction of the window (headroom for the token estimate). |
| `windowDefault` | number | `200000` | Context window (tokens) for models not matched by `window`. |
| `window` | `{modelGlob: tokens}` | `{}` | Per-model window sizes. **First match wins — order specific ids before broad globs** (e.g. `glm-5.2` before `glm-*`). |
| `maxOverflowRetries` | integer ≥0 | `2` | Reactive hard-trim + retry attempts on a provider context-overflow error. |

Token counts use a cheap `chars/4` estimate (no tokenizer dependency), so set windows a little
conservatively — an under-count is caught and self-corrected by the reactive overflow path.

Editable at runtime in the **dashboard** (⚙ Settings → *Context fitting*), persisted to
`~/.modelpipe/overrides.json`. Learned windows live in `~/.modelpipe/compact-learned-windows.json`.
