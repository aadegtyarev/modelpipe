// Self-test for the modelpipe passthrough model router (src/router.mjs).
//
// NO network, NO real keys. Two STUB upstream http servers on localhost stand in
// for the backends (an x-api-key one for "Anthropic", a Bearer one). The router
// is driven through its REAL http path (createRouter → a listening server → real
// http.request from a test client), so routing, the auth swap, body + streamed
// response passthrough, fail-closed behaviour, and log safety are all exercised
// on the real socket, not a mock.
//
// NOTE on the Bearer route: the official DeepSeek Anthropic-compatible endpoint
// authenticates with `x-api-key` (verified 2026-06-30; the example config uses
// that). The Bearer stub here exists purely to exercise the router's scheme-SWAP
// code path — proving the MECHANISM can emit `Authorization: Bearer <key>` for any
// backend that needs it, not a claim about DeepSeek.
//
// Run: node test/router.test.mjs

import http from "node:http";
import {
  createRouter,
  pickRoute,
  listModels,
  globToRegExp,
  modelFromBody,
  rewriteModelInBody,
  resolveAuthHeader,
  isPassthrough,
  bodyHasImageBlock,
  isImageUnsupported400,
  isFailoverTrigger,
  pickFailoverModel,
  pickVisionRoute,
  validateConfig,
  listConfig,
  ladderPosition,
  effectiveLadderModel,
  resolveGroup,
  isFallbackAuth,
  clientHasAuth,
  pickAccountIndex,
  accountEligible,
} from "../src/router.mjs";

let pass = 0;
const fails = [];
function check(name, got, want) {
  if (got === want) { pass++; return; }
  fails.push(`  ✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// A stub upstream: records every request it receives, then answers with a body
// streamed in three separate writes (proving chunked/streamed passthrough).
const STREAM_PARTS = ["chunk-A;", "chunk-B;", "chunk-C"];
const STREAM_BODY = STREAM_PARTS.join("");
function makeStub() {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(STREAM_PARTS[0]);
      res.write(STREAM_PARTS[1]);
      res.end(STREAM_PARTS[2]);
    });
  });
  return { server, received };
}

// A mode-switchable stub for the vision-fallback scenarios. `mode`:
//   "ok"      → streamed 200 (the multimodal / vision-success path)
//   "reject"  → 400 with the image-unsupported signal body
//   "badreq"  → 400 with an ambiguous (non-image) error body
function makeModeStub(initialMode) {
  const received = [];
  let mode = initialMode;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      if (mode === "ok") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(STREAM_PARTS[0]);
        res.write(STREAM_PARTS[1]);
        res.end(STREAM_PARTS[2]);
        return;
      }
      const message = mode === "reject"
        ? "this model does not support image blocks"
        : "messages: roles must alternate between user and assistant";
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message } }));
    });
  });
  return { server, received, setMode: (m) => { mode = m; } };
}

// A stub that returns a configurable status code and body. `responseStatus` and
// `responseBody` can be updated at any time via the returned setters.
function makeFlexStub(initialStatus = 200, initialBody = null) {
  const received = [];
  let status = initialStatus;
  let body = initialBody;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      const responseBody = body || JSON.stringify({ id: "ok", model: JSON.parse(Buffer.concat(chunks).toString("utf8")).model || "unknown" });
      const ct = status >= 400 ? "application/json" : "text/event-stream";
      res.writeHead(status, { "content-type": ct });
      if (status < 400) {
        res.write("chunk-A;");
        res.write("chunk-B;");
        res.end("chunk-C");
      } else {
        res.end(typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody));
      }
    });
  });
  return { server, received, setStatus: (s) => { status = s; }, setBody: (b) => { body = b; } };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

// Send a request THROUGH the router. `raw` (string) sends arbitrary bytes; else a
// JS object is JSON-encoded. Always carries a bogus client front-key so we can
// prove the router strips it before forwarding.
function request(port, payload, { raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(raw !== undefined ? raw : JSON.stringify(payload));
    const req = http.request(
      {
        hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "CLIENT-FRONT-KEY",
          "anthropic-version": "2023-06-01",
          "content-length": data.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// A GET through the router (for the /v1/models listing intercept). No body; resolves
// with status + body. Distinct from `request` (POST /v1/messages) so the listing and
// the routing paths stay separately exercisable.
function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method: "GET" },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// POST /v1/messages with caller-controlled headers (to exercise fallback auth: send or
// omit the client's own auth header). Unlike `request`, sets NO auth header by default.
function requestH(port, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload));
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST",
        headers: { "content-type": "application/json", "content-length": data.length, ...headers } },
      (res) => { const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString("utf8"), headers: res.headers })); },
    );
    req.on("error", reject); req.write(data); req.end();
  });
}

// A bare POST to an arbitrary path (for management endpoints like /v1/failover/reset).
function postPath(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method: "POST" },
      (res) => { const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString("utf8") })); },
    );
    req.on("error", reject); req.end();
  });
}

// A tolerant client for the mid-stream-abort case: resolves with whatever partial
// body arrived no matter HOW the connection ended (clean end, aborted, error, or a
// req-side error) — the point is to prove the router survives an upstream mid-stream
// drop without crashing, and that the partial reached the client.
function requestTolerant(port, payload) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(payload));
    let status = 0;
    const chunks = [];
    let done = false;
    const finish = (how) => {
      if (done) return;
      done = true;
      resolve({ status, body: Buffer.concat(chunks).toString("utf8"), how });
    };
    const req = http.request(
      {
        hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "CLIENT-FRONT-KEY", "content-length": data.length },
      },
      (res) => {
        status = res.statusCode;
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => finish("end"));
        res.on("aborted", () => finish("aborted"));
        res.on("error", () => finish("error"));
        res.on("close", () => finish("close"));
      },
    );
    req.on("error", () => finish("req-error"));
    req.write(data);
    req.end();
  });
}

// Bind a throwaway server to an ephemeral port, then close it — returns a port that
// is now free, so a route pointed at it connection-refuses (the 502 upstream case).
function closedPort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function main() {
  // ── pure-function units (no network) ──────────────────────────────────────
  check("glob claude-* matches", globToRegExp("claude-*").test("claude-opus-4-8"), true);
  check("glob claude-* rejects deepseek", globToRegExp("claude-*").test("deepseek-chat"), false);
  check("glob escapes the dot (no wildcard)", globToRegExp("claude-4.8").test("claude-4x8"), false);
  check("modelFromBody reads model", modelFromBody(Buffer.from('{"model":"m-1"}')), "m-1");
  check("modelFromBody bad json ⇒ null", modelFromBody(Buffer.from("not json")), null);
  check("modelFromBody no model ⇒ null", modelFromBody(Buffer.from("{}")), null);
  check("modelFromBody empty ⇒ null", modelFromBody(Buffer.from("")), null);
  check("rewriteModelInBody replaces the model id",
    modelFromBody(rewriteModelInBody(Buffer.from('{"model":"glm-x","messages":[]}'), "vendor/m")), "vendor/m");
  check("rewriteModelInBody preserves other fields",
    JSON.parse(rewriteModelInBody(Buffer.from('{"model":"glm-x","messages":[1]}'), "vendor/m").toString()).messages[0], 1);
  check("rewriteModelInBody falsy newModel ⇒ body unchanged",
    rewriteModelInBody(Buffer.from('{"model":"glm-x"}'), "").toString(), '{"model":"glm-x"}');
  check("rewriteModelInBody bad json ⇒ body unchanged (fail-safe)",
    rewriteModelInBody(Buffer.from("not json"), "vendor/m").toString(), "not json");

  const sampleRoutes = [
    { match: "claude-*", base_url: "https://api.anthropic.com", auth: { header: "x-api-key", keyEnv: "K" } },
    { match: "deepseek-*", base_url: "https://api.deepseek.com/anthropic", auth: { header: "x-api-key", keyEnv: "K" } },
  ];
  check("pickRoute first match wins", pickRoute("claude-x", sampleRoutes).match, "claude-*");
  check("pickRoute unknown ⇒ null", pickRoute("gpt-4", sampleRoutes), null);
  check("pickRoute empty model ⇒ null", pickRoute("", sampleRoutes), null);

  // ── listModels pure unit (secret-free NETWORK view, projects listConfig) ────
  const modelsListed = listModels({ routes: sampleRoutes });
  check("listModels lists every route", modelsListed.length, sampleRoutes.length);
  check("listModels id is the route match glob", modelsListed[0].id, "claude-*");
  check("listModels object is \"model\"", modelsListed[0].object, "model");
  check("listModels host is the base_url host (no path)", modelsListed[1].host, "api.deepseek.com");
  check("listModels leaks NO base_url path", JSON.stringify(modelsListed).includes("/anthropic"), false);
  check("listModels auth mode is \"key\" for a key-swap route", modelsListed[0].auth, "key");
  const secretRoutes = [
    { match: "x-*", base_url: "https://host.example", auth: { header: "x-api-key", keyEnv: "LEAKME-ENV-NAME" } },
    { match: "y-*", base_url: "https://host.example", auth: "passthrough", forImages: true },
  ];
  const secretListed = listModels({ routes: secretRoutes });
  const secretBlob = JSON.stringify(secretListed);
  check("listModels leaks NO key env-var name", secretBlob.includes("LEAKME-ENV-NAME"), false);
  check("listModels leaks NO auth header name", secretBlob.includes("x-api-key"), false);
  check("listModels auth \"passthrough\" for a passthrough route", secretListed[1].auth, "passthrough");
  check("listModels for_images reflects the forImages flag", secretListed[1].for_images, true);
  check("listModels for_images false when the flag is unset", secretListed[0].for_images, false);
  check("listModels host null on a bad base_url",
    listModels({ routes: [{ match: "z-*", base_url: "not-a-url", auth: "passthrough" }] })[0].host, null);
  check("resolveAuthHeader raw value", resolveAuthHeader(sampleRoutes[0], { K: "secret" }).value, "secret");
  check("resolveAuthHeader scheme prepend",
    resolveAuthHeader({ auth: { header: "Authorization", keyEnv: "K", scheme: "Bearer" } }, { K: "secret" }).value,
    "Bearer secret");
  let unsetThrew = false;
  try { resolveAuthHeader(sampleRoutes[0], {}); } catch { unsetThrew = true; }
  check("resolveAuthHeader unset env throws (fail-closed)", unsetThrew, true);
  check("isPassthrough true for string \"passthrough\"", isPassthrough({ auth: "passthrough" }), true);
  check("isPassthrough false for a key-swap object", isPassthrough(sampleRoutes[0]), false);

  // ── vision-fallback pure units (no network) ───────────────────────────────
  const imageBody = Buffer.from(JSON.stringify({
    model: "m", messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "hi" },
    ] }],
  }));
  check("bodyHasImageBlock detects an image block", bodyHasImageBlock(imageBody), true);
  check("bodyHasImageBlock false for text-only content array",
    bodyHasImageBlock(Buffer.from('{"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}')), false);
  check("bodyHasImageBlock false for a string content turn",
    bodyHasImageBlock(Buffer.from('{"model":"m","messages":[{"role":"user","content":"hi"}]}')), false);
  check("bodyHasImageBlock false for bad json", bodyHasImageBlock(Buffer.from("not json")), false);
  check("bodyHasImageBlock false for empty", bodyHasImageBlock(Buffer.from("")), false);

  const imageErr = Buffer.from('{"error":{"message":"this model does not support image blocks"}}');
  check("isImageUnsupported400 matches the image-unsupported signal", isImageUnsupported400(400, imageErr), true);
  check("isImageUnsupported400 ignores a non-400 status", isImageUnsupported400(500, imageErr), false);
  check("isImageUnsupported400 rejects an ambiguous 400",
    isImageUnsupported400(400, Buffer.from('{"error":{"message":"messages: roles must alternate between user and assistant"}}')), false);
  check("isImageUnsupported400 rejects a 400 mentioning image without support/block",
    isImageUnsupported400(400, Buffer.from('{"error":{"message":"image bytes were truncated"}}')), false);
  check("isImageUnsupported400 false for bad json", isImageUnsupported400(400, Buffer.from("not json")), false);

  const visionRoutes = [
    { match: "nonvis-*", base_url: "https://a.example", auth: { header: "x-api-key", keyEnv: "K" } },
    { match: "vis-*", base_url: "https://b.example", forImages: true, forImagesModel: "vendor/vis", auth: { header: "x-api-key", keyEnv: "K" } },
  ];
  check("pickVisionRoute returns the forImages route", pickVisionRoute(visionRoutes).match, "vis-*");
  check("pickVisionRoute null when none flagged", pickVisionRoute(sampleRoutes), null);
  check("validateConfig accepts one forImages route",
    validateConfig({ routes: visionRoutes }).routes.length, 2);
  let twoVisionThrew = false;
  try {
    validateConfig({ routes: [
      { match: "a-*", base_url: "https://a.example", forImages: true, forImagesModel: "vendor/a", auth: { header: "x-api-key", keyEnv: "K" } },
      { match: "b-*", base_url: "https://b.example", forImages: true, forImagesModel: "vendor/b", auth: { header: "x-api-key", keyEnv: "K" } },
    ] });
  } catch { twoVisionThrew = true; }
  check("validateConfig rejects two forImages routes", twoVisionThrew, true);
  let badVisionThrew = false;
  try {
    validateConfig({ routes: [{ match: "a-*", base_url: "https://a.example", forImages: "yes", auth: { header: "x-api-key", keyEnv: "K" } }] });
  } catch { badVisionThrew = true; }
  check("validateConfig rejects a non-true forImages", badVisionThrew, true);
  let missingModelThrew = false;
  try {
    validateConfig({ routes: [{ match: "vis-*", base_url: "https://b.example", forImages: true, auth: { header: "x-api-key", keyEnv: "K" } }] });
  } catch { missingModelThrew = true; }
  check("validateConfig rejects forImages route with no forImagesModel (fail-closed)", missingModelThrew, true);
  let strayModelThrew = false;
  try {
    validateConfig({ routes: [{ match: "x-*", base_url: "https://b.example", forImagesModel: "vendor/x", auth: { header: "x-api-key", keyEnv: "K" } }] });
  } catch { strayModelThrew = true; }
  check("validateConfig rejects forImagesModel without forImages", strayModelThrew, true);
  let emptyModelThrew = false;
  try {
    validateConfig({ routes: [{ match: "vis-*", base_url: "https://b.example", forImages: true, forImagesModel: "", auth: { header: "x-api-key", keyEnv: "K" } }] });
  } catch { emptyModelThrew = true; }
  check("validateConfig rejects an empty forImagesModel", emptyModelThrew, true);
  let badVisionFlagThrew = false;
  try {
    validateConfig({ routes: [{ match: "a-*", base_url: "https://a.example", vision: "no", auth: { header: "x-api-key", keyEnv: "K" } }] });
  } catch { badVisionFlagThrew = true; }
  check("validateConfig rejects a non-boolean vision flag", badVisionFlagThrew, true);
  check("validateConfig accepts vision:false",
    validateConfig({ routes: [{ match: "a-*", base_url: "https://a.example", vision: false, auth: { header: "x-api-key", keyEnv: "K" } }] }).routes[0].vision, false);

  // ── failover config validation ─────────────────────────────────────────────
  check("validateConfig accepts valid failover config",
    validateConfig({ routes: [{ match: "a-*", base_url: "https://a.example", auth: { header: "x-api-key", keyEnv: "K" } }], failover: { "a-*": "b" } }).failover["a-*"], "b");
  let foEmptyKeyThrew = false;
  try {
    validateConfig({ routes: [{ match: "a-*", base_url: "https://a.example", auth: { header: "x-api-key", keyEnv: "K" } }], failover: { "": "b" } });
  } catch { foEmptyKeyThrew = true; }
  check("validateConfig rejects empty failover key", foEmptyKeyThrew, true);
  let foEmptyValThrew = false;
  try {
    validateConfig({ routes: [{ match: "a-*", base_url: "https://a.example", auth: { header: "x-api-key", keyEnv: "K" } }], failover: { "a-*": "" } });
  } catch { foEmptyValThrew = true; }
  check("validateConfig rejects empty failover value", foEmptyValThrew, true);
  let foBadTypeThrew = false;
  try {
    validateConfig({ routes: [{ match: "a-*", base_url: "https://a.example", auth: { header: "x-api-key", keyEnv: "K" } }], failover: "not-an-object" });
  } catch { foBadTypeThrew = true; }
  check("validateConfig rejects non-object failover", foBadTypeThrew, true);
  let foBadCooldownThrew = false;
  try {
    validateConfig({ routes: [{ match: "a-*", base_url: "https://a.example", auth: { header: "x-api-key", keyEnv: "K" } }], failoverRecoveryIntervalMs: 500 });
  } catch { foBadCooldownThrew = true; }
  check("validateConfig rejects failoverRecoveryIntervalMs < 1000", foBadCooldownThrew, true);
  check("validateConfig accepts failoverRecoveryIntervalMs",
    validateConfig({ routes: [{ match: "a-*", base_url: "https://a.example", auth: { header: "x-api-key", keyEnv: "K" } }], failoverRecoveryIntervalMs: 5000 }).failoverRecoveryIntervalMs, 5000);

  // ── isFailoverTrigger (pure, no network) ───────────────────────────────────
  const rateLimitBody429 = Buffer.from('{"error":{"message":"rate limit exceeded"}}');
  check("isFailoverTrigger: 429 always triggers", isFailoverTrigger(429, Buffer.from("")), true);
  check("isFailoverTrigger: 529 always triggers", isFailoverTrigger(529, Buffer.from("")), true);
  check("isFailoverTrigger: 503 + rate-limit message triggers", isFailoverTrigger(503, rateLimitBody429), true);
  check("isFailoverTrigger: 503 + temp unavailable triggers",
    isFailoverTrigger(503, Buffer.from('{"error":{"message":"temporarily unavailable"}}')), true);
  check("isFailoverTrigger: 503 + overloaded triggers",
    isFailoverTrigger(503, Buffer.from('{"error":{"message":"server overloaded"}}')), true);
  check("isFailoverTrigger: 503 ambiguous does NOT trigger",
    isFailoverTrigger(503, Buffer.from('{"error":{"message":"internal server error"}}')), false);
  check("isFailoverTrigger: 400 + rate-limit message triggers", isFailoverTrigger(400, rateLimitBody429), true);
  check("isFailoverTrigger: 400 + ambiguous message does NOT trigger",
    isFailoverTrigger(400, Buffer.from('{"error":{"message":"messages: roles must alternate"}}')), false);
  check("isFailoverTrigger: 402 + 'credit balance' triggers",
    isFailoverTrigger(402, Buffer.from('{"error":{"message":"Your credit balance is too low"}}')), true);
  check("isFailoverTrigger: 403 + 'organization disabled' triggers",
    isFailoverTrigger(403, Buffer.from('{"error":{"message":"Organization is disabled"}}')), true);
  check("isFailoverTrigger: 200 never triggers", isFailoverTrigger(200, rateLimitBody429), false);
  check("isFailoverTrigger: bad json ⇒ false", isFailoverTrigger(503, Buffer.from("not json")), false);
  check("isFailoverTrigger: empty body ⇒ false", isFailoverTrigger(503, Buffer.from("")), false);
  check("isFailoverTrigger: 500 + 'try again later' triggers",
    isFailoverTrigger(500, Buffer.from('{"error":{"message":"try again later"}}')), true);
  check("isFailoverTrigger: 502 + 'cannot process' triggers",
    isFailoverTrigger(502, Buffer.from('{"error":{"message":"cannot process request"}}')), true);
  check("isFailoverTrigger: 503 + 'capacity' triggers",
    isFailoverTrigger(503, Buffer.from('{"error":{"message":"at capacity"}}')), true);
  check("isFailoverTrigger: 403 + 'account disabled' triggers",
    isFailoverTrigger(403, Buffer.from('{"error":{"message":"account is disabled"}}')), true);
  check("isFailoverTrigger: 402 + 'payment required' triggers",
    isFailoverTrigger(402, Buffer.from('{"error":{"message":"payment required"}}')), true);
  check("isFailoverTrigger: 500 + 'quota exceeded' triggers",
    isFailoverTrigger(500, Buffer.from('{"error":{"message":"quota exceeded"}}')), true);

  // ── pickFailoverModel (pure) ───────────────────────────────────────────────
  check("pickFailoverModel matches by glob", pickFailoverModel({ "claude-*": "glm-5.1" }, "claude-opus-4-8"), "glm-5.1");
  check("pickFailoverModel no match returns null", pickFailoverModel({ "claude-*": "glm-5.1" }, "deepseek-chat"), null);
  check("pickFailoverModel null config ⇒ null", pickFailoverModel(null, "any"), null);
  check("pickFailoverModel empty string model ⇒ null", pickFailoverModel({ "a-*": "b" }, ""), null);
  check("pickFailoverModel exact match", pickFailoverModel({ "glm-5.1": "deepseek-v4-pro" }, "glm-5.1"), "deepseek-v4-pro");
  check("pickFailoverModel first match wins", pickFailoverModel({ "claude-*": "glm-5.1", "claude-opus-*": "deepseek" }, "claude-opus-4-8"), "glm-5.1");

  // ── failover GROUPS: pure helpers ──────────────────────────────────────────
  const LADDER = ["claude-opus-*", "glm-5.1", "deepseek-v4-pro"];
  check("ladderPosition head glob matches", ladderPosition(LADDER, "claude-opus-4-8"), 0);
  check("ladderPosition concrete tier matches", ladderPosition(LADDER, "glm-5.1"), 1);
  check("ladderPosition last tier matches", ladderPosition(LADDER, "deepseek-v4-pro"), 2);
  check("ladderPosition no match ⇒ -1", ladderPosition(LADDER, "gpt-x"), -1);
  check("ladderPosition empty model ⇒ -1", ladderPosition(LADDER, ""), -1);
  check("effectiveLadderModel offset 0 = self", effectiveLadderModel(LADDER, 0, 0), "claude-opus-*");
  check("effectiveLadderModel offset 1 shifts head→glm", effectiveLadderModel(LADDER, 1, 0), "glm-5.1");
  check("effectiveLadderModel offset 1 shifts glm→deepseek", effectiveLadderModel(LADDER, 1, 1), "deepseek-v4-pro");
  check("effectiveLadderModel clamps at last tier", effectiveLadderModel(LADDER, 5, 2), "deepseek-v4-pro");
  const groups = [{ ladder: LADDER, mode: "shift" }];
  const gs0 = [{ offset: 0 }];
  const gs1 = [{ offset: 1 }];
  check("resolveGroup offset 0: opus serves itself", resolveGroup(groups, gs0, "claude-opus-4-8").effectiveModel, "claude-opus-*");
  check("resolveGroup offset 1: opus → glm", resolveGroup(groups, gs1, "claude-opus-4-8").effectiveModel, "glm-5.1");
  check("resolveGroup offset 1: glm → deepseek (whole ladder shifts)", resolveGroup(groups, gs1, "glm-5.1").effectiveModel, "deepseek-v4-pro");
  check("resolveGroup returns position", resolveGroup(groups, gs0, "glm-5.1").position, 1);
  check("resolveGroup no ladder match ⇒ null", resolveGroup(groups, gs0, "gpt-x"), null);
  check("resolveGroup no groups ⇒ null", resolveGroup(undefined, gs0, "glm-5.1"), null);

  // ── fallback auth (pure) ────────────────────────────────────────────────────
  check("isFallbackAuth true when flagged", isFallbackAuth({ auth: { header: "x-api-key", keyEnv: "K", fallback: true } }), true);
  check("isFallbackAuth false by default", isFallbackAuth({ auth: { header: "x-api-key", keyEnv: "K" } }), false);
  check("isFallbackAuth false for passthrough", isFallbackAuth({ auth: "passthrough" }), false);
  check("clientHasAuth true with x-api-key", clientHasAuth({ "x-api-key": "sk" }), true);
  check("clientHasAuth true with authorization", clientHasAuth({ authorization: "Bearer t" }), true);
  check("clientHasAuth false when empty", clientHasAuth({ "x-api-key": "" }), false);
  check("clientHasAuth false when absent", clientHasAuth({ "content-type": "x" }), false);
  check("validateConfig accepts auth.fallback",
    validateConfig({ routes: [{ match: "a-*", base_url: "https://a.example", auth: { header: "x-api-key", keyEnv: "K", fallback: true } }] }).routes[0].auth.fallback, true);
  let fbBadThrew = false;
  try { validateConfig({ routes: [{ match: "a-*", base_url: "https://a.example", auth: { header: "x-api-key", keyEnv: "K", fallback: "yes" } }] }); } catch { fbBadThrew = true; }
  check("validateConfig rejects non-boolean fallback", fbBadThrew, true);

  // ── account pools (pure) ────────────────────────────────────────────────────
  const mkPool = (strategy, exhausted = []) => ({ strategy, rr: -1, accounts: [0, 1, 2].map((i) => ({ label: "a" + i, exhaustedUntil: exhausted[i] || 0 })) });
  check("pickAccountIndex failover: lowest eligible", pickAccountIndex(mkPool("failover"), 1000), 0);
  check("pickAccountIndex failover: skips exhausted #0", pickAccountIndex(mkPool("failover", [9999]), 1000), 1);
  check("pickAccountIndex failover: exclude just-failed", pickAccountIndex(mkPool("failover"), 1000, 0), 1);
  check("pickAccountIndex all exhausted → least-recently (smallest until)", pickAccountIndex(mkPool("failover", [5000, 3000, 8000]), 1000), 1);
  const rr = mkPool("round-robin");
  const r1 = pickAccountIndex(rr, 1000), r2 = pickAccountIndex(rr, 1000), r3 = pickAccountIndex(rr, 1000), r4 = pickAccountIndex(rr, 1000);
  check("round-robin cycles 0,1,2,0", [r1, r2, r3, r4].join(","), "0,1,2,0");
  const rrEx = mkPool("round-robin", [0, 9999, 0]); // #1 exhausted
  check("round-robin skips exhausted", [pickAccountIndex(rrEx, 1000), pickAccountIndex(rrEx, 1000)].join(","), "0,2");
  check("accountEligible true when cooldown elapsed", accountEligible(mkPool("failover"), 0, 1000), true);
  check("accountEligible false when in cooldown", accountEligible(mkPool("failover", [9999]), 0, 1000), false);

  // ── validateConfig: accounts + strategy ─────────────────────────────────────
  const acctOK = { routes: [{ match: "g-*", base_url: "https://g.example", accounts: [
    { label: "m", auth: { header: "x-api-key", keyEnv: "K1" } },
    { label: "b", auth: { header: "x-api-key", keyEnv: "K2" } },
  ], strategy: "round-robin" }] };
  check("validateConfig accepts accounts pool (auth optional on route)", validateConfig(acctOK).routes[0].accounts.length, 2);
  const acctThrow = (cfg) => { try { validateConfig(cfg); return false; } catch { return true; } };
  check("rejects empty accounts", acctThrow({ routes: [{ match: "g-*", base_url: "https://g.example", accounts: [] }] }), true);
  check("rejects duplicate label", acctThrow({ routes: [{ match: "g-*", base_url: "https://g.example", accounts: [{ label: "x", auth: { header: "h", keyEnv: "K" } }, { label: "x", auth: { header: "h", keyEnv: "K2" } }] }] }), true);
  check("rejects account missing auth", acctThrow({ routes: [{ match: "g-*", base_url: "https://g.example", accounts: [{ label: "x" }] }] }), true);
  check("rejects strategy without accounts", acctThrow({ routes: [{ match: "g-*", base_url: "https://g.example", auth: { header: "h", keyEnv: "K" }, strategy: "failover" }] }), true);
  check("rejects bad strategy", acctThrow({ routes: [{ match: "g-*", base_url: "https://g.example", accounts: [{ label: "x", auth: { header: "h", keyEnv: "K" } }, { label: "y", auth: { header: "h", keyEnv: "K2" } }], strategy: "spread" }] }), true);
  check("rejects bad account base_url", acctThrow({ routes: [{ match: "g-*", base_url: "https://g.example", accounts: [{ label: "x", base_url: "not a url", auth: { header: "h", keyEnv: "K" } }, { label: "y", auth: { header: "h", keyEnv: "K2" } }] }] }), true);

  // ── validateConfig: failoverGroups ─────────────────────────────────────────
  const baseRoute = { routes: [{ match: "a-*", base_url: "https://a.example", auth: { header: "x-api-key", keyEnv: "K" } }] };
  check("validateConfig accepts valid failoverGroups",
    validateConfig({ ...baseRoute, failoverGroups: [{ ladder: ["a-*", "b-1", "c-1"], mode: "shift" }] }).failoverGroups[0].mode, "shift");
  let grpNotArrThrew = false;
  try { validateConfig({ ...baseRoute, failoverGroups: {} }); } catch { grpNotArrThrew = true; }
  check("validateConfig rejects non-array failoverGroups", grpNotArrThrew, true);
  let grpShortThrew = false;
  try { validateConfig({ ...baseRoute, failoverGroups: [{ ladder: ["a-*"] }] }); } catch { grpShortThrew = true; }
  check("validateConfig rejects ladder < 2 tiers", grpShortThrew, true);
  let grpGlobTargetThrew = false;
  try { validateConfig({ ...baseRoute, failoverGroups: [{ ladder: ["a-*", "b-*"] }] }); } catch { grpGlobTargetThrew = true; }
  check("validateConfig rejects glob in a lower (target) tier", grpGlobTargetThrew, true);
  let grpBadModeThrew = false;
  try { validateConfig({ ...baseRoute, failoverGroups: [{ ladder: ["a-*", "b-1"], mode: "wat" }] }); } catch { grpBadModeThrew = true; }
  check("validateConfig rejects bad group mode", grpBadModeThrew, true);

  // ── listConfig: the safe `--list` discovery summary (no network, no secrets) ─
  const listSample = {
    proxyUrl: "http://127.0.0.1:8787",
    routes: [
      { match: "claude-*", base_url: "https://api.anthropic.com", auth: "passthrough" },
      { match: "deepseek-*", base_url: "https://api.deepseek.com/anthropic", auth: { header: "x-api-key", keyEnv: "DEEPSEEK_API_KEY" } },
      { match: "vision-*", base_url: "https://openrouter.ai/api", forImages: true, forImagesModel: "google/gemini-2.5-flash-lite", auth: { header: "Authorization", scheme: "Bearer", keyEnv: "OPENROUTER_API_KEY" } },
      { match: "nonvis-*", base_url: "https://nv.example", vision: false, auth: { header: "x-api-key", keyEnv: "NV_KEY" } },
    ],
  };
  const listed = listConfig(listSample);
  // per-route safe fields: match + base_url present on every route.
  check("listConfig surfaces match", listed.routes[0].match, "claude-*");
  check("listConfig surfaces base_url", listed.routes[1].base_url, "https://api.deepseek.com/anthropic");
  // passthrough auth carried verbatim (no secret).
  check("listConfig carries passthrough auth verbatim", listed.routes[0].auth, "passthrough");
  // key-swap auth view: header + keyEnv NAME, scheme when present.
  check("listConfig surfaces auth.header", listed.routes[1].auth.header, "x-api-key");
  check("listConfig surfaces auth.keyEnv NAME", listed.routes[1].auth.keyEnv, "DEEPSEEK_API_KEY");
  check("listConfig surfaces auth.scheme when present", listed.routes[2].auth.scheme, "Bearer");
  check("listConfig omits auth.scheme when absent", "scheme" in listed.routes[1].auth, false);
  // capability flags surfaced when present.
  check("listConfig surfaces forImages", listed.routes[2].forImages, true);
  check("listConfig surfaces forImagesModel", listed.routes[2].forImagesModel, "google/gemini-2.5-flash-lite");
  check("listConfig surfaces vision:false", listed.routes[3].vision, false);
  check("listConfig omits forImages when absent", "forImages" in listed.routes[1], false);
  check("listConfig omits vision when absent", "vision" in listed.routes[0], false);
  // proxyUrl surfaced when present.
  check("listConfig surfaces proxyUrl when present", listed.proxyUrl, "http://127.0.0.1:8787");
  // NEVER a key value / secret-shaped field: only the keyEnv NAME is present on the auth view.
  const authKeys = Object.keys(listed.routes[1].auth).sort().join(",");
  check("listConfig auth view has ONLY header,keyEnv (no value/key/apiKey field)", authKeys, "header,keyEnv");
  const fullDump = JSON.stringify(listed);
  check("listConfig dump has NO 'value' field", /"value"\s*:/.test(fullDump), false);
  check("listConfig dump has NO 'apiKey'/'key' value field", /"(apiKey|key)"\s*:/.test(fullDump), false);
  check("listConfig carries the env-var NAME, not a value (keyEnv is the NAME)", listed.routes[2].auth.keyEnv, "OPENROUTER_API_KEY");
  // proxyUrl omitted when absent.
  const noProxy = listConfig({ routes: [{ match: "a-*", base_url: "https://a.example", auth: "passthrough" }] });
  check("listConfig omits proxyUrl when absent", "proxyUrl" in noProxy, false);
  // empty / no-routes config ⇒ well-formed empty list, no throw.
  let emptyListThrew = false;
  let emptyListed;
  try { emptyListed = listConfig({ routes: [] }); } catch { emptyListThrew = true; }
  check("listConfig empty routes ⇒ no throw", emptyListThrew, false);
  check("listConfig empty routes ⇒ well-formed empty list", Array.isArray(emptyListed.routes) && emptyListed.routes.length === 0, true);
  let noRoutesThrew = false;
  let noRoutesListed;
  try { noRoutesListed = listConfig({}); } catch { noRoutesThrew = true; }
  check("listConfig no routes key ⇒ no throw", noRoutesThrew, false);
  check("listConfig no routes key ⇒ empty list", Array.isArray(noRoutesListed.routes) && noRoutesListed.routes.length === 0, true);

  // ── e2e through the real socket ───────────────────────────────────────────
  const anthropicStub = makeStub();
  const bearerStub = makeStub();
  const passthroughStub = makeStub();
  const aPort = await listen(anthropicStub.server);
  const dPort = await listen(bearerStub.server);
  const pPort = await listen(passthroughStub.server);
  const deadPort = await closedPort(); // nothing listens here ⇒ upstream connect refused

  // A stub that begins a streamed response then DROPS its socket mid-stream — the
  // upstream-failure-after-headers case (sendError's headersSent branch).
  const midStub = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("PARTIAL-CHUNK;");
    setTimeout(() => res.socket.destroy(), 15);
  });
  const mPort = await listen(midStub);

  process.env.TEST_ANTHROPIC_KEY = "ANT-SECRET-123";
  process.env.TEST_DEEPSEEK_KEY = "DS-SECRET-456";
  delete process.env.TEST_UNSET_KEY_XYZ;
  process.env.MODEL_ROUTER_LOG = "1";

  // Tee stderr so the routing line is captured AND still visible.
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  const logCapture = [];
  process.stderr.write = (chunk, ...rest) => { logCapture.push(String(chunk)); return realStderrWrite(chunk, ...rest); };

  const config = {
    listen: { host: "127.0.0.1", port: 0 },
    maxBodyBytes: 2048, // small cap so an oversize-body request trips the 413 path
    routes: [
      { match: "claude-*", base_url: `http://127.0.0.1:${aPort}`, auth: { header: "x-api-key", keyEnv: "TEST_ANTHROPIC_KEY" } },
      { match: "deepseek-*", base_url: `http://127.0.0.1:${dPort}`, auth: { header: "Authorization", scheme: "Bearer", keyEnv: "TEST_DEEPSEEK_KEY" } },
      { match: "needkey-*", base_url: `http://127.0.0.1:${aPort}`, auth: { header: "x-api-key", keyEnv: "TEST_UNSET_KEY_XYZ" } },
      // passthrough: forward the client's auth verbatim, no backend key swap.
      { match: "passthru-*", base_url: `http://127.0.0.1:${pPort}`, auth: "passthrough" },
      // upstream connect-refused ⇒ 502; mid-stream socket drop ⇒ headersSent abort.
      { match: "dead-*", base_url: `http://127.0.0.1:${deadPort}`, auth: { header: "x-api-key", keyEnv: "TEST_ANTHROPIC_KEY" } },
      { match: "midstream-*", base_url: `http://127.0.0.1:${mPort}`, auth: { header: "x-api-key", keyEnv: "TEST_ANTHROPIC_KEY" } },
    ],
  };
  const router = createRouter(config);
  const routerPort = await listen(router);

  try {
    // 1. claude-* → the x-api-key (Anthropic) backend; key value swapped; body intact.
    const r1 = await request(routerPort, { model: "claude-opus-4-8", messages: [{ role: "user", content: "BODY-SENTINEL-CLAUDE" }] });
    check("claude routed to anthropic stub", anthropicStub.received.length, 1);
    check("claude did not touch bearer stub", bearerStub.received.length, 0);
    check("claude status 200", r1.status, 200);
    check("claude streamed response intact", r1.body, STREAM_BODY);
    const aReq = anthropicStub.received[0];
    check("anthropic got backend key under x-api-key", aReq.headers["x-api-key"], "ANT-SECRET-123");
    check("anthropic did NOT get the client front-key", aReq.headers["x-api-key"] !== "CLIENT-FRONT-KEY", true);
    check("anthropic got no Authorization header", aReq.headers["authorization"], undefined);
    check("anthropic host rewritten to backend", aReq.headers["host"], `127.0.0.1:${aPort}`);
    check("anthropic request body passed through intact", JSON.parse(aReq.body).messages[0].content, "BODY-SENTINEL-CLAUDE");

    // 2. deepseek-* → the Bearer backend; auth scheme swapped; x-api-key stripped.
    const r2 = await request(routerPort, { model: "deepseek-chat", messages: [{ role: "user", content: "BODY-SENTINEL-DS" }] });
    check("deepseek routed to bearer stub", bearerStub.received.length, 1);
    check("deepseek did not re-touch anthropic stub", anthropicStub.received.length, 1);
    check("deepseek status 200", r2.status, 200);
    check("deepseek streamed response intact", r2.body, STREAM_BODY);
    const dReq = bearerStub.received[0];
    check("deepseek got Authorization: Bearer <backend key>", dReq.headers["authorization"], "Bearer DS-SECRET-456");
    check("deepseek had client x-api-key stripped", dReq.headers["x-api-key"], undefined);
    check("deepseek request body passed through intact", JSON.parse(dReq.body).messages[0].content, "BODY-SENTINEL-DS");

    // 3. unknown model fails closed (4xx) and reaches NO backend.
    const r3 = await request(routerPort, { model: "gpt-4-turbo", messages: [] });
    check("unknown model ⇒ 4xx", r3.status >= 400 && r3.status < 500, true);
    check("unknown model not forwarded to anthropic", anthropicStub.received.length, 1);
    check("unknown model not forwarded to bearer", bearerStub.received.length, 1);

    // 4. missing model + unparseable body fail closed.
    const r4 = await request(routerPort, { messages: [] });
    check("missing model ⇒ 4xx", r4.status >= 400 && r4.status < 500, true);
    const r5 = await request(routerPort, null, { raw: "this is not json" });
    check("unparseable body ⇒ 4xx", r5.status >= 400 && r5.status < 500, true);

    // 5. matched route but unset key env ⇒ fail closed, NOT forwarded.
    const r6 = await request(routerPort, { model: "needkey-1", messages: [] });
    check("unset key env ⇒ error status", r6.status >= 400, true);
    check("unset key env not forwarded", anthropicStub.received.length, 1);

    // 6. log safety: the model→host line is present; NO key/body/header anywhere.
    const logText = logCapture.join("");
    check("log names model -> host", logText.includes(`claude-opus-4-8 -> 127.0.0.1:${aPort}`), true);
    check("log leaks NO backend key", logText.includes("ANT-SECRET-123") || logText.includes("DS-SECRET-456"), false);
    check("log leaks NO client front-key", logText.includes("CLIENT-FRONT-KEY"), false);
    check("log leaks NO request body", logText.includes("BODY-SENTINEL"), false);

    // 7. passthrough (B): the client's auth header is forwarded UNCHANGED — no
    //    backend key swap, no strip. Proves auth:"passthrough" works for a
    //    subscription/OAuth session that has no backend key.
    const r7 = await request(routerPort, { model: "passthru-1", messages: [{ role: "user", content: "BODY-SENTINEL-PT" }] });
    check("passthrough status 200", r7.status, 200);
    check("passthrough streamed response intact", r7.body, STREAM_BODY);
    const pReq = passthroughStub.received[0];
    check("passthrough forwarded the client x-api-key VERBATIM", pReq.headers["x-api-key"], "CLIENT-FRONT-KEY");
    check("passthrough sent NO Authorization swap", pReq.headers["authorization"], undefined);
    check("passthrough body passed through intact", JSON.parse(pReq.body).messages[0].content, "BODY-SENTINEL-PT");
    // and the contrast: the key-swap route (case 1) DID strip the client key + swap.
    check("non-passthrough still strips client key + swaps backend key",
      anthropicStub.received[0].headers["x-api-key"] === "ANT-SECRET-123" &&
        anthropicStub.received[0].headers["x-api-key"] !== "CLIENT-FRONT-KEY", true);

    // 8. A1 — 413: a body over maxBodyBytes fails closed with 413, not forwarded.
    const big = "x".repeat(5000); // > 2048 cap
    const r8 = await request(routerPort, { model: "claude-opus-4-8", filler: big });
    check("oversize body ⇒ 413", r8.status, 413);
    check("oversize body NOT forwarded to backend", anthropicStub.received.length, 1);

    // 9. A1 — 502: the upstream connection is refused (nothing listens) ⇒ 502.
    const r9 = await request(routerPort, { model: "dead-1", messages: [] });
    check("upstream connect-refused ⇒ 502", r9.status, 502);

    // 10. A1 — mid-stream abort: the upstream drops the socket AFTER streaming began.
    //     The router must NOT crash; the partial reached the client; the connection
    //     ended (not a clean end). Surviving to run the assertions IS the no-crash proof.
    const r10 = await requestTolerant(routerPort, { model: "midstream-1", messages: [] });
    check("mid-stream: client saw the streamed 200 headers", r10.status, 200);
    check("mid-stream: partial chunk reached the client", r10.body.includes("PARTIAL-CHUNK"), true);
    check("mid-stream: connection did not end cleanly (aborted/closed/errored)", r10.how !== "end", true);

    // 11. GET /v1/models: returns the configured routes as a secret-free listing
    //     (listModels, the network view — stricter than listConfig). Intercepted before
    //     routing, needs no body, reaches no backend. A POST /v1/messages still routes —
    //     proving the intercept didn't swallow routing.
    const m11 = await get(routerPort, "/v1/models");
    check("GET /v1/models ⇒ 200", m11.status, 200);
    const m11data = JSON.parse(m11.body);
    check("GET /v1/models: object is \"list\"", m11data.object, "list");
    check("GET /v1/models: one entry per route", m11data.data.length, config.routes.length);
    check("GET /v1/models: entry id is the route match glob", m11data.data[0].id, "claude-*");
    check("GET /v1/models: entry carries the backend host", typeof m11data.data[0].host, "string");
    check("GET /v1/models leaks NO key env-var name",
      m11.body.includes("TEST_ANTHROPIC_KEY") || m11.body.includes("TEST_DEEPSEEK_KEY") || m11.body.includes("TEST_UNSET_KEY_XYZ"), false);
    check("GET /v1/models leaks NO key value",
      m11.body.includes("ANT-SECRET-123") || m11.body.includes("DS-SECRET-456"), false);
    const m11bare = await get(routerPort, "/models");
    check("GET /models (bare path) ⇒ 200", m11bare.status, 200);
    const anthropicBefore11 = anthropicStub.received.length;
    const m11post = await request(routerPort, { model: "claude-opus-4-8", messages: [{ role: "user", content: "POST-STILL-ROUTES" }] });
    check("POST /v1/messages still routes after the models intercept", anthropicStub.received.length, anthropicBefore11 + 1);
    check("POST /v1/messages still 200 after the models intercept", m11post.status, 200);
  } finally {
    process.stderr.write = realStderrWrite;
    delete process.env.TEST_ANTHROPIC_KEY;
    delete process.env.TEST_DEEPSEEK_KEY;
    delete process.env.MODEL_ROUTER_LOG;
    await close(router);
    await close(anthropicStub.server);
    await close(bearerStub.server);
    await close(passthroughStub.server);
    await close(midStub);
  }

  // ── vision fallback e2e (reactive catch-400 reroute) ──────────────────────
  // Stub A (nonvis-*): mode-switchable; Stub B (vis-*, forImages): the vision target.
  const aStub = makeModeStub("reject");
  const bStub = makeModeStub("ok");
  const aVPort = await listen(aStub.server);
  const bVPort = await listen(bStub.server);

  process.env.TEST_VISION_KEY = "VIS-SECRET-789";
  process.env.MODEL_ROUTER_LOG = "1";
  const vLogCapture = [];
  const vRealStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { vLogCapture.push(String(chunk)); return vRealStderrWrite(chunk, ...rest); };

  // A request carrying an image block — text sentinel + image-data sentinel let us
  // prove the body (and the image bytes) pass through unaltered and never leak to logs.
  const imageReq = (model) => ({
    model,
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "IMG-DATA-SENTINEL" } },
      { type: "text", text: "VISION-BODY-SENTINEL" },
    ] }],
  });

  const visionConfig = {
    listen: { host: "127.0.0.1", port: 0 },
    routes: [
      { match: "nonvis-*", base_url: `http://127.0.0.1:${aVPort}`, auth: { header: "x-api-key", keyEnv: "TEST_VISION_KEY" } },
      // declared non-vision: an image turn must pre-route to B WITHOUT hitting A first.
      { match: "declared-*", base_url: `http://127.0.0.1:${aVPort}`, vision: false, auth: { header: "x-api-key", keyEnv: "TEST_VISION_KEY" } },
      { match: "vis-*", base_url: `http://127.0.0.1:${bVPort}`, forImages: true, forImagesModel: "vendor/vision-model", auth: { header: "x-api-key", keyEnv: "TEST_VISION_KEY" } },
    ],
  };
  const vRouter = createRouter(visionConfig);
  const vPort = await listen(vRouter);

  // A no-vision router: same nonvis route, NO forImages target (the fail-loud case).
  const noVisionConfig = {
    listen: { host: "127.0.0.1", port: 0 },
    routes: [
      { match: "nonvis-*", base_url: `http://127.0.0.1:${aVPort}`, auth: { header: "x-api-key", keyEnv: "TEST_VISION_KEY" } },
    ],
  };
  const noVisionRouter = createRouter(noVisionConfig);
  const noVisionPort = await listen(noVisionRouter);

  try {
    // V1. image request → route A 400-image → rerouted to B → client gets B's 200.
    aStub.setMode("reject");
    const v1 = await request(vPort, imageReq("nonvis-1"));
    check("V1 reroute: A received the first (failing) call", aStub.received.length, 1);
    check("V1 reroute: B received the rerouted call", bStub.received.length, 1);
    check("V1 reroute: client gets the vision route's 200", v1.status, 200);
    check("V1 reroute: client gets B's streamed body intact", v1.body, STREAM_BODY);
    // passthrough: the SAME image-bearing body reached B, bytes unaltered.
    const v1b = JSON.parse(bStub.received[0].body);
    check("V1 reroute: image bytes reached B unaltered", v1b.messages[0].content[0].source.data, "IMG-DATA-SENTINEL");
    check("V1 reroute: B got the rewritten model id (forImagesModel)", v1b.model, "vendor/vision-model");
    check("V1 reroute: B got the backend key, not the client front-key", bStub.received[0].headers["x-api-key"], "VIS-SECRET-789");

    // V2. multimodal: route A returns 200 → NO reroute (B untouched). Distinct model
    //     so the V1 cache entry (nonvis-1) does not pre-route it.
    aStub.setMode("ok");
    const v2 = await request(vPort, imageReq("nonvis-mm"));
    check("V2 no-reroute: A handled it (200)", aStub.received.length, 2);
    check("V2 no-reroute: B was NOT touched", bStub.received.length, 1);
    check("V2 no-reroute: client gets A's 200", v2.status, 200);
    check("V2 no-reroute: client gets A's streamed body", v2.body, STREAM_BODY);

    // V3. 400-image but NO forImages route → clear error, not the raw upstream 400.
    aStub.setMode("reject");
    const aBefore3 = aStub.received.length;
    const v3 = await request(noVisionPort, imageReq("nonvis-1"));
    check("V3 fail-loud: A received the call", aStub.received.length, aBefore3 + 1);
    check("V3 fail-loud: client gets a clear 4xx", v3.status >= 400 && v3.status < 500, true);
    check("V3 fail-loud: error names the missing vision fallback", v3.body.includes("no vision fallback"), true);
    check("V3 fail-loud: NOT the raw upstream image-blocks text", v3.body.includes("does not support image blocks"), false);

    // V4. ambiguous 400 (not image) → relayed as-is, no reroute, B untouched.
    aStub.setMode("badreq");
    const bBefore4 = bStub.received.length;
    const v4 = await request(vPort, { model: "nonvis-amb", messages: [{ role: "user", content: "no image here" }] });
    check("V4 ambiguous: relayed as the upstream 400", v4.status, 400);
    check("V4 ambiguous: the upstream body is relayed verbatim", v4.body.includes("roles must alternate"), true);
    check("V4 ambiguous: B was NOT touched (no reroute)", bStub.received.length, bBefore4);

    // V5. session cache: a 2nd image call to nonvis-1 pre-routes to B WITHOUT hitting A.
    aStub.setMode("reject"); // would 400 if hit — proving the pre-route skipped A
    const aBefore5 = aStub.received.length;
    const v5 = await request(vPort, imageReq("nonvis-1"));
    check("V5 pre-route: A was NOT hit (cache skipped the failing call)", aStub.received.length, aBefore5);
    check("V5 pre-route: B served it directly", bStub.received.length, 2);
    check("V5 pre-route: B got the rewritten model id too", JSON.parse(bStub.received[1].body).model, "vendor/vision-model");
    check("V5 pre-route: client gets B's 200", v5.status, 200);
    check("V5 pre-route: client gets B's streamed body", v5.body, STREAM_BODY);

    // V6. loop guard: A 400-image → reroute to B, but B ALSO 400-images → clear error,
    //     NO infinite reroute (A and B each hit exactly once for this call).
    aStub.setMode("reject");
    bStub.setMode("reject");
    const aBefore6 = aStub.received.length;
    const bBefore6 = bStub.received.length;
    const v6 = await request(vPort, imageReq("nonvis-loop"));
    check("V6 loop-guard: A hit exactly once", aStub.received.length, aBefore6 + 1);
    check("V6 loop-guard: B hit exactly once (no re-reroute)", bStub.received.length, bBefore6 + 1);
    check("V6 loop-guard: client gets a clear 4xx", v6.status >= 400 && v6.status < 500, true);
    check("V6 loop-guard: error names the loop guard", v6.body.includes("loop guard"), true);

    // V7. declared non-vision (vision:false): an image turn pre-routes to B WITHOUT ever
    //     hitting A — even though A would 400/refuse, A is never called. Proves the flag is
    //     proactive (no reliance on a wire signal). A set to "reject" so a hit would show.
    aStub.setMode("reject");
    bStub.setMode("ok");
    const aBefore7 = aStub.received.length;
    const bBefore7 = bStub.received.length;
    const v7 = await request(vPort, imageReq("declared-1"));
    check("V7 declared-non-vision: A was NOT hit (unconditional pre-route)", aStub.received.length, aBefore7);
    check("V7 declared-non-vision: B served it directly", bStub.received.length, bBefore7 + 1);
    check("V7 declared-non-vision: client gets B's 200", v7.status, 200);
    check("V7 declared-non-vision: B got the rewritten model id", JSON.parse(bStub.received[bStub.received.length - 1].body).model, "vendor/vision-model");

    // V8. declared non-vision but a TEXT-ONLY turn: the flag only affects image turns, so
    //     it routes normally to A (no pre-route to the vision backend).
    aStub.setMode("ok");
    const aBefore8 = aStub.received.length;
    const bBefore8 = bStub.received.length;
    const v8 = await request(vPort, { model: "declared-2", messages: [{ role: "user", content: "no image here" }] });
    check("V8 declared-non-vision text: A handled it (no pre-route)", aStub.received.length, aBefore8 + 1);
    check("V8 declared-non-vision text: B NOT touched", bStub.received.length, bBefore8);
    check("V8 declared-non-vision text: client gets A's 200", v8.status, 200);

    // log safety across every vision case: no key, no body sentinel, no image bytes.
    const vLogText = vLogCapture.join("");
    check("V-log: leaks NO backend key", vLogText.includes("VIS-SECRET-789"), false);
    check("V-log: leaks NO client front-key", vLogText.includes("CLIENT-FRONT-KEY"), false);
    check("V-log: leaks NO request body sentinel", vLogText.includes("VISION-BODY-SENTINEL"), false);
    check("V-log: leaks NO image bytes", vLogText.includes("IMG-DATA-SENTINEL"), false);
    check("V-log: leaks NO 400 error body", vLogText.includes("does not support image blocks"), false);
  } finally {
    process.stderr.write = vRealStderrWrite;
    delete process.env.TEST_VISION_KEY;
    delete process.env.MODEL_ROUTER_LOG;
    await close(vRouter);
    await close(noVisionRouter);
    await close(aStub.server);
    await close(bStub.server);
  }

  // ── failover e2e (reactive reroute + pre-route + chain + depth guard) ──────
  // Stub A (primary for claude-*), Stub B (backup glm-5.1), Stub C (backup for glm-5.1).
  const foA = makeFlexStub(429, '{"error":{"message":"rate limit exceeded"}}');
  const foB = makeFlexStub(200); // backup: returns success
  const foC = makeFlexStub(200); // chain backup
  const foAPort = await listen(foA.server);
  const foBPort = await listen(foB.server);
  const foCPort = await listen(foC.server);

  process.env.TEST_FO_KEY = "FO-SECRET-999";
  process.env.MODEL_ROUTER_LOG = "1";
  const foLogCapture = [];
  const foRealStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { foLogCapture.push(String(chunk)); return foRealStderrWrite(chunk, ...rest); };

  const failoverConfig = {
    listen: { host: "127.0.0.1", port: 0 },
    failover: { "claude-*": "glm-5.1", "glm-5.1": "deepseek-v4-pro" },
    failoverRecoveryIntervalMs: 30000,
    routes: [
      { match: "claude-*", base_url: `http://127.0.0.1:${foAPort}`, auth: { header: "x-api-key", keyEnv: "TEST_FO_KEY" } },
      { match: "glm-5.1", base_url: `http://127.0.0.1:${foBPort}`, auth: { header: "x-api-key", keyEnv: "TEST_FO_KEY" } },
      { match: "deepseek-*", base_url: `http://127.0.0.1:${foCPort}`, auth: { header: "x-api-key", keyEnv: "TEST_FO_KEY" } },
    ],
  };
  const foRouter = createRouter(failoverConfig);
  const foPort = await listen(foRouter);

  try {
    // F1. 429 from primary → failover to backup, client gets backup's 200.
    foA.setStatus(429);
    foA.setBody('{"error":{"message":"rate limit exceeded"}}');
    foB.setStatus(200);
    const f1 = await request(foPort, { model: "claude-opus-4-8", messages: [{ role: "user", content: "F1-BODY" }] });
    check("F1 failover: primary A received the call", foA.received.length, 1);
    check("F1 failover: backup B received the rerouted call", foB.received.length, 1);
    check("F1 failover: client gets B's 200", f1.status, 200);
    check("F1 failover: B got the rewritten model id", JSON.parse(foB.received[0].body).model, "glm-5.1");
    check("F1 failover: B got the body intact", JSON.parse(foB.received[0].body).messages[0].content, "F1-BODY");
    check("F1 failover: B got the backend key", foB.received[0].headers["x-api-key"], "FO-SECRET-999");

    // F2. Pre-route: second request skips the failed primary, goes straight to backup.
    const aBefore2 = foA.received.length;
    const bBefore2 = foB.received.length;
    const f2 = await request(foPort, { model: "claude-opus-4-8", messages: [{ role: "user", content: "F2-BODY" }] });
    check("F2 pre-route: A was NOT hit (skip failed primary)", foA.received.length, aBefore2);
    check("F2 pre-route: B served it directly", foB.received.length, bBefore2 + 1);
    check("F2 pre-route: client gets B's 200", f2.status, 200);

    // F3. 529 from primary → always triggers failover (status-only trigger).
    foC.setStatus(200);
    // For F3 we need a fresh failover state — clear it first.
    foRouter._modelpipe.failoverState.clear();
    foC.received.length = 0;
    foA.setStatus(529);
    foA.setBody("{}");
    foB.setStatus(200);
    const aBefore3 = foA.received.length;
    const bBefore3 = foB.received.length;
    const f3 = await request(foPort, { model: "claude-opus-4-8", messages: [{ role: "user", content: "F3" }] });
    check("F3: 529 triggers failover", f3.status, 200);
    check("F3: A was hit (529)", foA.received.length, aBefore3 + 1);
    check("F3: B served the reroute", foB.received.length, bBefore3 + 1);

    // F4. Ambiguous 503 (no rate-limit message) → NOT failed over, error relayed verbatim.
    foRouter._modelpipe.failoverState.clear();
    foA.setStatus(503);
    foA.setBody('{"error":{"message":"internal server error"}}');
    const aBefore4 = foA.received.length;
    const bBefore4 = foB.received.length;
    const f4 = await request(foPort, { model: "claude-opus-4-8", messages: [{ role: "user", content: "F4" }] });
    check("F4 ambiguous 503: NOT failed over", f4.status, 503);
    check("F4 ambiguous 503: error relayed verbatim", f4.body.includes("internal server error"), true);
    check("F4 ambiguous 503: A hit once", foA.received.length, aBefore4 + 1);
    check("F4 ambiguous 503: B NOT touched", foB.received.length, bBefore4);

    // F5. Chain failover: A 429 → B 429 → C 200. Depth = 2 hops.
    foRouter._modelpipe.failoverState.clear();
    foA.setStatus(429);
    foA.setBody('{"error":{"message":"rate limit exceeded"}}');
    foB.setStatus(429);
    foB.setBody('{"error":{"message":"rate limit exceeded"}}');
    foC.setStatus(200);
    const aBefore5 = foA.received.length;
    const bBefore5 = foB.received.length;
    const cBefore5 = foC.received.length;
    const f5 = await request(foPort, { model: "claude-opus-4-8", messages: [{ role: "user", content: "F5" }] });
    check("F5 chain: A was hit (first hop)", foA.received.length, aBefore5 + 1);
    check("F5 chain: B was hit (second hop)", foB.received.length, bBefore5 + 1);
    check("F5 chain: C served the final response", foC.received.length, cBefore5 + 1);
    check("F5 chain: client gets C's 200", f5.status, 200);
    check("F5 chain: C got the rewritten model", JSON.parse(foC.received[foC.received.length - 1].body).model, "deepseek-v4-pro");

    // F6. Non-rate-limit 400 is NOT failed over — relayed as-is.
    foRouter._modelpipe.failoverState.clear();
    foA.setStatus(400);
    foA.setBody('{"error":{"message":"messages: roles must alternate"}}');
    const aBefore6 = foA.received.length;
    const bBefore6 = foB.received.length;
    const f6 = await request(foPort, { model: "claude-opus-4-8", messages: [{ role: "user", content: "F6" }] });
    check("F6: 400 NOT failed over", f6.status, 400);
    check("F6: error relayed verbatim", f6.body.includes("roles must alternate"), true);
    check("F6: A hit once", foA.received.length, aBefore6 + 1);
    check("F6: B NOT touched", foB.received.length, bBefore6);

    // F7. log safety for failover: model+status logged, NO keys/secrets/body.
    const foLogText = foLogCapture.join("");
    check("F-log: names failover model -> backup", foLogText.includes("claude-opus-4-8 -> glm-5.1"), true);
    check("F-log: leaks NO backend key", foLogText.includes("FO-SECRET-999"), false);
    check("F-log: leaks NO body sentinel", foLogText.includes("F1-BODY") || foLogText.includes("F2-BODY"), false);
  } finally {
    process.stderr.write = foRealStderrWrite;
    delete process.env.TEST_FO_KEY;
    delete process.env.MODEL_ROUTER_LOG;
    // ── F8-F10: fresh stubs + router for clean state ───────────────────────
    process.env.TEST_FO_KEY = "FO-SECRET-999";
    const foA2 = makeFlexStub(429, '{"error":{"message":"rate limit exceeded"}}');
    const foB2 = makeFlexStub(429, '{"error":{"message":"rate limit exceeded"}}');
    const foC2 = makeFlexStub(429, '{"error":{"message":"rate limit exceeded"}}');
    const foA2Port = await listen(foA2.server);
    const foB2Port = await listen(foB2.server);
    const foC2Port = await listen(foC2.server);

    const fo2Config = {
      listen: { host: "127.0.0.1", port: 0 },
      failover: { "claude-*": "glm-5.1", "glm-5.1": "deepseek-v4-pro" },
      failoverRecoveryIntervalMs: 1000,
      routes: [
        { match: "claude-*", base_url: `http://127.0.0.1:${foA2Port}`, auth: { header: "x-api-key", keyEnv: "TEST_FO_KEY" } },
        { match: "glm-5.1", base_url: `http://127.0.0.1:${foB2Port}`, auth: { header: "x-api-key", keyEnv: "TEST_FO_KEY" } },
        { match: "deepseek-*", base_url: `http://127.0.0.1:${foC2Port}`, auth: { header: "x-api-key", keyEnv: "TEST_FO_KEY" } },
      ],
    };
    const fo2Router = createRouter(fo2Config);
    const fo2Port = await listen(fo2Router);

    try {
      // F8. Depth guard: chain A→B→C all 429, deepseek has no pair → relay C's 429.
      const f8 = await request(fo2Port, { model: "claude-opus-4-8", messages: [{ role: "user", content: "F8" }] });
      check("F8 depth guard: A was hit (hop 0)", foA2.received.length, 1);
      check("F8 depth guard: B was hit (hop 1)", foB2.received.length, 1);
      check("F8 depth guard: C was hit (hop 2, no backup)", foC2.received.length, 1);
      check("F8 depth guard: client gets C's 429 relayed", f8.status, 429);

      // F9. Model with route but no failover pair: 503 → relay error as-is.
      foC2.setStatus(503);
      foC2.setBody('{"error":{"message":"rate limit exceeded"}}');
      const cBefore9 = foC2.received.length;
      const f9 = await request(fo2Port, { model: "deepseek-v4-pro", messages: [{ role: "user", content: "F9" }] });
      check("F9 no-backup: C was hit once", foC2.received.length, cBefore9 + 1);
      check("F9 no-backup: error relayed verbatim", f9.status, 503);

      // F10. Recovery ping: probe succeeds → failoverState cleared.
      fo2Router._modelpipe.failoverState.set("claude-opus-4-8", { enteredAt: 1 }); // ancient timestamp
      foA2.setStatus(200); // primary healthy
      const pinger = fo2Router._modelpipe.failoverPinger;
      if (pinger) {
        await pinger.poll();
        check("F10 recovery ping: failoverState cleared after probe",
          fo2Router._modelpipe.failoverState.has("claude-opus-4-8"), false);
      }
    } finally {
      delete process.env.TEST_FO_KEY;
      await close(fo2Router);
      await close(foA2.server);
      await close(foB2.server);
      await close(foC2.server);
    }

    await close(foRouter);
    await close(foA.server);
    await close(foB.server);
    await close(foC.server);
  }

  // ── failover GROUP shift e2e (the whole ladder moves down together) ────────
  {
    process.env.TEST_GRP_KEY = "GRP-SECRET";
    const grpA = makeFlexStub(200); // claude-* backend (head)
    const grpB = makeFlexStub(200); // glm-5.1 backend
    const grpC = makeFlexStub(200); // deepseek backend
    const grpAPort = await listen(grpA.server);
    const grpBPort = await listen(grpB.server);
    const grpCPort = await listen(grpC.server);
    const grpConfig = {
      listen: { host: "127.0.0.1", port: 0 },
      failoverGroups: [{ ladder: ["claude-opus-*", "glm-5.1", "deepseek-v4-pro"], mode: "shift" }],
      failoverRecoveryIntervalMs: 1000,
      routes: [
        { match: "claude-*", base_url: `http://127.0.0.1:${grpAPort}`, auth: { header: "x-api-key", keyEnv: "TEST_GRP_KEY" } },
        { match: "glm-5.1", base_url: `http://127.0.0.1:${grpBPort}`, auth: { header: "x-api-key", keyEnv: "TEST_GRP_KEY" } },
        { match: "deepseek-*", base_url: `http://127.0.0.1:${grpCPort}`, auth: { header: "x-api-key", keyEnv: "TEST_GRP_KEY" } },
      ],
    };
    const grpRouter = createRouter(grpConfig);
    const grpPort = await listen(grpRouter);
    try {
      // G0. Healthy head at offset 0 must forward the ORIGINAL concrete model id, NOT the
      //     ladder's glob head ("claude-opus-*"). Guards the glob-head rewrite bug.
      grpA.setStatus(200);
      const g0 = await request(grpPort, { model: "claude-opus-4-8", messages: [{ role: "user", content: "G0" }] });
      check("G0 group: healthy head serves itself", g0.status, 200);
      check("G0 group: forwards the REAL model id (not the glob)", JSON.parse(grpA.received[grpA.received.length - 1].body).model, "claude-opus-4-8");
      check("G0 group: offset still 0", grpRouter._modelpipe.groupState[0].offset, 0);
      grpA.received.length = 0;

      // G1. Head (opus) 429 → reactive shift to glm; offset becomes 1.
      grpA.setStatus(429); grpA.setBody('{"error":{"message":"rate limit exceeded"}}');
      grpB.setStatus(200);
      const g1 = await request(grpPort, { model: "claude-opus-4-8", messages: [{ role: "user", content: "G1" }] });
      check("G1 group: head A hit", grpA.received.length, 1);
      check("G1 group: head A got the real model id (not glob)", JSON.parse(grpA.received[0].body).model, "claude-opus-4-8");
      check("G1 group: glm B served the reroute", grpB.received.length, 1);
      check("G1 group: client gets 200", g1.status, 200);
      check("G1 group: B got rewritten model", JSON.parse(grpB.received[0].body).model, "glm-5.1");
      check("G1 group: offset shifted to 1", grpRouter._modelpipe.groupState[0].offset, 1);

      // G2. THE KEY FEATURE: glm's OWN traffic now pre-routes to deepseek (whole ladder
      //     shifted), even though glm itself never failed.
      const cBefore = grpC.received.length;
      const bBefore = grpB.received.length;
      grpC.setStatus(200);
      const g2 = await request(grpPort, { model: "glm-5.1", messages: [{ role: "user", content: "G2" }] });
      check("G2 group: glm traffic shifted to deepseek", grpC.received.length, cBefore + 1);
      check("G2 group: glm backend B NOT hit for glm traffic", grpB.received.length, bBefore);
      check("G2 group: deepseek got rewritten model", JSON.parse(grpC.received[grpC.received.length - 1].body).model, "deepseek-v4-pro");
      check("G2 group: client gets 200", g2.status, 200);

      // G3. opus pre-routes to glm during shift (head A skipped).
      const aBefore3 = grpA.received.length;
      const bBefore3 = grpB.received.length;
      const g3 = await request(grpPort, { model: "claude-opus-4-8", messages: [{ role: "user", content: "G3" }] });
      check("G3 group: head A skipped (pre-route)", grpA.received.length, aBefore3);
      check("G3 group: glm B served opus", grpB.received.length, bBefore3 + 1);
      check("G3 group: client gets 200", g3.status, 200);

      // G4. The synthetic pinger must NOT probe a GLOB head (ladder[offset-1]="claude-opus-*"):
      //     a glob has no concrete id to ping with, so the pinger skips it and offset stays.
      //     (Recovery for a glob/passthrough head is the live-request path in G4b.)
      grpA.setStatus(200);
      grpRouter._modelpipe.groupState[0].shiftedAt = 1; // ancient → cooldown elapsed
      const pinger = grpRouter._modelpipe.failoverPinger;
      await pinger.poll();
      check("G4 group: pinger does NOT wind back a glob head (offset stays 1)", grpRouter._modelpipe.groupState[0].offset, 1);

      // G4b. LIVE-REQUEST recovery (the passthrough/glob-head path the pinger can't probe):
      //      force a shift, then a head request after cooldown probes the real head and
      //      winds back on success — no synthetic ping involved.
      grpA.setStatus(429); grpA.setBody('{"error":{"message":"rate limit exceeded"}}');
      await request(grpPort, { model: "claude-opus-4-8", messages: [{ role: "user", content: "G4b-shift" }] });
      check("G4b: shifted to offset 1", grpRouter._modelpipe.groupState[0].offset, 1);
      grpA.setStatus(200); // head recovered
      grpRouter._modelpipe.groupState[0].shiftedAt = 1; // cooldown elapsed
      const aBefore4b = grpA.received.length;
      const g4b = await request(grpPort, { model: "claude-opus-4-8", messages: [{ role: "user", content: "G4b-probe" }] });
      check("G4b: live head probe hit the real head A", grpA.received.length, aBefore4b + 1);
      check("G4b: probe forwarded the real model id", JSON.parse(grpA.received[grpA.received.length - 1].body).model, "claude-opus-4-8");
      check("G4b: client got 200", g4b.status, 200);
      check("G4b: offset wound back to 0 by the live request", grpRouter._modelpipe.groupState[0].offset, 0);

      // G5. After recovery, opus serves itself again.
      const aBefore5 = grpA.received.length;
      const g5 = await request(grpPort, { model: "claude-opus-4-8", messages: [{ role: "user", content: "G5" }] });
      check("G5 group: head A serves itself after recovery", grpA.received.length, aBefore5 + 1);
      check("G5 group: client gets 200", g5.status, 200);
    } finally {
      delete process.env.TEST_GRP_KEY;
      await close(grpRouter);
      await close(grpA.server);
      await close(grpB.server);
      await close(grpC.server);
    }
  }

  // ── fallback auth e2e (client token wins; else inject the proxy key) ───────
  {
    process.env.FB_PROXY_KEY = "PROXY-SIDE-KEY";
    const fbStub = makeFlexStub(200);
    const fbPort = await listen(fbStub.server);
    const fbRouter = createRouter({
      listen: { host: "127.0.0.1", port: 0 },
      routes: [
        { match: "claude-*", base_url: `http://127.0.0.1:${fbPort}`,
          auth: { header: "x-api-key", keyEnv: "FB_PROXY_KEY", fallback: true } },
        { match: "bearer-*", base_url: `http://127.0.0.1:${fbPort}`,
          auth: { header: "Authorization", scheme: "Bearer", keyEnv: "FB_PROXY_KEY", fallback: true } },
      ],
    });
    const fbRouterPort = await listen(fbRouter);
    try {
      // FB1. Client flew its OWN key → forward it, do NOT inject the proxy key.
      await requestH(fbRouterPort, { model: "claude-opus-4-8", messages: [] }, { "x-api-key": "CLIENT-OWN-KEY" });
      check("FB1: client's own key is forwarded", fbStub.received[fbStub.received.length - 1].headers["x-api-key"], "CLIENT-OWN-KEY");

      // FB2. Client sent NO auth → inject the proxy's key.
      await requestH(fbRouterPort, { model: "claude-opus-4-8", messages: [] }, {});
      check("FB2: proxy key injected when client sends none", fbStub.received[fbStub.received.length - 1].headers["x-api-key"], "PROXY-SIDE-KEY");

      // FB3. Client flew an Authorization bearer (OAuth-style) → forwarded verbatim.
      await requestH(fbRouterPort, { model: "claude-opus-4-8", messages: [] }, { authorization: "Bearer CLIENT-OAUTH" });
      check("FB3: client's bearer token is forwarded", fbStub.received[fbStub.received.length - 1].headers["authorization"], "Bearer CLIENT-OAUTH");

      // FB4. Bearer-scheme fallback route, no client auth → inject "Bearer <proxy key>".
      await requestH(fbRouterPort, { model: "bearer-x", messages: [] }, {});
      check("FB4: proxy bearer injected when client sends none", fbStub.received[fbStub.received.length - 1].headers["authorization"], "Bearer PROXY-SIDE-KEY");
    } finally {
      delete process.env.FB_PROXY_KEY;
      await close(fbRouter);
      await close(fbStub.server);
    }
  }

  // ── group-reset endpoint (wind a stuck offset back without a restart) ──────
  {
    process.env.GR_KEY = "x";
    const grStub = makeFlexStub(200);
    const grPort = await listen(grStub.server);
    const grRouter = createRouter({
      listen: { host: "127.0.0.1", port: 0 },
      dashboard: true,
      failoverGroups: [{ ladder: ["claude-opus-*", "glm-5.1", "deepseek-v4-pro"], mode: "shift" }],
      routes: [
        { match: "claude-*", base_url: `http://127.0.0.1:${grPort}`, auth: { header: "x-api-key", keyEnv: "GR_KEY" } },
        { match: "glm-*", base_url: `http://127.0.0.1:${grPort}`, auth: { header: "x-api-key", keyEnv: "GR_KEY" } },
        { match: "deepseek-*", base_url: `http://127.0.0.1:${grPort}`, auth: { header: "x-api-key", keyEnv: "GR_KEY" } },
      ],
    });
    const grRouterPort = await listen(grRouter);
    try {
      // Simulate a stuck double-shift.
      grRouter._modelpipe.groupState[0].offset = 2;
      const r1 = await postPath(grRouterPort, "/v1/failover/reset?group=0");
      check("group reset: endpoint matched despite query string", r1.status, 200);
      check("group reset: offset wound back to 0", grRouter._modelpipe.groupState[0].offset, 0);
      check("group reset: reported cleared", JSON.parse(r1.body).cleared, 1);
      // Unknown group → 400.
      const r2 = await postPath(grRouterPort, "/v1/failover/reset?group=9");
      check("group reset: unknown group → 400", r2.status, 400);
    } finally {
      delete process.env.GR_KEY;
      await close(grRouter);
      await close(grStub.server);
    }
  }

  // ── account pool e2e (rotate on limit, cooldown recovery, round-robin, endpoints) ──
  {
    process.env.AP_K1 = "KEY-ACCT-1"; process.env.AP_K2 = "KEY-ACCT-2";
    const apA = makeFlexStub(200); // account "a1" backend
    const apB = makeFlexStub(200); // account "a2" backend
    const apAPort = await listen(apA.server);
    const apBPort = await listen(apB.server);
    const apRouter = createRouter({
      listen: { host: "127.0.0.1", port: 0 },
      dashboard: true,
      failoverRecoveryIntervalMs: 30000,
      routes: [{
        match: "glm-*", base_url: `http://127.0.0.1:${apAPort}`, billing: "subscription",
        accounts: [
          { label: "a1", base_url: `http://127.0.0.1:${apAPort}`, auth: { header: "x-api-key", keyEnv: "AP_K1" } },
          { label: "a2", base_url: `http://127.0.0.1:${apBPort}`, auth: { header: "x-api-key", keyEnv: "AP_K2" } },
        ],
      }],
    });
    const apPort = await listen(apRouter);
    const pool = [...apRouter._modelpipe.accountPools.values()][0];
    try {
      // AP1. a1 hits a rate-limit → rotate to a2; each account uses its OWN key.
      apA.setStatus(429); apA.setBody('{"error":{"message":"rate limit exceeded"}}'); apB.setStatus(200);
      const ap1 = await request(apPort, { model: "glm-5.1", messages: [{ role: "user", content: "AP1" }] });
      check("AP1: a1 backend hit", apA.received.length, 1);
      check("AP1: a1 got its own key", apA.received[0].headers["x-api-key"], "KEY-ACCT-1");
      check("AP1: rotated to a2 backend", apB.received.length, 1);
      check("AP1: a2 got its own key", apB.received[0].headers["x-api-key"], "KEY-ACCT-2");
      check("AP1: client gets 200", ap1.status, 200);
      check("AP1: a1 parked in cooldown", pool.accounts[0].exhaustedUntil > Date.now(), true);

      // AP2. Next request pre-routes straight to a2 (a1 still in cooldown) — a1 not retried.
      const aBefore = apA.received.length;
      const ap2 = await request(apPort, { model: "glm-5.1", messages: [{ role: "user", content: "AP2" }] });
      check("AP2: a1 NOT retried during cooldown", apA.received.length, aBefore);
      check("AP2: a2 served it", apB.received[apB.received.length - 1].headers["x-api-key"], "KEY-ACCT-2");
      check("AP2: client gets 200", ap2.status, 200);

      // AP3. Recover a1 (clear cooldown) + a1 healthy → failover prefers a1 again.
      pool.accounts[0].exhaustedUntil = 0; apA.setStatus(200);
      const aBefore3 = apA.received.length;
      const ap3 = await request(apPort, { model: "glm-5.1", messages: [{ role: "user", content: "AP3" }] });
      check("AP3: a1 preferred again after recovery", apA.received.length, aBefore3 + 1);
      check("AP3: a1 used its key", apA.received[apA.received.length - 1].headers["x-api-key"], "KEY-ACCT-1");
      check("AP3: client gets 200", ap3.status, 200);

      // AP4. /v1/accounts reports pool state; reset endpoint clears cooldowns.
      pool.accounts[1].exhaustedUntil = Date.now() + 99999;
      const accView = JSON.parse((await get(apPort, "/v1/accounts")).body);
      check("AP4: /v1/accounts lists the pool", accView.pools[0].accounts.length, 2);
      check("AP4: a2 shown exhausted", accView.pools[0].accounts[1].exhausted, true);
      const rst = await postPath(apPort, "/v1/accounts/reset");
      check("AP4: reset cleared a cooldown", JSON.parse(rst.body).cleared >= 1, true);
      check("AP4: a2 cooldown cleared", pool.accounts[1].exhaustedUntil, 0);
    } finally {
      delete process.env.AP_K1; delete process.env.AP_K2;
      await close(apRouter); await close(apA.server); await close(apB.server);
    }

    // AP5. round-robin spreads across accounts.
    process.env.AP_K1 = "K1"; process.env.AP_K2 = "K2";
    const rrA = makeFlexStub(200), rrB = makeFlexStub(200);
    const rrAPort = await listen(rrA.server), rrBPort = await listen(rrB.server);
    const rrRouter = createRouter({
      listen: { host: "127.0.0.1", port: 0 },
      routes: [{
        match: "glm-*", base_url: `http://127.0.0.1:${rrAPort}`, strategy: "round-robin",
        accounts: [
          { label: "a1", base_url: `http://127.0.0.1:${rrAPort}`, auth: { header: "x-api-key", keyEnv: "AP_K1" } },
          { label: "a2", base_url: `http://127.0.0.1:${rrBPort}`, auth: { header: "x-api-key", keyEnv: "AP_K2" } },
        ],
      }],
    });
    const rrPort = await listen(rrRouter);
    try {
      for (let i = 0; i < 4; i++) await request(rrPort, { model: "glm-5.1", messages: [] });
      check("AP5 round-robin: a1 got 2 of 4", rrA.received.length, 2);
      check("AP5 round-robin: a2 got 2 of 4", rrB.received.length, 2);
    } finally {
      delete process.env.AP_K1; delete process.env.AP_K2;
      await close(rrRouter); await close(rrA.server); await close(rrB.server);
    }
  }

  if (fails.length) {
    console.log("MODELPIPE ROUTER SELF-TEST:");
    fails.forEach((f) => console.log(f));
    console.log(`\nFAIL — ${fails.length} case(s) failed`);
    process.exit(1);
  }
  console.log(`PASS — ${pass} passed`);
}

main().catch((err) => {
  console.log(`FAIL — unexpected error: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
