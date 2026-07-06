// modelpipe context fitting — the proxy's ONE job around context: when a request is routed to
// a model whose context window is SMALLER than the request needs, mechanically trim it to fit
// BEFORE it 400s. The motivating case is failover downshift: a 1M-window primary fails over to
// a 256K backup, but the conversation already grew past 256K (it fit in 1M) — the backup would
// reject it. Claude Code's own auto-compact can't help: it thinks it's still talking to the 1M
// model and has no idea the effective window just dropped. Only the proxy knows.
//
// Steady-state compaction is deliberately NOT done here — that's left to the harness (Claude
// Code's native auto-compact, which works against the Anthropic primary). This module only
// trims the edge case, deterministically, with no summarizer and no per-session state — so the
// normal path adds zero latency and can never fail.
//
// Two entry points:
//   • fitToWindow(parsed, windowTokens) — proactive: called with the TARGET model's window.
//     No-ops when the request already fits (the normal case); trims only on a real downshift.
//   • isContextOverflow / parseOverflowLimit — reactive: classify a provider's context-length
//     error so the router can hard-trim + retry and learn the model's real window.
//
// The pure helpers are unit-tested.

// --- token estimate -------------------------------------------------------------------
// Cheap and dependency-free (modelpipe ships zero deps). ~4 chars/token over serialized JSON —
// a rough estimate; every budget is a fraction of the window, so a small miss only trims
// slightly early/late, and the reactive overflow path self-corrects a real under-count.
export function estimateTokens(x) {
  if (x == null) return 0;
  const s = typeof x === "string" ? x : JSON.stringify(x);
  return Math.ceil(s.length / 4);
}

// system + tools are fixed overhead we never trim — counted toward the window budget.
export function overheadTokens(parsed) {
  return estimateTokens(parsed.system) + estimateTokens(parsed.tools);
}

export function messagesTokens(messages) {
  let n = 0;
  for (const m of messages) n += estimateTokens(m.content);
  return n;
}

export function bodyTokens(parsed) {
  return overheadTokens(parsed) + messagesTokens(parsed.messages || []);
}

// --- content-block helpers ------------------------------------------------------------
// content is a plain string (one text block) or an array of typed blocks. Normalize to array.
export function blocksOf(msg) {
  const c = msg && msg.content;
  if (typeof c === "string") return [{ type: "text", text: c }];
  return Array.isArray(c) ? c : [];
}

function hasBlockType(msg, type) {
  return blocksOf(msg).some((b) => b && b.type === type);
}

// A real user prompt = a user turn the human typed: role "user", carries text, and is NOT a
// tool_result continuation (a user message of only tool_result blocks is the answer to the
// assistant's tool call — cutting right before it would orphan the result). The only safe
// places to start a retained slice.
export function isRealUserPrompt(msg) {
  if (!msg || msg.role !== "user") return false;
  if (hasBlockType(msg, "tool_result")) return false;
  return hasBlockType(msg, "text");
}

// True when messages[i:] is tool-CLOSED: every tool_result in it references a tool_use also in
// it. A cut that leaves a tool_result whose tool_use was dropped is the dangling-pair API 400.
export function tailIsToolClosed(messages, i) {
  const produced = new Set();
  for (let j = i; j < messages.length; j++) {
    for (const b of blocksOf(messages[j])) if (b && b.type === "tool_use" && b.id) produced.add(b.id);
  }
  for (let j = i; j < messages.length; j++) {
    for (const b of blocksOf(messages[j])) {
      if (b && b.type === "tool_result" && b.tool_use_id && !produced.has(b.tool_use_id)) return false;
    }
  }
  return true;
}

// Indices where the head may be cut so the retained tail is a valid, self-contained request:
// a real user prompt AND tool-closed from there on. Index 0 qualifies iff it's a real prompt.
export function findCheckpoints(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    if (isRealUserPrompt(messages[i]) && tailIsToolClosed(messages, i)) out.push(i);
  }
  return out;
}

// Earliest checkpoint whose retained tail (overhead + messages[k:]) fits `budget` — keeps the
// LARGEST amount of recent context that still fits. Returns the chosen index, the deepest
// checkpoint if none fits (best effort), or null if there is no checkpoint.
export function chooseCut(messages, checkpoints, budget, overhead) {
  let last = null;
  for (const k of checkpoints) {
    last = k;
    if (overhead + messagesTokens(messages.slice(k)) <= budget) return k;
  }
  return last;
}

// Prepend a note as a leading text block on the first retained message (a user prompt, per
// findCheckpoints) — folding into an existing message sidesteps role-alternation and leaves
// tool pairing untouched. Returns a NEW messages array.
export function prependNote(messages, k, note) {
  const first = messages[k];
  const merged = { ...first, content: [{ type: "text", text: note }, ...blocksOf(first)] };
  return [merged, ...messages.slice(k + 1)];
}

const TRIM_MARKER = "[modelpipe — older turns dropped to fit the model's context window]";

// Mechanical trim to `budget` tokens: drop the head to the earliest checkpoint that fits,
// folding a short marker into the retained slice. Returns { messages, cut, applied }. Pure.
export function mechanicalTrim(messages, budget, overhead, marker = TRIM_MARKER) {
  const checkpoints = findCheckpoints(messages);
  if (checkpoints.length === 0) return { messages, cut: 0, applied: false };
  const k = chooseCut(messages, checkpoints, budget, overhead);
  if (k == null || k === 0) return { messages, cut: 0, applied: false };
  return { messages: prependNote(messages, k, marker), cut: k, applied: true };
}

// Last-resort floor: even the deepest checkpoint's tail overflows (one giant recent turn / a
// huge tool_result). Cap each block's text/content so the total lands under budget. Pure.
export function truncateOversizedBlocks(messages, budget, overhead) {
  const totalBlocks = messages.reduce((n, m) => n + blocksOf(m).length, 0) || 1;
  const perBlockChars = Math.max(200, Math.floor(((budget - overhead) * 4) / totalBlocks));
  const cap = (s) => (s.length > perBlockChars ? s.slice(0, perBlockChars) + " …[truncated by modelpipe]" : s);
  return messages.map((m) => ({
    ...m,
    content: blocksOf(m).map((b) => {
      if (!b || !b.type) return b;
      if (b.type === "text") return { ...b, text: cap(String(b.text || "")) };
      if (b.type === "tool_result") {
        const c = typeof b.content === "string" ? b.content : JSON.stringify(b.content || "");
        return { ...b, content: cap(c) };
      }
      return b;
    }),
  }));
}

// Fit a request body to `windowTokens`. No-op (trimmed:false) when it already fits — the normal
// path. On a genuine over-window request (the downshift edge case) drop the head to the newest
// stable checkpoint that fits; if a single recent turn still overflows, cap oversized blocks.
export function fitToWindow(parsed, windowTokens, safetyPct = 0.95) {
  const messages = parsed.messages || [];
  const overhead = overheadTokens(parsed);
  const budget = Math.floor(windowTokens * safetyPct);
  if (overhead + messagesTokens(messages) <= budget) return { parsed, trimmed: false, cut: 0 };

  const mt = mechanicalTrim(messages, budget, overhead);
  let newMessages = mt.messages;
  if (overhead + messagesTokens(newMessages) > budget) {
    newMessages = truncateOversizedBlocks(newMessages, budget, overhead);
  }
  return { parsed: { ...parsed, messages: newMessages }, trimmed: true, cut: mt.cut };
}

// --- reactive: classify a provider's context-overflow error -----------------------------
export function isContextOverflow(status, body) {
  if (status !== 400 && status !== 413) return false;
  let msg;
  try {
    const p = JSON.parse(body.toString("utf8"));
    msg = p && p.error && (p.error.message || p.error);
  } catch { return false; }
  if (typeof msg !== "string") return false;
  return /context[ _]length|context_length_exceeded|prompt is too long|maximum context|too many (?:input )?tokens|reduce the (?:length|number of tokens)|input (?:is )?too long|exceeds? (?:the )?(?:maximum |allowed )?context|context window/i.test(msg);
}

// Best-effort extract of the model's REAL max token limit from an overflow message, so the
// router can self-calibrate (e.g. "prompt is too long: 250000 tokens > 200000 maximum", or
// "maximum context length is 128000 tokens"). Returns an int or null.
export function parseOverflowLimit(body) {
  try {
    const p = JSON.parse(body.toString("utf8"));
    const m = p && p.error && (p.error.message || p.error);
    if (typeof m !== "string") return null;
    const mt = m.match(/(?:>\s*|maximum(?:\s+context(?:\s+length)?)?(?:\s+is)?\s*|context\s+(?:window|length)\s*(?:of|is)?\s*)(\d{4,})/i);
    return mt ? parseInt(mt[1], 10) : null;
  } catch { return null; }
}

// --- window resolution ----------------------------------------------------------------
// Context window (tokens) for a model id from `compact.window` (model glob → tokens), first
// match wins; falls back to `compact.windowDefault`.
export function resolveWindow(compact, model) {
  const map = compact.window || {};
  for (const [glob, tokens] of Object.entries(map)) {
    if (globMatch(glob, model)) return tokens;
  }
  return compact.windowDefault || 200000;
}

function globMatch(glob, s) {
  if (typeof s !== "string") return false;
  return new RegExp("^" + glob.split("*").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(s);
}

export const COMPACT_DEFAULTS = {
  enabled: true,
  safetyPct: 0.95,      // trim to this fraction of the window (headroom for the chars/4 estimate)
  windowDefault: 200000,
  window: {},
  maxOverflowRetries: 2, // reactive: hard-trim + retry this many times on a provider overflow
};
