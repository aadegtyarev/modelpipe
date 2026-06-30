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

const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MB — bound the per-request buffer

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

// True when a route forwards the client's incoming auth header unchanged instead of
// swapping in a backend key (auth: "passthrough"). Lets a subscription/OAuth Claude
// Code session use the Anthropic/default route with NO backend API key.
export function isPassthrough(route) {
  return route && route.auth === "passthrough";
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
    // models_url + models_format: OPTIONAL, meaningful only on a glob route — the
    // provider's own model-listing endpoint, fetched by GET /v1/models?expand=1 to resolve
    // the glob into the concrete ids it currently matches. base_url is the messages
    // endpoint and tells us nothing about where a provider's catalog lives (the path
    // differs per provider), so this is a separate, explicit field — never guessed.
    // Both or neither: a models_format with no models_url has nothing to parse; a
    // models_url with no format is ambiguous about how to read the response.
    if (route.models_url !== undefined) {
      if (typeof route.models_url !== "string" || route.models_url.length === 0) {
        throw new Error(`${at}.models_url: must be a non-empty string`);
      }
      try {
        new URL(route.models_url);
      } catch {
        throw new Error(`${at}.models_url: not a valid URL`);
      }
      if (route.models_format !== "openai" && route.models_format !== "anthropic") {
        throw new Error(`${at}.models_format: required ("openai" or "anthropic") when models_url is set`);
      }
    } else if (route.models_format !== undefined) {
      throw new Error(`${at}.models_format: only valid when models_url is set`);
    }
    // auth is EITHER the string "passthrough" (forward the client's auth unchanged)
    // OR a key-swap object { header, keyEnv, scheme? }.
    if (route.auth === "passthrough") continue;
    if (!route.auth || typeof route.auth !== "object") throw new Error(`${at}.auth: missing (object or "passthrough")`);
    if (typeof route.auth.header !== "string" || route.auth.header.length === 0) throw new Error(`${at}.auth.header: missing`);
    if (typeof route.auth.keyEnv !== "string" || route.auth.keyEnv.length === 0) throw new Error(`${at}.auth.keyEnv: missing`);
  }
  if (visionCount > 1) throw new Error("config.routes: at most one route may set forImages: true (the vision fallback target)");
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
      out.auth = authView;
    }
    if (route.forImages !== undefined) out.forImages = route.forImages;
    if (route.forImagesModel !== undefined) out.forImagesModel = route.forImagesModel;
    if (route.vision !== undefined) out.vision = route.vision;
    if (route.models_url !== undefined) {
      out.models_url = route.models_url;
      out.models_format = route.models_format;
    }
    return out;
  });
  return safe;
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
      vision: r.vision !== false,                        // vision-capable unless explicitly opted out
      for_images: r.forImages === true,                  // the forImages vision-fallback flag
    };
  });
}

// ── GET /v1/models?expand=1 — glob expansion against the backend's own catalog ────
//
// The default listModels() above returns the route table AS CONFIGURED — a glob
// (`glm-*`) stays a glob. expand=1 resolves a glob route into the CONCRETE ids it
// currently matches, by fetching the provider's own model-listing endpoint
// (`models_url`) and filtering its catalog through the same `match` glob. Opt-in via
// query param so the default response is byte-for-byte unchanged (existing consumers,
// e.g. --probe, are unaffected).

// A model catalog can be larger than the small 400-error bodies REROUTE_BUFFER_CAP was
// sized for (a provider can list hundreds of ids) — its own, more generous cap.
const MODELS_CATALOG_BUFFER_CAP = 256 * 1024;
// Per-process-instance cache TTL for a fetched catalog — providers don't expect their
// model-listing endpoint to be hit on every client probe.
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
const MODELS_FETCH_TIMEOUT_MS = 5000;

// Parse a model-catalog response body into an array of model id strings. Both supported
// `models_format`s ("openai" and "anthropic") ship the same `{ data: [{ id, ... }] }`
// shape over the wire — the field exists for clarity/forward-compat, not because the
// parse differs today. Throws on bad JSON or a missing/non-array `data` (fail-closed: the
// caller falls back to the unexpanded glob rather than serve a partial/garbage id list).
export function parseModelsCatalog(body) {
  const parsed = JSON.parse(body.toString("utf8"));
  if (!parsed || !Array.isArray(parsed.data)) throw new Error("models catalog: response has no data[] array");
  return parsed.data.map((m) => m && m.id).filter((id) => typeof id === "string");
}

// Fetch (or return the cached) array of model ids from a route's models_url. `cache` is
// the per-router-instance Map(models_url → { ids, expiresAt }) passed down from
// createRouter. Auth mirrors the normal proxy hop: a key-swap route resolves its own
// backend key (resolveAuthHeader); a passthrough route forwards the CLIENT's incoming
// auth header unchanged (it has no backend key of its own — same rule as proxyToRoute).
// Rejects on any failure (bad URL, network error, non-200, oversize/unparseable body) —
// the caller (expandRouteEntry) catches and falls back to the unexpanded glob; this
// function never reaches further than one HTTP round trip and never throws past its
// Promise.
function fetchModelCatalog(route, req, cache) {
  const cached = cache.get(route.models_url);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.ids);

  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(route.models_url);
    } catch (err) {
      reject(err);
      return;
    }

    const headers = {};
    if (isPassthrough(route)) {
      if (req.headers["x-api-key"]) headers["x-api-key"] = req.headers["x-api-key"];
      if (req.headers["authorization"]) headers["authorization"] = req.headers["authorization"];
    } else {
      let auth;
      try {
        auth = resolveAuthHeader(route);
      } catch (err) {
        reject(err);
        return;
      }
      headers[auth.name] = auth.value;
    }

    const client = target.protocol === "http:" ? http : https;
    const upstreamReq = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "http:" ? 80 : 443),
        path: target.pathname + target.search,
        method: "GET",
        headers,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`models_url returned status ${res.statusCode}`));
          return;
        }
        bufferResponse(res, MODELS_CATALOG_BUFFER_CAP, (err, buffered) => {
          if (err) {
            reject(err);
            return;
          }
          let ids;
          try {
            ids = parseModelsCatalog(buffered);
          } catch (parseErr) {
            reject(parseErr);
            return;
          }
          cache.set(route.models_url, { ids, expiresAt: Date.now() + MODELS_CACHE_TTL_MS });
          resolve(ids);
        });
      },
    );
    upstreamReq.on("error", reject);
    upstreamReq.setTimeout(MODELS_FETCH_TIMEOUT_MS, () => upstreamReq.destroy(new Error("models_url request timed out")));
    upstreamReq.end();
  });
}

// One route's contribution to the expand=1 listing. `baseEntry` is this route's safe
// listModels() projection (id/object/host/auth/vision/for_images) — reused so there is
// one source of truth for those fields; this function only adds `match` + `concrete` and,
// for an expanded glob, swaps `id` to each matched concrete id.
//   • match has no `*` (already concrete)         → baseEntry as-is, concrete: true.
//   • match is a glob, no models_url configured    → baseEntry as-is, concrete: false.
//   • match is a glob, models_url configured       → fetch the catalog, filter by the
//     glob, return one entry per matched id, concrete: true.
//   • ANY failure above (network/auth/parse/no match) → falls back to the unexpanded
//     glob, concrete: false — a route never throws the whole endpoint down; partial
//     success (one backend's catalog up, another's down) is the normal case.
function expandRouteEntry(route, baseEntry, req, cache) {
  if (!route.match.includes("*")) {
    return Promise.resolve([{ ...baseEntry, match: route.match, concrete: true }]);
  }
  const fallback = [{ ...baseEntry, match: route.match, concrete: false }];
  if (!route.models_url) return Promise.resolve(fallback);
  return fetchModelCatalog(route, req, cache)
    .then((ids) => {
      const re = globToRegExp(route.match);
      const matched = ids.filter((id) => re.test(id));
      if (matched.length === 0) return fallback;
      return matched.map((id) => ({ ...baseEntry, id, match: route.match, concrete: true }));
    })
    .catch(() => fallback);
}

// The expand=1 view of GET /v1/models — see the section comment above. Built on
// listModels (one source of truth for the safe per-route fields); each route resolves
// independently via expandRouteEntry, which never rejects, so Promise.all here can't
// reject either — one backend's catalog being down never blocks another's expansion or
// fails the whole endpoint.
export function expandModels(config, req, cache) {
  const baseEntries = listModels(config);
  return Promise.all(config.routes.map((route, i) => expandRouteEntry(route, baseEntries[i], req, cache)))
    .then((groups) => ({ object: "list", data: groups.flat() }));
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
function pipeResponse(upstreamRes, res) {
  // Mid-stream upstream failure (the backend drops the socket after we began
  // streaming): the response headers are already sent, so sendError can only tear the
  // client connection down — never a write-after-headers crash.
  const onUpstreamFail = () => {
    if (res.headersSent) res.destroy();
    else sendError(res, 502, "upstream response error");
  };
  upstreamRes.on("error", onUpstreamFail);
  upstreamRes.on("aborted", onUpstreamFail);
  res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
  upstreamRes.pipe(res);
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
function proxyToRoute(route, req, res, body, log, { onResponse } = {}) {
  const passthrough = isPassthrough(route);
  let auth = null;
  if (!passthrough) {
    try {
      auth = resolveAuthHeader(route);
    } catch (err) {
      sendError(res, err.status || 500, err.message);
      return;
    }
  }

  const upstream = new URL(route.base_url);
  log(`${modelFromBody(body)} -> ${upstream.host}`); // safe: model + hostname only, never key/body/header

  // Passthrough keeps the client's auth header; key-swap drops it and sets the backend's.
  const headers = sanitizeHeaders(req.headers, upstream.host, { keepClientAuth: passthrough });
  if (auth) headers[auth.name] = auth.value;
  if (body.length) headers["content-length"] = String(body.length);

  // A dropped/aborted client connection must not crash the process or leave the
  // upstream hanging.
  res.on("error", () => {});

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
    onResponse || ((upstreamRes) => pipeResponse(upstreamRes, res)),
  );
  upstreamReq.on("error", () => sendError(res, 502, "upstream request failed"));
  if (body.length) upstreamReq.write(body);
  upstreamReq.end();
}

// Build the response handler that realises the reactive vision fallback. `ctx` carries
// the in-flight request; `isVisionTarget` is true when the route being answered IS the
// `forImages` route (so a 400-image from it is the loop-guard case, never a re-reroute).
function makeResponseHandler(ctx) {
  return (upstreamRes) => {
    const status = upstreamRes.statusCode || 502;
    // 2xx and every other non-400 stream straight back — a success / SSE is NEVER
    // buffered, so streaming stays intact.
    if (status !== 400) {
      pipeResponse(upstreamRes, ctx.res);
      return;
    }
    // A 400: buffer the small error body and classify it.
    bufferResponse(upstreamRes, REROUTE_BUFFER_CAP, (err, buffered, headers) => {
      if (err) {
        if (!ctx.res.headersSent) sendError(ctx.res, 502, "upstream error response could not be relayed");
        else ctx.res.destroy();
        return;
      }
      if (isImageUnsupported400(status, buffered)) {
        if (ctx.isVisionTarget) {
          // Loop guard: the vision target itself can't take the image — clear error,
          // never re-reroute (no infinite loop).
          sendError(ctx.res, 422, "vision route cannot process this image request; not rerouting (loop guard)");
          return;
        }
        if (ctx.visionRoute) {
          // Reroute the buffered request to the vision target, rewriting only `model`
          // to the route's forImagesModel (the cross-provider hop); remember the client
          // model so the next image call pre-routes (per-process cache, never the payload).
          if (ctx.model) ctx.nonVisionCache.set(ctx.model, true);
          const visionBody = rewriteModelInBody(ctx.body, ctx.visionRoute.forImagesModel);
          proxyToRoute(ctx.visionRoute, ctx.req, ctx.res, visionBody, ctx.log, {
            onResponse: makeResponseHandler({ ...ctx, isVisionTarget: true }),
          });
          return;
        }
        // No vision fallback configured — fail LOUD with a clear error, never the raw
        // cryptic upstream 400.
        sendError(ctx.res, 422, `model "${ctx.model}" cannot process images and no vision fallback is configured`);
        return;
      }
      // An ambiguous 400 (a real bad request) — relay it as-is, never reroute.
      relayBuffered(ctx.res, status, headers, buffered);
    });
  };
}

// Route one buffered request to its backend, with the reactive vision fallback.
// `nonVisionCache` is a per-process Map(model → true) of models a backend has already
// rejected for images — ephemeral state, never the payload.
function forward(config, req, res, body, log, nonVisionCache) {
  const model = modelFromBody(body);
  const route = pickRoute(model, config.routes);
  if (!route) {
    sendError(res, 400, model ? `no route for model "${model}"` : "request has no routable model");
    return;
  }

  const visionRoute = pickVisionRoute(config.routes);

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
      onResponse: makeResponseHandler({ res, req, body, log, model, visionRoute, nonVisionCache, isVisionTarget: true }),
    });
    return;
  }

  proxyToRoute(route, req, res, body, log, {
    onResponse: makeResponseHandler({
      res, req, body, log, model, visionRoute, nonVisionCache, isVisionTarget: route === visionRoute,
    }),
  });
}

// Build the router as an http.Server. `options.log` overrides the stderr logger
// (used by the self-test to capture the routing line).
export function createRouter(config, options = {}) {
  validateConfig(config);
  const maxBytes = config.maxBodyBytes || DEFAULT_MAX_BODY_BYTES;
  const log = options.log || defaultLogger();
  // Per-process (per-router-instance) cache of models a backend rejected for images,
  // so a repeat image call pre-routes to the vision target without the failing first
  // hop. Ephemeral, holds only model ids — never any request payload.
  const nonVisionCache = new Map();
  // Per-router-instance cache of a backend's fetched model catalog (expand=1). See the
  // GET /v1/models?expand=1 section above.
  const modelsCache = new Map();
  return http.createServer((req, res) => {
    // GET /v1/models (and the bare /models) returns the configured routes as a
    // secret-free model listing (listModels). Intercepted BEFORE body reading/routing so
    // it needs no request body and never reaches a backend — everything else (POST
    // messages, passthrough, the vision reroute) flows through readBody → forward unchanged.
    if (req.method === "GET") {
      const url = new URL(req.url, "http://placeholder"); // base is required by the ctor; never used
      if (url.pathname === "/v1/models" || url.pathname === "/models") {
        if (url.searchParams.get("expand") === "1") {
          // expand=1: resolve each glob route against its backend's own catalog
          // (models_url). Opt-in — the plain GET below is byte-for-byte unchanged.
          expandModels(config, req, modelsCache)
            .then((payload) => {
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify(payload));
            })
            .catch(() => sendError(res, 502, "failed to build the expanded model listing"));
          return;
        }
        const payload = JSON.stringify({ object: "list", data: listModels(config) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(payload);
        return;
      }
    }
    readBody(req, maxBytes)
      .then((body) => forward(config, req, res, body, log, nonVisionCache))
      .catch((err) => sendError(res, err.status || 400, err.message || "bad request"));
  });
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
