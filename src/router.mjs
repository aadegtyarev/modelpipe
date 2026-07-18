// modelpipe — a passthrough Anthropic-format model router (first-party localhost
// reverse-proxy).
//
// WHAT IT IS: a reverse-proxy with model-based routing + a per-backend auth swap.
//   A client (any Anthropic-format client — the Anthropic SDK, Cline, Cursor's
//   Anthropic mode, Claude Code) is pointed at this router via ANTHROPIC_BASE_URL;
//   the router keys on the request body's `model` id and forwards to the matching
//   backend. The request body is passthrough (never transformed) and both ends speak
//   the Anthropic Messages API, so there is nothing to translate. The response is
//   mostly passthrough too — a 2xx / SSE streams straight back — with ONE reactive
//   hop: a specific "image not supported" 400 is buffered, classified, and the same
//   request is rerouted to the `forImages` vision target; any other 400 is relayed
//   verbatim. The reroute is the ONE scoped exception to passthrough: it rewrites the
//   body's `model` to the vision route's `forImagesModel`, because the reroute crosses
//   to a different provider whose model id differs from the client's (rewriteModelInBody).
//   A route may also be DECLARED non-vision (`vision: false`): an image-bearing request
//   for it is pre-routed to the `forImages` target WITHOUT trying the backend first —
//   reliable where the backend does not 400 on an image (a 200 soft-refusal, or its own
//   server-side image tool), which the reactive catch-400 hop cannot detect.
//
// SECURITY POSTURE (the threat surface this code owns):
//   • Backend keys come ONLY from env vars named by the route config — never
//     inline in the config, never logged.
//   • The incoming client auth header is STRIPPED before forwarding, so a seat's
//     front-key never reaches a backend and the wrong backend never sees a key
//     meant for another.
//   • FAIL-CLOSED: an unroutable request (no model, or a model no route matches,
//     or a route whose key env is unset) is a 4xx/5xx error — NEVER silently sent
//     to a default backend (sending traffic to the wrong provider, or forwarding
//     with no credential, is the worst failure).
//   • No secret / body / header logging. At most an opt-in (MODEL_ROUTER_LOG=1)
//     `model -> hostname` line to stderr — built from safe pieces only.
//   • Binds to localhost by default (config.listen.host).
//
// Run as a process:   node src/router.mjs <config.json>   (or the modelpipe CLI:
//   modelpipe <config.json> [--port N] — see bin/modelpipe.mjs)
//   (config shape + worked example: routes.example.json; provider catalog: providers.json)
// Importable:         createRouter / pickRoute / resolveAuthHeader / loadConfig …
//   are exported for the self-test (test/router.test.mjs).

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  StatsCollector, QuotaPoller, DASHBOARD_HTML,
  createUsageTracker, providerIdFromUrl,
  decompressIfNeeded, decompressBuffer,
} from "./stats.mjs";
import { readJson, writeJson, OVERRIDES_FILE } from "./store.mjs";
import {
  fitToWindow, resolveWindow, isContextOverflow, parseOverflowLimit, bodyTokens, COMPACT_DEFAULTS,
} from "./compact.mjs";
import { ConcurrencyLimiter, resolveConcurrencyLimit } from "./concurrency.mjs";
import {
  effectiveProfile, resolveAlias, intendedHead, stepIndex, defaultProfile,
  stepAdvancesOn, routingSummary,
} from "./profiles.mjs";

// Effective context window for a model = min(configured/glob window, anything learned from a
// prior overflow). `learned` is the per-model self-calibration map threaded through ctx.
function effectiveWindow(compact, learned, model) {
  const configured = resolveWindow(compact, model);
  const cap = learned && learned[model];
  return cap ? Math.min(configured, cap) : configured;
}

// Record a model's real window learned from an overflow error, persisting the map. Only ever
// lowers (the smallest observed ceiling wins). Best-effort — never throws.
function learnWindow(learned, model, tokens, log) {
  if (!learned || !model || !(tokens > 0)) return;
  if (learned[model] && learned[model] <= tokens) return;
  learned[model] = tokens;
  writeJson("compact-learned-windows.json", learned);
  if (log) log(`compact: learned window for ${model} <= ${tokens}`);
}

// Fit a request Buffer to `windowTokens`, returning a Buffer (original if it already fits or on
// any parse error — fail-open). `label` names the model for the log line.
function fitBufferToWindow(bodyBuf, windowTokens, safetyPct, label, log) {
  try {
    const parsed = JSON.parse(bodyBuf.toString("utf8"));
    if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) return bodyBuf;
    const { parsed: fitted, trimmed, cut } = fitToWindow(parsed, windowTokens, safetyPct);
    if (!trimmed) return bodyBuf;
    if (log) log(`compact: trim ${label} to window ${windowTokens} (dropped head[0:${cut}])`);
    return Buffer.from(JSON.stringify(fitted));
  } catch { return bodyBuf; }
}

const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MB — bound the per-request buffer
const MAX_FAILOVER_HOPS = 5; // chain-depth guard — at most 5 backup hops per request
// How long a request may wait in a full concurrency queue before it is treated as a 429
// from the backend (→ account rotation / model failover). Kept well under a typical client
// request timeout so the "wait, then failover" safety valve fires before the client gives up.
const DEFAULT_QUEUE_TIMEOUT_MS = 45000;
// How long a concurrency key's empirically-learned ceiling must stay quiet before it creeps
// back up by 1 toward the configured limit (ConcurrencyLimiter.recoverDue).
const DEFAULT_CONCURRENCY_RECOVERY_INTERVAL_MS = 30000;
// How often the background ticker checks every key for a recovery bump due (see
// ConcurrencyRecoveryTicker below) — independent of the interval itself, just the poll rate.
const CONCURRENCY_RECOVERY_POLL_MS = 5000;
// Chain-depth guard for the concurrency-requeue loop (report hit + retry through the SAME
// limiter key) — separate from MAX_FAILOVER_HOPS, which counts hops to a DIFFERENT target.
const MAX_CONCURRENCY_REQUEUE_ATTEMPTS = 3;

// A synthetic upstream response used when a concurrency-queue wait times out — there is no
// real backend response, but feeding a 429 into the normal response handler reuses the entire
// tested reroute cascade (account rotation → group/pair failover), and, when no failover is
// configured, relays a clean 429 to the client instead of a silent hang. It's an empty-bodied
// Readable carrying an Anthropic-shaped overloaded_error so both paths read cleanly.
function makeSyntheticLimitResponse() {
  const payload = Buffer.from(JSON.stringify({
    type: "error",
    error: { type: "overloaded_error", message: "modelpipe: backend concurrency limit reached and the request queue wait timed out" },
  }), "utf8");
  const r = Readable.from([payload]);
  r.statusCode = 429;
  r.headers = { "content-type": "application/json" };
  return r;
}

// Hop-specific headers the router always recomputes for the upstream — never
// forwarded verbatim.
const HOP_HEADERS = new Set(["host", "content-length"]);

// The client's own auth headers. STRIPPED on a normal (key-swap) route so a seat's
// front-key can't leak to a backend or reach the wrong provider; KEPT verbatim on a
// passthrough route (auth: "passthrough"), where forwarding the client's auth
// unchanged is the whole point (a subscription/OAuth session with no backend key).
const CLIENT_AUTH_HEADERS = new Set(["x-api-key", "authorization"]);

// A routing failure carrying the HTTP status the client should see.
class RouterError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Convert a simple glob (only the `*` wildcard) to an anchored RegExp. Every other
// regex metacharacter is escaped, so `claude-*` matches `claude-opus-4-8` but a
// dotted id is matched literally — no accidental wildcard from a `.` in the model.
export function globToRegExp(glob) {
  const escaped = String(glob).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

// A safe "who sent this" label for the dashboard trace: the client's user-agent product token
// (e.g. "claude-cli/1.0.83") plus a short, stable fingerprint of its auth token (6 hex of a
// sha256) so different sessions/keys/apps are distinguishable WITHOUT ever storing or logging
// the secret. Never includes the token itself. "unknown" when neither header is present.
export function clientLabel(headers) {
  if (!headers || typeof headers !== "object") return "unknown";
  const ua = String(headers["user-agent"] || "").trim().split(/\s+/)[0] || "";
  const auth = headers["authorization"] || headers["x-api-key"] || "";
  const key = auth ? crypto.createHash("sha256").update(String(auth)).digest("hex").slice(0, 6) : "";
  return [ua, key].filter(Boolean).join("·") || "unknown"; // ua·key
}

// The first route whose `match` glob matches the model id; null when the model is
// absent/empty or no route matches (the fail-closed signal the caller turns into a 4xx).
export function pickRoute(model, routes) {
  if (typeof model !== "string" || model.length === 0) return null;
  for (const route of routes) {
    if (globToRegExp(route.match).test(model)) return route;
  }
  return null;
}

// The single route flagged `forImages: true` — the vision fallback target — or null
// when none is configured. validateConfig guarantees at most one.
export function pickVisionRoute(routes) {
  return routes.find((route) => route.forImages === true) || null;
}

// The default/fallback route for requests that don't carry a routable model id
// (GET /v1/models, HEAD /, a misc count_tokens call, or any auxiliary endpoint).
// Prefers a passthrough route (the natural universal target — it forwards the
// client's own auth unchanged) then falls back to the first configured route.
export function findDefaultRoute(routes) {
  if (!Array.isArray(routes) || routes.length === 0) return null;
  const passthrough = routes.find(r => r.auth === "passthrough");
  return passthrough || routes[0];
}

// The `model` field of a JSON request body, or null when the body is empty, not
// JSON, or carries no string model — all fail-closed (the caller returns a 4xx).
export function modelFromBody(body) {
  if (!body || body.length === 0) return null;
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    return typeof parsed.model === "string" ? parsed.model : null;
  } catch {
    return null;
  }
}

// Rewrite the `model` field of a JSON request body to `newModel`, returning a NEW
// Buffer (the original is never mutated). Used ONLY on the vision-reroute hop: the
// reroute crosses to a different provider, so the client's model id (which that
// backend does not know) is replaced with the vision route's own `forImagesModel`.
// This is the single scoped exception to passthrough, on the hop that is already
// content-aware. Fail-safe: a falsy newModel or an unparseable body is returned
// unchanged (it would fail downstream regardless) — this never throws.
export function rewriteModelInBody(body, newModel) {
  if (!newModel || !body || body.length === 0) return body;
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    parsed.model = newModel;
    return Buffer.from(JSON.stringify(parsed), "utf8");
  } catch {
    return body;
  }
}

// Drop every `thinking` / `redacted_thinking` block from the request's message history.
// WHY: a strict, signature-validating backend (real Anthropic) rejects the WHOLE request with a
// 400 "Invalid `signature` in `thinking` block" when the transcript carries a thinking block whose
// signature it can't verify — e.g. one minted by a different provider's Anthropic-shim (z.ai/GLM,
// which returns thinking blocks with signatures that aren't real Anthropic signatures) and then
// replayed here after a model rewrite, or a block carried across a cross-provider profile hop. The
// signature can't be repaired: the Messages API rejects a MODIFIED thinking block just as it does an
// invalid one, and stripping only the `signature` field turns "invalid" into "missing". Omitting the
// whole block is the one edit the API accepts. Trade-off: the target model loses the prior reasoning
// trace for those turns — acceptable for a cross-provider router whose point is free model routing,
// which is exactly why this is OPT-IN per route (route.stripThinking) rather than always-on.
// A block whose removal would leave an assistant turn with EMPTY content is kept, so the strip never
// produces an invalid empty-content message. Fail-safe: returns the body unchanged on any parse miss
// or when nothing was stripped (no re-serialization). Pure — never throws.
export function stripThinkingBlocks(body) {
  if (!body || body.length === 0) return body;
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  if (!Array.isArray(parsed.messages)) return body;
  let changed = false;
  for (const msg of parsed.messages) {
    if (!msg || !Array.isArray(msg.content)) continue;
    const filtered = msg.content.filter(
      (b) => !(b && (b.type === "thinking" || b.type === "redacted_thinking")),
    );
    // Only apply if something was removed AND the turn keeps at least one block — dropping a
    // turn's last block would make an empty content array, itself a 400.
    if (filtered.length !== msg.content.length && filtered.length > 0) {
      msg.content = filtered;
      changed = true;
    }
  }
  if (!changed) return body;
  return Buffer.from(JSON.stringify(parsed), "utf8");
}

// Drop two distinct shapes of foreign tool-use bookkeeping a strict, schema-validating backend
// (real Anthropic) rejects outright when a transcript was minted by another provider's
// Anthropic-shim (z.ai/GLM) and replayed here after a cross-provider model rewrite or profile
// hop — same failure mode as the thinking-signature case (see stripThinkingBlocks):
//   1. `server_tool_use.id` not matching Anthropic's own `^srvtoolu_[a-zA-Z0-9_]+$` shape (its
//      bookkeeping for server-executed tools — web_search, code_execution, ...) → `400
//      messages.N.content.M.server_tool_use.id: String should match pattern '...'`.
//   2. A plain `tool_result` block (the CLIENT tool-result type — distinct from named
//      server-tool result types like `web_search_tool_result`, which legitimately live inline in
//      an assistant turn) sitting in a NON-`user` message → `400 messages.N: \`tool_result\`
//      blocks can only be in \`user\` messages`. Some providers' shims inline the whole
//      tool_use/tool_result round-trip into one assistant turn instead of Anthropic's two-message
//      dance.
// Neither can be repaired in place (we don't know what internal state Anthropic keys the id off
// of, and relocating a misplaced block would be reconstructing history we don't own), so the
// whole pair is dropped: whichever half is bad marks its id as poisoned, then EVERY block
// anywhere in the transcript referencing that id (tool_use/server_tool_use by `id`,
// tool_result/`*_tool_result` by `tool_use_id`) is removed together, else the surviving half
// dangles the way compact's tool-pairing guard exists to avoid. Only a block that actually
// violates one of the two rules marks its id — a genuine, correctly-placed Anthropic pair is left
// untouched. A turn whose only content is a dropped block is kept intact, so the strip never
// produces an empty content array. Fail-safe: returns the body unchanged on any parse miss or
// when nothing was stripped (no re-serialization). Pure — never throws.
const SERVER_TOOL_USE_ID_RE = /^srvtoolu_[a-zA-Z0-9_]+$/;

// Pass 1 shared by stripBadServerToolUseBlocks and rewriteBadServerToolUseBlocks: the set of
// tool_use ids a strict, schema-validating backend will reject — (1) a `server_tool_use` whose
// `id` isn't Anthropic's own `^srvtoolu_...` shape, and (2) a plain client `tool_result` sitting
// in a NON-`user` message (some providers' shims inline the whole tool_use/tool_result round-trip
// into one assistant turn). Either half of a poisoned pair marks its id.
function _poisonedToolUseIds(messages) {
  const ids = new Set();
  for (const msg of messages) {
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (!b) continue;
      if (b.type === "server_tool_use" && typeof b.id === "string" && !SERVER_TOOL_USE_ID_RE.test(b.id)) {
        ids.add(b.id);
      } else if (b.type === "tool_result" && msg.role !== "user" && typeof b.tool_use_id === "string") {
        ids.add(b.tool_use_id);
      }
    }
  }
  return ids;
}

export function stripBadServerToolUseBlocks(body) {
  if (!body || body.length === 0) return body;
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  if (!Array.isArray(parsed.messages)) return body;

  const poisonedIds = _poisonedToolUseIds(parsed.messages);
  if (poisonedIds.size === 0) return body;

  // Drop every block anywhere (either half of a poisoned pair) that references one.
  let changed = false;
  for (const msg of parsed.messages) {
    if (!msg || !Array.isArray(msg.content)) continue;
    const filtered = msg.content.filter((b) => {
      if (!b) return true;
      if ((b.type === "server_tool_use" || b.type === "tool_use") && poisonedIds.has(b.id)) return false;
      if ((b.type === "tool_result" || (typeof b.type === "string" && b.type.endsWith("_tool_result"))) &&
        poisonedIds.has(b.tool_use_id)) return false;
      return true;
    });
    if (filtered.length !== msg.content.length && filtered.length > 0) {
      msg.content = filtered;
      changed = true;
    }
  }
  if (!changed) return body;
  return Buffer.from(JSON.stringify(parsed), "utf8");
}

// Like stripBadServerToolUseBlocks, but instead of dropping a poisoned tool-use RESULT it rewrites
// the result into a plain `text` block — preserving what the tool returned for later turns, with a
// label saying how it was obtained. The `server_tool_use`/`tool_use` CALL block (the part whose id
// is bad and unrepairable) is still dropped; its name/input fold into the label. Bookkeeping the
// model has no use for (the provider's opaque `encrypted_content`, the foreign id) is discarded —
// only the result payload (titles, urls, snippets) survives, as readable text. A turn that would be
// left empty is kept intact (never produces an empty content array). Same fail-safes as strip:
// body unchanged on parse miss / no poisoned ids / nothing rewritten (no re-serialize). Pure.
function _renderToolResult(meta, block) {
  const name = (meta && meta.name) || (block.type === "web_search_tool_result" ? "web_search" : "tool");
  const query = meta && meta.input && typeof meta.input.query === "string" ? meta.input.query : null;
  const head = query ? `[${name} · server-side · query: "${query}"]` : `[${name} · server-side]`;
  let payload = "";
  const c = Array.isArray(block.content) ? block.content : null;
  if (c && c.length) {
    const lines = [];
    for (let i = 0; i < c.length; i++) {
      const it = c[i];
      if (!it || typeof it !== "object") { lines.push(`${i + 1}. ${String(it)}`); continue; }
      // A tool result can carry mixed content (z.ai/GLM image-reading tools, text snippets, …);
      // render each by what it IS, never dumping a raw base64/encrypted blob into history.
      if (it.type === "image") { lines.push(`${i + 1}. [image]`); continue; }
      if (it.type === "text" && typeof it.text === "string") { lines.push(`${i + 1}. ${it.text}`); continue; }
      const title = typeof it.title === "string" ? it.title : "";
      const url = typeof it.url === "string" ? it.url : "";
      // encrypted_content is the provider's opaque blob — drop it (bookkeeping, not signal).
      if (title && url) lines.push(`${i + 1}. ${title} — ${url}`);
      else if (title) lines.push(`${i + 1}. ${title}`);
      else if (url) lines.push(`${i + 1}. ${url}`);
      else lines.push(`${i + 1}. ${JSON.stringify(it).slice(0, 200)}`);
    }
    payload = lines.join("\n");
  } else if (typeof block.content === "string" && block.content.length) {
    payload = block.content;   // a misplaced client tool_result often carries a string content
  } else {
    payload = "(results not captured)";
  }
  return `${head}\n${payload}`;
}

export function rewriteBadServerToolUseBlocks(body) {
  if (!body || body.length === 0) return body;
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  if (!Array.isArray(parsed.messages)) return body;

  const poisonedIds = _poisonedToolUseIds(parsed.messages);
  if (poisonedIds.size === 0) return body;

  // meta[id] = {name, input} from the CALL block, so the rewritten result carries the query.
  const meta = Object.create(null);
  for (const msg of parsed.messages) {
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (!b) continue;
      if ((b.type === "server_tool_use" || b.type === "tool_use") && typeof b.id === "string" && poisonedIds.has(b.id)) {
        meta[b.id] = { name: b.name, input: b.input };
      }
    }
  }

  let changed = false;
  for (const msg of parsed.messages) {
    if (!msg || !Array.isArray(msg.content)) continue;
    const mapped = [];
    let msgChanged = false;
    for (const b of msg.content) {
      if (!b) { mapped.push(b); continue; }
      // Drop the CALL half — bad id, unrepairable.
      if ((b.type === "server_tool_use" || b.type === "tool_use") && typeof b.id === "string" && poisonedIds.has(b.id)) {
        msgChanged = true;
        continue;
      }
      // Rewrite the RESULT half into a labelled text block (1:1, schema-safe).
      const isResult =
        (b.type === "tool_result" || (typeof b.type === "string" && b.type.endsWith("_tool_result"))) &&
        typeof b.tool_use_id === "string" && poisonedIds.has(b.tool_use_id);
      if (isResult) {
        mapped.push({ type: "text", text: _renderToolResult(meta[b.tool_use_id], b) });
        msgChanged = true;
        continue;
      }
      mapped.push(b);
    }
    // Commit only if the turn still has content — never produce an empty content array (a 400).
    if (msgChanged && mapped.length > 0) {
      msg.content = mapped;
      changed = true;
    }
  }
  if (!changed) return body;
  return Buffer.from(JSON.stringify(parsed), "utf8");
}

// True when the request body carries an image content block — the Messages API
// shape is a `messages[].content[]` block whose `type` is "image" (verified against
// the Anthropic Messages API, the only format this router speaks). Used ONLY by the
// pre-route optimisation to skip a known-failing first call — never to transform the
// payload. Fail-safe to false on any parse miss (a non-detected image just falls back
// to the reactive path).
export function bodyHasImageBlock(body) {
  if (!body || body.length === 0) return false;
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (!Array.isArray(parsed.messages)) return false;
    for (const msg of parsed.messages) {
      const content = msg && msg.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block && block.type === "image") return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// True when the CURRENT turn carries an image — an image block in a message AFTER the
// last `assistant` reply (or anywhere, on the first turn before any assistant message).
// This is what decides a vision reroute: an image the model has NOT yet answered needs a
// vision backend, whereas an image buried in earlier history has already been "processed"
// (see stripImageBlocks). Distinct from bodyHasImageBlock, which is true for an image
// ANYWHERE — the whole-history scan that made the reroute sticky for the life of the image.
// Fail-safe to false on any parse miss.
export function currentTurnHasImage(body) {
  if (!body || body.length === 0) return false;
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (!Array.isArray(parsed.messages)) return false;
    let lastAssistant = -1;
    for (let i = 0; i < parsed.messages.length; i++) {
      if (parsed.messages[i] && parsed.messages[i].role === "assistant") lastAssistant = i;
    }
    for (let i = lastAssistant + 1; i < parsed.messages.length; i++) {
      const content = parsed.messages[i] && parsed.messages[i].content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block && block.type === "image") return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// Replace every image content block with a short text placeholder, returning a NEW Buffer
// (the original is never mutated); returns the body UNCHANGED when there is nothing to strip
// or on any parse miss. This is the second scoped exception to passthrough (alongside
// rewriteModelInBody), applied ONLY when dispatching to a backend that cannot see images
// (a `vision: false` route, or one learned non-vision): the image bytes are useless to that
// backend, and leaving them in would force every follow-up turn onto the vision target for
// the whole life of the image. Only reached for HISTORICAL images (a current-turn image
// pre-routes to the vision backend before this runs), so the model has already answered them.
export function stripImageBlocks(body) {
  if (!body || body.length === 0) return body;
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (!Array.isArray(parsed.messages)) return body;
    let stripped = 0;
    for (const msg of parsed.messages) {
      if (!msg || !Array.isArray(msg.content)) continue;
      msg.content = msg.content.map((block) => {
        if (block && block.type === "image") { stripped++; return { type: "text", text: "[image omitted]" }; }
        return block;
      });
    }
    if (stripped === 0) return body;
    return Buffer.from(JSON.stringify(parsed), "utf8");
  } catch {
    return body;
  }
}

// True only for the SPECIFIC image-unsupported 400 signal: status 400 AND the JSON
// error message mentions an image together with a support/block word (e.g. a backend's
// "does not support image blocks"). Deliberately narrow — an ambiguous 400 (e.g.
// "messages: roles must alternate") does NOT match, so a real bad request is relayed
// as-is and never rerouted. Fail-safe to false on any parse miss.
export function isImageUnsupported400(status, body) {
  if (status !== 400) return false;
  let message;
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    message = parsed && parsed.error && parsed.error.message;
  } catch {
    return false;
  }
  if (typeof message !== "string") return false;
  return /image/i.test(message) && /(support|block)/i.test(message);
}

// True when an upstream error is a retryable signal — rate-limit, overload, or
// account/org issue — that warrants failing over to a backup model.
// 429/529 are always triggers (unambiguous rate-limit / overload).
// Other 4xx/5xx trigger only when the body mentions a recognisable keyword:
// rate-limit, overload, capacity, account/credit/org issues.
// An ambiguous error (e.g. "messages: roles must alternate") does NOT match,
// so a real bad request is relayed as-is. Fail-safe to false on any parse miss.
export function isFailoverTrigger(status, body) {
  if (status === 429 || status === 529) return true;
  // Only classify 400-599 (exclude 2xx/3xx, and very unusual 1xx).
  if (status < 400 || status >= 600) return false;
  // An EMPTY body SPECIFICALLY on a 400 is itself the anomaly: the Messages API always returns
  // a structured { error: { message } } on a genuine rejection, so a zero-byte 400 looks like an
  // HTTP/network-level break (a dropped/reset connection, a gateway hiccup) rather than a real
  // validation error — treat it the same as a 429/529 instead of relaying an opaque, silent
  // error to the client. Scoped to 400 only: a 5xx with no body stays ambiguous (a generic
  // gateway/proxy error unrelated to any specific API contract) and needs a real keyword match.
  if (status === 400 && (!body || body.length === 0)) return true;
  let message;
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    message = parsed && parsed.error && parsed.error.message;
  } catch {
    return false;
  }
  if (typeof message !== "string") return false;
  return /(rate\s*limit|temporarily\s*unavailable|overloaded|try\s*again\s*later|cannot\s*process|capacity|credit\s*balance|organization\s*(is\s*)?disabled|account\s*(is\s*)?disabled|payment\s*required|quota\s*exceeded)/i.test(message);
}

// A HARD, long-duration exhaustion — a weekly/monthly plan quota, a disabled org/account, or
// payment required — is a failover trigger (isFailoverTrigger) but NOT worth retrying in
// place: an identical retry is guaranteed to fail again (the backend won't recover until a
// reset date, sometimes days away) and only burns the retry budget / delays the ACTUAL fix
// (account rotation or a profile step). Only meaningful once isFailoverTrigger is already true.
// A plain rate-limit/overload/capacity blip, a bare 5xx, or our own concurrency-queue-timeout
// synthetic 429 (see makeSyntheticLimitResponse) all remain retry-worthy — those ARE transient.
const HARD_EXHAUSTION_RE = /weekly|monthly|credit\s*balance|organization\s*(is\s*)?disabled|account\s*(is\s*)?disabled|payment\s*required|quota\s*exceeded/i;
export function isRetryWorthy(status, body) {
  if (status >= 500 && status < 600) return true; // a plain server error is transient by nature
  // 429/529/400 all only reach here after isFailoverTrigger already matched a keyword (or,
  // for 429/529, matched unconditionally) — retry-worthy unless the message signals a HARD,
  // long-duration exhaustion.
  let message;
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    message = parsed && parsed.error && parsed.error.message;
  } catch {
    return true; // unparseable body — assume transient
  }
  if (typeof message !== "string") return true;
  return !HARD_EXHAUSTION_RE.test(message);
}

// Some backends (observed on z.ai) put an explicit reset timestamp in a HARD-exhaustion
// message ("...limit will reset at 2026-07-16 07:17:46..."). It's the only authoritative
// signal we have for how long a hard exhaustion actually lasts, so the caller parks the
// account directly against it (sanity-capped — see MAX_HARD_PARK_MS at the call site — in
// case of a malformed or absurd timestamp). Returns ms-until-reset (>0) when a timestamp is
// found and still in the future, else null (caller falls back to the sanity cap).
export function parseHardExhaustionResetMs(body, nowMs) {
  let message;
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    message = parsed && parsed.error && parsed.error.message;
  } catch {
    return null;
  }
  if (typeof message !== "string") return null;
  const m = /reset\s*(?:at)?\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/i.exec(message);
  if (!m) return null;
  const resetMs = Date.parse(`${m[1].replace(" ", "T")}Z`);
  if (!Number.isFinite(resetMs)) return null;
  const delta = resetMs - nowMs;
  return delta > 0 ? delta : null;
}

// Persist the runtime profile state ({ pinned, offset, shiftedAt, attempts }) under
// ~/.modelpipe/profile-state.json. Best-effort — never throws. Called after a shift /
// wind-back / pin change so a restart resumes where it left off.
function persistProfileState(state) {
  try { writeJson("profile-state.json", state); } catch { /* best-effort */ }
}

// ── Time-window helpers (fixed UTC offset) ────────────────────────────────────
// Small pure helpers for wall-clock windows, evaluated against the system clock via the
// UTC epoch so they are correct no matter the host timezone. Profile scheduling (see
// profiles.mjs, which carries its own copies to stay cycle-free) uses the same shapes.

// Pure: parse a fixed UTC offset ("+08:00" | "+08" | "-0530" | "Z" | "UTC" | "") into
// minutes east of UTC. null when malformed. Empty / "Z" / "UTC" ⇒ 0.
export function parseTzOffset(tz) {
  if (tz == null || tz === "" || tz === "Z" || tz === "UTC") return 0;
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(String(tz));
  if (!m) return null;
  const hh = Number(m[2]);
  const mm = Number(m[3] || 0);
  if (hh > 23 || mm > 59) return null;
  return (m[1] === "-" ? -1 : 1) * (hh * 60 + mm);
}

// Pure: parse "H:MM" / "HH:MM" into minute-of-day (0..1439); null when malformed.
export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

// Pure: is minute-of-day `minute` inside [from, to)? A window with from > to wraps past
// midnight (e.g. 22:00→02:00). from === to is an empty window (never active).
export function inWindow(minute, from, to) {
  if (from === to) return false;
  return from < to ? (minute >= from && minute < to) : (minute >= from || minute < to);
}

// True when a route forwards the client's incoming auth header unchanged instead of
// swapping in a backend key (auth: "passthrough"). Lets a subscription/OAuth Claude
// Code session use the Anthropic/default route with NO backend API key.
export function isPassthrough(route) {
  return route && route.auth === "passthrough";
}

// True for a key-swap route that opts into fallback auth (auth.fallback === true):
// forward the client's OWN auth header when it sent one, otherwise inject the backend key.
// "Use the token that flies if present, else the one the proxy holds." Lets Claude Code
// pass its own Anthropic token through while the proxy's key covers clients that send none.
export function isFallbackAuth(route) {
  return !!(route && route.auth && typeof route.auth === "object" && route.auth.fallback === true);
}

// True when the incoming request already carries a non-empty client auth header
// (x-api-key or authorization) — i.e. the client "flew" its own token.
export function clientHasAuth(headers) {
  for (const name of CLIENT_AUTH_HEADERS) {
    const v = headers && headers[name];
    if (typeof v === "string" && v.length > 0) return true;
  }
  return false;
}

// ── Account pools (multiple accounts per route, rotate on limit) ───────────────
// A route may carry an `accounts` pool — several backends for the SAME model, each with
// its own key (and optionally its own base_url), identified by a `label`. When the active
// account hits a rate-limit / quota error, the router rotates to the next eligible account
// (same model, no body rewrite) and parks the exhausted one for a cooldown; it becomes
// eligible again once the cooldown elapses. `strategy` picks the order:
//   • "failover" (default) — always prefer the lowest-index eligible account (drain #1,
//     move to #2 on limit, snap back to #1 when it recovers).
//   • "round-robin" — spread requests across eligible accounts (stretch total quota).
// This is backend/key-level rotation, distinct from failover pairs/groups (model-id level).

// Pure: choose an account index from a pool given the current time. `excludeIdx` skips the
// just-failed account during a rotation. Returns the chosen index, or -1 only when the
// pool has no account other than the excluded one. When at least one account is eligible
// (cooldown elapsed) it returns an ELIGIBLE one; when none are eligible it returns the
// least-recently-exhausted non-excluded account (a best-effort last try). For round-robin
// it advances `pool.rr` to the returned index.
export function pickAccountIndex(pool, now, excludeIdx = -1) {
  const accts = pool.accounts;
  const n = accts.length;
  const eligible = [];
  for (let i = 0; i < n; i++) {
    if (i === excludeIdx) continue;
    if ((accts[i].exhaustedUntil || 0) <= now) eligible.push(i);
  }
  if (eligible.length === 0) {
    // No eligible account — return the least-recently-exhausted non-excluded one, or -1.
    let best = -1, bestUntil = Infinity;
    for (let i = 0; i < n; i++) {
      if (i === excludeIdx) continue;
      const u = accts[i].exhaustedUntil || 0;
      if (u < bestUntil) { bestUntil = u; best = i; }
    }
    return best;
  }
  if (pool.strategy === "round-robin") {
    for (let step = 1; step <= n; step++) {
      const cand = (pool.rr + step) % n;
      if (eligible.includes(cand)) { pool.rr = cand; return cand; }
    }
  }
  return eligible[0]; // failover: lowest-index eligible (prefers primary order)
}

// True when the given account index is genuinely eligible right now (cooldown elapsed) —
// used to decide whether a rotation has a live account to move to, vs the pool being spent.
export function accountEligible(pool, idx, now) {
  return idx >= 0 && (pool.accounts[idx].exhaustedUntil || 0) <= now;
}

// Resolve a route's backend auth header from the environment. Returns
// { name, value }; throws a 500 RouterError when the named env var is unset/empty
// — fail-closed: the router never forwards a request without the backend's own key.
// `scheme` (optional, e.g. "Bearer") is prepended: `Authorization: Bearer <key>`;
// absent ⇒ the raw key is the value (e.g. `x-api-key: <key>`).
// Not called for a passthrough route (which carries no backend key) — see isPassthrough.
export function resolveAuthHeader(route, env = process.env) {
  const { header, keyEnv, scheme } = route.auth;
  const key = env[keyEnv];
  if (typeof key !== "string" || key.length === 0) {
    throw new RouterError(500, `routing backend key env ${keyEnv} is not set`);
  }
  return { name: header, value: scheme ? `${scheme} ${key}` : key };
}

// Validate the config SHAPE at load/start time (fail-closed before serving). Does
// not touch env — keys are read per-request so the process can be started before
// the keys are exported.
// Validate one auth spec (a route's or an account's): "passthrough" OR a key-swap object
// { header, keyEnv, scheme?, fallback? }. Throws on any problem. `at` prefixes the message.
function validateAuth(auth, at) {
  if (auth === "passthrough") return;
  if (!auth || typeof auth !== "object") throw new Error(`${at}.auth: missing (object or "passthrough")`);
  if (typeof auth.header !== "string" || auth.header.length === 0) throw new Error(`${at}.auth.header: missing`);
  if (typeof auth.keyEnv !== "string" || auth.keyEnv.length === 0) throw new Error(`${at}.auth.keyEnv: missing`);
  if (auth.fallback !== undefined && typeof auth.fallback !== "boolean") throw new Error(`${at}.auth.fallback: must be a boolean when present`);
}

// Validate + normalize the `compact` context-compaction block, filling defaults (compaction
// is ON by default). Used both for the config file and the dashboard POST path, so the two
// can never diverge. Returns a fully-populated, safe object. Throws on a bad type/range.
export function validateCompact(compact, prefix = "config.compact") {
  if (compact !== undefined && (typeof compact !== "object" || compact === null || Array.isArray(compact))) {
    throw new Error(`${prefix}: must be an object when present`);
  }
  const c = { ...COMPACT_DEFAULTS, ...(compact && typeof compact === "object" ? compact : {}) };
  if (typeof c.enabled !== "boolean") throw new Error(`${prefix}.enabled: must be a boolean`);
  if (typeof c.safetyPct !== "number" || !(c.safetyPct > 0) || c.safetyPct > 1) throw new Error(`${prefix}.safetyPct: must be a number in (0,1]`);
  if (typeof c.windowDefault !== "number" || c.windowDefault <= 0) throw new Error(`${prefix}.windowDefault: must be a positive number of tokens`);
  if (!Number.isInteger(c.maxOverflowRetries) || c.maxOverflowRetries < 0) throw new Error(`${prefix}.maxOverflowRetries: must be a non-negative integer`);
  if (c.window === undefined || c.window === null) c.window = {};
  if (typeof c.window !== "object" || Array.isArray(c.window)) throw new Error(`${prefix}.window: must be an object { modelGlob: tokens }`);
  for (const [glob, tok] of Object.entries(c.window)) {
    if (typeof tok !== "number" || tok <= 0) throw new Error(`${prefix}.window["${glob}"]: must be a positive number of tokens`);
    try { globToRegExp(glob); } catch (e) { throw new Error(`${prefix}.window: key "${glob}" is not a valid glob: ${e.message}`); }
  }
  return c;
}

export function validateConfig(config) {
  if (!config || typeof config !== "object") throw new Error("config: not an object");
  if (config.compact !== undefined) validateCompact(config.compact);
  if (!Array.isArray(config.routes) || config.routes.length === 0) {
    throw new Error("config.routes: must be a non-empty array");
  }
  let visionCount = 0;
  for (const [i, route] of config.routes.entries()) {
    const at = `config.routes[${i}]`;
    if (typeof route.match !== "string" || route.match.length === 0) throw new Error(`${at}.match: missing`);
    if (typeof route.base_url !== "string") throw new Error(`${at}.base_url: missing`);
    try {
      new URL(route.base_url);
    } catch {
      throw new Error(`${at}.base_url: not a valid URL`);
    }
    // forImages flags the vision fallback target — the route a 400-image reroute
    // lands on. Optional; when present it must be exactly true, and at most one route
    // may carry it (a second is ambiguous about which backend is the vision target).
    if (route.forImages !== undefined) {
      if (route.forImages !== true) throw new Error(`${at}.forImages: must be true when present`);
      visionCount++;
      // The vision target rewrites the rerouted request's `model` to this id (the one
      // scoped exception to passthrough — the reroute crosses to a different provider
      // whose model id differs from the client's). REQUIRED, fail-closed: a vision route
      // with no model id would forward the client's id to a backend that does not know
      // it — a guaranteed runtime 400 — so the omission is caught here at startup.
      if (typeof route.forImagesModel !== "string" || route.forImagesModel.length === 0) {
        throw new Error(`${at}.forImagesModel: required non-empty model id on the forImages route`);
      }
    } else if (route.forImagesModel !== undefined) {
      throw new Error(`${at}.forImagesModel: only valid on the forImages route (needs forImages: true)`);
    }
    // vision: OPTIONAL boolean, default true. false ⇒ this route's backend has no vision,
    // so an image-bearing request is routed straight to the forImages target (forward()),
    // never sent to this backend first — reliable where the backend does not 400 on an
    // image (a 200 soft-refusal or a server-side image tool). Must be a boolean when present.
    if (route.vision !== undefined && typeof route.vision !== "boolean") {
      throw new Error(`${at}.vision: must be a boolean (default true) when present`);
    }
    // billing: OPTIONAL "metered" | "subscription". Governs how the dashboard reports
    // money for this backend. "metered" = pay-as-you-go (real per-token $ shown, e.g.
    // DeepSeek/OpenRouter). "subscription" = a flat plan (GLM Coding Plan, an Anthropic
    // subscription) where per-token $ is meaningless — the dashboard shows tokens + a
    // "flat plan" label, never a fabricated cost. Default: a passthrough route is
    // "subscription" (it rides the client's own plan/OAuth), a key-swap route is "metered".
    if (route.billing !== undefined && route.billing !== "metered" && route.billing !== "subscription") {
      throw new Error(`${at}.billing: must be "metered" or "subscription" when present`);
    }
    // accounts: OPTIONAL pool of backends for the SAME model, each { label, auth, base_url? }.
    // Rotates on a rate-limit; see the account-pool helpers above. When present, the route's
    // top-level `auth` is OPTIONAL (each account carries its own).
    if (route.accounts !== undefined) {
      if (!Array.isArray(route.accounts) || route.accounts.length === 0) {
        throw new Error(`${at}.accounts: must be a non-empty array of { label, auth, base_url? }`);
      }
      const labels = new Set();
      for (const [j, acc] of route.accounts.entries()) {
        const aat = `${at}.accounts[${j}]`;
        if (!acc || typeof acc !== "object") throw new Error(`${aat}: must be an object { label, auth, base_url? }`);
        if (typeof acc.label !== "string" || acc.label.length === 0) throw new Error(`${aat}.label: missing`);
        if (labels.has(acc.label)) throw new Error(`${aat}.label: duplicate label "${acc.label}" in the pool`);
        labels.add(acc.label);
        if (acc.base_url !== undefined) {
          try { new URL(acc.base_url); } catch { throw new Error(`${aat}.base_url: not a valid URL`); }
        }
        validateAuth(acc.auth, aat);
      }
    }
    // strategy: OPTIONAL "failover" (default) | "round-robin"; only meaningful with a pool.
    if (route.strategy !== undefined) {
      if (route.accounts === undefined) throw new Error(`${at}.strategy: only valid together with an accounts pool`);
      if (route.strategy !== "failover" && route.strategy !== "round-robin") {
        throw new Error(`${at}.strategy: must be "failover" or "round-robin" (default "failover")`);
      }
    }
    // auth: REQUIRED unless an accounts pool supplies per-account auth. When present it is
    // "passthrough" OR a key-swap object { header, keyEnv, scheme?, fallback? }.
    if (route.accounts === undefined || route.auth !== undefined) {
      validateAuth(route.auth, at);
    }
  }
  if (visionCount > 1) throw new Error("config.routes: at most one route may set forImages: true (the vision fallback target)");

  // dashboard: optional boolean (default false). When true, modelpipe collects
  // per-provider usage stats (tokens, requests, RPS), polls real provider billing APIs,
  // and serves /v1/stats, /v1/quotas, and /dashboard endpoints.
  if (config.dashboard !== undefined && config.dashboard !== true && config.dashboard !== false) {
    throw new Error("config.dashboard: must be a boolean (default false) when present");
  }
  // dropProcessedImages: optional boolean (default true). When true, an image that has
  // already been answered (not in the current turn) is stripped to a text placeholder before
  // a non-vision backend sees it, so a historical image no longer pins every follow-up turn
  // to the vision target. Set false to keep the old behaviour (any image → vision target).
  if (config.dropProcessedImages !== undefined && config.dropProcessedImages !== true && config.dropProcessedImages !== false) {
    throw new Error("config.dropProcessedImages: must be a boolean (default true) when present");
  }
  // tokenPrices: optional per-model API price overrides ($ per 1M tokens).
  // E.g. { "claude-opus-*": { input: 15, output: 75 }, "glm-5.2": { input: 1.2, output: 4.0, cacheRead: 0.26 } }.
  // cacheRead is optional (price for cache_read_input_tokens); falls back to the input
  // rate when omitted. Model keys can use * globs. Falls back to built-in PRICE_MAP.
  if (config.tokenPrices !== undefined) {
    if (typeof config.tokenPrices !== "object") throw new Error("config.tokenPrices: must be an object { model: { input, output, cacheRead? } }");
    for (const [key, p] of Object.entries(config.tokenPrices)) {
      if (!p || typeof p.input !== "number" || typeof p.output !== "number" || (p.cacheRead !== undefined && typeof p.cacheRead !== "number")) {
        throw new Error(`config.tokenPrices.${key}: must be { input: number, output: number, cacheRead?: number }`);
      }
    }
  }
  // LEGACY REJECTION: failover / failoverGroups / schedules were replaced by `profiles`
  // + `auto` (see docs/profiles.md). Fail closed with a clear pointer so a stale config
  // never silently loses its routing behaviour.
  for (const legacy of ["failover", "failoverGroups", "schedules"]) {
    if (config[legacy] !== undefined) {
      throw new Error(`config.${legacy}: removed — migrate to profiles (see docs/profiles.md; run \`modelpipe migrate\`)`);
    }
  }
  // profiles: optional object of named worlds { name: { bind: { aliasGlob: targetModelId } } }.
  // bind maps an alias glob (`*` only) to a concrete target model id (must resolve to a route).
  if (config.profiles !== undefined) {
    if (!config.profiles || typeof config.profiles !== "object" || Array.isArray(config.profiles)) {
      throw new Error("config.profiles: must be an object { name: { bind: { aliasGlob: targetModelId } } }");
    }
    for (const [name, prof] of Object.entries(config.profiles)) {
      const at = `config.profiles["${name}"]`;
      if (!name.length) throw new Error("config.profiles: a profile name must be a non-empty string");
      if (!prof || typeof prof !== "object" || Array.isArray(prof)) throw new Error(`${at}: must be an object { bind }`);
      const bind = prof.bind === undefined ? {} : prof.bind;
      if (typeof bind !== "object" || bind === null || Array.isArray(bind)) throw new Error(`${at}.bind: must be an object { aliasGlob: targetModelId }`);
      for (const [alias, target] of Object.entries(bind)) {
        if (typeof alias !== "string" || alias.length === 0) throw new Error(`${at}.bind: alias key must be a non-empty glob`);
        if (typeof target !== "string" || target.length === 0) throw new Error(`${at}.bind["${alias}"]: target must be a non-empty model id`);
        try { globToRegExp(alias); } catch (e) { throw new Error(`${at}.bind: alias "${alias}" is not a valid glob: ${e.message}`); }
      }
      // Shadowing guard: resolveAlias is first-match, so an EARLIER glob that already matches a
      // LATER alias key makes the later binding unreachable — a silent footgun. Reject it (order
      // specific aliases before broad globs). Only a glob can shadow; literal keys are unique.
      const aliasKeys = Object.keys(bind);
      for (let bi = 1; bi < aliasKeys.length; bi++) {
        for (let bj = 0; bj < bi; bj++) {
          if (aliasKeys[bj].includes("*") && globToRegExp(aliasKeys[bj]).test(aliasKeys[bi])) {
            throw new Error(`${at}.bind: "${aliasKeys[bi]}" is unreachable — the earlier glob "${aliasKeys[bj]}" already matches it (order specific aliases before broad globs)`);
          }
        }
      }
      // notes: OPTIONAL per-binding comments { aliasGlob: string } — display-only (the resolver
      // reads only `bind`), surfaced in the dashboard editor next to each pair.
      if (prof.notes !== undefined) {
        if (typeof prof.notes !== "object" || prof.notes === null || Array.isArray(prof.notes)) throw new Error(`${at}.notes: must be an object { aliasGlob: string }`);
        for (const [k, v] of Object.entries(prof.notes)) {
          if (typeof v !== "string") throw new Error(`${at}.notes["${k}"]: must be a string`);
        }
      }
    }
  }
  // auto: optional { steps: [{ profile, when? }], recover?, schedules?: [{ profile, tz, windows }] }.
  // steps is the ordered auto-failover ladder (steps[0] is the head; each later step's `when` is
  // the error class that steps down to it — "limit" (default) or "5xx"). Every profile named by a
  // step, a schedule, or defaultProfile must be a declared profile.
  const profileNames = config.profiles ? new Set(Object.keys(config.profiles)) : new Set();
  const knownProfile = (n) => profileNames.has(n);
  if (config.auto !== undefined) {
    if (!config.auto || typeof config.auto !== "object" || Array.isArray(config.auto)) {
      throw new Error("config.auto: must be an object { steps, recover?, schedules? }");
    }
    if (config.auto.steps !== undefined) {
      if (!Array.isArray(config.auto.steps) || config.auto.steps.length === 0) throw new Error("config.auto.steps: must be a non-empty array of { profile, when? }");
      for (const [i, step] of config.auto.steps.entries()) {
        const at = `config.auto.steps[${i}]`;
        if (!step || typeof step !== "object") throw new Error(`${at}: must be an object { profile, when? }`);
        if (typeof step.profile !== "string" || !knownProfile(step.profile)) throw new Error(`${at}.profile: must name a declared profile (got "${step.profile}")`);
        if (i === 0 && step.when !== undefined) throw new Error(`${at}.when: the head step (index 0) is entered by default, not by an error — remove its "when"`);
        if (i > 0 && step.when !== undefined && step.when !== "limit" && step.when !== "5xx") throw new Error(`${at}.when: must be "limit" or "5xx" when present`);
      }
    }
    if (config.auto.recover !== undefined && typeof config.auto.recover !== "boolean") throw new Error("config.auto.recover: must be a boolean when present");
    if (config.auto.schedules !== undefined) {
      if (!Array.isArray(config.auto.schedules)) throw new Error("config.auto.schedules: must be an array of { profile, tz, windows }");
      for (const [i, s] of config.auto.schedules.entries()) {
        const at = `config.auto.schedules[${i}]`;
        if (!s || typeof s !== "object") throw new Error(`${at}: must be an object { profile, tz, windows }`);
        if (typeof s.profile !== "string" || !knownProfile(s.profile)) throw new Error(`${at}.profile: must name a declared profile (got "${s.profile}")`);
        if (parseTzOffset(s.tz) == null) throw new Error(`${at}.tz: must be a fixed UTC offset like "+08:00" (or "Z")`);
        if (!Array.isArray(s.windows) || s.windows.length === 0) throw new Error(`${at}.windows: must be a non-empty array of ["HH:MM","HH:MM"] pairs`);
        for (const [j, w] of s.windows.entries()) {
          if (!Array.isArray(w) || w.length !== 2 || parseHHMM(w[0]) == null || parseHHMM(w[1]) == null) throw new Error(`${at}.windows[${j}]: must be ["HH:MM","HH:MM"] with valid 24h times`);
        }
      }
    }
    // retry: OPTIONAL { attempts, delayMs } — before spending a failover hop (account
    // rotation / profile step), retry the IDENTICAL request against the SAME target this
    // many times. attempts: 0 (default) = today's immediate-failover behaviour, no retry.
    if (config.auto.retry !== undefined) {
      const r = config.auto.retry;
      if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error("config.auto.retry: must be an object { attempts, delayMs? }");
      if (!Number.isInteger(r.attempts) || r.attempts < 0) throw new Error("config.auto.retry.attempts: must be a non-negative integer");
      if (r.delayMs !== undefined && (typeof r.delayMs !== "number" || r.delayMs < 0)) throw new Error("config.auto.retry.delayMs: must be a non-negative number of ms when present");
    }
  }
  // defaultProfile: optional; when set it must name a declared profile.
  if (config.defaultProfile !== undefined) {
    if (typeof config.defaultProfile !== "string" || !knownProfile(config.defaultProfile)) {
      throw new Error(`config.defaultProfile: must name a declared profile (got "${config.defaultProfile}")`);
    }
  }
  // failoverRecoveryIntervalMs: optional number, default 60000. Min time between
  // recovery pings to a failed-over primary. Must be >= 1000.
  if (config.failoverRecoveryIntervalMs !== undefined) {
    if (typeof config.failoverRecoveryIntervalMs !== "number" || config.failoverRecoveryIntervalMs < 1000) {
      throw new Error("config.failoverRecoveryIntervalMs: must be a number >= 1000");
    }
  }
  // failoverRecoveryBackoffMs: optional array of increasing probe intervals, e.g.
  // [60000, 300000, 600000] = probe a still-down primary after 1 min, then 5, then 10,
  // capping at the last — so we back off instead of hammering. When set it overrides the
  // flat failoverRecoveryIntervalMs for the recovery cadence.
  if (config.failoverRecoveryBackoffMs !== undefined) {
    const bo = config.failoverRecoveryBackoffMs;
    if (!Array.isArray(bo) || bo.length === 0) {
      throw new Error("config.failoverRecoveryBackoffMs: must be a non-empty array of intervals (ms)");
    }
    for (const [i, v] of bo.entries()) {
      if (typeof v !== "number" || v < 1000) throw new Error(`config.failoverRecoveryBackoffMs[${i}]: must be a number >= 1000`);
    }
  }
  // concurrency: optional object mapping model globs to a max number of SIMULTANEOUS in-flight
  // requests against that (provider, model). E.g. { "glm-5.2": 3, "glm-*": 8 }. First match
  // wins, so order specific ids before broad globs. An unmatched model is unlimited. The limit
  // is per account/key (a pool of 2 accounts carries 2× the limit). See concurrency.mjs.
  if (config.concurrency !== undefined) {
    if (!config.concurrency || typeof config.concurrency !== "object" || Array.isArray(config.concurrency)) {
      throw new Error("config.concurrency: must be an object { modelGlob: maxConcurrent }");
    }
    for (const [glob, limit] of Object.entries(config.concurrency)) {
      if (typeof glob !== "string" || glob.length === 0) throw new Error(`config.concurrency: key "${glob}" must be a non-empty model glob`);
      if (!Number.isInteger(limit) || limit < 1) throw new Error(`config.concurrency["${glob}"]: must be a positive integer (max simultaneous requests)`);
      try { globToRegExp(glob); } catch (e) { throw new Error(`config.concurrency: key "${glob}" is not a valid glob: ${e.message}`); }
    }
  }
  // concurrencyQueueTimeoutMs: optional number, default 45000. How long a request may wait in a
  // full concurrency queue before it is treated as a backend 429 (→ account rotation / model
  // failover). Must be >= 1000 to keep it above the network noise floor.
  if (config.concurrencyQueueTimeoutMs !== undefined) {
    if (typeof config.concurrencyQueueTimeoutMs !== "number" || config.concurrencyQueueTimeoutMs < 1000) {
      throw new Error("config.concurrencyQueueTimeoutMs: must be a number >= 1000");
    }
  }
  // concurrencyRecoveryIntervalMs: optional number, default 30000. How long a (provider,model)
  // key's empirically-learned concurrency ceiling (see ConcurrencyLimiter.reportLimitHit) must
  // stay quiet — no further rate-limit hit — before it creeps back up by 1 toward the
  // configured limit. Must be >= 1000.
  if (config.concurrencyRecoveryIntervalMs !== undefined) {
    if (typeof config.concurrencyRecoveryIntervalMs !== "number" || config.concurrencyRecoveryIntervalMs < 1000) {
      throw new Error("config.concurrencyRecoveryIntervalMs: must be a number >= 1000");
    }
  }

  return config;
}

// Load + validate a config file.
export function loadConfig(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return validateConfig(config);
}

// Build a SAFE JSON summary of the route table for discovery (the `--list` CLI mode,
// so a client setup dialog can read what a modelpipe is configured for instead of
// re-asking). PURE: reads only the parsed config object, NEVER process.env and NEVER a
// backend — no secret value is ever in scope.
//
// SAFE-SURFACE (whitelist, fail-closed by construction): each field is copied in by
// name, so an unexpected future config field cannot leak through. Per route we expose
// only the model glob (`match`), the backend origin (`base_url`), the capability flags
// (forImages / forImagesModel / vision, when present), and an auth VIEW:
//   • "passthrough" verbatim — it carries no secret (the client's own auth is forwarded).
//   • the key-swap object as { header, scheme?, keyEnv } — the env-var NAME only.
// `keyEnv` is the NAME of the env var holding the key, never the key VALUE: the config
// by design holds env-var names (SECURITY POSTURE above), so the name is config data,
// not a secret. The top-level `proxyUrl` is surfaced only when present.
//
// Does NOT call validateConfig: an empty/no-routes config yields a well-formed empty
// list (the discovery contract is "summarise whatever is configured", not "serve it").
export function listConfig(config) {
  const safe = {};
  if (config && config.proxyUrl !== undefined) safe.proxyUrl = config.proxyUrl;
  const routes = (config && Array.isArray(config.routes)) ? config.routes : [];
  safe.routes = routes.map((route) => {
    const out = { match: route.match, base_url: route.base_url };
    if (route.auth === "passthrough") {
      out.auth = "passthrough";
    } else if (route.auth && typeof route.auth === "object") {
      const authView = { header: route.auth.header };
      if (route.auth.scheme !== undefined) authView.scheme = route.auth.scheme;
      authView.keyEnv = route.auth.keyEnv; // the env-var NAME, never a key value
      if (route.auth.fallback === true) authView.fallback = true;
      out.auth = authView;
    }
    if (route.forImages !== undefined) out.forImages = route.forImages;
    if (route.forImagesModel !== undefined) out.forImagesModel = route.forImagesModel;
    if (route.vision !== undefined) out.vision = route.vision;
    if (route.billing !== undefined) out.billing = route.billing;
    // Account pool (safe view): label + optional base_url + the auth VIEW (env-var NAME
    // only, never a key value) — same whitelist as the route auth above.
    if (Array.isArray(route.accounts)) {
      if (route.strategy !== undefined) out.strategy = route.strategy;
      out.accounts = route.accounts.map((acc) => {
        const av = { label: acc.label };
        if (acc.base_url !== undefined) av.base_url = acc.base_url;
        if (acc.auth === "passthrough") {
          av.auth = "passthrough";
        } else if (acc.auth && typeof acc.auth === "object") {
          const aa = { header: acc.auth.header };
          if (acc.auth.scheme !== undefined) aa.scheme = acc.auth.scheme;
          aa.keyEnv = acc.auth.keyEnv; // NAME only
          if (acc.auth.fallback === true) aa.fallback = true;
          av.auth = aa;
        }
        return av;
      });
    }
    return out;
  });
  // profiles / auto / defaultProfile carry model ids, globs, and wall-clock windows — no
  // secrets, safe to surface for discovery.
  if (config && config.profiles !== undefined) safe.profiles = config.profiles;
  if (config && config.auto !== undefined) safe.auto = config.auto;
  if (config && config.defaultProfile !== undefined) safe.defaultProfile = config.defaultProfile;
  return safe;
}

// The effective billing mode for a route: explicit `billing` wins, else derived.
// - passthrough rides the client's own plan/OAuth → subscription.
// - the z.ai GLM Anthropic endpoint is the Coding Plan (a flat subscription, NOT pay-as-
//   you-go — that's z.ai's separate OpenAI-format API), so default it to subscription;
//   otherwise a Coding-Plan user would see a fabricated per-token $ (the fantik we removed).
// - every other key-swap route is metered (pay-as-you-go).
export function routeBilling(route) {
  if (route && (route.billing === "metered" || route.billing === "subscription")) return route.billing;
  if (isPassthrough(route)) return "subscription";
  if (route && providerIdFromUrl(route.base_url) === "glm") return "subscription";
  return "metered";
}

// The NETWORK-FACING view of the route table for GET /v1/models — a STRICTER projection
// of listConfig (the operator-facing `--list`/CLI view). listConfig is localhost/operator
// scope and exposes the key env-var NAME + the full base_url + the auth header/scheme;
// this HTTP endpoint is reachable by ANY client pointed at the router, so it drops all of
// that and exposes ONLY: the match glob (as `id`), the backend `host` (hostname[:port],
// never the base path), the auth MODE ("passthrough" | "key" — never the env name or
// header), and the vision flags. NEVER a key value, NEVER the key env-var name — the
// stricter surface a network endpoint demands. Built on listConfig so there is one source
// of truth for "what is configured"; this is its safe-for-network projection. PURE: reads
// only the parsed config, no process.env, no backend.
export function listModels(config) {
  return listConfig(config).routes.map((r) => {
    let host = null;
    try { host = new URL(r.base_url).host; } catch { /* bad base_url → leave null */ }
    const entry = {
      id: r.match,                                       // the match glob, e.g. "deepseek-*"
      object: "model",
      host,                                              // backend host — no path, no key
      auth: r.auth === "passthrough" ? "passthrough" : "key",  // mode only, never the env name
      provider: providerIdFromUrl(r.base_url),           // server-computed id — one source of truth with stats
      vision: r.vision !== false,                        // vision-capable unless explicitly opted out
      for_images: r.forImages === true,                  // the forImages vision-fallback flag
      billing: routeBilling(r),                          // "metered" | "subscription" — how the dashboard reports $
    };
    // Account pool: expose each account's LABEL (the stats provider id), its host, and its
    // billing — so the dashboard maps $ per account without re-deriving anything.
    if (Array.isArray(r.accounts)) {
      entry.strategy = r.strategy || "failover";
      entry.accounts = r.accounts.map((acc) => {
        let ahost = host;
        try { if (acc.base_url) ahost = new URL(acc.base_url).host; } catch { /* keep route host */ }
        // Per-account billing: explicit route billing wins, else derive from the account auth.
        const billing = r.billing || (acc.auth === "passthrough" ? "subscription" : "metered");
        return { label: acc.label, host: ahost, billing };
      });
    }
    return entry;
  });
}

// The opt-in stderr logger: a no-op unless MODEL_ROUTER_LOG=1. Logs only the
// caller-supplied line (which is always model -> hostname) — never a key, body, or header.
function defaultLogger(env = process.env) {
  if (env.MODEL_ROUTER_LOG === "1") {
    return (line) => process.stderr.write(`[model-router] ${line}\n`);
  }
  return () => {};
}

// Join the backend base path with the client's request path. base "/" collapses
// (anthropic: https://api.anthropic.com → "/v1/messages"); a real base path is
// kept (deepseek: https://api.deepseek.com/anthropic → "/anthropic/v1/messages").
function joinPath(basePath, requestUrl) {
  return basePath.replace(/\/+$/, "") + requestUrl;
}

// Copy the client's headers minus the hop set, and point `host` at the backend.
// keepClientAuth=false (the key-swap default) also drops the client's auth headers;
// keepClientAuth=true (passthrough) forwards them unchanged.
function sanitizeHeaders(incoming, upstreamHost, { keepClientAuth = false } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    const lower = k.toLowerCase();
    if (HOP_HEADERS.has(lower)) continue;
    if (!keepClientAuth && CLIENT_AUTH_HEADERS.has(lower)) continue;
    out[k] = v;
  }
  out.host = upstreamHost;
  return out;
}

// Send a JSON error in the Anthropic error shape, once (no-op if streaming began).
function sendError(res, status, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const type = status >= 500 ? "api_error" : "invalid_request_error";
  const payload = JSON.stringify({ type: "error", error: { type, message } });
  // `connection: close` so an error reply mid-upload (e.g. a 413 with the client
  // still sending body) is delivered cleanly and the socket is not reused with an
  // unconsumed request body.
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(payload);
}

// Read the full request body into a buffer, bounded by maxBytes (over ⇒ 413).
// On overflow it rejects but does NOT destroy the socket: the caller's catch sends
// a clean 413 (sendError closes the connection). Destroying here would tear down the
// response socket too, turning the 413 into a connection reset the client can't read.
// Further data after overflow is ignored (the `aborted` guard) so memory stays bounded.
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBytes) {
        aborted = true;
        reject(new RouterError(413, "request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { if (!aborted) resolve(Buffer.concat(chunks)); });
    req.on("error", (err) => { if (!aborted) reject(err); });
  });
}

// A 400 error body is small JSON — bound the buffer we read to classify it, so a
// pathological upstream can't make us hold an unbounded error response in memory.
const REROUTE_BUFFER_CAP = 64 * 1024;

// Stream an upstream response straight back to the client — SSE/chunked passthrough.
// A success (2xx) and every non-reroutable status take this path: nothing is buffered.
// When `ctx` is provided (dashboard enabled), the SSE stream is intercepted by a
// zero-buffer Transform that extracts usage (input/output tokens) for stats recording,
// and ratelimit headers are captured.
function pipeResponse(upstreamRes, res, ctx = null) {
  const onUpstreamFail = () => {
    if (ctx && ctx.stats) {
      ctx.stats.record({ providerId: ctx.providerId, model: ctx.model, clientModel: ctx.clientModel, client: ctx.client, durationMs: Date.now() - ctx.startTime, inputTokens: 0, outputTokens: 0, status: 502 });
    }
    if (res.headersSent) res.destroy();
    else sendError(res, 502, "upstream response error");
  };
  upstreamRes.on("error", onUpstreamFail);
  upstreamRes.on("aborted", onUpstreamFail);

  // Capture ratelimit headers for Anthropic
  if (ctx && ctx.stats && ctx.providerId) {
    ctx.stats.recordRatelimitHeaders(ctx.providerId, upstreamRes.headers);
  }

  if (ctx && ctx.stats && upstreamRes.statusCode < 400) {
    const { stream, headers, decompressed } = decompressIfNeeded(upstreamRes);
    const tracker = createUsageTracker(ctx.stats, {
      providerId: ctx.providerId,
      model: ctx.model,
      clientModel: ctx.clientModel,
      client: ctx.client,
      startTime: ctx.startTime,
    });
    res.writeHead(upstreamRes.statusCode || 502, headers);
    stream.pipe(tracker).pipe(res);
  } else {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  }
}

// Read a (small) upstream response fully into a buffer, bounded by `cap`. Only used
// for a 400, to classify it before deciding reroute-vs-relay. cb(err, buffer, headers).
function bufferResponse(upstreamRes, cap, cb) {
  const chunks = [];
  let size = 0;
  let done = false;
  const finish = (err) => { if (!done) { done = true; cb(err, Buffer.concat(chunks), upstreamRes.headers); } };
  upstreamRes.on("data", (c) => {
    if (done) return;
    size += c.length;
    if (size > cap) { finish(new Error("error response too large to buffer")); return; }
    chunks.push(c);
  });
  upstreamRes.on("end", () => finish(null));
  upstreamRes.on("error", () => finish(new Error("upstream error")));
  upstreamRes.on("aborted", () => finish(new Error("upstream aborted")));
}

// Relay a buffered (already-read) error response verbatim. Drops the upstream's
// content-length / transfer-encoding so Node recomputes them for the exact bytes we
// re-send; keeps content-type and the status.
function relayBuffered(res, status, upstreamHeaders, buffered) {
  const headers = {};
  for (const [k, v] of Object.entries(upstreamHeaders)) {
    const lower = k.toLowerCase();
    if (lower === "content-length" || lower === "transfer-encoding") continue;
    headers[k] = v;
  }
  res.writeHead(status, headers);
  res.end(buffered);
}

// Send the buffered request to one backend route and hand its response to `onResponse`
// (or stream it straight back when none is given). Pure routing + per-backend auth
// swap — the body buffer is never transformed (passthrough; image bytes untouched).
// `statsCtx` (optional): { stats, startTime } — when dashboard is enabled, carries the
// stats collector and request start time for usage tracking.
async function proxyToRoute(route, req, res, body, log, { onResponse, statsCtx, providerId: optProviderId, limiter, concLimit, queueTimeoutMs } = {}) {
  const passthrough = isPassthrough(route);
  // Fallback auth: if the client flew its own token, forward it (like passthrough);
  // otherwise inject the proxy's backend key (like key-swap). "The one that flies wins,
  // else the one the proxy holds."
  const fallbackClientAuth = isFallbackAuth(route) && clientHasAuth(req.headers);
  const keepClientAuth = passthrough || fallbackClientAuth;
  let auth = null;
  if (!keepClientAuth) {
    try {
      auth = resolveAuthHeader(route);
    } catch (err) {
      if (statsCtx && statsCtx.stats) {
        statsCtx.stats.record({
          providerId: optProviderId || providerIdFromUrl(route.base_url),
          model: modelFromBody(body),
          durationMs: Date.now() - statsCtx.startTime,
          inputTokens: 0, outputTokens: 0, status: err.status || 500,
        });
      }
      sendError(res, err.status || 500, err.message);
      return;
    }
  }

  const upstream = new URL(route.base_url);
  log(`${modelFromBody(body)} -> ${upstream.host}`);

  // Passthrough (or fallback with a client token present) keeps the client's auth header;
  // key-swap drops it and sets the backend's.
  const headers = sanitizeHeaders(req.headers, upstream.host, { keepClientAuth });
  if (auth) headers[auth.name] = auth.value;
  if (body.length) headers["content-length"] = String(body.length);

  // A dropped/aborted client connection must not crash the process or leave the
  // upstream hanging.
  res.on("error", () => {});

  const providerId = optProviderId || providerIdFromUrl(route.base_url);
  const model = modelFromBody(body);

  // CONCURRENCY GATE: when this (providerId, model) has a configured limit, hold the request
  // in a FIFO queue until a slot frees rather than firing it and risking a limit-429. release
  // is idempotent and wired onto every terminal event below, so a slot is freed exactly once
  // no matter how the exchange ends (stream complete, buffered-for-reroute, error, or client
  // disconnect). Unlimited models get a no-op release and skip all of this.
  let release = null;
  if (limiter && concLimit > 0 && concLimit !== Infinity) {
    const key = `${providerId}\u0000${model}`;
    try {
      release = await limiter.acquire(key, concLimit, queueTimeoutMs || 0);
    } catch (e) {
      // Queue wait timed out (or any acquire failure) — no slot was taken. Treat it as a 429
      // from this backend so the normal cascade (account rotation → model failover) runs; with
      // no failover configured this relays a clean 429 to the client instead of hanging.
      log(`concurrency: ${model} @ ${providerId} queue wait timed out (limit ${concLimit}) — treating as 429`);
      if (onResponse) onResponse(makeSyntheticLimitResponse());
      else sendError(res, 503, "backend concurrency limit reached; request queue wait timed out");
      return;
    }
    // The client may have disconnected while we were queued — don't open an upstream call
    // nobody is waiting for; just free the slot.
    if (res.writableEnded || res.destroyed) { release(); return; }
  }

  const client = upstream.protocol === "http:" ? http : https;
  const upstreamReq = client.request(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === "http:" ? 80 : 443),
      path: joinPath(upstream.pathname, req.url),
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      if (release) {
        // The provider counts the request in flight until IT finishes sending the response
        // (streamed SSE runs to 'end'); release then. 'close'/'aborted'/'error' are backstops.
        // Registered BEFORE the handler runs so the slot is freed before any same-key reroute
        // (e.g. an overflow hard-trim retry) tries to re-acquire it.
        upstreamRes.on("end", release);
        upstreamRes.on("close", release);
        upstreamRes.on("aborted", release);
        upstreamRes.on("error", release);
      }
      (onResponse || ((r) => pipeResponse(r, res, statsCtx
        ? { stats: statsCtx.stats, providerId, model, startTime: statsCtx.startTime }
        : null)))(upstreamRes);
    },
  );
  // Backstop: a client disconnect (or normal response completion) frees the slot even if the
  // upstream never emits a terminal event.
  if (release) res.on("close", release);
  upstreamReq.on("error", () => {
    if (release) release();
    if (statsCtx && statsCtx.stats) {
      statsCtx.stats.record({ providerId, model, durationMs: Date.now() - statsCtx.startTime, inputTokens: 0, outputTokens: 0, status: 502 });
    }
    sendError(res, 502, "upstream request failed");
  });
  if (body.length) upstreamReq.write(body);
  upstreamReq.end();
}

function capReason(s) {
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

// Best-effort short human-readable reason from a provider's error body — surfaced on the
// dashboard trace so a red row says WHY, not just a status code. Tries the shape Anthropic (and
// most others) use ({"type":"error","error":{"type":"rate_limit_error","message":"..."}}) first;
// when the body doesn't parse as JSON, or parses but carries no `error.message`/`error.type`/
// `message` field (e.g. a gateway/edge 429 in front of the real API, or a plain-text body), falls
// back to the RAW body text (whitespace-collapsed to one line) rather than surfacing nothing —
// an ugly reason beats a bare status code on the dashboard. Never throws; capped length so a
// pathological body can't bloat the timeline. undefined only when the body is empty or, after
// collapsing, blank.
export function errorReason(buffered) {
  if (!buffered || !buffered.length) return undefined;
  const raw = buffered.toString("utf8");
  try {
    const parsed = JSON.parse(raw);
    const err = parsed && parsed.error;
    const msg = (err && (err.message || err.type)) || parsed.message;
    if (typeof msg === "string" && msg) return capReason(msg);
  } catch { /* fall through to the raw-body fallback below */ }
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat ? capReason(flat) : undefined;
}

// Record a zero-token error/relay stat for the tier a ctx is currently on. No-op when
// the dashboard is off. Carries client/clientModel too, so an error row keeps the same
// "sent → routed [provider]" trace as a successful one instead of a bare orphan row —
// and an optional short human-readable reason (see errorReason) for the dashboard tooltip.
function recordStat(ctx, status, message) {
  if (ctx.statsCtx && ctx.statsCtx.stats) {
    ctx.statsCtx.stats.record({
      providerId: ctx.providerId, model: ctx.model,
      clientModel: ctx.clientModel, client: ctx.client,
      durationMs: Date.now() - ctx.statsCtx.startTime,
      inputTokens: 0, outputTokens: 0, status,
      ...(message ? { errorMessage: message } : {}),
    });
  }
}

// Classify a failover-triggering error into the profile-step condition it satisfies:
// "limit" (rate-limit / quota / overload — 429/529 or a limit-ish message) or "5xx"
// (a plain server error). Consulted against a step's `when` by stepAdvancesOn.
function errorClassOf(status) {
  if (status === 429 || status === 529) return "limit";
  if (status >= 500 && status < 600) return "5xx";
  return "limit"; // a keyword-matched 4xx (quota/credit/payment) is a limit condition
}

// Handle a failover-triggering error by stepping the PROFILE ladder (called once the
// route's account pool, if any, is exhausted). "Safety always armed": a live manual pin is
// cleared so the resolver falls back to schedule/default, then the cascade walks auto.steps
// down. The shared offset only advances when THIS request was riding the current effective
// step (guards concurrent double-advance) and the next step's `when` matches the error.
// THIS request is then re-dispatched on the (possibly new) active profile's binding.
function handleProfileFailover(ctx, status, buffered, headers, hop) {
  const ps = ctx.profileState;
  const config = ctx.config;
  const relay = () => {
    ctx.log(`profile: no further step for ${ctx.model} (status ${status}) — relaying error`);
    recordStat(ctx, status, errorReason(buffered));
    relayBuffered(ctx.res, status, headers, buffered);
  };
  // The profile ladder (if any) has nothing further to offer this request (no profiles
  // configured, or — checked again further down — the active profile resolves to the same
  // failing model). This route's account pool, if any, already declared itself fully exhausted
  // to get here (see the ACCOUNT ROTATION block in makeResponseHandler). That "no eligible
  // account" read is a snapshot at ONE hop's failure time; with several concurrent requests in
  // flight, another hop can park/un-park an account between that snapshot and now. Rather than
  // relay a raw upstream error while the pool's picture may already be stale, force ONE
  // last-resort attempt on the least-recently-parked OTHER account, ignoring its cooldown, before
  // truly giving up. Capped at ONE last-resort hop per client request (ctx.lastResortTried) — a
  // pool that is genuinely, entirely dead (e.g. both accounts hard-exhausted for real) must not
  // ping-pong between its accounts hop after hop; it gets exactly one extra roll of the dice,
  // then relays honestly like before.
  const giveUpOrLastResort = () => {
    if (!ctx.lastResortTried && ctx.account && ctx.route && ctx.accountPools) {
      const pool = ctx.accountPools.get(ctx.route);
      const now = Date.now();
      const lastResortIdx = pool ? pickAccountIndex(pool, now, ctx.account.idx) : -1;
      if (pool && lastResortIdx >= 0 && lastResortIdx !== ctx.account.idx) {
        const acct = pool.accounts[lastResortIdx];
        recordStat(ctx, status, errorReason(buffered));
        ctx.log(`account: ${ctx.model} ${ctx.account.label} -> ${acct.label} (status ${status}, hop ${hop + 1}, last resort — profile has nowhere else to go)`);
        const effRoute = { ...ctx.route, auth: acct.auth, base_url: acct.base_url || ctx.route.base_url };
        proxyToRoute(effRoute, ctx.req, ctx.res, ctx.body, ctx.log, {
          onResponse: makeResponseHandler({
            ...ctx,
            providerId: acct.label,
            account: { idx: lastResortIdx, label: acct.label, lastResort: true },
            failoverHopCount: hop + 1,
            lastResortTried: true,
            profileProbe: null,
            retryCount: 0,
            climitCount: 0,
          }),
          statsCtx: ctx.statsCtx,
          providerId: acct.label,
          limiter: ctx.limiter,
          concLimit: resolveConcurrencyLimit(ctx.config && ctx.config.concurrency, ctx.model),
          queueTimeoutMs: queueTimeoutOf(ctx.config),
        });
        return;
      }
    }
    relay();
  };
  if (!ps || !config.profiles) { giveUpOrLastResort(); return; }

  const errorClass = errorClassOf(status);
  if (ps.pinned) {
    ctx.log(`profile: failover under manual pin "${ps.pinned}" — clearing pin (safety armed)`);
    ps.pinned = null;
    persistProfileState(ps);
  }
  const now = Date.now();
  const intended = intendedHead(config, ps, now);
  const basePos = stepIndex(config, intended);
  const steps = (config.auto && Array.isArray(config.auto.steps)) ? config.auto.steps : [];
  const last = steps.length - 1;
  const curEff = basePos < 0 ? -1 : Math.min(basePos + (ps.offset || 0), last);
  if (curEff >= 0 && ctx.profileEffIndex === curEff && curEff < last && stepAdvancesOn(config, curEff, errorClass)) {
    ps.offset = (curEff + 1) - basePos;
    ps.shiftedAt = now; ps.attempts = 0;
    persistProfileState(ps);
    ctx.log(`profile: step "${steps[curEff].profile}" failing (status ${status}) — shift offset -> ${ps.offset} (now "${steps[curEff + 1].profile}")`);
  }

  // Re-dispatch THIS request on the (possibly new) active profile.
  const eff2 = effectiveProfile(config, ps, now);
  const targetModel = resolveAlias(config, eff2.active, ctx.clientModel);
  const targetRoute = targetModel ? pickRoute(targetModel, config.routes) : null;
  if (!targetRoute || targetModel === ctx.model) {
    // Nothing further to try (no route, or the active profile resolves to the same failing
    // model) — see giveUpOrLastResort above for why this isn't an immediate relay.
    giveUpOrLastResort();
    return;
  }
  recordStat(ctx, status); // record the original error on the failing tier
  ctx.log(`profile: ${ctx.model} -> ${targetModel} (status ${status}, retrying, hop ${hop + 1})`);
  const nextBody = rewriteModelInBody(ctx.body, targetModel);
  dispatch(targetRoute, nextBody, ctx, {
    model: targetModel,
    isVisionTarget: targetRoute === ctx.visionRoute,
    failoverHopCount: hop + 1,
    profileEffIndex: stepIndex(config, eff2.active),
    profileProbe: null, // a reroute is no longer the recovery probe — don't wind back on its success
    retryCount: 0, // new target — its own retry budget
    climitCount: 0, // new target — its own concurrency-requeue budget
  });
}

// Build the response handler that realises the reactive vision fallback AND failover
// reroute. `ctx` carries the in-flight request; `isVisionTarget` is true when the route
// being answered IS the `forImages` route (so a 400-image from it is the loop-guard case,
// never a re-reroute). `failoverHopCount` is the number of failover hops already taken
// for this request (starts at 0, max MAX_FAILOVER_HOPS — chain-depth guard).
function makeResponseHandler(ctx) {
  return (upstreamRes) => {
    const status = upstreamRes.statusCode || 502;

    // A recovery PROBE (a request the pre-route sent one step UP the ladder during cooldown)
    // that comes back WITHOUT a failover-triggering error means the intended head recovered →
    // wind the offset back up one. Called on the success/relay paths, not when the probe itself
    // triggers failover (then the offset stays and it re-serves lower).
    const windBackProbe = () => {
      const p = ctx.profileProbe;
      const ps = ctx.profileState;
      if (!p || !ps) return;
      if ((ps.offset || 0) === p.fromOffset) {
        ps.offset = p.windTo;
        ps.shiftedAt = Date.now();
        ps.attempts = 0;
        persistProfileState(ps);
        ctx.log(`profile: intended head recovered on a live request — offset -> ${ps.offset}`);
      }
    };

    // An account in a pool that answers cleanly has recovered → reset its progressive-cooldown
    // counter so its NEXT limit-hit starts back at the first (1-min) ladder rung instead of the
    // last one it climbed to. The account analogue of windBackProbe for a ladder.
    const resetAccountBackoff = () => {
      if (!ctx.account || !ctx.route || !ctx.accountPools) return;
      const pool = ctx.accountPools.get(ctx.route);
      const acct = pool && pool.accounts[ctx.account.idx];
      if (acct && acct.attempts) acct.attempts = 0;
    };

    // Fast path — success / SSE (2xx) and every other non-error that is neither a
    // 400 (vision classifier) nor a failover-candidate status. These are NEVER
    // buffered, so streaming stays intact.
    // Buffer only real failover candidates + 400 (vision path): 400 for account/org
    // issues, 429/529 for unambiguous rate-limit/overload, 5xx for server errors.
    // Other 4xx (401, 403, 404, etc.) stream straight back — they're client errors
    // that failover can't fix, so buffering them is wasted work + changes delivery
    // semantics for oversized error bodies.
    const canProfileStep = !!(ctx.profileState && ctx.config.profiles && ctx.config.auto);
    const retryCfg = ctx.config.auto && ctx.config.auto.retry;
    const canRetry = !!(retryCfg && retryCfg.attempts > 0);
    // A model with a CONFIGURED concurrency limit has a signal to learn against — a 429/5xx on
    // it is worth buffering + classifying even with no profiles/accounts/auto.retry configured,
    // so the empirical self-throttle (below) still kicks in on a bare concurrency-limited route.
    const configuredConcLimit = resolveConcurrencyLimit(ctx.config && ctx.config.concurrency, ctx.model);
    const canConcurrencyLearn = !!(ctx.limiter && configuredConcLimit > 0 && configuredConcLimit !== Infinity);
    const isFailoverCandidate = (canProfileStep || (ctx.account && ctx.route) || canRetry || canConcurrencyLearn)
      && (status === 400 || status === 429 || status === 529 || (status >= 500 && status < 600));
    // 413 is also buffered so the context-overflow safety net can classify it (some backends
    // signal an oversized request with 413 rather than a 400).
    const compactOn = ctx.config.compact && ctx.config.compact.enabled;
    if (status !== 400 && !(compactOn && status === 413) && !isFailoverCandidate) {
      windBackProbe(); // a non-candidate response to a recovery probe = head is back
      resetAccountBackoff(); // a clean answer means this account's cooldown ladder resets
      pipeResponse(upstreamRes, ctx.res, ctx.statsCtx
        ? { stats: ctx.statsCtx.stats, providerId: ctx.providerId, model: ctx.model, clientModel: ctx.clientModel, client: ctx.client, startTime: ctx.statsCtx.startTime }
        : null);
      return;
    }

    // Buffer the (small) error body and classify it — either for failover or vision.
    bufferResponse(upstreamRes, REROUTE_BUFFER_CAP, (err, buffered, headers) => {
      if (err) {
        if (!ctx.res.headersSent) sendError(ctx.res, 502, "upstream error response could not be relayed");
        else ctx.res.destroy();
        return;
      }

      // Decompress the error body for classification. Anthropic (and others) can return the
      // { error: { message } } JSON gzip/br-encoded; the classifiers below JSON.parse the raw
      // bytes and silently fail on compressed input — so an overflow/rate-limit/image-unsupported
      // error would be relayed verbatim instead of being caught. Decode once here; on success also
      // drop content-encoding/content-length so the verbatim relay sends the (now plain) bytes with
      // honest headers. On any decode failure decompressBuffer returns the input unchanged and we
      // leave headers alone — identical to the pre-decode behaviour.
      if (headers) {
        const enc = headers["content-encoding"];
        if (enc) {
          const decoded = decompressBuffer(buffered, enc);
          if (decoded !== buffered) {
            buffered = decoded;
            delete headers["content-encoding"];
            delete headers["content-length"];
          }
        }
      }

      // 0. CONTEXT-OVERFLOW SAFETY NET: the backend rejected the request as too long for its
      //    window — our proactive downshift-fit under-estimated, or the model's real window is
      //    smaller than configured. Learn the real ceiling (from the error message when it
      //    states one), hard-trim the body, and retry — up to maxOverflowRetries, shrinking the
      //    target each time so it converges. Out of retries → relay the error honestly.
      if (ctx.config.compact && ctx.config.compact.enabled && isContextOverflow(status, buffered)) {
        const attempt = ctx.overflowRetry || 0;
        const limit = parseOverflowLimit(buffered);
        let sent = 0;
        try { sent = bodyTokens(JSON.parse(ctx.body.toString("utf8"))); } catch { /* keep 0 */ }
        learnWindow(ctx.learnedWindows, ctx.model, limit || (sent ? Math.floor(sent * 0.9) : 0), ctx.log);
        const maxRetries = ctx.config.compact.maxOverflowRetries ?? 2;
        if (attempt < maxRetries) {
          const base = limit || effectiveWindow(ctx.config.compact, ctx.learnedWindows, ctx.model);
          const win = Math.floor(base * [0.9, 0.7, 0.5][Math.min(attempt, 2)]);
          const trimmed = fitBufferToWindow(ctx.body, win, 1, `${ctx.model} overflow-retry ${attempt + 1}`, ctx.log);
          recordStat(ctx, status, errorReason(buffered));
          ctx.log(`compact: context overflow from ${ctx.model} — hard-trim + retry ${attempt + 1}/${maxRetries}`);
          dispatch(ctx.route, trimmed, ctx, { model: ctx.model, overflowRetry: attempt + 1 });
          return;
        }
        recordStat(ctx, status, errorReason(buffered));
        relayBuffered(ctx.res, status, headers, buffered);
        return;
      }

      // 1. FAILOVER CHECK: a rate-limit or temporary-unavailable error from a backend
      //    that has a configured backup model → reroute to the backup.
      if (isFailoverCandidate && isFailoverTrigger(status, buffered)) {
        // CONCURRENCY-LIMIT SELF-CORRECTION: a 429/5xx on a (provider,model) key that has a
        // CONFIGURED concurrency limit likely means the configured ceiling is currently too
        // optimistic for what the backend will actually bear — rather than bounce this through
        // account rotation / a profile step, LEARN a lower ceiling (reportLimitHit) and requeue
        // the SAME request through the SAME limiter key: proxyToRoute's own concurrency gate
        // then naturally holds it until a slot frees under the new (lower) ceiling — no blind
        // fixed delay, the queue IS the backoff. Bounded by MAX_CONCURRENCY_REQUEUE_ATTEMPTS,
        // independent of auto.retry (for routes with no concurrency signal to learn from) —
        // always on for any model with a configured limit, no extra config needed. Gated by
        // isRetryWorthy: a hard weekly/monthly exhaustion isn't a concurrency problem at all,
        // so it skips straight to failover instead of pointlessly lowering the ceiling.
        const climitCount = ctx.climitCount || 0;
        if (canConcurrencyLearn && climitCount < MAX_CONCURRENCY_REQUEUE_ATTEMPTS && isRetryWorthy(status, buffered)) {
          const concKey = `${ctx.providerId} ${ctx.model}`;
          ctx.limiter.reportLimitHit(concKey, configuredConcLimit);
          recordStat(ctx, status, errorReason(buffered));
          ctx.log(`concurrency: ${ctx.model} @ ${ctx.providerId} hit a limit (status ${status}) — learned ceiling lowered, requeue ${climitCount + 1}/${MAX_CONCURRENCY_REQUEUE_ATTEMPTS}`);
          let effRoute = ctx.route;
          if (ctx.account && ctx.accountPools) {
            const pool = ctx.accountPools.get(ctx.route);
            const acct = pool && pool.accounts[ctx.account.idx];
            if (acct) effRoute = { ...ctx.route, auth: acct.auth, base_url: acct.base_url || ctx.route.base_url };
          }
          proxyToRoute(effRoute, ctx.req, ctx.res, ctx.body, ctx.log, {
            onResponse: makeResponseHandler({ ...ctx, climitCount: climitCount + 1 }),
            statsCtx: ctx.statsCtx,
            providerId: ctx.providerId,
            limiter: ctx.limiter,
            concLimit: configuredConcLimit,
            queueTimeoutMs: queueTimeoutOf(ctx.config),
          });
          return;
        }

        // SAME-TARGET RETRY: a single bad response doesn't necessarily mean the backend/
        // account is actually down — retry the IDENTICAL request against the SAME target
        // up to failoverRetry.attempts times before spending a failover hop (account
        // rotation / profile step). Off by default (attempts: 0 = today's immediate-failover
        // behaviour). retryCount resets to 0 whenever a hop moves to a NEW target below.
        // Gated by isRetryWorthy: a HARD, long-duration exhaustion (weekly/monthly plan
        // quota, a disabled org/account, payment required) skips retry entirely and goes
        // straight to failover — retrying it is guaranteed to fail again and only delays
        // the actual fix. A plain rate-limit/overload/5xx blip, or our own concurrency-queue
        // timeout, remains retry-worthy.
        const retryCount = ctx.retryCount || 0;
        if (retryCfg && retryCfg.attempts > 0 && retryCount < retryCfg.attempts && isRetryWorthy(status, buffered)) {
          recordStat(ctx, status, errorReason(buffered)); // record this failed attempt on the current tier
          ctx.log(`retry: ${ctx.model} @ ${ctx.providerId} (status ${status}, retry ${retryCount + 1}/${retryCfg.attempts})`);
          // Re-send to the EXACT SAME effective backend — NOT dispatch(), which re-runs
          // accountSetup and (on a round-robin pool) would advance to the NEXT account
          // instead of retrying this one. Rebuild the same account's effRoute by hand.
          let effRoute = ctx.route;
          if (ctx.account && ctx.accountPools) {
            const pool = ctx.accountPools.get(ctx.route);
            const acct = pool && pool.accounts[ctx.account.idx];
            if (acct) effRoute = { ...ctx.route, auth: acct.auth, base_url: acct.base_url || ctx.route.base_url };
          }
          const again = () => proxyToRoute(effRoute, ctx.req, ctx.res, ctx.body, ctx.log, {
            onResponse: makeResponseHandler({ ...ctx, retryCount: retryCount + 1 }),
            statsCtx: ctx.statsCtx,
            providerId: ctx.providerId,
            limiter: ctx.limiter,
            concLimit: resolveConcurrencyLimit(ctx.config && ctx.config.concurrency, ctx.model),
            queueTimeoutMs: queueTimeoutOf(ctx.config),
          });
          if (retryCfg.delayMs > 0) setTimeout(again, retryCfg.delayMs);
          else again();
          return;
        }

        // Chain-depth guard — prevent infinite failover loops.
        const hop = ctx.failoverHopCount || 0;
        if (hop >= MAX_FAILOVER_HOPS) {
          recordStat(ctx, 502, `failover chain limit (${MAX_FAILOVER_HOPS} hops) reached`);
          sendError(ctx.res, 502, `failover chain limit (${MAX_FAILOVER_HOPS} hops) reached — could not route "${ctx.model}"`);
          return;
        }

        // ACCOUNT ROTATION (innermost): the current route has an account pool → park the
        // failed account for a cooldown and retry the SAME request (same model, no body
        // rewrite) on the next eligible account. Only when the pool has no live account left
        // do we fall through to model-level failover (group/pairs).
        // ctx.account.lastResort marks a hop that handleProfileFailover already sent back into a
        // KNOWN-parked account as a last-ditch effort (see giveUpOrLastResort) — if that retry
        // also fails, re-parking it here would double-count the SAME underlying exhaustion (it
        // was already parked moments ago); skip straight to model-level failover instead, which
        // now just relays honestly (giveUpOrLastResort only spends its one shot once per request).
        if (ctx.account && !ctx.account.lastResort && ctx.route && ctx.accountPools) {
          const pool = ctx.accountPools.get(ctx.route);
          if (pool) {
            const now = Date.now();
            // PROGRESSIVE cooldown: park the exhausted account for recoveryWaitMs(attempts) —
            // the SAME 1→5→10-min ladder (config.failoverRecoveryBackoffMs) model failover
            // rides, not a flat 60s. attempts counts consecutive limit-hits on THIS account;
            // it climbs the ladder each repeat park and is reset to 0 the next time the account
            // serves a request cleanly (recovery). Falls back to the flat cooldown when no
            // backoff schedule is configured.
            //
            // EXCEPTION — a HARD-classified message (isRetryWorthy false: "weekly/monthly limit
            // exhausted" and friends) is a GENUINE multi-day block in practice (confirmed: a
            // backend can quote a reset days out and mean it), so climbing the same short ladder
            // used for ordinary rate-limit blips would re-probe a dead account every few minutes
            // for days, burning requests against it for nothing. When the message quotes an
            // explicit reset time, trust it directly (sanity-capped at MAX_HARD_PARK_MS so one
            // malformed/absurd timestamp can't park an account forever); otherwise fall back to
            // that same cap rather than the short ladder. attempts is left untouched here (not
            // incremented) so a later GENUINE transient hit on this account still starts the
            // ordinary ladder from its first rung instead of inheriting a count run up by a
            // multi-day hard block.
            const exhausted = pool.accounts[ctx.account.idx];
            const hardHit = !isRetryWorthy(status, buffered);
            const MAX_HARD_PARK_MS = 3 * 24 * 60 * 60 * 1000; // 3 days — sanity ceiling, not a guess at the real duration
            if (hardHit) {
              const quoted = parseHardExhaustionResetMs(buffered, now);
              exhausted.exhaustedUntil = now + Math.min(quoted ?? MAX_HARD_PARK_MS, MAX_HARD_PARK_MS);
            } else {
              exhausted.exhaustedUntil = now + recoveryWaitMs(ctx.config, exhausted.attempts || 0);
              exhausted.attempts = (exhausted.attempts || 0) + 1;
            }
            const nextIdx = pickAccountIndex(pool, now, ctx.account.idx);
            if (accountEligible(pool, nextIdx, now)) {
              recordStat(ctx, status, errorReason(buffered)); // record the error on the exhausted account label
              const acct = pool.accounts[nextIdx];
              ctx.log(`account: ${ctx.model} ${ctx.account.label} -> ${acct.label} (status ${status}, hop ${hop + 1})`);
              const effRoute = { ...ctx.route, auth: acct.auth, base_url: acct.base_url || ctx.route.base_url };
              proxyToRoute(effRoute, ctx.req, ctx.res, ctx.body, ctx.log, {
                onResponse: makeResponseHandler({
                  ...ctx,
                  providerId: acct.label,
                  account: { idx: nextIdx, label: acct.label },
                  failoverHopCount: hop + 1,
                  profileProbe: null,
                  retryCount: 0, // new target — its own retry budget
                  climitCount: 0, // new target — its own concurrency-requeue budget
                }),
                statsCtx: ctx.statsCtx,
                providerId: acct.label,
                limiter: ctx.limiter,
                // Same model, but the next account has its OWN per-key concurrency budget.
                concLimit: resolveConcurrencyLimit(ctx.config && ctx.config.concurrency, ctx.model),
                queueTimeoutMs: queueTimeoutOf(ctx.config),
              });
              return;
            }
            // Pool exhausted — fall through to model-level failover.
          }
        }

        // MODEL-LEVEL failover: step the profile ladder (pool exhausted or no pool).
        handleProfileFailover(ctx, status, buffered, headers, hop);
        return;
      }

      // 2. VISION CHECK: a specific "image not supported" 400 → reroute to the
      //    forImages vision target (existing behaviour).
      if (isImageUnsupported400(status, buffered)) {
        if (ctx.isVisionTarget) {
          // Loop guard: the vision target itself can't take the image — clear error,
          // never re-reroute (no infinite loop).
          recordStat(ctx, 422, "vision route cannot process this image; not rerouting (loop guard)");
          sendError(ctx.res, 422, "vision route cannot process this image request; not rerouting (loop guard)");
          return;
        }
        if (ctx.visionRoute) {
          // Reroute the buffered request to the vision target, rewriting only `model`
          // to the route's forImagesModel (the cross-provider hop); remember the client
          // model so the next image call pre-routes (per-process cache, never the payload).
          if (ctx.model) ctx.nonVisionCache.set(ctx.model, true);
          const visionBody = rewriteModelInBody(ctx.body, ctx.visionRoute.forImagesModel);
          // Drop the profile-step context: the vision target is a fixed cross-provider hop,
          // not a ladder step, so a later failover-trigger from it must not advance the profile
          // offset off a stale index. dispatch applies the vision route's own account pool.
          dispatch(ctx.visionRoute, visionBody, ctx, {
            model: ctx.visionRoute.forImagesModel,
            isVisionTarget: true,
            profileEffIndex: -1,
            profileProbe: null,
          });
          return;
        }
        // No vision fallback configured — fail LOUD with a clear error, never the raw
        // cryptic upstream 400.
        recordStat(ctx, 422, `model "${ctx.model}" cannot process images and no vision fallback is configured`);
        sendError(ctx.res, 422, `model "${ctx.model}" cannot process images and no vision fallback is configured`);
        return;
      }

      // 3. Any other error — relay it verbatim (an ambiguous 400, a non-rate-limit
      //    5xx, etc.). Never reroute.
      const reason = errorReason(buffered);
      if (reason) ctx.log(`error-relay: ${ctx.model} status=${status} msg="${reason}"`);
      windBackProbe(); // a non-retryable response to a recovery probe = head is back
      resetAccountBackoff(); // account answered (a non-limit error) — it's reachable, reset its ladder
      recordStat(ctx, status, reason);
      relayBuffered(ctx.res, status, headers, buffered);
    });
  };
}

// Resolve a target route to an effective backend, applying its account pool if it has one.
// Returns { effRoute, providerId, account } — for a pooled route the effRoute carries the
// selected account's auth/base_url, providerId is the account LABEL (so stats are per
// account), and account = { idx, label }; for a plain route it's the route itself and the
// host-derived providerId with account = null.
function accountSetup(route, accountPools) {
  const pool = accountPools && accountPools.get(route);
  if (!pool) return { effRoute: route, providerId: providerIdFromUrl(route.base_url), account: null };
  const idx = pickAccountIndex(pool, Date.now(), -1);
  const acct = pool.accounts[idx];
  return {
    effRoute: { ...route, auth: acct.auth, base_url: acct.base_url || route.base_url },
    providerId: acct.label,
    account: { idx, label: acct.label },
  };
}

// The single proxy choke-point: pick this route's account (if pooled), build the ctx from
// a carry ctx (baseCtx for a first hop, the current ctx for a reroute) plus per-hop
// overrides, and forward. Every routing path (primary, vision, failover pair/group) goes
// through here so account selection + per-label stats are uniform. Account ROTATION (same
// route, next account) is handled inline in makeResponseHandler, not here.
function dispatch(targetRoute, sendBody, carryCtx, overrides = {}) {
  const setup = accountSetup(targetRoute, carryCtx.accountPools);
  const targetModel = overrides.model || carryCtx.model;

  // DOWNSHIFT SAFETY NET (see compact.mjs): if this hop routes to a model whose context window
  // is SMALLER than the client's original model (a failover downshift, e.g. 1M → 256K), the
  // grown conversation may not fit — trim it to the target's window before sending. Only fires
  // on a genuine downshift: the primary hop (same/again window) is never touched, so the
  // harness stays in charge of normal compaction. Off unless config.compact.enabled. dispatch()
  // is the SOLE send choke-point (forward() calls it for the primary hop too, see its tail), so
  // this one check covers a fresh pre-routed request AND every later reroute.
  const compact = carryCtx.config && carryCtx.config.compact;
  let outBody = sendBody;
  if (compact && compact.enabled && carryCtx.clientModel) {
    const targetWin = effectiveWindow(compact, carryCtx.learnedWindows, targetModel);
    const clientWin = effectiveWindow(compact, carryCtx.learnedWindows, carryCtx.clientModel);
    if (targetWin < clientWin) {
      outBody = fitBufferToWindow(sendBody, targetWin, compact.safetyPct, targetModel, carryCtx.log);
    }
  }

  const ctx = {
    ...carryCtx,
    ...overrides,
    route: targetRoute,
    body: outBody,
    providerId: setup.providerId,
    account: setup.account,
  };
  proxyToRoute(setup.effRoute, carryCtx.req, carryCtx.res, outBody, carryCtx.log, {
    onResponse: makeResponseHandler(ctx),
    statsCtx: carryCtx.statsCtx,
    providerId: setup.providerId,
    limiter: carryCtx.limiter,
    concLimit: resolveConcurrencyLimit(carryCtx.config && carryCtx.config.concurrency, targetModel),
    queueTimeoutMs: queueTimeoutOf(carryCtx.config),
  });
}

// The queue-wait ceiling for this config, in ms (config.concurrencyQueueTimeoutMs or the
// default). Beyond it a queued request is treated as a backend 429 (rotation/failover).
function queueTimeoutOf(config) {
  return (config && config.concurrencyQueueTimeoutMs) || DEFAULT_QUEUE_TIMEOUT_MS;
}

// The concurrency-recovery interval for this config, in ms (config.concurrencyRecoveryIntervalMs
// or the default).
function concurrencyRecoveryIntervalOf(config) {
  return (config && config.concurrencyRecoveryIntervalMs) || DEFAULT_CONCURRENCY_RECOVERY_INTERVAL_MS;
}

// Route one buffered request to its backend, with the reactive vision fallback
// AND failover reroute.
// `nonVisionCache` is a per-process Map(model → true) of models a backend has already
// rejected for images — ephemeral state, never the payload.
// `profileState` is the per-process { pinned, offset, shiftedAt, attempts } that (with the
// config's profiles/auto) decides what each incoming alias resolves to right now.
// `statsCtx` (optional): { stats } — when dashboard is enabled.
function forward(config, req, res, body, log, nonVisionCache, statsCtx = null, profileState = null, accountPools = null, learnedWindows = {}, limiter = null) {
  let model = modelFromBody(body);
  // The alias the CLIENT sent + sized its context against (before any profile rewrite) — the
  // reference id for the downshift safety net and the stable key the profile ladder steps on.
  const clientModel = model;
  const client = clientLabel(req.headers); // "who" — user-agent·auth-fingerprint, for the trace log

  // PROFILE RESOLUTION: the active profile (manual pin > error-shift > schedule > default)
  // rewrites the incoming alias to its concrete backend target BEFORE routing/vision. When
  // shifted and past the recovery cooldown, THIS request probes the intended head one step up
  // (winds the offset back on a clean response — the analogue of the old group live-probe).
  let profileEffIndex = -1;
  let profileProbe = null;
  if (model && profileState && config.profiles) {
    const now = Date.now();
    const eff = effectiveProfile(config, profileState, now);
    let activeName = eff.active;
    profileEffIndex = stepIndex(config, activeName);
    if (eff.shifted && (!config.auto || config.auto.recover !== false) &&
        now - (profileState.shiftedAt || 0) >= recoveryWaitMs(config, profileState.attempts || 0)) {
      const intended = intendedHead(config, profileState, now);
      const basePos = stepIndex(config, intended);
      const probeOffset = Math.max(0, (profileState.offset || 0) - 1);
      const steps = (config.auto && Array.isArray(config.auto.steps)) ? config.auto.steps : [];
      const probeIdx = basePos < 0 ? -1 : Math.min(basePos + probeOffset, steps.length - 1);
      if (probeIdx >= 0 && steps[probeIdx]) {
        profileProbe = { fromOffset: profileState.offset || 0, windTo: probeOffset };
        profileState.shiftedAt = now;                 // hold off another probe for this window
        profileState.attempts = (profileState.attempts || 0) + 1; // widen it if the probe also fails
        activeName = steps[probeIdx].profile;
        profileEffIndex = probeIdx;
      }
    }
    const target = resolveAlias(config, activeName, model);
    if (target && target !== model) {
      log(`profile[${activeName}]: ${model} -> ${target}`);
      body = rewriteModelInBody(body, target);
      model = target;
    }
  }

  const route = pickRoute(model, config.routes);
  if (!route) {
    // If the body has no model field at all, fall back to the default route
    // (passthrough or first route) so requests to auxiliary endpoints
    // (count_tokens without a model, any new Anthropic endpoint, etc.) still
    // reach a backend instead of failing with a 400.
    if (!model) {
      const fallback = findDefaultRoute(config.routes);
      if (fallback) {
        log(`no model in body — using default route (${fallback.match} -> ${fallback.base_url})`);
        proxyToRoute(fallback, req, res, body, log, {
          statsCtx,
          providerId: providerIdFromUrl(fallback.base_url),
          limiter,
          concLimit: resolveConcurrencyLimit(config.concurrency, null),
          queueTimeoutMs: queueTimeoutOf(config),
        });
        return;
      }
    }
    sendError(res, 400, model ? `no route for model "${model}"` : "request has no routable model");
    return;
  }

  // Signature-safe cross-provider routing: drop thinking blocks the target would reject (see
  // stripThinkingBlocks). Opt-in per route — set on a signature-validating backend (real
  // Anthropic) that receives transcripts carrying thinking minted elsewhere.
  if (route.stripThinking) {
    const before = body.length;
    body = stripThinkingBlocks(body);
    if (body.length !== before) log(`stripThinking: dropped thinking block(s) from "${model}" history -> ${route.base_url}`);
  }

  // Schema-safe cross-provider routing: rewrite-or-drop foreign server_tool_use/tool_result
  // bookkeeping the target would reject. `rewriteServerToolUse` keeps the tool's RESULT in
  // history as a labelled text block (drops only the bad-id call + opaque blobs); opt-in per
  // route — preferred over the plain drop. Falls back to `stripServerToolUse` (drop the whole
  // pair) when only that is set. Set either on a strict, schema-validating backend (real
  // Anthropic) that receives transcripts carrying tool-use artifacts minted by another provider.
  if (route.rewriteServerToolUse) {
    const before = body.length;
    body = rewriteBadServerToolUseBlocks(body);
    if (body.length !== before) log(`rewriteServerToolUse: inlined foreign tool-use result(s) as text in "${model}" history -> ${route.base_url}`);
  } else if (route.stripServerToolUse) {
    const before = body.length;
    body = stripBadServerToolUseBlocks(body);
    if (body.length !== before) log(`stripServerToolUse: dropped foreign tool-use block(s) from "${model}" history -> ${route.base_url}`);
  }

  const visionRoute = pickVisionRoute(config.routes);

  // A route is "known non-vision" when it is DECLARED (`vision: false`) or LEARNED (cached
  // from a prior 400-image on this model) to lack vision — and is not itself the vision
  // target. Such a backend cannot process an image at all: a current-turn image must go to
  // the vision target, and a historical image is dead weight to strip (see below).
  const knownNonVision =
    route !== visionRoute &&
    (route.vision === false || (model && nonVisionCache.has(model)));

  // One-shot vision (default) vs legacy sticky vision (config.dropProcessedImages === false).
  const stripProcessed = config.dropProcessedImages !== false;

  // Strip already-processed (historical) images before a non-vision backend ever sees them.
  // Only reached when the CURRENT turn has no image (a current-turn image pre-routes to vision
  // just below), so every image left in the body is historical — the model has already
  // answered it, and the backend can't read it anyway. Without this, one image in the
  // transcript would pin every later turn to the vision target for the life of the image.
  if (stripProcessed && knownNonVision && bodyHasImageBlock(body) && !currentTurnHasImage(body)) {
    const before = body.length;
    body = stripImageBlocks(body);
    if (body.length !== before) log(`vision: stripped processed image(s) from "${model}" history (non-vision backend)`);
  }

  // Build the base ctx for makeResponseHandler — the shared context threaded through every
  // hop (vision reroute, profile failover reroute, account rotation). providerId/account/route
  // are set per hop by dispatch(). body is the (possibly image-stripped) buffer every hop carries.
  const baseCtx = { res, req, body, log, model, clientModel, client, learnedWindows, visionRoute, nonVisionCache, isVisionTarget: route === visionRoute, statsCtx, config, profileState, profileEffIndex, profileProbe, accountPools, limiter, failoverHopCount: 0 };

  // Pre-route an image straight to the vision target, skipping the non-vision backend call,
  // when the matched route is known non-vision. The trigger differs by mode: a CURRENT-TURN
  // image (default) — so the reroute is one image, not sticky; once answered, follow-up turns
  // fall through to the native backend with the image stripped above — OR ANY image (legacy
  // mode, dropProcessedImages:false). Needed because a backend that lacks vision does NOT
  // always 400 — it may soft-refuse with a 200 or invoke its own server-side image tool,
  // neither of which the reactive catch-400 path (makeResponseHandler) can detect. That
  // reactive fallback stays for the default (vision unset/true) route — belt-and-suspenders
  // for a backend that DOES 400.
  const needsVision = stripProcessed ? currentTurnHasImage(body) : bodyHasImageBlock(body);
  if (visionRoute && knownNonVision && needsVision) {
    const visionBody = rewriteModelInBody(body, visionRoute.forImagesModel);
    dispatch(visionRoute, visionBody, baseCtx, { model: visionRoute.forImagesModel, isVisionTarget: true });
    return;
  }

  dispatch(route, body, baseCtx, {});
}

// ── ProfileRecoveryPinger ─────────────────────────────────────────────────────
// Background timer that, while the profile ladder is shifted (offset > 0), probes the
// backend targets the step ONE UP would route to (the delta vs the current step). When they
// answer cleanly, it winds the offset back up one. This is the out-of-band analogue of the
// live recovery probe in forward() — it recovers even when no traffic is flowing.
//
// Probe: a minimal messages API call ({model, messages:[{role:"user",content:"."}],
// max_tokens:1}) through the target's backend route — a real API call, so it reflects whether
// the backend accepts messages again. Passthrough targets are unprobeable (no key of our own);
// those are left to the live head-probe in forward(). Similar to QuotaPoller: setInterval +
// unref, best-effort.

// Progressive backoff between recovery probes. Attempt N (0-based) waits
// backoff[min(N, last)] ms — config.failoverRecoveryBackoffMs, e.g. [60000,300000,600000]
// = 1→5→10 min — so a still-down primary is probed ever less often instead of every
// cooldown ("не долбить"). Falls back to the flat failoverRecoveryIntervalMs (or 60s)
// when no schedule is configured. Shared by the synthetic pinger and the live head-probe.
export function recoveryWaitMs(config, attempts) {
  const bo = config && config.failoverRecoveryBackoffMs;
  if (Array.isArray(bo) && bo.length) return bo[Math.min(attempts, bo.length - 1)];
  return (config && config.failoverRecoveryIntervalMs) || 60000;
}

class ProfileRecoveryPinger {
  #profileState;   // shared { pinned, offset, shiftedAt, attempts }
  #config;         // shared config object (for route + profile resolution)
  #log;            // opt-in stderr logger (same as the router's log)
  #interval = null;

  constructor(profileState, config, log) {
    this.#profileState = profileState;
    this.#config = config;
    this.#log = log || (() => {});
  }

  async poll() {
    const ps = this.#profileState;
    const config = this.#config;
    if (!ps || (ps.offset || 0) <= 0) return;                       // not shifted — nothing to recover
    if (config.auto && config.auto.recover === false) return;       // recovery disabled
    const now = Date.now();
    if (now - (ps.shiftedAt || 0) < recoveryWaitMs(config, ps.attempts || 0)) return; // backoff window

    const intended = intendedHead(config, ps, now);
    const basePos = stepIndex(config, intended);
    const steps = (config.auto && Array.isArray(config.auto.steps)) ? config.auto.steps : [];
    const curEff = basePos < 0 ? -1 : Math.min(basePos + (ps.offset || 0), steps.length - 1);
    if (curEff <= basePos || curEff < 1) return;                    // already at/above the intended head

    const upProfile = steps[curEff - 1].profile;
    const curProfile = steps[curEff].profile;
    const targets = this.#deltaTargets(upProfile, curProfile);
    if (!targets.length) return;                                    // nothing concrete to probe — live head-probe handles it

    let allUp = true, anyConfirmed = false;
    for (const t of targets) {
      const r = await this.#probeRecovery(t);
      if (r === "down") { allUp = false; break; }
      if (r === "recovered" || r === "no-route") anyConfirmed = true; // "unprobeable" neither confirms nor blocks
    }
    if (allUp && anyConfirmed) {
      ps.offset -= 1;
      ps.shiftedAt = Date.now();
      ps.attempts = 0;
      persistProfileState(ps);
      this.#log(`profile-recovery: "${upProfile}" restored — offset -> ${ps.offset} (ladder winds back up one)`);
    } else {
      ps.attempts = (ps.attempts || 0) + 1; // widen the backoff window
      ps.shiftedAt = Date.now();            // gate the next probe off now (shiftedAt + backoff)
    }
  }

  // The distinct, concrete (non-glob) target model ids the step ONE UP would route to that
  // DIFFER from the current step — the backends that must be healthy to wind up. Resolves each
  // alias key across the up / current / default profiles.
  #deltaTargets(upProfile, curProfile) {
    const config = this.#config;
    const bindKeys = (name) => {
      const p = config.profiles && config.profiles[name];
      return (p && p.bind && typeof p.bind === "object") ? Object.keys(p.bind) : [];
    };
    const base = defaultProfile(config);
    const aliases = new Set([...bindKeys(upProfile), ...bindKeys(curProfile), ...bindKeys(base)]);
    const out = new Set();
    for (const alias of aliases) {
      const upT = resolveAlias(config, upProfile, alias);
      const curT = resolveAlias(config, curProfile, alias);
      if (upT !== curT && typeof upT === "string" && !upT.includes("*")) out.add(upT);
    }
    return [...out];
  }

  // Probe one model's backend with a minimal real messages call. Returns
  // "recovered" (backend accepts messages again), "down" (still a failover error),
  // "unprobeable" (passthrough or no key — can't probe), or "no-route".
  async #probeRecovery(model) {
    const route = pickRoute(model, this.#config.routes);
    if (!route) return "no-route";
    if (isPassthrough(route)) return "unprobeable"; // no backend key of our own to probe with
    let auth;
    try {
      auth = resolveAuthHeader(route);
    } catch {
      return "unprobeable"; // key not set
    }

    const upstream = new URL(route.base_url);
    const pingBody = JSON.stringify({ model, messages: [{ role: "user", content: "." }], max_tokens: 1 });
    const headers = {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(pingBody)),
      host: upstream.host,
    };
    headers[auth.name] = auth.value;

    return await new Promise((resolve) => {
      const client = upstream.protocol === "http:" ? http : https;
      const req = client.request(
        {
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port || (upstream.protocol === "http:" ? 80 : 443),
          path: joinPath(upstream.pathname, "/v1/messages"),
          method: "POST",
          headers,
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const status = res.statusCode || 502;
            const body = Buffer.concat(chunks);
            resolve((status < 400 || !isFailoverTrigger(status, body)) ? "recovered" : "down");
          });
          res.on("error", () => resolve("down"));
          res.on("aborted", () => resolve("down"));
        },
      );
      req.on("error", () => resolve("down")); // network error — keep state
      req.write(pingBody);
      req.end();
    });
  }

  start(intervalMs) {
    this.poll();
    this.#interval = setInterval(() => this.poll(), intervalMs);
    this.#interval.unref(); // don't keep the process alive
  }

  stop() {
    if (this.#interval) { clearInterval(this.#interval); this.#interval = null; }
  }
}

// Build the router as an http.Server. `options.log` overrides the stderr logger
// (used by the self-test to capture the routing line).
export function createRouter(config, options = {}) {
  validateConfig(config);
  config.compact = validateCompact(config.compact); // normalize + default-on
  const maxBytes = config.maxBodyBytes || DEFAULT_MAX_BODY_BYTES;
  const log = options.log || defaultLogger();

  // Dashboard-set overrides from a previous run, persisted to ~/.modelpipe/overrides.json.
  // tokenPrices MERGE over the file (file entries survive). compact/concurrency, once edited in
  // the dashboard, are AUTHORITATIVE — the stored value REPLACES the file's so a change made in
  // the UI survives a restart. The live PROFILE state (pin/offset) lives in its own
  // profile-state.json, not here. A corrupt/invalid overrides file is ignored rather than
  // bricking startup.
  const stored = readJson(OVERRIDES_FILE, {});
  const dashOverrides = {
    tokenPrices: (stored && typeof stored.tokenPrices === "object") ? stored.tokenPrices : {},
    // billing: { <providerId|accountLabel>: "metered" | "subscription" } — dashboard-only
    // display override when the derived default guesses wrong (e.g. a metered z.ai key).
    billing: (stored && typeof stored.billing === "object") ? stored.billing : {},
    // compact: null = never edited in the UI (use the file's compact block / defaults); an
    // object = the dashboard-set compaction config, AUTHORITATIVE across restart.
    compact: (stored && stored.compact && typeof stored.compact === "object" && !Array.isArray(stored.compact)) ? stored.compact : null,
    // concurrency: null = never edited in the UI (use the file's concurrency map); an object
    // = the dashboard-set per-model concurrency limits, AUTHORITATIVE across restart (an empty
    // object means "the user cleared every limit", which must survive a restart).
    concurrency: (stored && stored.concurrency && typeof stored.concurrency === "object" && !Array.isArray(stored.concurrency)) ? stored.concurrency : null,
    // profiles/auto/defaultProfile: null = never edited in the UI (use the file's). Once edited in
    // the dashboard they are AUTHORITATIVE across restart (the UI edit wins), like compact/concurrency.
    profiles: (stored && stored.profiles && typeof stored.profiles === "object" && !Array.isArray(stored.profiles)) ? stored.profiles : null,
    auto: (stored && stored.auto && typeof stored.auto === "object" && !Array.isArray(stored.auto)) ? stored.auto : null,
    defaultProfile: (stored && typeof stored.defaultProfile === "string") ? stored.defaultProfile : null,
  };
  {
    const beforeTP = config.tokenPrices;
    const beforeCM = config.compact;
    const beforeCC = config.concurrency;
    const beforePR = config.profiles, beforeAU = config.auto, beforeDP = config.defaultProfile;
    try {
      if (Object.keys(dashOverrides.tokenPrices).length) config.tokenPrices = { ...(config.tokenPrices || {}), ...dashOverrides.tokenPrices };
      // Compact: authoritative-replace, re-normalized so a stored partial still gets defaults.
      if (dashOverrides.compact !== null) config.compact = validateCompact(dashOverrides.compact);
      // Concurrency: same authoritative-replace semantics; null sentinel = leave the file's map.
      if (dashOverrides.concurrency !== null) config.concurrency = dashOverrides.concurrency;
      // Profiles are edited as ONE unit — once the UI has written `profiles`, the whole profile
      // layer (profiles + auto + defaultProfile) is authoritative. So a CLEARED auto/default
      // (persisted as null) correctly means "no chain", NOT "fall back to the file's ladder", and
      // the applied auto can never reference a profile the stored override doesn't declare.
      if (dashOverrides.profiles !== null) {
        config.profiles = dashOverrides.profiles;
        config.auto = dashOverrides.auto || undefined;
        config.defaultProfile = dashOverrides.defaultProfile || undefined;
      }
      validateConfig(config);
    } catch {
      config.tokenPrices = beforeTP;
      config.compact = beforeCM;
      config.concurrency = beforeCC;
      config.profiles = beforePR;
      config.auto = beforeAU;
      config.defaultProfile = beforeDP;
    }
  }
  // Persist ONLY the dashboard-set overrides (best-effort).
  const saveOverrides = () => writeJson(OVERRIDES_FILE, dashOverrides);
  // Per-process (per-router-instance) cache of models a backend rejected for images,
  // so a repeat image call pre-routes to the vision target without the failing first
  // hop. Ephemeral, holds only model ids — never any request payload.
  const nonVisionCache = new Map();

  // Per-backend concurrency limiter (FIFO queue keyed by providerId+model). Holds requests to
  // a concurrency-limited (provider, model) rather than firing them into a limit-429. Empty of
  // state until a request actually queues; unlimited models never touch it.
  const limiter = new ConcurrencyLimiter();

  // Background recovery: periodically ease any empirically-learned (lowered) concurrency
  // ceiling back up toward its configured limit once a key has been quiet for
  // concurrencyRecoveryIntervalMs (see ConcurrencyLimiter.recoverDue). Only worth polling when
  // at least one model has a configured limit to learn against.
  let concurrencyRecoveryTimer = null;
  if (config.concurrency && Object.keys(config.concurrency).length > 0) {
    concurrencyRecoveryTimer = setInterval(
      () => limiter.recoverDue(Date.now(), concurrencyRecoveryIntervalOf(config)),
      CONCURRENCY_RECOVERY_POLL_MS,
    );
    concurrencyRecoveryTimer.unref(); // never keep the process alive just to poll this
  }

  // Profile routing state — the live { pinned, offset, shiftedAt, attempts } that (with the
  // config's profiles/auto) decides what each alias resolves to. Persisted across restarts in
  // ~/.modelpipe/profile-state.json so a manual pin / active shift survives a restart. Fields
  // are sanitized so a corrupt file can't wedge routing.
  const profileState = (() => {
    const s = readJson("profile-state.json", null);
    const clean = { pinned: null, offset: 0, shiftedAt: 0, attempts: 0 };
    if (s && typeof s === "object") {
      if (typeof s.pinned === "string" && config.profiles && config.profiles[s.pinned]) clean.pinned = s.pinned;
      if (Number.isFinite(s.offset) && s.offset >= 0) clean.offset = Math.floor(s.offset);
      if (Number.isFinite(s.shiftedAt) && s.shiftedAt >= 0) clean.shiftedAt = s.shiftedAt;
      if (Number.isFinite(s.attempts) && s.attempts >= 0) clean.attempts = Math.floor(s.attempts);
    }
    return clean;
  })();

  // Account pools: per-route rotation state, keyed by the route object. Each account tracks
  // exhaustedUntil (cooldown after a rate-limit); rr is the round-robin cursor (-1 so the
  // first round-robin pick lands on index 0).
  const accountPools = new Map();
  for (const route of config.routes) {
    if (Array.isArray(route.accounts) && route.accounts.length > 0) {
      accountPools.set(route, {
        strategy: route.strategy || "failover",
        rr: -1,
        accounts: route.accounts.map((a) => ({ label: a.label, auth: a.auth, base_url: a.base_url || null, exhaustedUntil: 0, attempts: 0 })),
      });
    }
  }
  // Recovery pinger: winds the profile offset back up when the higher step's backends recover.
  // Runs whenever an auto ladder with more than the head step is configured (recovery can be
  // turned off with auto.recover: false, checked inside poll()).
  let profilePinger = null;
  const hasLadder = config.auto && Array.isArray(config.auto.steps) && config.auto.steps.length > 1;
  if (hasLadder) {
    const cooldown = config.failoverRecoveryIntervalMs || 60000;
    // Poll at the SHORTEST backoff step so a fast probe can actually fire; longer steps are
    // honoured via the shiftedAt + recoveryWaitMs gate inside poll().
    const bo = config.failoverRecoveryBackoffMs;
    const pollEvery = (Array.isArray(bo) && bo.length) ? bo[0] : cooldown;
    profilePinger = new ProfileRecoveryPinger(profileState, config, log);
    profilePinger.start(pollEvery);
  }

  // Dashboard stats + quota polling (enabled by config.dashboard)
  let stats = null;
  let quotaPoller = null;
  const dashboard = config.dashboard === true;
  if (dashboard) {
    stats = new StatsCollector();
    stats.startAutosave(10000); // flush the live session every 10s so a crash loses little
    // Wire billing-API pollers only for providers that actually expose one (DeepSeek
    // balance, OpenRouter credits). Anthropic's limits come from live response headers,
    // not a poll — so it is deliberately absent here.
    const keyEnvs = {};
    for (const route of config.routes) {
      if (route.auth && typeof route.auth === "object" && route.auth.keyEnv) {
        const pid = providerIdFromUrl(route.base_url);
        if (pid === "deepseek" || pid === "openrouter") {
          keyEnvs[pid] = route.auth.keyEnv;
        }
      }
    }
    if (Object.keys(keyEnvs).length > 0) {
      quotaPoller = new QuotaPoller(keyEnvs);
      quotaPoller.start(30000);
    }
  }

  // Self-calibration store (see compact.mjs): a model's REAL context window, learned from an
  // overflow error. Persisted per model under ~/.modelpipe/ so later requests fit it up front.
  // Loaded once here; threaded into forward() → ctx and mutated by the reactive overflow path.
  const learnedWindows = readJson("compact-learned-windows.json", {}) || {};

  const server = http.createServer((req, res) => {
    // Dashboard endpoints (before body reading)
    if (dashboard && req.method === "GET") {
      if (req.url === "/dashboard") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(DASHBOARD_HTML);
        return;
      }
      if (req.url === "/v1/stats") {
        const snap = stats.snapshot(config.tokenPrices || null);
        if (config.tokenPrices) snap.tokenPrices = config.tokenPrices;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(snap));
        return;
      }
      if (req.url === "/v1/quotas") {
        const quotas = quotaPoller ? quotaPoller.snapshot() : {};
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(quotas));
        return;
      }
      if (req.url === "/v1/sessions") {
        const history = stats.sessionHistory();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(history));
        return;
      }
    }
    // POST /v1/sessions/reset — start a new session (archives current)
    if (dashboard && req.method === "POST" && req.url === "/v1/sessions/reset") {
      stats.reset();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, startedAt: stats.snapshot().session.startedAt }));
      return;
    }
    // POST /v1/token-prices — update per-model metered API prices in-memory + persist.
    // Body: { "glm-5.2": { input, output }, ... } (or { tokenPrices: {...} }). These are
    // REAL pay-as-you-go prices used for honest per-response cost on metered providers —
    // there are no more "subscription plan price" fantik fields.
    if (dashboard && req.method === "POST" && (req.url === "/v1/token-prices" || req.url === "/v1/plans")) {
      readBody(req, 8192).then((body) => {
        try {
          const data = JSON.parse(body.toString("utf8"));
          if (!data || typeof data !== "object") throw new Error("must be an object { model: { input, output } }");
          // Accept either a bare price map or { tokenPrices } / legacy { _tokenPrices }.
          const prices = data.tokenPrices || data._tokenPrices || data;
          for (const [k, p] of Object.entries(prices)) {
            if (!p || typeof p.input !== "number" || typeof p.output !== "number" || p.input < 0 || p.output < 0 ||
                (p.cacheRead !== undefined && (typeof p.cacheRead !== "number" || p.cacheRead < 0))) {
              throw new Error(`price for "${k}" must be { input: number>=0, output: number>=0, cacheRead?: number>=0 }`);
            }
          }
          config.tokenPrices = { ...(config.tokenPrices || {}), ...prices };
          dashOverrides.tokenPrices = { ...dashOverrides.tokenPrices, ...prices };
          saveOverrides();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, tokenPrices: config.tokenPrices }));
        } catch (e) {
          sendError(res, 400, `invalid: ${e.message}`);
        }
      }).catch(() => sendError(res, 400, "invalid body"));
      return;
    }
    // GET /v1/profiles — the full profile picture for the dashboard: the declared profiles,
    // the auto ladder, the default, the live routing state, and the ready-to-render banner
    // summary (active/intended/source/shifted + the alias→target changes vs default).
    if (dashboard && req.method === "GET" && req.url === "/v1/profiles") {
      const providerOf = (m) => { const r = pickRoute(m, config.routes); return r ? providerIdFromUrl(r.base_url) : null; };
      const recoveryMs = recoveryWaitMs(config, profileState.attempts || 0);
      const summary = routingSummary(config, profileState, Date.now(), { providerOf, recoveryMs });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        profiles: config.profiles || {},
        auto: config.auto || null,
        defaultProfile: defaultProfile(config),
        state: { pinned: profileState.pinned, offset: profileState.offset || 0, shiftedAt: profileState.shiftedAt || 0 },
        summary,
      }));
      return;
    }
    // POST /v1/profiles/pin — set (or clear) the manual pin. Body: { profile: "<name>" } to pin,
    // { profile: null } (or "") to clear. A pin/clear is a fresh operator intent, so it also
    // drops any active error-shift (offset → 0). The pinned profile must be a declared one.
    if (dashboard && req.method === "POST" && req.url === "/v1/profiles/pin") {
      readBody(req, 4096).then((body) => {
        try {
          const data = JSON.parse(body.toString("utf8"));
          const name = data && data.profile;
          if (name === null || name === undefined || name === "") {
            profileState.pinned = null;
          } else if (typeof name === "string" && config.profiles && config.profiles[name]) {
            profileState.pinned = name;
          } else {
            throw new Error(`unknown profile "${name}"`);
          }
          profileState.offset = 0; profileState.shiftedAt = 0; profileState.attempts = 0;
          persistProfileState(profileState);
          const providerOf = (m) => { const r = pickRoute(m, config.routes); return r ? providerIdFromUrl(r.base_url) : null; };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, state: { pinned: profileState.pinned, offset: 0 }, summary: routingSummary(config, profileState, Date.now(), { providerOf }) }));
        } catch (e) {
          sendError(res, 400, `invalid: ${e.message}`);
        }
      }).catch(() => sendError(res, 400, "invalid body"));
      return;
    }
    // POST /v1/profiles/reset — full reset to the default head: clear the pin AND any error-shift.
    if (dashboard && req.method === "POST" && req.url === "/v1/profiles/reset") {
      profileState.pinned = null; profileState.offset = 0; profileState.shiftedAt = 0; profileState.attempts = 0;
      persistProfileState(profileState);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // POST /v1/profiles/config — replace the profile DEFINITIONS + switching rules in-memory and
    // persist (authoritative across restart, like compact). Body: { profiles, defaultProfile?, auto? }.
    // The whole candidate config is run through validateConfig (so auto.steps/schedules/defaultProfile
    // referential integrity + the legacy-field rejection all apply) — nothing is applied unless it
    // validates. An edit is fresh intent, so it clears any error-shift; a pin to a now-deleted
    // profile is dropped. No restart needed — forward() reads the same live `config` object.
    if (dashboard && req.method === "POST" && req.url === "/v1/profiles/config") {
      readBody(req, 262144).then((body) => {
        try {
          const data = JSON.parse(body.toString("utf8"));
          if (!data || typeof data !== "object" || !data.profiles || typeof data.profiles !== "object") {
            throw new Error("must be an object { profiles, defaultProfile?, auto? }");
          }
          // Build a candidate from the live config, swapping ONLY the profile layer. Empty auto /
          // defaultProfile are treated as absent (optional) so validateConfig applies its defaults.
          const candidate = { ...config, profiles: data.profiles };
          if (data.auto && typeof data.auto === "object" && Array.isArray(data.auto.steps) && data.auto.steps.length) candidate.auto = data.auto;
          else delete candidate.auto;
          if (typeof data.defaultProfile === "string" && data.defaultProfile) candidate.defaultProfile = data.defaultProfile;
          else delete candidate.defaultProfile;
          validateConfig(candidate); // throws on any problem — nothing mutated yet
          // Apply live.
          config.profiles = candidate.profiles;
          config.auto = candidate.auto || undefined;
          config.defaultProfile = candidate.defaultProfile || undefined;
          // Reset the shift (the chain may have changed) and drop a pin to a vanished profile.
          if (profileState.pinned && !config.profiles[profileState.pinned]) profileState.pinned = null;
          profileState.offset = 0; profileState.shiftedAt = 0; profileState.attempts = 0;
          persistProfileState(profileState);
          // Persist the override (authoritative). null = fall back to the file on next start.
          dashOverrides.profiles = config.profiles;
          dashOverrides.auto = config.auto || null;
          dashOverrides.defaultProfile = config.defaultProfile || null;
          saveOverrides();
          const providerOf = (m) => { const r = pickRoute(m, config.routes); return r ? providerIdFromUrl(r.base_url) : null; };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            ok: true,
            profiles: config.profiles,
            auto: config.auto || null,
            defaultProfile: defaultProfile(config),
            state: { pinned: profileState.pinned, offset: 0 },
            summary: routingSummary(config, profileState, Date.now(), { providerOf }),
          }));
        } catch (e) {
          sendError(res, 400, `invalid: ${e.message}`);
        }
      }).catch(() => sendError(res, 400, "invalid body"));
      return;
    }

    // GET /v1/compact — the live, normalized context-compaction config (for the dashboard UI).
    if (dashboard && req.method === "GET" && req.url === "/v1/compact") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ compact: config.compact }));
      return;
    }
    // POST /v1/compact — replace the compaction config in-memory + persist (authoritative).
    // Body: the compact object, or { compact: {...} }. Validated the SAME way as the file.
    if (dashboard && req.method === "POST" && req.url === "/v1/compact") {
      readBody(req, 16384).then((body) => {
        try {
          const data = JSON.parse(body.toString("utf8"));
          const raw = (data && typeof data === "object" && data.compact) ? data.compact : data;
          const norm = validateCompact(raw, "compact");
          config.compact = norm;
          dashOverrides.compact = norm;
          saveOverrides();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, compact: config.compact }));
        } catch (e) {
          sendError(res, 400, `invalid: ${e.message}`);
        }
      }).catch(() => sendError(res, 400, "invalid body"));
      return;
    }

    // GET /v1/concurrency — configured per-model limits + the live queue state (honest, real
    // active/queued counts from the limiter — never a fabricated number).
    if (dashboard && req.method === "GET" && req.url === "/v1/concurrency") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        config: config.concurrency || {},
        queueTimeoutMs: queueTimeoutOf(config),
        // key is "providerId\u0000model"; split for a readable dashboard row.
        live: limiter.snapshot().map((s) => {
          const sep = s.key.indexOf("\u0000");
          return { provider: sep >= 0 ? s.key.slice(0, sep) : s.key, model: sep >= 0 ? s.key.slice(sep + 1) : "", active: s.active, limit: s.limit, effLimit: s.effLimit, queued: s.queued };
        }),
      }));
      return;
    }
    // POST /v1/concurrency — replace the per-model concurrency limits in-memory + persist
    // (authoritative, same pattern as compact/schedules). Body: the { modelGlob: max } map, or
    // { concurrency: {...} } / { concurrency, queueTimeoutMs }. Validated the SAME way as the file.
    if (dashboard && req.method === "POST" && req.url === "/v1/concurrency") {
      readBody(req, 16384).then((body) => {
        try {
          const data = JSON.parse(body.toString("utf8"));
          if (!data || typeof data !== "object") throw new Error("must be an object { modelGlob: maxConcurrent }");
          const map = (data.concurrency && typeof data.concurrency === "object") ? data.concurrency : data;
          const clean = {};
          for (const [glob, limit] of Object.entries(map)) {
            if (glob === "concurrency" || glob === "queueTimeoutMs") continue; // envelope keys, not globs
            if (typeof glob !== "string" || glob.length === 0) throw new Error(`key "${glob}" must be a non-empty model glob`);
            if (!Number.isInteger(limit) || limit < 1) throw new Error(`"${glob}": must be a positive integer`);
            try { globToRegExp(glob); } catch (ge) { throw new Error(`key "${glob}" is not a valid glob: ${ge.message}`); }
            clean[glob] = limit;
          }
          if (data.queueTimeoutMs !== undefined) {
            if (typeof data.queueTimeoutMs !== "number" || data.queueTimeoutMs < 1000) throw new Error("queueTimeoutMs must be a number >= 1000");
            config.concurrencyQueueTimeoutMs = data.queueTimeoutMs;
          }
          // The posted set is authoritative (replace) — a limit removed in the UI stays removed.
          config.concurrency = clean;
          dashOverrides.concurrency = clean;
          saveOverrides();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, concurrency: config.concurrency, queueTimeoutMs: queueTimeoutOf(config) }));
        } catch (e) {
          sendError(res, 400, `invalid: ${e.message}`);
        }
      }).catch(() => sendError(res, 400, "invalid body"));
      return;
    }

    // GET /v1/compact — the live, normalized context-compaction config (for the dashboard UI).
    if (dashboard && req.method === "GET" && req.url === "/v1/compact") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ compact: config.compact }));
      return;
    }
    // POST /v1/compact — replace the compaction config in-memory + persist (authoritative).
    // Body: the compact object, or { compact: {...} }. Validated the SAME way as the file.
    if (dashboard && req.method === "POST" && req.url === "/v1/compact") {
      readBody(req, 16384).then((body) => {
        try {
          const data = JSON.parse(body.toString("utf8"));
          const raw = (data && typeof data === "object" && data.compact) ? data.compact : data;
          const norm = validateCompact(raw, "compact");
          config.compact = norm;
          dashOverrides.compact = norm;
          saveOverrides();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, compact: config.compact }));
        } catch (e) {
          sendError(res, 400, `invalid: ${e.message}`);
        }
      }).catch(() => sendError(res, 400, "invalid body"));
      return;
    }

    // GET /v1/concurrency — configured per-model limits + the live queue state (honest, real
    // active/queued counts from the limiter — never a fabricated number).
    if (dashboard && req.method === "GET" && req.url === "/v1/concurrency") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        config: config.concurrency || {},
        queueTimeoutMs: queueTimeoutOf(config),
        // key is "providerId\u0000model"; split for a readable dashboard row.
        live: limiter.snapshot().map((s) => {
          const sep = s.key.indexOf("\u0000");
          return { provider: sep >= 0 ? s.key.slice(0, sep) : s.key, model: sep >= 0 ? s.key.slice(sep + 1) : "", active: s.active, limit: s.limit, effLimit: s.effLimit, queued: s.queued };
        }),
      }));
      return;
    }
    // POST /v1/concurrency — replace the per-model concurrency limits in-memory + persist
    // (authoritative, same pattern as compact/schedules). Body: the { modelGlob: max } map, or
    // { concurrency: {...} } / { concurrency, queueTimeoutMs }. Validated the SAME way as the file.
    if (dashboard && req.method === "POST" && req.url === "/v1/concurrency") {
      readBody(req, 16384).then((body) => {
        try {
          const data = JSON.parse(body.toString("utf8"));
          if (!data || typeof data !== "object") throw new Error("must be an object { modelGlob: maxConcurrent }");
          const map = (data.concurrency && typeof data.concurrency === "object") ? data.concurrency : data;
          const clean = {};
          for (const [glob, limit] of Object.entries(map)) {
            if (glob === "concurrency" || glob === "queueTimeoutMs") continue; // envelope keys, not globs
            if (typeof glob !== "string" || glob.length === 0) throw new Error(`key "${glob}" must be a non-empty model glob`);
            if (!Number.isInteger(limit) || limit < 1) throw new Error(`"${glob}": must be a positive integer`);
            try { globToRegExp(glob); } catch (ge) { throw new Error(`key "${glob}" is not a valid glob: ${ge.message}`); }
            clean[glob] = limit;
          }
          if (data.queueTimeoutMs !== undefined) {
            if (typeof data.queueTimeoutMs !== "number" || data.queueTimeoutMs < 1000) throw new Error("queueTimeoutMs must be a number >= 1000");
            config.concurrencyQueueTimeoutMs = data.queueTimeoutMs;
          }
          // The posted set is authoritative (replace) — a limit removed in the UI stays removed.
          config.concurrency = clean;
          dashOverrides.concurrency = clean;
          saveOverrides();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, concurrency: config.concurrency, queueTimeoutMs: queueTimeoutOf(config) }));
        } catch (e) {
          sendError(res, 400, `invalid: ${e.message}`);
        }
      }).catch(() => sendError(res, 400, "invalid body"));
      return;
    }

    // GET /v1/accounts — per-route account-pool state (labels, strategy, cooldowns).
    if (dashboard && req.method === "GET" && req.url === "/v1/accounts") {
      const now = Date.now();
      const pools = [];
      for (const route of config.routes) {
        const pool = accountPools.get(route);
        if (!pool) continue;
        pools.push({
          match: route.match,
          strategy: pool.strategy,
          accounts: pool.accounts.map((a) => ({
            label: a.label,
            exhausted: (a.exhaustedUntil || 0) > now,
            cooldownUntil: a.exhaustedUntil || 0,
            // How many ms remain on the current park (0 when live) and how far up the
            // progressive-cooldown ladder this account has climbed (0 = fresh / recovered).
            cooldownRemainingMs: Math.max(0, (a.exhaustedUntil || 0) - now),
            attempts: a.attempts || 0,
          })),
        });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ pools }));
      return;
    }
    // POST /v1/billing — override a provider's/account's billing mode for the dashboard.
    // Body: { provider: "<id or label>", mode: "metered" | "subscription" | "auto" }.
    // "auto" clears the override (back to the derived default). Persisted.
    if (dashboard && req.method === "POST" && req.url === "/v1/billing") {
      readBody(req, 2048).then((body) => {
        try {
          const data = JSON.parse(body.toString("utf8"));
          const prov = data && data.provider;
          const mode = data && data.mode;
          if (typeof prov !== "string" || prov.length === 0) throw new Error("provider (id/label) required");
          if (mode === "auto" || mode == null) delete dashOverrides.billing[prov];
          else if (mode === "metered" || mode === "subscription") dashOverrides.billing[prov] = mode;
          else throw new Error('mode must be "metered", "subscription", or "auto"');
          saveOverrides();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, billing: dashOverrides.billing }));
        } catch (e) {
          sendError(res, 400, `invalid: ${e.message}`);
        }
      }).catch(() => sendError(res, 400, "invalid body"));
      return;
    }
    // POST /v1/accounts/reset — clear account cooldowns without a restart.
    //   (no param)   → clear every account's cooldown in every pool
    //   ?label=<l>   → clear one account's cooldown by label
    if (dashboard && req.method === "POST" &&
        (req.url === "/v1/accounts/reset" || req.url.startsWith("/v1/accounts/reset?"))) {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const label = url.searchParams.get("label");
      let cleared = 0;
      for (const pool of accountPools.values()) {
        for (const a of pool.accounts) {
          if (label && a.label !== label) continue;
          if ((a.exhaustedUntil || 0) > 0 || (a.attempts || 0) > 0) { a.exhaustedUntil = 0; a.attempts = 0; cleared++; }
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, cleared }));
      return;
    }

    // GET /v1/models (and /models) — model discovery. Served locally from the route
    // config (listModels). Accepts any query string (e.g. ?limit=1000 from the gateway
    // protocol) — the path alone decides.
    if (req.method === "GET" && (req.url.split("?")[0] === "/v1/models" || req.url.split("?")[0] === "/models")) {
      const models = listModels(config);
      // Apply dashboard billing overrides (by provider id, or by account label for pools).
      if (dashboard) {
        for (const m of models) {
          if (dashOverrides.billing[m.provider]) m.billing = dashOverrides.billing[m.provider];
          if (Array.isArray(m.accounts)) {
            for (const a of m.accounts) if (dashOverrides.billing[a.label]) a.billing = dashOverrides.billing[a.label];
          }
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: models }));
      return;
    }

    // HEAD / — connectivity probe (best-effort startup traffic). Respond locally.
    if (req.method === "HEAD" && (req.url === "/" || req.url === "")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end();
      return;
    }

    // GET / HEAD requests to every other path — proxy them through the default route
    // (passthrough or first route) so auxiliary endpoints (model discovery from the
    // real upstream, connectivity probes that reach past the proxy, count_tokens, etc.)
    // work without requiring a routable model id in the body.
    const defaultRoute = findDefaultRoute(config.routes);
    if (defaultRoute && (req.method === "GET" || req.method === "HEAD")) {
      const statsCtx = dashboard ? { stats, startTime: Date.now() } : null;
      proxyToRoute(defaultRoute, req, res, Buffer.alloc(0), log, {
        statsCtx,
        providerId: providerIdFromUrl(defaultRoute.base_url),
        limiter,
        concLimit: 0, // no concurrency limiting for GET/HEAD
        queueTimeoutMs: queueTimeoutOf(config),
      });
      return;
    }

    // Everything else (POST, PUT, etc.) — read body and route by model (or fall back to default).
    readBody(req, maxBytes)
      .then((body) => {
        const statsCtx = dashboard ? { stats, startTime: Date.now() } : null;
        forward(config, req, res, body, log, nonVisionCache, statsCtx, profileState, accountPools, learnedWindows, limiter);
      })
      .catch((err) => sendError(res, err.status || 400, err.message || "bad request"));
  });

  // Expose internals for teardown + assertions in tests.
  server._modelpipe = { stats, quotaPoller, profileState, profilePinger, accountPools, limiter };

  // Archive session on graceful shutdown
  server.on("close", () => {
    if (stats) stats.shutdown();
    if (quotaPoller) quotaPoller.stop();
    if (profilePinger) profilePinger.stop();
    if (concurrencyRecoveryTimer) clearInterval(concurrencyRecoveryTimer);
  });

  return server;
}

// CLI entry: node src/router.mjs <config.json>  (or MODEL_ROUTER_CONFIG=<path>).
// The packaged `modelpipe` bin (bin/modelpipe.mjs) is the supported entry point and
// adds a --port override; this remains for a direct `node src/router.mjs` run.
function main() {
  const configPath = process.argv[2] || process.env.MODEL_ROUTER_CONFIG;
  if (!configPath) {
    process.stderr.write("usage: node src/router.mjs <config.json>  (or set MODEL_ROUTER_CONFIG)\n");
    process.exit(2);
  }
  const config = loadConfig(configPath);
  const host = (config.listen && config.listen.host) || "127.0.0.1";
  const port = (config.listen && config.listen.port) || 8787;
  createRouter(config).listen(port, host, () => {
    process.stderr.write(`[model-router] listening on http://${host}:${port} (${config.routes.length} routes)\n`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
