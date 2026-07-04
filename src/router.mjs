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
import { fileURLToPath } from "node:url";
import {
  StatsCollector, QuotaPoller, DASHBOARD_HTML,
  createUsageTracker, providerIdFromUrl,
  decompressIfNeeded,
} from "./stats.mjs";
import { readJson, writeJson, OVERRIDES_FILE } from "./store.mjs";

const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MB — bound the per-request buffer
const MAX_FAILOVER_HOPS = 5; // chain-depth guard — at most 5 backup hops per request

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
export function validateConfig(config) {
  if (!config || typeof config !== "object") throw new Error("config: not an object");
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
    // auth is EITHER the string "passthrough" (forward the client's auth unchanged)
    // OR a key-swap object { header, keyEnv, scheme?, fallback? }.
    if (route.auth === "passthrough") continue;
    if (!route.auth || typeof route.auth !== "object") throw new Error(`${at}.auth: missing (object or "passthrough")`);
    if (typeof route.auth.header !== "string" || route.auth.header.length === 0) throw new Error(`${at}.auth.header: missing`);
    if (typeof route.auth.keyEnv !== "string" || route.auth.keyEnv.length === 0) throw new Error(`${at}.auth.keyEnv: missing`);
    // fallback: OPTIONAL boolean. true ⇒ forward the client's OWN auth header when it sent
    // one, and inject keyEnv only when it didn't ("the token that flies wins, else the
    // proxy's"). Default false = always swap in keyEnv.
    if (route.auth.fallback !== undefined && typeof route.auth.fallback !== "boolean") {
      throw new Error(`${at}.auth.fallback: must be a boolean when present`);
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
  // E.g. { "claude-opus-*": { input: 15, output: 75 }, "glm-5.2": { input: 1.2, output: 4.0 } }.
  // Model keys can use * globs. Falls back to built-in PRICE_MAP.
  if (config.tokenPrices !== undefined) {
    if (typeof config.tokenPrices !== "object") throw new Error("config.tokenPrices: must be an object { model: { input, output } }");
    for (const [key, p] of Object.entries(config.tokenPrices)) {
      if (!p || typeof p.input !== "number" || typeof p.output !== "number") {
        throw new Error(`config.tokenPrices.${key}: must be { input: number, output: number }`);
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
    return out;
  });
  if (config && Array.isArray(config.failoverGroups)) safe.failoverGroups = config.failoverGroups;
  return safe;
}

// The effective billing mode for a route: explicit `billing`, else derived —
// passthrough rides the client's own plan (subscription), a key-swap route is metered.
export function routeBilling(route) {
  if (route && (route.billing === "metered" || route.billing === "subscription")) return route.billing;
  return isPassthrough(route) ? "subscription" : "metered";
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
    return {
      id: r.match,                                       // the match glob, e.g. "deepseek-*"
      object: "model",
      host,                                              // backend host — no path, no key
      auth: r.auth === "passthrough" ? "passthrough" : "key",  // mode only, never the env name
      provider: providerIdFromUrl(r.base_url),           // server-computed id — one source of truth with stats
      vision: r.vision !== false,                        // vision-capable unless explicitly opted out
      for_images: r.forImages === true,                  // the forImages vision-fallback flag
      billing: routeBilling(r),                          // "metered" | "subscription" — how the dashboard reports $
    };
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
function proxyToRoute(route, req, res, body, log, { onResponse, statsCtx } = {}) {
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
          providerId: providerIdFromUrl(route.base_url),
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

  const providerId = providerIdFromUrl(route.base_url);
  const model = modelFromBody(body);

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
    onResponse || ((upstreamRes) => pipeResponse(upstreamRes, res, statsCtx
      ? { stats: statsCtx.stats, providerId, model, startTime: statsCtx.startTime }
      : null)),
  );
  upstreamReq.on("error", () => {
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
  proxyToRoute(nextRoute, ctx.req, ctx.res, nextBody, ctx.log, {
    onResponse: makeResponseHandler({
      ...ctx,
      body: nextBody,
      model: nextModel,
      providerId: providerIdFromUrl(nextRoute.base_url),
      isVisionTarget: nextRoute === ctx.visionRoute,
      failoverHopCount: hop + 1,
      groupEffIndex: nextIdx,
      groupProbe: null, // a reroute is no longer the head-recovery probe — don't wind back on its success
    }),
    statsCtx: ctx.statsCtx,
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
        ctx.log(`failover-group[${p.groupIndex}]: head recovered on a live request — shift offset -> ${gs.offset}`);
      }
    };

    // Fast path — success / SSE (2xx) and every other non-error that is neither a
    // 400 (vision classifier) nor a failover-candidate status. These are NEVER
    // buffered, so streaming stays intact.
    // Buffer only real failover candidates + 400 (vision path): 400 for account/org
    // issues, 429/529 for unambiguous rate-limit/overload, 5xx for server errors.
    // Other 4xx (401, 403, 404, etc.) stream straight back — they're client errors
    // that failover can't fix, so buffering them is wasted work + changes delivery
    // semantics for oversized error bodies.
    const isFailoverCandidate = (ctx.failoverConfig || ctx.group)
      && (status === 400 || status === 429 || status === 529 || (status >= 500 && status < 600));
    if (status !== 400 && !isFailoverCandidate) {
      windBackProbe(); // a non-candidate response to a recovery probe = head is back
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
        // and reroute to the backup.
        const failoverBody = rewriteModelInBody(ctx.body, backup);
        const visionRoute = ctx.visionRoute; // preserve from outer ctx (may be null)
        proxyToRoute(backupRoute, ctx.req, ctx.res, failoverBody, ctx.log, {
          onResponse: makeResponseHandler({
            ...ctx,
            body: failoverBody,
            model: backup,
            providerId: providerIdFromUrl(backupRoute.base_url),
            visionRoute,
            isVisionTarget: backupRoute === visionRoute,
            failoverHopCount: hop + 1,
          }),
          statsCtx: ctx.statsCtx,
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
          // a stale groupEffIndex.
          proxyToRoute(ctx.visionRoute, ctx.req, ctx.res, visionBody, ctx.log, {
            onResponse: makeResponseHandler({ ...ctx, isVisionTarget: true, group: null, groupProbe: null }),
            statsCtx: ctx.statsCtx,
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
      if (ctx.statsCtx && ctx.statsCtx.stats) {
        ctx.statsCtx.stats.record({ providerId: ctx.providerId, model: ctx.model, durationMs: Date.now() - ctx.statsCtx.startTime, inputTokens: 0, outputTokens: 0, status });
      }
      relayBuffered(ctx.res, status, headers, buffered);
    });
  };
}

// Route one buffered request to its backend, with the reactive vision fallback
// AND failover reroute.
// `nonVisionCache` is a per-process Map(model → true) of models a backend has already
// rejected for images — ephemeral state, never the payload.
// `failoverState` is a per-process Map(model → { enteredAt }) of currently failed-over
// models — when set, requests for that model pre-route to its backup.
// `failoverConfig` is the config.failover mapping (model glob → backup model id).
// `statsCtx` (optional): { stats } — when dashboard is enabled.
function forward(config, req, res, body, log, nonVisionCache, statsCtx = null, failoverState = null, failoverConfig = null, groupState = null) {
  const model = modelFromBody(body);
  const route = pickRoute(model, config.routes);
  if (!route) {
    sendError(res, 400, model ? `no route for model "${model}"` : "request has no routable model");
    return;
  }

  const visionRoute = pickVisionRoute(config.routes);
  const providerId = providerIdFromUrl(route.base_url);

  // Build the base ctx for makeResponseHandler — the shared context threaded
  // through every hop (vision reroute AND failover reroute).
  const baseCtx = { res, req, body, log, model, visionRoute, nonVisionCache, isVisionTarget: route === visionRoute, providerId, statsCtx, config, failoverState, failoverConfig, groupState, failoverHopCount: 0 };

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
          Date.now() - (gs.shiftedAt || 0) >= (config.failoverRecoveryIntervalMs || 60000)) {
        effIndex = gs.offset - 1;
        gs.shiftedAt = Date.now(); // hold off another probe for a full cooldown
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
        proxyToRoute(effRoute, req, res, gBody, log, {
          onResponse: makeResponseHandler({
            ...baseCtx,
            body: gBody,
            model: targetModel,
            providerId: providerIdFromUrl(effRoute.base_url),
            isVisionTarget: effRoute === visionRoute,
            group: { groupIndex: gres.groupIndex, position: gres.position, mode: gres.mode },
            groupEffIndex: effIndex,
            groupProbe,
          }),
          statsCtx,
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
          proxyToRoute(backupRoute, req, res, failoverBody, log, {
            onResponse: makeResponseHandler({
              ...baseCtx,
              body: failoverBody,
              model: backup,
              providerId: providerIdFromUrl(backupRoute.base_url),
              visionRoute,
              isVisionTarget: backupRoute === visionRoute,
            }),
            statsCtx,
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
    proxyToRoute(visionRoute, req, res, visionBody, log, {
      onResponse: makeResponseHandler({ ...baseCtx, body: visionBody, model: visionRoute.forImagesModel, visionRoute, nonVisionCache, isVisionTarget: true, providerId: providerIdFromUrl(visionRoute.base_url) }),
      statsCtx,
    });
    return;
  }

  proxyToRoute(route, req, res, body, log, {
    onResponse: makeResponseHandler(baseCtx),
    statsCtx,
  });
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
    // Plain failover pairs.
    const toProbe = [];
    for (const [model, state] of this.#failoverState) {
      if (now - state.enteredAt >= this.#cooldownMs) toProbe.push(model);
    }
    for (const model of toProbe) {
      const r = await this.#probeRecovery(model);
      if (r === "recovered" || r === "no-route") {
        this.#failoverState.delete(model);
        if (r === "recovered") this.#log(`failover-recovery: ${model} primary restored, failover cleared`);
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
      if (now - (gs.shiftedAt || 0) < this.#cooldownMs) continue;
      const probeModel = groups[g].ladder[gs.offset - 1];
      // A glob tier (only the head may be one) has no concrete id to synthesize a probe
      // with — sending the glob string would be a bogus model id. Leave it to the live
      // head-request cooldown fall-through in forward() to recover.
      if (probeModel.includes("*")) continue;
      const r = await this.#probeRecovery(probeModel);
      if (r === "recovered" || r === "no-route") {
        gs.offset--;
        gs.shiftedAt = Date.now();
        this.#log(`failover-group[${g}]: tier "${probeModel}" restored — shift offset -> ${gs.offset} (ladder winds back up one)`);
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
  };
  {
    const beforeTP = config.tokenPrices;
    const beforeFO = config.failover;
    try {
      if (Object.keys(dashOverrides.tokenPrices).length) config.tokenPrices = { ...(config.tokenPrices || {}), ...dashOverrides.tokenPrices };
      // Failover: once edited in the dashboard, the dashboard set is AUTHORITATIVE (a
      // replace, not a merge) — so a pair removed in the UI stays removed across restart.
      if (Object.keys(dashOverrides.failover).length) config.failover = { ...dashOverrides.failover };
      validateConfig(config);
    } catch {
      config.tokenPrices = beforeTP;
      config.failover = beforeFO;
    }
  }
  // Persist ONLY the dashboard-set overrides (best-effort).
  const saveOverrides = () => writeJson(OVERRIDES_FILE, dashOverrides);
  // Per-process (per-router-instance) cache of models a backend rejected for images,
  // so a repeat image call pre-routes to the vision target without the failing first
  // hop. Ephemeral, holds only model ids — never any request payload.
  const nonVisionCache = new Map();

  // Failover state + recovery pinger
  const failoverConfig = config.failover || null;
  const failoverState = new Map();
  // Per-group shift state (offset winds down/up as the head tier fails/recovers).
  const groupState = (config.failoverGroups || []).map(() => ({ offset: 0, shiftedAt: 0 }));
  let failoverPinger = null;
  const hasPairs = failoverConfig && Object.keys(failoverConfig).length > 0;
  const hasGroups = groupState.length > 0;
  if (hasPairs || hasGroups) {
    const cooldown = config.failoverRecoveryIntervalMs || 60000;
    failoverPinger = new FailoverPinger(failoverState, config, log, cooldown, groupState);
    failoverPinger.start(cooldown);
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
            if (!p || typeof p.input !== "number" || typeof p.output !== "number" || p.input < 0 || p.output < 0) {
              throw new Error(`price for "${k}" must be { input: number>=0, output: number>=0 }`);
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
      res.end(JSON.stringify({ config: config.failover || {}, active, groups }));
      return;
    }
    // POST /v1/failover — merge failover pairs in-memory (same pattern as POST /v1/plans)
    if (dashboard && req.method === "POST" && req.url === "/v1/failover") {
      readBody(req, 16384).then((body) => {
        try {
          const data = JSON.parse(body.toString("utf8"));
          if (typeof data !== "object") throw new Error("must be an object");
          const { pairs, cooldownMs } = data;
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
          if (cooldownMs !== undefined) {
            if (typeof cooldownMs !== "number" || cooldownMs < 1000) throw new Error("cooldownMs must be a number >= 1000");
            config.failoverRecoveryIntervalMs = cooldownMs;
          }
          // Clean stale failoverState entries whose patterns no longer exist.
          for (const model of failoverState.keys()) {
            if (!pickFailoverModel(config.failover, model)) failoverState.delete(model);
          }
          // Start the pinger if pairs now exist and it wasn't running
          if (config.failover && Object.keys(config.failover).length > 0 && !failoverPinger) {
            failoverPinger = new FailoverPinger(failoverState, config, log, config.failoverRecoveryIntervalMs || 60000, groupState);
            failoverPinger.start(config.failoverRecoveryIntervalMs || 60000);
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

    // GET /v1/models (and the bare /models) returns the configured routes as a
    // secret-free model listing (listModels). Intercepted BEFORE body reading/routing so
    // it needs no request body and never reaches a backend — everything else (POST
    // messages, passthrough, the vision reroute) flows through readBody → forward unchanged.
    if (req.method === "GET" && (req.url === "/v1/models" || req.url === "/models")) {
      const payload = JSON.stringify({ object: "list", data: listModels(config) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
      return;
    }
    readBody(req, maxBytes)
      .then((body) => {
        const statsCtx = dashboard ? { stats, startTime: Date.now() } : null;
        // Pass config.failover LIVE (not the startup snapshot) so dashboard edits take
        // effect; an empty map counts as "no pairs" (don't buffer every error needlessly).
        const liveFailover = config.failover && Object.keys(config.failover).length ? config.failover : null;
        forward(config, req, res, body, log, nonVisionCache, statsCtx, failoverState, liveFailover, groupState);
      })
      .catch((err) => sendError(res, err.status || 400, err.message || "bad request"));
  });

  // Expose stats + quotaPoller for teardown in tests
  server._modelpipe = { stats, quotaPoller, failoverState, failoverPinger, groupState };

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
