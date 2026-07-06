# Context compaction

Keep a session under its model's context window **without** relying on the client's built-in
`/compact` — which is unreliable on non-Anthropic models (DeepSeek, GLM) and does nothing once
the window has already overflowed. modelpipe sits in the request path and sees the **entire**
`messages` array on every turn (the Messages API is stateless), so it can shrink the request
*before forwarding it* — the one place a live, already-oversized window can actually be reduced.

Compaction is **on by default**.

## What it does

When a request exceeds **`triggerPct`** (default 70%) of the model's context window:

1. The **older** turns (everything up to a stable checkpoint) are summarized by a model into a
   dense checkpoint.
2. The summary is spliced in **ahead of a verbatim recent tail**, so the forwarded request
   lands around **`targetPct`** (default ~15%) of the window — summary (≤ `summaryMaxPct`) plus
   the most recent turns kept word-for-word.
3. The summary is **cached per session** (keyed on the `x-claude-code-session-id` header) and
   reused on later turns, so the summarizer model runs only when the history first crosses — or
   *re-crosses* — the trigger, not on every request.

One rule (`request > budget → compact before forward`) covers both cases:

- **Steady state** — a growing session is trimmed early, so it never reaches overflow.
- **Emergency** — a huge session loaded from disk, or one already past the limit, is trimmed on
  its very next request before it can crash.

The full transcript on disk (`~/.claude/projects/…jsonl`) is **untouched** — compaction only
changes what the model *sees* per request.

## Safety net: mechanical trim

If the summarizer is unavailable / errors, or the request is already so large the summarizer
input itself wouldn't fit, modelpipe falls back to a **deterministic mechanical trim**: drop the
head to the newest **stable checkpoint** and forward. A stable checkpoint is a real user-prompt
boundary with every `tool_use`/`tool_result` pair intact — cutting elsewhere would leave a
dangling pair, which the API rejects with a 400. So a turn never crashes; worst case it loses the
older context with a short marker in place of a summary.

## The summarizer

By default the **session's own model** summarizes (whatever the request's `model` is). Set
`compact.summarizerModel` to route summaries to a cheaper/faster model instead — it must resolve
to one of your routes. The summarizer call goes back through modelpipe itself (reusing all
routing/auth/failover) as an internal, non-streaming request; the head is flattened to a plain
text transcript first, so no `tools` schema or tool-block pairing travels with it.

## Config

```json
{
  "compact": {
    "enabled": true,
    "triggerPct": 0.70,
    "targetPct": 0.15,
    "summaryMaxPct": 0.08,
    "windowDefault": 200000,
    "window": { "claude-*": 1000000, "deepseek-*": 128000 },
    "summarizerModel": null
  }
}
```

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Master on/off. |
| `triggerPct` | number (0,1) | `0.70` | Fraction of the window at which compaction fires. |
| `targetPct` | number (0,1) | `0.15` | Size to compact down to (summary + verbatim tail). Must be `< triggerPct`. |
| `summaryMaxPct` | number (0,1) | `0.08` | Share of the window the summary may take. Must be `< targetPct`. |
| `windowDefault` | number | `200000` | Context window (tokens) for models not matched by `window`. |
| `window` | `{modelGlob: tokens}` | `{}` | Per-model window sizes (`*` globs). E.g. Claude with the 1M beta = `1000000`. |
| `summarizerModel` | string \| null | `null` | Model id to summarize with; `null` = the session's own model. |

All of it is editable at runtime in the **dashboard** (⚙ Settings → *Context compaction*) and
persisted to `~/.modelpipe/overrides.json`, so edits survive a restart without touching the
config file. Token counts use a cheap `chars/4` estimate (no tokenizer dependency), so set the
window a little conservatively — over-counting only compacts slightly earlier.
