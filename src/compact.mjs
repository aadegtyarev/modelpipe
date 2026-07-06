// modelpipe context compaction — keep a Claude Code session under its model's context
// window by replacing the OLDER part of the conversation with a model-generated summary
// once the request crosses a trigger threshold, splicing that summary in ahead of a
// verbatim recent tail. Claude Code re-sends the WHOLE history on every turn (the Messages
// API is stateless), so the proxy sees the full `messages` array each request and can act
// before forwarding — the one place a live, already-overflowed window can actually be
// shrunk (a harness hook can only append, never remove).
//
// Two layers, by design:
//   • PRIMARY (semantic): at `triggerPct` of the window, summarize the head via a summarizer
//     model into a compact checkpoint (~`summaryMaxPct`), cache it per session, and on every
//     later turn substitute the already-summarized head with the cached summary. The model
//     call happens only when (re)crossing the threshold — NOT every request — because the
//     cache is reused until the real history grows enough to re-cross it.
//   • SAFETY NET (mechanical): if the summarizer errors / is unavailable, OR the request is
//     already so large the summarizer input itself wouldn't fit, deterministically drop the
//     head to the newest STABLE CHECKPOINT that fits the budget. Never crash, never leave a
//     dangling tool_use/tool_result pair (that is an API 400).
//
// The pure helpers below are unit-tested; the async orchestrator `compactBody` takes its
// network (`summarize`) and persistence (`store`) as injected deps so it tests without a
// socket or disk.

// A Claude Code session id travels in a REQUEST HEADER, not the body — this is the cache key.
export const SESSION_HEADER = "x-claude-code-session-id";

const CHECKPOINT_HEADER =
  "[modelpipe — compressed context]\n" +
  "The earlier part of this session was summarized to stay within the context window. " +
  "Treat the summary below as established, authoritative state and continue from it; " +
  "the messages that follow are the recent turns kept verbatim.\n\n=== SESSION SUMMARY ===\n";
const CHECKPOINT_FOOTER = "\n=== END SUMMARY (recent turns follow verbatim) ===\n\n";

const MECH_MARKER =
  "[modelpipe — older turns dropped to fit the context window; no summary available. " +
  "Continue from the recent turns below.]";

// --- token estimate -------------------------------------------------------------------
// Deliberately cheap and dependency-free (modelpipe ships zero deps — no tiktoken). ~4
// chars/token over the serialized JSON is a rough OVER-estimate for text and a wild one for
// base64 images; that is fine because every budget here is set as a fraction of the window,
// well under the true limit, so over-counting only makes us compact slightly earlier.
export function estimateTokens(x) {
  if (x == null) return 0;
  const s = typeof x === "string" ? x : JSON.stringify(x);
  return Math.ceil(s.length / 4);
}

// system may be a string or an array of blocks; tools is an array of tool schemas. Both are
// FIXED overhead we never trim — they must be added to the messages estimate for the budget.
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
// A message's content is EITHER a plain string (shorthand for one text block) or an array of
// typed blocks (text / thinking / tool_use / tool_result / image). Normalize to an array.
export function blocksOf(msg) {
  const c = msg && msg.content;
  if (typeof c === "string") return [{ type: "text", text: c }];
  return Array.isArray(c) ? c : [];
}

function hasBlockType(msg, type) {
  return blocksOf(msg).some((b) => b && b.type === type);
}

// A real user prompt = a user turn the human typed: role "user", carries actual text, and is
// NOT a tool_result continuation (a user message made only of tool_result blocks is the
// answer to the assistant's tool call, i.e. mid-cycle — cutting right before it would orphan
// the result). These are the only safe places to start a retained slice.
export function isRealUserPrompt(msg) {
  if (!msg || msg.role !== "user") return false;
  if (hasBlockType(msg, "tool_result")) return false;
  return hasBlockType(msg, "text");
}

// True when the slice messages[i:] is tool-CLOSED: every tool_result in it references a
// tool_use that is also in it. A cut that leaves a tool_result whose tool_use was dropped
// produces the classic dangling-pair API 400. (A fresh user prompt implies this, but we
// verify defensively — a malformed/rewound transcript could violate it.)
export function tailIsToolClosed(messages, i) {
  const produced = new Set();
  for (let j = i; j < messages.length; j++) {
    for (const b of blocksOf(messages[j])) {
      if (b && b.type === "tool_use" && b.id) produced.add(b.id);
    }
  }
  for (let j = i; j < messages.length; j++) {
    for (const b of blocksOf(messages[j])) {
      if (b && b.type === "tool_result" && b.tool_use_id && !produced.has(b.tool_use_id)) {
        return false;
      }
    }
  }
  return true;
}

// Indices at which the head may be cut so the retained tail is a valid, self-contained
// Messages request: a real user prompt AND tool-closed from there on. Index 0 is always a
// candidate iff it qualifies (keeping everything). Ascending order.
export function findCheckpoints(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    if (isRealUserPrompt(messages[i]) && tailIsToolClosed(messages, i)) out.push(i);
  }
  return out;
}

// Pick the EARLIEST checkpoint whose retained tail (overhead + messages[k:]) fits `budget`.
// Earliest-that-fits keeps the LARGEST amount of recent context that still fits. Returns the
// chosen index, or the last checkpoint if none fits (best effort — caller may then need the
// block-level floor), or null if there is no checkpoint to cut at beyond 0.
export function chooseCut(messages, checkpoints, budget, overhead) {
  let last = null;
  for (const k of checkpoints) {
    last = k;
    if (overhead + messagesTokens(messages.slice(k)) <= budget) return k;
  }
  return last; // nothing fit — deepest cut we can make (or null if checkpoints was empty)
}

// Splice a summary into the retained slice: fold it as a leading text block on the first
// retained message (messages[k], which findCheckpoints guarantees is a user prompt). Folding
// into an existing message — rather than inserting a new one — sidesteps role-alternation
// concerns entirely and keeps tool pairing untouched. Returns a NEW messages array.
export function spliceSummary(messages, k, summaryText) {
  const first = messages[k];
  const merged = {
    ...first,
    content: [{ type: "text", text: CHECKPOINT_HEADER + summaryText + CHECKPOINT_FOOTER }, ...blocksOf(first)],
  };
  return [merged, ...messages.slice(k + 1)];
}

// Mechanical (no-model) trim to `budget`: drop the head to the earliest checkpoint that fits,
// folding a short marker into the retained slice so the model knows history was cut. If even
// the deepest checkpoint's tail overflows, we still return that slice (the caller sizes the
// summarizer/model budget conservatively, so this is the last-resort floor). Pure.
export function mechanicalTrim(messages, budget, overhead) {
  const checkpoints = findCheckpoints(messages);
  if (checkpoints.length === 0) return { messages, cut: 0, applied: false };
  const k = chooseCut(messages, checkpoints, budget, overhead);
  if (k == null || k === 0) return { messages, cut: 0, applied: false };
  return { messages: spliceSummary(messages, k, MECH_MARKER), cut: k, applied: true };
}

// A stable fingerprint of the head messages[0:count] — cheap, structural. Used to detect that
// a cached summary still matches the current prefix (a rewind/edit changes the prefix, so the
// summary is stale and must be regenerated). Not cryptographic; collision here only costs an
// occasional needless re-summarize.
export function headHash(messages, count) {
  let h = 5381;
  const upto = Math.min(count, messages.length);
  for (let i = 0; i < upto; i++) {
    const s = (messages[i].role || "") + ":" + estimateTokens(messages[i].content);
    for (let c = 0; c < s.length; c++) h = ((h << 5) + h + s.charCodeAt(c)) | 0;
  }
  return `${upto}:${h >>> 0}`;
}

// Resolve the context window (in tokens) for a model id from `compact.window`, a map of model
// globs → token counts. First matching glob wins; falls back to `compact.windowDefault`.
export function resolveWindow(compact, model) {
  const map = compact.window || {};
  for (const [glob, tokens] of Object.entries(map)) {
    if (globMatch(glob, model)) return tokens;
  }
  return compact.windowDefault || 200000;
}

// Minimal glob (only `*`), matching the router's own globToRegExp semantics closely enough
// for the window map. Kept local so compact.mjs has no import cycle with router.mjs.
function globMatch(glob, s) {
  if (typeof s !== "string") return false;
  const re = new RegExp("^" + glob.split("*").map(escapeRe).join(".*") + "$");
  return re.test(s);
}
function escapeRe(x) {
  return x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- orchestrator ---------------------------------------------------------------------
// Decide and apply compaction for one request. Pure control flow; all IO is via deps:
//   deps.summarize(headMessages, model, { maxTokens }) => Promise<string>   (may reject)
//   deps.store = { get(sid) => obj|null, set(sid, obj) => void }
//   deps.log(msg)                                                            (optional)
// Returns { messages, action } where action ∈ passthrough | reuse | summarized | mechanical.
// `messages` is the (possibly rewritten) array to forward; on passthrough it is the original.
export async function compactBody(parsed, headers, compact, model, deps) {
  const messages = parsed.messages || [];
  const overhead = overheadTokens(parsed);
  const window = resolveWindow(compact, model);
  const triggerTok = Math.floor(window * (compact.triggerPct ?? 0.7));
  const log = deps.log || (() => {});

  const total = overhead + messagesTokens(messages);
  if (total < triggerTok) return { messages, action: "passthrough" };

  const sid = headers[SESSION_HEADER] || null;
  const summaryMaxTok = Math.floor(window * (compact.summaryMaxPct ?? 0.08));
  // The verbatim recent tail we aim to keep: the target size minus the summary's share, so
  // summary (≤summaryMaxPct) + tail land around targetPct of the window. Floored at 1 token
  // so a degenerate config still cuts rather than divides by zero.
  const verbatimBudget = Math.max(
    1,
    Math.floor(window * ((compact.targetPct ?? 0.15) - (compact.summaryMaxPct ?? 0.08)))
  );

  // 1. REUSE a cached summary when the prefix still matches and reuse alone gets us under.
  const cached = sid ? deps.store.get(sid) : null;
  if (cached && cached.coveredCount <= messages.length &&
      headHash(messages, cached.coveredCount) === cached.headHash) {
    const spliced = spliceSummary(messages, cached.coveredCount, cached.summaryText);
    if (overhead + messagesTokens(spliced) < triggerTok) {
      log(`compact: reuse cached summary (sid ${sid.slice(0, 8)}, cut ${cached.coveredCount})`);
      return { messages: spliced, action: "reuse" };
    }
    // History grew past the trigger again even with the old summary — fall through and
    // re-summarize a deeper head below.
  }

  // 2. SUMMARIZE the head via the model, then splice.
  const checkpoints = findCheckpoints(messages);
  const k = chooseCut(messages, checkpoints, verbatimBudget, overhead);
  if (k == null || k === 0) {
    // No head to summarize (whole thing is one un-cuttable turn). Nothing semantic to do;
    // fall to the mechanical floor which will also no-op, then forward as-is.
    const mech = mechanicalTrim(messages, triggerTok, overhead);
    return { messages: mech.messages, action: mech.applied ? "mechanical" : "passthrough" };
  }

  let head = messages.slice(0, k);
  // If the head itself is bigger than the summarizer can take (already-overflowed load),
  // mechanically drop its oldest turns so the summarizer input fits triggerTok. The dropped-
  // oldest are lost, but this only happens in the emergency case and never crashes.
  if (overhead + messagesTokens(head) > triggerTok) {
    const hcp = findCheckpoints(head);
    const hk = chooseCut(head, hcp, triggerTok - overhead, overhead);
    if (hk && hk > 0) head = head.slice(hk);
  }

  try {
    const summaryText = await deps.summarize(head, model, { maxTokens: summaryMaxTok });
    if (!summaryText || !summaryText.trim()) throw new Error("empty summary");
    if (sid) deps.store.set(sid, { summaryText, coveredCount: k, headHash: headHash(messages, k) });
    log(`compact: summarized head[0:${k}] (${messages.length} msgs, ~${total} tok → ~${overhead + messagesTokens(messages.slice(k))} + summary)`);
    return { messages: spliceSummary(messages, k, summaryText), action: "summarized" };
  } catch (e) {
    // SAFETY NET: summarizer unavailable/failed → deterministic mechanical trim so the turn
    // still fits and never 400s on a dangling pair.
    log(`compact: summarizer failed (${e && e.message}); mechanical trim`);
    const mech = mechanicalTrim(messages, triggerTok, overhead);
    return { messages: mech.messages, action: mech.applied ? "mechanical" : "passthrough" };
  }
}

// The instruction handed to the summarizer model alongside the flattened head transcript.
// Kept model-neutral and language-agnostic (mirror the conversation's own language) so it
// works across DeepSeek/GLM/Claude backends.
export const SUMMARY_PROMPT =
  "You are compressing the EARLIER part of a coding session so it can be dropped from the " +
  "context window without losing anything needed to continue. Read the transcript below and " +
  "produce a dense, structured summary. Keep: the current goal, settled decisions and WHY, " +
  "state of the code (files/functions/classes changed or created), constraints and user " +
  "preferences, open next steps, and critical facts (paths, versions, exact errors). Drop: " +
  "small talk, abandoned attempts, superseded decisions. Be concrete — name files, symbols, " +
  "and error text. Do not invent anything not in the transcript. Write in the language the " +
  "conversation uses.";

// Flatten a slice of messages into one plain-text transcript for the summarizer: role-tagged
// lines, tool calls rendered as `[called Name(input…)]`, tool results and long text capped at
// `perBlockCap` chars. This deliberately DROPS the structured tool_use/tool_result blocks —
// the summarizer neither needs the full I/O nor the `tools` schema to capture the gist, and a
// text-only single turn sidesteps role-alternation and tool-pairing pitfalls in the sub-call.
export function flattenForSummary(messages, perBlockCap = 2000) {
  const cap = (s) => (s.length > perBlockCap ? s.slice(0, perBlockCap) + " …[truncated]" : s);
  const parts = [];
  for (const m of messages) {
    const segs = [];
    for (const b of blocksOf(m)) {
      if (!b || !b.type) continue;
      if (b.type === "text") segs.push(cap(String(b.text || "")));
      else if (b.type === "thinking") segs.push("[thinking] " + cap(String(b.thinking || "")));
      else if (b.type === "tool_use") segs.push(`[called ${b.name || "tool"}(${cap(JSON.stringify(b.input || {}))})]`);
      else if (b.type === "tool_result") {
        const c = typeof b.content === "string" ? b.content : JSON.stringify(b.content || "");
        segs.push(`[tool result: ${cap(c)}]`);
      } else if (b.type === "image") segs.push("[image]");
    }
    if (segs.length) parts.push(`${m.role}: ${segs.join(" ")}`);
  }
  return parts.join("\n\n");
}

// Default compaction config — enabled by default (per product decision). Merged over any
// user-supplied `compact` block by normalizeCompact.
export const COMPACT_DEFAULTS = {
  enabled: true,
  triggerPct: 0.7,
  targetPct: 0.15,
  summaryMaxPct: 0.08,
  windowDefault: 200000,
  window: {},
  summarizerModel: null, // null ⇒ use the session's own model
};
