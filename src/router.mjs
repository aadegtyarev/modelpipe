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
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  StatsCollector, QuotaPoller, DASHBOARD_HTML,
  createUsageTracker, providerIdFromUrl,
  decompressIfNeeded,
} from "./stats.mjs";
import { readJson, writeJson, OVERRIDES_FILE } from "./store.mjs";
import {
  fitToWindow, resolveWindow, isContextOverflow, parseOverflowLimit, bodyTokens, COMPACT_DEFAULTS,
} from "./compact.mjs";
import { ConcurrencyLimiter, resolveConcurrencyLimit } from "./concurrency.mjs";

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

// The first failover pair whose key glob matches the model id; null when no
// failover config is present or no pair matches. Keys are model globs (same `*`
// syntax as route match), values are the backup model id to rewrite the body to.
export function pickFailoverModel(failoverConfig, model) {
  if (!failoverConfig || typeof failoverConfig !== "object") return null;
  if (typeof model !== "string" || model.length === 0) return null;
  for (const [pattern, backup] of Object.entries(failoverConfig)) {
    if (typeof pattern !== "string" || typeof backup !== "string") continue;
    if (globToRegExp(pattern).test(model)) return backup;
  }
  return null;
}

// ── Failover groups (coordinated "shift the whole ladder") ────────────────────
// A failover GROUP is an ordered ladder of model ids — a shared priority chain that
// multiple models ride together. Unlike a plain `failover` pair (which reroutes only
// the ONE model that erred), a group in `mode: "shift"` moves the ENTIRE ladder down
// by one when its HEAD tier fails: e.g. ladder ["claude-opus-*","glm-5.1","deepseek-v4-pro"]
// with the head on Anthropic — when Anthropic errors, opus→glm AND glm's own traffic
// →deepseek at the same time (a group `offset` of 1 applied to every position). When the
// head recovers, the offset winds back. `mode: "cascade"` skips the global shift and just
// walks the ladder per-request on error (the same shape as a plain `failover` chain, but
// expressed as one ordered list). Groups take precedence over `failover` pairs for any
// model whose id lands on a ladder.

// Pure: the index of the first ladder entry that matches `model` — an exact id match, or
// a glob match when the entry carries a `*` (only the head is allowed to be a glob; see
// validateConfig). -1 when no entry matches or inputs are malformed.
export function ladderPosition(ladder, model) {
  if (!Array.isArray(ladder) || typeof model !== "string" || model.length === 0) return -1;
  for (let i = 0; i < ladder.length; i++) {
    const entry = ladder[i];
    if (typeof entry !== "string") continue;
    if (entry === model) return i;
    if (entry.includes("*") && globToRegExp(entry).test(model)) return i;
  }
  return -1;
}

// Pure: the effective tier id a request at ladder position `p` resolves to given the
// group's current `offset`, clamped to the last tier (never runs off the end).
export function effectiveLadderModel(ladder, offset, p) {
  const last = ladder.length - 1;
  return ladder[Math.min(p + (offset || 0), last)];
}

// A ready-to-consume, machine-readable signal of what the HEAD slot resolves to RIGHT NOW —
// so an external consumer (statusline, an out-of-harness compaction trigger, the dashboard)
// reads ONE field and reacts, without re-deriving `effective[offset]` or keeping its own
// model→window table. modelpipe already knows the truth of a downshift; this surfaces it.
//
// The head is served by the FIRST failover group (the one carrying the head slot). Returns
// null when no group is configured (there is no coordinated head to speak of — plain pairs
// reroute per-model, they don't shift a shared head). Shape:
//   believed        — the configured head (offset 0): what the client still thinks it's on
//   head            — the model actually serving the head now (after any shift)
//   window          — head's effective context window, from effectiveWindow (→ resolveWindow,
//                     min'd with any learned ceiling) — the SINGLE source, never client-sized
//   shifted         — offset > 0 (fast branch for a consumer)
//   recoversInSec   — ETA to the next head-recovery probe window (shiftedAt + recoveryWaitMs);
//                     null when healthy
//   accountCooldown — seconds until the head model's account pool has a live key again, when
//                     every key is currently parked on its progressive backoff; else null
export function computeEffectiveHead(config, groupState, learnedWindows, accountPools, now) {
  const groups = config && config.failoverGroups;
  if (!Array.isArray(groups) || groups.length === 0) return null;
  const grp = groups[0];
  const gs = (groupState && groupState[0]) || { offset: 0, shiftedAt: 0, attempts: 0, nextProbeAt: 0 };
  const ladder = grp.ladder;
  const offset = gs.offset || 0;
  const believed = ladder[0];
  const head = effectiveLadderModel(ladder, offset, 0);
  const shifted = offset > 0;
  const window = effectiveWindow(config.compact || {}, learnedWindows || {}, head);

  let recoversInSec = null;
  if (shifted) {
    const due = (gs.shiftedAt || 0) + recoveryWaitMs(config, gs.attempts || 0);
    recoversInSec = Math.max(0, Math.ceil((due - now) / 1000));
  }

  // If the head model's backend is an account pool with every key parked, report how long
  // until the soonest one frees (progressive account backoff). A single-key backend, a live
  // key, or a glob head that resolves to no route all report null.
  let accountCooldown = null;
  const headRoute = pickRoute(head, config.routes);
  const pool = headRoute && accountPools && accountPools.get(headRoute);
  if (pool && pool.accounts.length) {
    const anyLive = pool.accounts.some((a) => (a.exhaustedUntil || 0) <= now);
    if (!anyLive) {
      const soonest = Math.min(...pool.accounts.map((a) => a.exhaustedUntil || 0));
      accountCooldown = Math.max(0, Math.ceil((soonest - now) / 1000));
    }
  }

  return { believed, head, window, shifted, recoversInSec, accountCooldown };
}

// Pure: resolve which group (if any) a model rides, its position on that ladder, the
// group's current offset, and the effective tier to route to. `groupState` is a parallel
// array of { offset } (per group). null when no ladder matches.
export function resolveGroup(groups, groupState, model) {
  if (!Array.isArray(groups)) return null;
  for (let g = 0; g < groups.length; g++) {
    const grp = groups[g];
    const p = ladderPosition(grp && grp.ladder, model);
    if (p >= 0) {
      const offset = (groupState && groupState[g] && groupState[g].offset) || 0;
      return {
        groupIndex: g,
        position: p,
        offset,
        effIndex: Math.min(p + offset, grp.ladder.length - 1),
        effectiveModel: effectiveLadderModel(grp.ladder, offset, p),
        mode: grp.mode || "shift",
      };
    }
  }
  return null;
}

// ── Scheduled routing (time-of-day cost control) ──────────────────────────────
// A SCHEDULE proactively rewrites a model id during a wall-clock window — e.g. a
// provider that bills a peak-hours multiplier (GLM: GLM-5.2 / GLM-5-Turbo cost 3x
// quota 14:00–18:00 UTC+8) can be dodged by dropping to a cheaper same-plan tier for
// those hours only. Unlike `failover`/`failoverGroups` (reactive, on error), a schedule
// fires on EVERY matching request while its window is open. The window is expressed in
// the PROVIDER's timezone (a fixed UTC offset) and evaluated against the system clock via
// the UTC epoch — so it is correct no matter how the host machine's local timezone is set.

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

// Pure: minute-of-day (0..1439) at UTC offset `offsetMinutes` for epoch ms `nowMs`.
function minuteOfDayAt(nowMs, offsetMinutes) {
  const shifted = nowMs + offsetMinutes * 60000;
  const dayMs = ((shifted % 86400000) + 86400000) % 86400000;
  return Math.floor(dayMs / 60000);
}

// Pure: the replacement model id for `model` if any schedule window is open at epoch
// `nowMs`, else null. First matching schedule with an open window wins; a schedule whose
// `to` equals the incoming model id is a no-op and skipped. `schedules` is the validated
// config.schedules array — each { match: glob, to: model id, tz: offset, windows: [[from,to]] }.
export function resolveSchedule(schedules, model, nowMs) {
  if (!Array.isArray(schedules) || typeof model !== "string" || model.length === 0) return null;
  for (const s of schedules) {
    if (!s || typeof s.to !== "string" || s.to === model) continue;
    if (typeof s.match !== "string" || !globToRegExp(s.match).test(model)) continue;
    const off = parseTzOffset(s.tz);
    if (off == null) continue;
    const minute = minuteOfDayAt(nowMs, off);
    const windows = Array.isArray(s.windows) ? s.windows : [];
    for (const w of windows) {
      const from = parseHHMM(w && w[0]);
      const to = parseHHMM(w && w[1]);
      if (from == null || to == null) continue;
      if (inWindow(minute, from, to)) return s.to;
    }
  }
  return null;
}

// Validate a schedules array the SAME way whether it arrives from the config file or the
// dashboard POST (no weaker path than the file). Throws on the first problem; returns a
// normalized copy ({ match, to, tz, windows } only) on success. `prefix` labels errors.
export function validateSchedules(schedules, prefix = "config.schedules") {
  if (!Array.isArray(schedules)) throw new Error(`${prefix}: must be an array of { match, to, tz, windows }`);
  return schedules.map((s, i) => {
    const at = `${prefix}[${i}]`;
    if (!s || typeof s !== "object") throw new Error(`${at}: must be an object { match, to, tz, windows }`);
    if (typeof s.match !== "string" || s.match.length === 0) throw new Error(`${at}.match: must be a non-empty model glob`);
    try { globToRegExp(s.match); } catch (e) { throw new Error(`${at}.match: not a valid glob: ${e.message}`); }
    if (typeof s.to !== "string" || s.to.length === 0) throw new Error(`${at}.to: must be a non-empty model id`);
    if (parseTzOffset(s.tz) == null) throw new Error(`${at}.tz: must be a fixed UTC offset like "+08:00" (or "Z")`);
    if (!Array.isArray(s.windows) || s.windows.length === 0) throw new Error(`${at}.windows: must be a non-empty array of ["HH:MM","HH:MM"] pairs`);
    const windows = s.windows.map((w, j) => {
      if (!Array.isArray(w) || w.length !== 2 || parseHHMM(w[0]) == null || parseHHMM(w[1]) == null) {
        throw new Error(`${at}.windows[${j}]: must be ["HH:MM","HH:MM"] with valid 24h times`);
      }
      return [w[0], w[1]];
    });
    return { match: s.match, to: s.to, tz: s.tz == null ? "Z" : s.tz, windows };
  });
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
  // failover: optional object mapping model globs to backup model ids. E.g.
  // { "claude-opus-*": "glm-5.1", "glm-5.1": "deepseek-v4-pro" }.
  // When a matched model's upstream returns a rate-limit / temporary-unavailable
  // error, the router rewrites the body's model to the backup id and reroutes.
  if (config.failover !== undefined) {
    if (!config.failover || typeof config.failover !== "object") throw new Error("config.failover: must be an object { modelGlob: backupModelId }");
    for (const [pattern, backup] of Object.entries(config.failover)) {
      if (typeof pattern !== "string" || pattern.length === 0) throw new Error(`config.failover: key "${pattern}" must be a non-empty model glob`);
      if (typeof backup !== "string" || backup.length === 0) throw new Error(`config.failover: value for "${pattern}" must be a non-empty backup model id`);
      try {
        globToRegExp(pattern);
      } catch (e) {
        throw new Error(`config.failover: key "${pattern}" is not a valid glob: ${e.message}`);
      }
    }
  }
  // failoverGroups: optional array of ordered ladders. Each group is
  // { ladder: [modelId, ...], mode?: "shift" | "cascade" }. In "shift" mode a head-tier
  // failure shifts the whole ladder down one (opus→glm AND glm→deepseek together);
  // "cascade" just walks the ladder per-request on error. The head (index 0) may be a
  // glob; every lower tier is a rewrite target and MUST be a concrete model id.
  if (config.failoverGroups !== undefined) {
    if (!Array.isArray(config.failoverGroups)) {
      throw new Error("config.failoverGroups: must be an array of { ladder, mode? }");
    }
    for (const [i, grp] of config.failoverGroups.entries()) {
      const at = `config.failoverGroups[${i}]`;
      if (!grp || typeof grp !== "object") throw new Error(`${at}: must be an object { ladder, mode? }`);
      if (!Array.isArray(grp.ladder) || grp.ladder.length < 2) {
        throw new Error(`${at}.ladder: must be an array of at least 2 model ids`);
      }
      for (const [j, entry] of grp.ladder.entries()) {
        if (typeof entry !== "string" || entry.length === 0) {
          throw new Error(`${at}.ladder[${j}]: must be a non-empty model id`);
        }
        // Lower tiers are rewrite targets — a glob there would forward `*` to a backend.
        if (j >= 1 && entry.includes("*")) {
          throw new Error(`${at}.ladder[${j}] "${entry}": only the head (index 0) may be a glob; lower tiers are rewrite targets and must be concrete model ids`);
        }
      }
      if (grp.mode !== undefined && grp.mode !== "shift" && grp.mode !== "cascade") {
        throw new Error(`${at}.mode: must be "shift" or "cascade" (default "shift")`);
      }
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
  // schedules: optional array of time-window model rewrites (proactive cost control) —
  // see validateSchedules / resolveSchedule. Normalized in place so the running config
  // carries a clean copy.
  if (config.schedules !== undefined) {
    config.schedules = validateSchedules(config.schedules);
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
  // failover maps model globs → backup model ids; model ids and globs are not secrets.
  if (config && config.failover !== undefined) safe.failover = config.failover;
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
  if (config && Array.isArray(config.failoverGroups)) safe.failoverGroups = config.failoverGroups;
  // schedules hold model ids/globs + wall-clock windows — no secrets, safe to surface.
  if (config && Array.isArray(config.schedules)) safe.schedules = config.schedules;
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
      ctx.stats.record({ providerId: ctx.providerId, model: ctx.model, durationMs: Date.now() - ctx.startTime, inputTokens: 0, outputTokens: 0, status: 502 });
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

// Record a zero-token error/relay stat for the tier a ctx is currently on. No-op when
// the dashboard is off.
function recordStat(ctx, status) {
  if (ctx.statsCtx && ctx.statsCtx.stats) {
    ctx.statsCtx.stats.record({
      providerId: ctx.providerId, model: ctx.model,
      durationMs: Date.now() - ctx.statsCtx.startTime,
      inputTokens: 0, outputTokens: 0, status,
    });
  }
}

// Handle a failover-triggering error for a request riding a failover GROUP ladder.
// In "shift" mode, a failing HEAD tier bumps the group's shared offset so the whole
// ladder moves down one for future traffic; in either mode THIS request advances to the
// next tier down (depth-guarded by the caller's hop check).
function handleGroupFailover(ctx, status, buffered, headers, hop) {
  const g = ctx.group.groupIndex;
  const grp = ctx.config.failoverGroups[g];
  const gs = ctx.groupState[g];
  const ladder = grp.ladder;
  const last = ladder.length - 1;
  const currentEff = ctx.groupEffIndex != null ? ctx.groupEffIndex : Math.min(ctx.group.position + gs.offset, last);

  // SHIFT: the tier serving ladder position 0 (index === offset) is the head. When it
  // fails, shift the whole ladder down one — every rider moves together next time.
  if (ctx.group.mode === "shift" && currentEff === gs.offset && gs.offset < last) {
    gs.offset++;
    gs.shiftedAt = Date.now();
    gs.attempts = 0; gs.nextProbeAt = 0; // fresh backoff schedule for the newly-shifted tier
    ctx.log(`failover-group[${g}]: head tier "${ladder[currentEff]}" failing (status ${status}) — shift offset -> ${gs.offset} (whole ladder moves down one)`);
  }

  // Advance THIS request to the next tier down.
  const nextIdx = Math.min(currentEff + 1, last);
  if (nextIdx === currentEff) {
    // Already at the last tier — nothing lower to try. Relay the error verbatim.
    recordStat(ctx, status);
    relayBuffered(ctx.res, status, headers, buffered);
    return;
  }
  const nextModel = ladder[nextIdx];
  const nextRoute = pickRoute(nextModel, ctx.config.routes);
  if (!nextRoute) {
    recordStat(ctx, 502);
    sendError(ctx.res, 502, `failover group tier "${nextModel}" has no matching route`);
    return;
  }
  recordStat(ctx, status); // record the original error on the tier that failed
  ctx.log(`failover-group[${g}]: ${ctx.model} -> ${nextModel} (status ${status}, retrying, hop ${hop + 1})`);
  const nextBody = rewriteModelInBody(ctx.body, nextModel);
  dispatch(nextRoute, nextBody, ctx, {
    model: nextModel,
    isVisionTarget: nextRoute === ctx.visionRoute,
    failoverHopCount: hop + 1,
    groupEffIndex: nextIdx,
    groupProbe: null, // a reroute is no longer the head-recovery probe — don't wind back on its success
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

    // A group recovery PROBE (a head-position request the pre-route sent one tier up during
    // cooldown) that comes back WITHOUT a failover-triggering error means the head has
    // recovered → wind the whole ladder back up one. Called on the success/relay paths, not
    // when the probe itself triggers failover (then the offset stays and it re-serves lower).
    const windBackProbe = () => {
      const p = ctx.groupProbe;
      if (!p || !ctx.groupState) return;
      const gs = ctx.groupState[p.groupIndex];
      if (gs && gs.offset === p.fromOffset) {
        gs.offset = p.windTo;
        gs.shiftedAt = Date.now();
        gs.attempts = 0; gs.nextProbeAt = 0; // recovered — reset the backoff schedule
        ctx.log(`failover-group[${p.groupIndex}]: head recovered on a live request — shift offset -> ${gs.offset}`);
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
    const isFailoverCandidate = (ctx.failoverConfig || ctx.group || (ctx.account && ctx.route))
      && (status === 400 || status === 429 || status === 529 || (status >= 500 && status < 600));
    // 413 is also buffered so the context-overflow safety net can classify it (some backends
    // signal an oversized request with 413 rather than a 400).
    const compactOn = ctx.config.compact && ctx.config.compact.enabled;
    if (status !== 400 && !(compactOn && status === 413) && !isFailoverCandidate) {
      windBackProbe(); // a non-candidate response to a recovery probe = head is back
      resetAccountBackoff(); // a clean answer means this account's cooldown ladder resets
      pipeResponse(upstreamRes, ctx.res, ctx.statsCtx
        ? { stats: ctx.statsCtx.stats, providerId: ctx.providerId, model: ctx.model, startTime: ctx.statsCtx.startTime }
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
          recordStat(ctx, status);
          ctx.log(`compact: context overflow from ${ctx.model} — hard-trim + retry ${attempt + 1}/${maxRetries}`);
          dispatch(ctx.route, trimmed, ctx, { model: ctx.model, overflowRetry: attempt + 1 });
          return;
        }
        if (ctx.statsCtx && ctx.statsCtx.stats) {
          ctx.statsCtx.stats.record({ providerId: ctx.providerId, model: ctx.model, durationMs: Date.now() - ctx.statsCtx.startTime, inputTokens: 0, outputTokens: 0, status });
        }
        relayBuffered(ctx.res, status, headers, buffered);
        return;
      }

      // 1. FAILOVER CHECK: a rate-limit or temporary-unavailable error from a backend
      //    that has a configured backup model → reroute to the backup.
      if (isFailoverCandidate && isFailoverTrigger(status, buffered)) {
        // Chain-depth guard — prevent infinite failover loops.
        const hop = ctx.failoverHopCount || 0;
        if (hop >= MAX_FAILOVER_HOPS) {
          if (ctx.statsCtx && ctx.statsCtx.stats) {
            ctx.statsCtx.stats.record({ providerId: ctx.providerId, model: ctx.model, durationMs: Date.now() - ctx.statsCtx.startTime, inputTokens: 0, outputTokens: 0, status: 502 });
          }
          sendError(ctx.res, 502, `failover chain limit (${MAX_FAILOVER_HOPS} hops) reached — could not route "${ctx.model}"`);
          return;
        }

        // ACCOUNT ROTATION (innermost): the current route has an account pool → park the
        // failed account for a cooldown and retry the SAME request (same model, no body
        // rewrite) on the next eligible account. Only when the pool has no live account left
        // do we fall through to model-level failover (group/pairs).
        if (ctx.account && ctx.route && ctx.accountPools) {
          const pool = ctx.accountPools.get(ctx.route);
          if (pool) {
            const now = Date.now();
            // PROGRESSIVE cooldown: park the exhausted account for recoveryWaitMs(attempts) —
            // the SAME 1→5→10-min ladder (config.failoverRecoveryBackoffMs) model failover
            // rides, not a flat 60s. attempts counts consecutive limit-hits on THIS account;
            // it climbs the ladder each repeat park and is reset to 0 the next time the account
            // serves a request cleanly (recovery). Falls back to the flat cooldown when no
            // backoff schedule is configured.
            const exhausted = pool.accounts[ctx.account.idx];
            exhausted.exhaustedUntil = now + recoveryWaitMs(ctx.config, exhausted.attempts || 0);
            exhausted.attempts = (exhausted.attempts || 0) + 1;
            const nextIdx = pickAccountIndex(pool, now, ctx.account.idx);
            if (accountEligible(pool, nextIdx, now)) {
              recordStat(ctx, status); // record the error on the exhausted account label
              const acct = pool.accounts[nextIdx];
              ctx.log(`account: ${ctx.model} ${ctx.account.label} -> ${acct.label} (status ${status}, hop ${hop + 1})`);
              const effRoute = { ...ctx.route, auth: acct.auth, base_url: acct.base_url || ctx.route.base_url };
              proxyToRoute(effRoute, ctx.req, ctx.res, ctx.body, ctx.log, {
                onResponse: makeResponseHandler({
                  ...ctx,
                  providerId: acct.label,
                  account: { idx: nextIdx, label: acct.label },
                  failoverHopCount: hop + 1,
                  groupProbe: null,
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

        // GROUP failover takes precedence for a model riding a ladder.
        if (ctx.group) {
          handleGroupFailover(ctx, status, buffered, headers, hop);
          return;
        }

        const backup = pickFailoverModel(ctx.failoverConfig, ctx.model);
        if (!backup) {
          // No backup configured for this model — relay the error as-is.
          if (ctx.statsCtx && ctx.statsCtx.stats) {
            ctx.statsCtx.stats.record({ providerId: ctx.providerId, model: ctx.model, durationMs: Date.now() - ctx.statsCtx.startTime, inputTokens: 0, outputTokens: 0, status });
          }
          relayBuffered(ctx.res, status, headers, buffered);
          return;
        }

        const backupRoute = pickRoute(backup, ctx.config.routes);
        if (!backupRoute) {
          if (ctx.statsCtx && ctx.statsCtx.stats) {
            ctx.statsCtx.stats.record({ providerId: ctx.providerId, model: ctx.model, durationMs: Date.now() - ctx.statsCtx.startTime, inputTokens: 0, outputTokens: 0, status: 502 });
          }
          sendError(ctx.res, 502, `failover backup model "${backup}" has no matching route`);
          return;
        }

        // Record the original error on the primary model.
        if (ctx.statsCtx && ctx.statsCtx.stats) {
          ctx.statsCtx.stats.record({ providerId: ctx.providerId, model: ctx.model, durationMs: Date.now() - ctx.statsCtx.startTime, inputTokens: 0, outputTokens: 0, status });
        }

        // Enter failover state — subsequent requests for this model pre-route to backup.
        ctx.failoverState.set(ctx.model, { enteredAt: Date.now() });
        ctx.log(`failover: ${ctx.model} -> ${backup} (status ${status}, retrying on backup, hop ${hop + 1})`);

        // Rewrite only `model` in the body (the ONE scoped exception to passthrough)
        // and reroute to the backup (dispatch applies the backup route's own account pool).
        const failoverBody = rewriteModelInBody(ctx.body, backup);
        dispatch(backupRoute, failoverBody, ctx, {
          model: backup,
          isVisionTarget: backupRoute === ctx.visionRoute,
          failoverHopCount: hop + 1,
        });
        return;
      }

      // 2. VISION CHECK: a specific "image not supported" 400 → reroute to the
      //    forImages vision target (existing behaviour).
      if (isImageUnsupported400(status, buffered)) {
        if (ctx.isVisionTarget) {
          // Loop guard: the vision target itself can't take the image — clear error,
          // never re-reroute (no infinite loop).
          if (ctx.statsCtx && ctx.statsCtx.stats) {
            ctx.statsCtx.stats.record({ providerId: ctx.providerId, model: ctx.model, durationMs: Date.now() - ctx.statsCtx.startTime, inputTokens: 0, outputTokens: 0, status: 422 });
          }
          sendError(ctx.res, 422, "vision route cannot process this image request; not rerouting (loop guard)");
          return;
        }
        if (ctx.visionRoute) {
          // Reroute the buffered request to the vision target, rewriting only `model`
          // to the route's forImagesModel (the cross-provider hop); remember the client
          // model so the next image call pre-routes (per-process cache, never the payload).
          if (ctx.model) ctx.nonVisionCache.set(ctx.model, true);
          const visionBody = rewriteModelInBody(ctx.body, ctx.visionRoute.forImagesModel);
          // Drop group context: the vision target's model is not on the ladder, so a later
          // failover-trigger from it must fall to plain pair logic, not walk the ladder off
          // a stale groupEffIndex. dispatch applies the vision route's own account pool.
          dispatch(ctx.visionRoute, visionBody, ctx, {
            model: ctx.visionRoute.forImagesModel,
            isVisionTarget: true,
            group: null,
            groupProbe: null,
          });
          return;
        }
        // No vision fallback configured — fail LOUD with a clear error, never the raw
        // cryptic upstream 400.
        if (ctx.statsCtx && ctx.statsCtx.stats) {
          ctx.statsCtx.stats.record({ providerId: ctx.providerId, model: ctx.model, durationMs: Date.now() - ctx.statsCtx.startTime, inputTokens: 0, outputTokens: 0, status: 422 });
        }
        sendError(ctx.res, 422, `model "${ctx.model}" cannot process images and no vision fallback is configured`);
        return;
      }

      // 3. Any other error — relay it verbatim (an ambiguous 400, a non-rate-limit
      //    5xx, etc.). Never reroute.
      // DIAGNOSTIC: log the error message so we can see what the backend returned
      // (only when a failover candidate didn't match — helps tune the classifier).
      try {
        const diag = JSON.parse(buffered.toString("utf8"));
        const diagMsg = (diag && diag.error && diag.error.message) || JSON.stringify(diag).slice(0, 200);
        ctx.log(`error-relay: ${ctx.model} status=${status} msg="${diagMsg}"`);
      } catch { /* never fail on diagnostics */ }
      windBackProbe(); // a non-retryable response to a recovery probe = head is back
      resetAccountBackoff(); // account answered (a non-limit error) — it's reachable, reset its ladder
      if (ctx.statsCtx && ctx.statsCtx.stats) {
        ctx.statsCtx.stats.record({ providerId: ctx.providerId, model: ctx.model, durationMs: Date.now() - ctx.statsCtx.startTime, inputTokens: 0, outputTokens: 0, status });
      }
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
  // harness stays in charge of normal compaction. Off unless config.compact.enabled.
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

// Route one buffered request to its backend, with the reactive vision fallback
// AND failover reroute.
// `nonVisionCache` is a per-process Map(model → true) of models a backend has already
// rejected for images — ephemeral state, never the payload.
// `failoverState` is a per-process Map(model → { enteredAt }) of currently failed-over
// models — when set, requests for that model pre-route to its backup.
// `failoverConfig` is the config.failover mapping (model glob → backup model id).
// `statsCtx` (optional): { stats } — when dashboard is enabled.
function forward(config, req, res, body, log, nonVisionCache, statsCtx = null, failoverState = null, failoverConfig = null, groupState = null, accountPools = null, learnedWindows = {}, limiter = null) {
  let model = modelFromBody(body);
  // The model the CLIENT sized its context against (before any schedule/failover rewrite) —
  // the reference window for the downshift safety net in dispatch().
  const clientModel = model;
  // SCHEDULE PRE-ROUTE (proactive cost control): while a configured wall-clock window is
  // open, rewrite the model to a cheaper target BEFORE routing/group/failover/vision — so
  // the whole pipeline (route match, failover ladders, stats) sees the scheduled model as
  // if the client had asked for it. Off-window (or no schedules) this is a no-op.
  if (model && Array.isArray(config.schedules) && config.schedules.length > 0) {
    const scheduled = resolveSchedule(config.schedules, model, Date.now());
    if (scheduled && scheduled !== model) {
      log(`schedule: ${model} -> ${scheduled}`);
      body = rewriteModelInBody(body, scheduled);
      model = scheduled;
    }
  }
  const route = pickRoute(model, config.routes);
  if (!route) {
    sendError(res, 400, model ? `no route for model "${model}"` : "request has no routable model");
    return;
  }

  const visionRoute = pickVisionRoute(config.routes);

  // Build the base ctx for makeResponseHandler — the shared context threaded through every
  // hop (vision reroute, failover reroute, account rotation). providerId/account/route are
  // set per hop by dispatch().
  const baseCtx = { res, req, body, log, model, clientModel, learnedWindows, visionRoute, nonVisionCache, isVisionTarget: route === visionRoute, statsCtx, config, failoverState, failoverConfig, groupState, accountPools, limiter, failoverHopCount: 0 };

  // 0a. FAILOVER GROUP PRE-ROUTE: a model riding a ladder is served by its group's
  //     effective tier (position + current shift offset). Takes precedence over plain
  //     failover pairs. When offset is 0 this routes to the model itself; when the head
  //     tier has shifted, the whole ladder rides down together.
  if (groupState && Array.isArray(config.failoverGroups) && config.failoverGroups.length > 0) {
    const gres = resolveGroup(config.failoverGroups, groupState, model);
    if (gres) {
      const gs = groupState[gres.groupIndex];
      const ladderArr = config.failoverGroups[gres.groupIndex].ladder;
      let effIndex = gres.effIndex;
      let groupProbe = null;
      // RECOVERY via a live request (works for passthrough / glob heads the synthetic
      // pinger cannot probe): once the cooldown has elapsed since the last shift, a
      // HEAD-position request tries one tier UP with the real request + real model id.
      // If it comes back healthy, makeResponseHandler winds the whole ladder back one;
      // if it fails, the reactive path re-serves it on the shifted tier (offset unchanged).
      // Only head traffic can probe this way — a lower tier's request can't test the head's
      // model. This is the group analogue of the plain-pairs cooldown fall-through below.
      if (gres.position === 0 && gs.offset > 0 &&
          Date.now() - (gs.shiftedAt || 0) >= recoveryWaitMs(config, gs.attempts || 0)) {
        effIndex = gs.offset - 1;
        gs.shiftedAt = Date.now();       // hold off another probe for the current backoff window
        gs.attempts = (gs.attempts || 0) + 1; // widen the window if this probe also fails; windback resets it
        gs.nextProbeAt = 0;              // let the synthetic pinger re-arm from the new shiftedAt
        groupProbe = { groupIndex: gres.groupIndex, fromOffset: gs.offset, windTo: gs.offset - 1 };
      }
      // Served by its OWN tier (effIndex === position) → pass the original body unchanged.
      // Only a genuine DOWNWARD shift rewrites, and only to a lower tier — which
      // validateConfig guarantees is a concrete id, never a glob. (So we must NOT compare
      // against the ladder entry: a glob HEAD serving its own traffic keeps the real id.)
      const shifted = effIndex > gres.position;
      const targetModel = shifted ? ladderArr[effIndex] : model;
      const effRoute = pickRoute(targetModel, config.routes);
      if (effRoute) {
        const gBody = shifted ? rewriteModelInBody(body, targetModel) : body;
        dispatch(effRoute, gBody, baseCtx, {
          model: targetModel,
          isVisionTarget: effRoute === visionRoute,
          group: { groupIndex: gres.groupIndex, position: gres.position, mode: gres.mode },
          groupEffIndex: effIndex,
          groupProbe,
        });
        return;
      }
      // Effective tier has no matching route — fall through to normal routing.
    }
  }

  // 0. FAILOVER PRE-ROUTE: if this model is in the active failover state AND the
  //    failover cooldown hasn't elapsed, skip the known-failing primary and go
  //    straight to the backup. When the cooldown HAS elapsed, fall through and try
  //    the primary — it's the natural recovery probe for routes the pinger can't
  //    probe (e.g. passthrough with no backend key). If the primary works, the old
  //    failoverState entry just sits stale (every subsequent request falls through
  //    past the cooldown and tries the primary normally). If it fails again, the
  //    reactive failover in makeResponseHandler re-enters the state with a fresh
  //    timestamp.
  if (failoverState && failoverState.has(model)) {
    const foState = failoverState.get(model);
    const cooldownMs = config.failoverRecoveryIntervalMs || 60000;
    if (Date.now() - foState.enteredAt <= cooldownMs) {
      const backup = pickFailoverModel(failoverConfig, model);
      if (backup) {
        const backupRoute = pickRoute(backup, config.routes);
        if (backupRoute) {
          const failoverBody = rewriteModelInBody(body, backup);
          dispatch(backupRoute, failoverBody, baseCtx, {
            model: backup,
            isVisionTarget: backupRoute === visionRoute,
          });
          return;
        }
      }
      // Backup model doesn't resolve — fall through, try the primary.
    }
    // Cooldown elapsed (or no backup found) — fall through, try the primary.
  }

  // Pre-route an image-bearing request straight to the vision target, skipping the
  // non-vision backend call, when the matched route is known non-vision — EITHER:
  //   • DECLARED non-vision (`vision: false` on the route) — proactive, reliable. Needed
  //     because a backend that lacks vision does NOT always 400: it may soft-refuse with a
  //     200 ("I can't see images") or invoke its own server-side image tool, neither of
  //     which the reactive catch-400 path (makeResponseHandler) can detect. The flag is
  //     the config-driven escape from wire-detection's blind spots.
  //   • LEARNED non-vision (cached from a prior 400-image on this model) — the reactive
  //     optimisation that skips a repeat known-failing first call.
  // The catch-400 fallback in makeResponseHandler stays for the default (vision unset/true)
  // route — belt-and-suspenders for a backend that DOES 400.
  if (
    visionRoute &&
    route !== visionRoute &&
    bodyHasImageBlock(body) &&
    (route.vision === false || (model && nonVisionCache.has(model)))
  ) {
    const visionBody = rewriteModelInBody(body, visionRoute.forImagesModel);
    dispatch(visionRoute, visionBody, baseCtx, { model: visionRoute.forImagesModel, isVisionTarget: true });
    return;
  }

  dispatch(route, body, baseCtx, {});
}

// ── FailoverPinger ──────────────────────────────────────────────────────────
// Background timer that periodically probes failed-over primary models to check
// whether they've recovered. When a probe succeeds (non-failover response), the
// model is removed from failoverState and routing reverts to the primary.
//
// Probe: a minimal messages API call ({model, messages:[{role:"user",content:"."}],
// max_tokens:1}) through the primary's backend route — a real API call, not just
// a connectivity check, so it accurately reflects whether the backend accepts
// messages for that model.
//
// Similar to QuotaPoller in stats.mjs: setInterval + unref, best-effort.

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

class FailoverPinger {
  #failoverState;  // shared Map<modelId, {enteredAt: number}>
  #groupState;     // shared Array<{offset, shiftedAt}> parallel to config.failoverGroups
  #config;         // shared config object (for route resolution)
  #log;            // opt-in stderr logger (same as the router's log)
  #interval = null;
  #cooldownMs;

  constructor(failoverState, config, log, cooldownMs = 60000, groupState = null) {
    this.#failoverState = failoverState;
    this.#groupState = groupState;
    this.#config = config;
    this.#log = log || (() => {});
    this.#cooldownMs = cooldownMs;
  }

  async poll() {
    const now = Date.now();
    // Plain failover pairs — probe once this entry's backoff window has elapsed, then
    // widen the window on each failed probe (progressive backoff).
    const toProbe = [];
    for (const [model, state] of this.#failoverState) {
      if (state.nextProbeAt === undefined) { state.attempts = 0; state.nextProbeAt = state.enteredAt + recoveryWaitMs(this.#config, 0); }
      if (now >= state.nextProbeAt) toProbe.push(model);
    }
    for (const model of toProbe) {
      const r = await this.#probeRecovery(model);
      if (r === "recovered" || r === "no-route") {
        this.#failoverState.delete(model);
        if (r === "recovered") this.#log(`failover-recovery: ${model} primary restored, failover cleared`);
      } else {
        const st = this.#failoverState.get(model);
        if (st) { st.attempts = (st.attempts || 0) + 1; st.nextProbeAt = Date.now() + recoveryWaitMs(this.#config, st.attempts); }
      }
    }
    // Failover groups in "shift" mode: probe the tier we shifted PAST (ladder[offset-1]);
    // when it recovers, wind the whole ladder back up one step.
    await this.#pollGroups(now);
  }

  async #pollGroups(now) {
    const groups = this.#config.failoverGroups;
    if (!this.#groupState || !Array.isArray(groups)) return;
    for (let g = 0; g < groups.length; g++) {
      const gs = this.#groupState[g];
      if (!gs || gs.offset <= 0) continue;
      if (!gs.nextProbeAt) { gs.attempts = 0; gs.nextProbeAt = (gs.shiftedAt || now) + recoveryWaitMs(this.#config, 0); }
      if (now < gs.nextProbeAt) continue;
      const probeModel = groups[g].ladder[gs.offset - 1];
      // A glob tier (only the head may be one) has no concrete id to synthesize a probe
      // with — sending the glob string would be a bogus model id. Leave it to the live
      // head-request cooldown fall-through in forward() to recover.
      if (probeModel.includes("*")) continue;
      const r = await this.#probeRecovery(probeModel);
      if (r === "recovered" || r === "no-route") {
        gs.offset--;
        gs.shiftedAt = Date.now();
        gs.attempts = 0; gs.nextProbeAt = 0; // re-arm backoff for the next tier (if still shifted)
        this.#log(`failover-group[${g}]: tier "${probeModel}" restored — shift offset -> ${gs.offset} (ladder winds back up one)`);
      } else {
        gs.attempts = (gs.attempts || 0) + 1;
        gs.nextProbeAt = Date.now() + recoveryWaitMs(this.#config, gs.attempts);
      }
    }
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
  // tokenPrices MERGE over the file (file entries survive). failover, once edited in the
  // dashboard, is AUTHORITATIVE — the stored set REPLACES the file's `failover` so a pair
  // removed in the UI stays removed (to go back to the file config, clear overrides.json).
  // A corrupt/invalid overrides file is ignored rather than bricking startup.
  const stored = readJson(OVERRIDES_FILE, {});
  const dashOverrides = {
    tokenPrices: (stored && typeof stored.tokenPrices === "object") ? stored.tokenPrices : {},
    failover: (stored && typeof stored.failover === "object") ? stored.failover : {},
    // failoverGroups: null = never edited in the UI (use the file's groups); an array
    // (possibly empty) = the dashboard-set group list, AUTHORITATIVE across restart —
    // an empty array means "the user deleted every group", which must survive a restart.
    failoverGroups: (stored && Array.isArray(stored.failoverGroups)) ? stored.failoverGroups : null,
    // failoverBackoffMs: undefined = never edited (use the file); an array = the dashboard-set
    // progressive-retry schedule; null = explicitly cleared back to the flat cooldown.
    failoverBackoffMs: (stored && Array.isArray(stored.failoverBackoffMs)) ? stored.failoverBackoffMs
      : (stored && stored.failoverBackoffMs === null ? null : undefined),
    // billing: { <providerId|accountLabel>: "metered" | "subscription" } — dashboard-only
    // display override when the derived default guesses wrong (e.g. a metered z.ai key).
    billing: (stored && typeof stored.billing === "object") ? stored.billing : {},
    // schedules: null = never edited in the UI (use the file's schedules); an array
    // (possibly empty) = the dashboard-set schedule list, AUTHORITATIVE across restart —
    // an empty array means "the user deleted every schedule", which must survive a restart.
    schedules: (stored && Array.isArray(stored.schedules)) ? stored.schedules : null,
    // compact: null = never edited in the UI (use the file's compact block / defaults); an
    // object = the dashboard-set compaction config, AUTHORITATIVE across restart.
    compact: (stored && stored.compact && typeof stored.compact === "object" && !Array.isArray(stored.compact)) ? stored.compact : null,
    // concurrency: null = never edited in the UI (use the file's concurrency map); an object
    // = the dashboard-set per-model concurrency limits, AUTHORITATIVE across restart (an empty
    // object means "the user cleared every limit", which must survive a restart).
    concurrency: (stored && stored.concurrency && typeof stored.concurrency === "object" && !Array.isArray(stored.concurrency)) ? stored.concurrency : null,
  };
  {
    const beforeTP = config.tokenPrices;
    const beforeFO = config.failover;
    const beforeFG = config.failoverGroups;
    const beforeBO = config.failoverRecoveryBackoffMs;
    const beforeSC = config.schedules;
    const beforeCM = config.compact;
    const beforeCC = config.concurrency;
    try {
      if (Object.keys(dashOverrides.tokenPrices).length) config.tokenPrices = { ...(config.tokenPrices || {}), ...dashOverrides.tokenPrices };
      // Failover: once edited in the dashboard, the dashboard set is AUTHORITATIVE (a
      // replace, not a merge) — so a pair removed in the UI stays removed across restart.
      if (Object.keys(dashOverrides.failover).length) config.failover = { ...dashOverrides.failover };
      // Groups: same authoritative-replace semantics; null sentinel = leave the file's groups.
      if (dashOverrides.failoverGroups !== null) config.failoverGroups = dashOverrides.failoverGroups;
      // Backoff schedule: undefined = untouched, array = set, null = cleared to flat cooldown.
      if (dashOverrides.failoverBackoffMs !== undefined) {
        if (dashOverrides.failoverBackoffMs === null) delete config.failoverRecoveryBackoffMs;
        else config.failoverRecoveryBackoffMs = dashOverrides.failoverBackoffMs;
      }
      // Schedules: same authoritative-replace semantics; null sentinel = leave the file's.
      if (dashOverrides.schedules !== null) config.schedules = dashOverrides.schedules;
      // Compact: authoritative-replace, re-normalized so a stored partial still gets defaults.
      if (dashOverrides.compact !== null) config.compact = validateCompact(dashOverrides.compact);
      // Concurrency: same authoritative-replace semantics; null sentinel = leave the file's map.
      if (dashOverrides.concurrency !== null) config.concurrency = dashOverrides.concurrency;
      validateConfig(config);
    } catch {
      config.tokenPrices = beforeTP;
      config.failover = beforeFO;
      config.failoverGroups = beforeFG;
      config.failoverRecoveryBackoffMs = beforeBO;
      config.schedules = beforeSC;
      config.compact = beforeCM;
      config.concurrency = beforeCC;
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

  // Failover state + recovery pinger
  const failoverConfig = config.failover || null;
  const failoverState = new Map();
  // Per-group shift state (offset winds down/up as the head tier fails/recovers).
  const groupState = (config.failoverGroups || []).map(() => ({ offset: 0, shiftedAt: 0, attempts: 0, nextProbeAt: 0 }));

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
  let failoverPinger = null;
  const hasPairs = failoverConfig && Object.keys(failoverConfig).length > 0;
  const hasGroups = groupState.length > 0;
  if (hasPairs || hasGroups) {
    const cooldown = config.failoverRecoveryIntervalMs || 60000;
    // Poll at the SHORTEST backoff step so a 1-min probe can actually fire; longer steps
    // are honoured per-entry via nextProbeAt (a 10-min entry is simply skipped until due).
    const bo = config.failoverRecoveryBackoffMs;
    const pollEvery = (Array.isArray(bo) && bo.length) ? bo[0] : cooldown;
    failoverPinger = new FailoverPinger(failoverState, config, log, cooldown, groupState);
    failoverPinger.start(pollEvery);
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
    // GET /v1/failover — return current failover config + active state (pairs + groups)
    if (dashboard && req.method === "GET" && req.url === "/v1/failover") {
      const active = {};
      for (const [model, state] of failoverState) active[model] = { enteredAt: state.enteredAt };
      const groups = (config.failoverGroups || []).map((grp, g) => ({
        ladder: grp.ladder,
        mode: grp.mode || "shift",
        offset: (groupState[g] && groupState[g].offset) || 0,
        // The tier each ladder position is CURRENTLY served by, given the shift offset.
        effective: grp.ladder.map((_, p) => effectiveLadderModel(grp.ladder, (groupState[g] && groupState[g].offset) || 0, p)),
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        config: config.failover || {},
        active,
        groups,
        // Ready-to-consume signal of the head slot's current effective state (see
        // computeEffectiveHead): believed vs actual head, its window, recovery ETA. null when
        // no failover group is configured. Consumers read this instead of re-deriving offsets.
        effective: computeEffectiveHead(config, groupState, learnedWindows, accountPools, Date.now()),
        cooldownMs: config.failoverRecoveryIntervalMs || 60000,
        backoffMs: Array.isArray(config.failoverRecoveryBackoffMs) ? config.failoverRecoveryBackoffMs : null,
      }));
      return;
    }
    // POST /v1/failover — merge failover pairs in-memory (same pattern as POST /v1/plans)
    if (dashboard && req.method === "POST" && req.url === "/v1/failover") {
      readBody(req, 16384).then((body) => {
        try {
          const data = JSON.parse(body.toString("utf8"));
          if (typeof data !== "object") throw new Error("must be an object");
          const { pairs, groups, cooldownMs, backoffMs } = data;
          if (pairs !== undefined) {
            if (!pairs || typeof pairs !== "object") throw new Error("pairs must be an object { modelGlob: backupModelId }");
            // Validate each pair the SAME way startup does (R5): non-empty string glob →
            // non-empty string backup, glob must compile. No weaker path than the file.
            for (const [pattern, backup] of Object.entries(pairs)) {
              if (typeof pattern !== "string" || pattern.length === 0) throw new Error(`pair key "${pattern}" must be a non-empty model glob`);
              if (typeof backup !== "string" || backup.length === 0) throw new Error(`pair value for "${pattern}" must be a non-empty backup model id`);
              try { globToRegExp(pattern); } catch (ge) { throw new Error(`pair key "${pattern}" is not a valid glob: ${ge.message}`); }
            }
            // The posted set is the authoritative dashboard failover config (replace),
            // so removing a pair in the UI and re-posting actually deletes it.
            config.failover = { ...pairs };
            dashOverrides.failover = { ...pairs };
          }
          if (groups !== undefined) {
            // Validate groups the SAME way startup does (validateConfig): ladder of >=2
            // ids, only the head may be a glob, lower tiers concrete, mode shift|cascade.
            if (!Array.isArray(groups)) throw new Error("groups must be an array of { ladder, mode? }");
            for (const [gi, grp] of groups.entries()) {
              const at = `groups[${gi}]`;
              if (!grp || typeof grp !== "object") throw new Error(`${at}: must be an object { ladder, mode? }`);
              if (!Array.isArray(grp.ladder) || grp.ladder.length < 2) throw new Error(`${at}.ladder: must be an array of at least 2 model ids`);
              for (const [j, entry] of grp.ladder.entries()) {
                if (typeof entry !== "string" || entry.length === 0) throw new Error(`${at}.ladder[${j}]: must be a non-empty model id`);
                if (j >= 1 && entry.includes("*")) throw new Error(`${at}.ladder[${j}] "${entry}": only the head (index 0) may be a glob; lower tiers must be concrete model ids`);
              }
              if (grp.mode !== undefined && grp.mode !== "shift" && grp.mode !== "cascade") throw new Error(`${at}.mode: must be "shift" or "cascade"`);
            }
            // Normalize to { ladder, mode } and REPLACE the running group list.
            const norm = groups.map((g) => ({ ladder: g.ladder.slice(), mode: g.mode || "shift" }));
            config.failoverGroups = norm;
            dashOverrides.failoverGroups = norm;
            // Rebuild groupState IN PLACE — the pinger and forward() both hold this exact
            // array reference by closure; reassigning it would leave them pointing at the
            // stale one. A group edit resets every shift offset (the ladders changed).
            groupState.length = 0;
            for (let i = 0; i < norm.length; i++) groupState.push({ offset: 0, shiftedAt: 0, attempts: 0, nextProbeAt: 0 });
          }
          if (cooldownMs !== undefined) {
            if (typeof cooldownMs !== "number" || cooldownMs < 1000) throw new Error("cooldownMs must be a number >= 1000");
            config.failoverRecoveryIntervalMs = cooldownMs;
          }
          if (backoffMs !== undefined) {
            // null / empty array clears the schedule (back to the flat cooldown).
            if (backoffMs === null) { delete config.failoverRecoveryBackoffMs; dashOverrides.failoverBackoffMs = null; }
            else {
              if (!Array.isArray(backoffMs) || backoffMs.length === 0) throw new Error("backoffMs must be a non-empty array of ms (or null)");
              for (const [i, v] of backoffMs.entries()) if (typeof v !== "number" || v < 1000) throw new Error(`backoffMs[${i}] must be a number >= 1000`);
              config.failoverRecoveryBackoffMs = backoffMs.slice();
              dashOverrides.failoverBackoffMs = backoffMs.slice();
            }
          }
          // Clean stale failoverState entries whose patterns no longer exist.
          for (const model of failoverState.keys()) {
            if (!pickFailoverModel(config.failover, model)) failoverState.delete(model);
          }
          // Start the pinger if any failover (pairs OR groups) now exists and it wasn't running
          const failoverExists = (config.failover && Object.keys(config.failover).length > 0) ||
            (Array.isArray(config.failoverGroups) && config.failoverGroups.length > 0);
          if (failoverExists && !failoverPinger) {
            const cd = config.failoverRecoveryIntervalMs || 60000;
            const bo = config.failoverRecoveryBackoffMs;
            failoverPinger = new FailoverPinger(failoverState, config, log, cd, groupState);
            failoverPinger.start((Array.isArray(bo) && bo.length) ? bo[0] : cd);
          }
          saveOverrides();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, config: config.failover || {}, cooldownMs: config.failoverRecoveryIntervalMs }));
        } catch (e) {
          sendError(res, 400, `invalid: ${e.message}`);
        }
      }).catch(() => sendError(res, 400, "invalid body"));
      return;
    }
    // POST /v1/failover/reset — clear active failover state without a restart.
    //   (no param)   → clear ALL pair state AND wind every group offset back to 0
    //   ?model=<id>  → clear one model's pair failover state
    //   ?group=<n>   → wind group #n's offset back to 0 (fixes a stuck double-shift)
    // NOTE: match the PATHNAME so a query string still routes here (a plain `=== req.url`
    // check would miss "/v1/failover/reset?group=0").
    if (dashboard && req.method === "POST" &&
        (req.url === "/v1/failover/reset" || req.url.startsWith("/v1/failover/reset?"))) {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      const targetModel = url.searchParams.get("model");
      const targetGroup = url.searchParams.get("group");
      let cleared = 0;
      if (targetModel) {
        if (failoverState.delete(targetModel)) cleared = 1;
      } else if (targetGroup !== null) {
        const g = Number(targetGroup);
        if (Number.isInteger(g) && groupState[g]) {
          if (groupState[g].offset > 0) { groupState[g].offset = 0; groupState[g].shiftedAt = 0; cleared = 1; }
        } else {
          sendError(res, 400, `no failover group #${targetGroup}`);
          return;
        }
      } else {
        cleared = failoverState.size;
        failoverState.clear();
        for (const gs of groupState) { if (gs.offset > 0) { gs.offset = 0; gs.shiftedAt = 0; cleared++; } }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, cleared }));
      return;
    }

    // GET /v1/schedules — current time-window model rewrites + which are active right now.
    if (dashboard && req.method === "GET" && req.url === "/v1/schedules") {
      const now = Date.now();
      const list = (config.schedules || []).map((s) => {
        const off = parseTzOffset(s.tz);
        let active = false;
        if (off != null) {
          const shifted = now + off * 60000;
          const minute = Math.floor((((shifted % 86400000) + 86400000) % 86400000) / 60000);
          active = (s.windows || []).some((w) => {
            const from = parseHHMM(w[0]);
            const to = parseHHMM(w[1]);
            return from != null && to != null && inWindow(minute, from, to);
          });
        }
        return { match: s.match, to: s.to, tz: s.tz, windows: s.windows, active };
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ schedules: list }));
      return;
    }
    // POST /v1/schedules — replace the schedule list in-memory + persist (authoritative,
    // same pattern as POST /v1/failover groups). Body: an array, or { schedules: [...] }.
    // Validated the SAME way as the config file (validateSchedules) — no weaker path.
    if (dashboard && req.method === "POST" && req.url === "/v1/schedules") {
      readBody(req, 16384).then((body) => {
        try {
          const data = JSON.parse(body.toString("utf8"));
          const arr = Array.isArray(data) ? data : (data && data.schedules);
          const norm = validateSchedules(arr, "schedules");
          config.schedules = norm;
          dashOverrides.schedules = norm;
          saveOverrides();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, schedules: config.schedules }));
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
          return { provider: sep >= 0 ? s.key.slice(0, sep) : s.key, model: sep >= 0 ? s.key.slice(sep + 1) : "", active: s.active, limit: s.limit, queued: s.queued };
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

    // GET /v1/models (and the bare /models) returns the configured routes as a
    // secret-free model listing (listModels). Intercepted BEFORE body reading/routing so
    // it needs no request body and never reaches a backend — everything else (POST
    // messages, passthrough, the vision reroute) flows through readBody → forward unchanged.
    if (req.method === "GET" && (req.url === "/v1/models" || req.url === "/models")) {
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
    readBody(req, maxBytes)
      .then((body) => {
        const statsCtx = dashboard ? { stats, startTime: Date.now() } : null;
        // Pass config.failover LIVE (not the startup snapshot) so dashboard edits take
        // effect; an empty map counts as "no pairs" (don't buffer every error needlessly).
        const liveFailover = config.failover && Object.keys(config.failover).length ? config.failover : null;
        forward(config, req, res, body, log, nonVisionCache, statsCtx, failoverState, liveFailover, groupState, accountPools, learnedWindows, limiter);
      })
      .catch((err) => sendError(res, err.status || 400, err.message || "bad request"));
  });

  // Expose stats + quotaPoller for teardown in tests
  server._modelpipe = { stats, quotaPoller, failoverState, failoverPinger, groupState, accountPools, limiter };

  // Archive session on graceful shutdown
  server.on("close", () => {
    if (stats) stats.shutdown();
    if (quotaPoller) quotaPoller.stop();
    if (failoverPinger) failoverPinger.stop();
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
