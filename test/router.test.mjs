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
  pickVisionRoute,
  validateConfig,
  listConfig,
  parseModelsCatalog,
  expandModels,
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
function get(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method: "GET", headers },
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

  // ── parseModelsCatalog pure unit (expand=1 catalog parsing, no network) ───────
  check("parseModelsCatalog reads data[].id",
    JSON.stringify(parseModelsCatalog(Buffer.from('{"data":[{"id":"a-1"},{"id":"a-2"}]}'))), '["a-1","a-2"]');
  check("parseModelsCatalog drops a non-string id",
    JSON.stringify(parseModelsCatalog(Buffer.from('{"data":[{"id":"a-1"},{"id":42},{"notid":"x"}]}'))), '["a-1"]');
  check("parseModelsCatalog empty data ⇒ empty array",
    JSON.stringify(parseModelsCatalog(Buffer.from('{"data":[]}'))), "[]");
  let badCatalogThrew = false;
  try { parseModelsCatalog(Buffer.from('{"models":[]}')); } catch { badCatalogThrew = true; }
  check("parseModelsCatalog throws when data[] is missing", badCatalogThrew, true);
  let nonJsonCatalogThrew = false;
  try { parseModelsCatalog(Buffer.from("not json")); } catch { nonJsonCatalogThrew = true; }
  check("parseModelsCatalog throws on bad JSON", nonJsonCatalogThrew, true);

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
  check("validateConfig accepts models_url + models_format",
    validateConfig({ routes: [{ match: "a-*", base_url: "https://a.example", models_url: "https://a.example/v1/models", models_format: "openai", auth: { header: "x-api-key", keyEnv: "K" } }] }).routes[0].models_format, "openai");
  let modelsUrlNoFormatThrew = false;
  try {
    validateConfig({ routes: [{ match: "a-*", base_url: "https://a.example", models_url: "https://a.example/v1/models", auth: { header: "x-api-key", keyEnv: "K" } }] });
  } catch { modelsUrlNoFormatThrew = true; }
  check("validateConfig rejects models_url without models_format", modelsUrlNoFormatThrew, true);
  let badModelsFormatThrew = false;
  try {
    validateConfig({ routes: [{ match: "a-*", base_url: "https://a.example", models_url: "https://a.example/v1/models", models_format: "weird", auth: { header: "x-api-key", keyEnv: "K" } }] });
  } catch { badModelsFormatThrew = true; }
  check("validateConfig rejects an unknown models_format", badModelsFormatThrew, true);
  let badModelsUrlThrew = false;
  try {
    validateConfig({ routes: [{ match: "a-*", base_url: "https://a.example", models_url: "not-a-url", models_format: "openai", auth: { header: "x-api-key", keyEnv: "K" } }] });
  } catch { badModelsUrlThrew = true; }
  check("validateConfig rejects a non-URL models_url", badModelsUrlThrew, true);
  let strayModelsFormatThrew = false;
  try {
    validateConfig({ routes: [{ match: "a-*", base_url: "https://a.example", models_format: "openai", auth: { header: "x-api-key", keyEnv: "K" } }] });
  } catch { strayModelsFormatThrew = true; }
  check("validateConfig rejects models_format without models_url", strayModelsFormatThrew, true);

  // ── listConfig: the safe `--list` discovery summary (no network, no secrets) ─
  const listSample = {
    proxyUrl: "http://127.0.0.1:8787",
    routes: [
      { match: "claude-*", base_url: "https://api.anthropic.com", auth: "passthrough" },
      { match: "deepseek-*", base_url: "https://api.deepseek.com/anthropic", auth: { header: "x-api-key", keyEnv: "DEEPSEEK_API_KEY" } },
      { match: "vision-*", base_url: "https://openrouter.ai/api", forImages: true, forImagesModel: "google/gemini-2.5-flash-lite", auth: { header: "Authorization", scheme: "Bearer", keyEnv: "OPENROUTER_API_KEY" } },
      { match: "nonvis-*", base_url: "https://nv.example", vision: false, auth: { header: "x-api-key", keyEnv: "NV_KEY" } },
      { match: "glm-*", base_url: "https://api.z.ai/api/anthropic", models_url: "https://api.z.ai/api/paas/v4/models", models_format: "openai", auth: { header: "Authorization", scheme: "Bearer", keyEnv: "ZAI_KEY" } },
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
  check("listConfig surfaces models_url", listed.routes[4].models_url, "https://api.z.ai/api/paas/v4/models");
  check("listConfig surfaces models_format", listed.routes[4].models_format, "openai");
  check("listConfig omits models_url when absent", "models_url" in listed.routes[0], false);
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

  // A provider model-catalog stub for GET /v1/models?expand=1 (src/router.mjs
  // fetchModelCatalog). mode "ok" → a {data:[{id},...]} catalog mixing ids that DO and
  // do NOT match the glob under test (proves the filter, not just the fetch); "error" →
  // 500; "badjson" → 200 with an unparseable body. Both failure modes must fall back to
  // the unexpanded glob (concrete:false), never break the endpoint.
  function makeCatalogStub(initialMode) {
    const received = [];
    let mode = initialMode;
    const server = http.createServer((req, res) => {
      received.push({ url: req.url, headers: req.headers });
      if (mode === "ok") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "glm-4.6" }, { id: "glm-4.5-air" }, { id: "gpt-4-turbo" }] }));
        return;
      }
      if (mode === "badjson") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("not json");
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "catalog unavailable" }));
    });
    return { server, received, setMode: (m) => { mode = m; } };
  }
  // Three FIXED-mode stubs (not mode-switched) so the per-process catalog cache
  // (keyed by models_url, see MODELS_CACHE_TTL_MS) can never make one scenario's earlier
  // success mask a later failure test against the same URL — each scenario gets its own
  // models_url, so a single expand=1 call (no waiting on cache TTL) exercises all of them.
  const catalogStub = makeCatalogStub("ok");
  const catalogErrorStub = makeCatalogStub("error");
  const catalogBadJsonStub = makeCatalogStub("badjson");
  const catalogPort = await listen(catalogStub.server);
  const catalogErrorPort = await listen(catalogErrorStub.server);
  const catalogBadJsonPort = await listen(catalogBadJsonStub.server);

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
      // expand=1 fixtures (src/router.mjs expandModels):
      // already-concrete (no `*`) ⇒ returned as-is, concrete:true, no catalog fetch.
      { match: "literal-model-1", base_url: `http://127.0.0.1:${aPort}`, auth: { header: "x-api-key", keyEnv: "TEST_ANTHROPIC_KEY" } },
      // glob + models_url ⇒ expanded against the catalog stub, filtered by the glob.
      { match: "glm-*", base_url: `http://127.0.0.1:${dPort}`, models_url: `http://127.0.0.1:${catalogPort}/v1/models`, models_format: "openai", auth: { header: "Authorization", scheme: "Bearer", keyEnv: "TEST_DEEPSEEK_KEY" } },
      // glob + models_url, but the route's OWN key env is unset ⇒ catalog fetch fails
      // closed ⇒ falls back to the unexpanded glob (concrete:false), endpoint still 200.
      { match: "noupstream-*", base_url: `http://127.0.0.1:${aPort}`, models_url: `http://127.0.0.1:${catalogPort}/v1/models`, models_format: "openai", auth: { header: "x-api-key", keyEnv: "TEST_UNSET_KEY_XYZ" } },
      // glob + models_url + auth:"passthrough" ⇒ the catalog fetch carries the CLIENT's
      // own incoming auth header (no backend key to swap in).
      { match: "ptglob-*", base_url: `http://127.0.0.1:${pPort}`, auth: "passthrough", models_url: `http://127.0.0.1:${catalogPort}/v1/models`, models_format: "openai" },
      // glob + models_url, but the CATALOG BACKEND itself fails: 500 / unparseable body.
      // Both must fall back to the unexpanded glob, never break the endpoint.
      { match: "errglob-*", base_url: `http://127.0.0.1:${aPort}`, models_url: `http://127.0.0.1:${catalogErrorPort}/v1/models`, models_format: "openai", auth: { header: "x-api-key", keyEnv: "TEST_ANTHROPIC_KEY" } },
      { match: "badjsonglob-*", base_url: `http://127.0.0.1:${aPort}`, models_url: `http://127.0.0.1:${catalogBadJsonPort}/v1/models`, models_format: "openai", auth: { header: "x-api-key", keyEnv: "TEST_ANTHROPIC_KEY" } },
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
    // without expand, the response carries neither new field — locks in byte-for-byte
    // backward compatibility for an existing consumer (e.g. --probe).
    check("GET /v1/models (no expand) has no \"match\" field", "match" in m11data.data[0], false);
    check("GET /v1/models (no expand) has no \"concrete\" field", "concrete" in m11data.data[0], false);

    // 12. GET /v1/models?expand=1: globs resolved against each route's models_url. Carries
    // a client front-key so the passthrough-route catalog-fetch case (12d) is exercisable.
    const m12 = await get(routerPort, "/v1/models?expand=1", { "x-api-key": "CLIENT-FRONT-KEY" });
    check("GET /v1/models?expand=1 ⇒ 200", m12.status, 200);
    const m12data = JSON.parse(m12.body);
    const byMatch = (match) => m12data.data.filter((e) => e.match === match);

    // 12a. already-concrete (no `*`): returned as-is, concrete:true, no catalog hit.
    const literalEntries = byMatch("literal-model-1");
    check("expand: concrete route ⇒ exactly one entry", literalEntries.length, 1);
    check("expand: concrete route id unchanged", literalEntries[0].id, "literal-model-1");
    check("expand: concrete route is concrete:true", literalEntries[0].concrete, true);

    // 12b. glob + models_url: expanded to the catalog ids that match THIS route's glob —
    // "gpt-4-turbo" (also in the stub's catalog) must be filtered OUT.
    const glmEntries = byMatch("glm-*");
    const glmIds = glmEntries.map((e) => e.id).sort();
    check("expand: glm-* expands to exactly its matching catalog ids",
      JSON.stringify(glmIds), JSON.stringify(["glm-4.5-air", "glm-4.6"]));
    check("expand: glm-* entries are concrete:true", glmEntries.every((e) => e.concrete === true), true);
    check("expand: glm-* entries carry the backend host (from listModels), not the catalog host",
      glmEntries.every((e) => e.host === `127.0.0.1:${dPort}`), true);
    check("expand: glm-* expansion did not leak the backend key",
      m12.body.includes("DS-SECRET-456"), false);

    // 12c. glob + models_url but the route's own key env is unset: the catalog fetch
    // fails closed (resolveAuthHeader throws) ⇒ falls back to the unexpanded glob —
    // the endpoint still answers 200 (one route's failure doesn't break the others).
    const noUpstreamEntries = byMatch("noupstream-*");
    check("expand: unset-key route falls back to exactly one (glob) entry", noUpstreamEntries.length, 1);
    check("expand: unset-key route id is the unexpanded glob", noUpstreamEntries[0].id, "noupstream-*");
    check("expand: unset-key route is concrete:false", noUpstreamEntries[0].concrete, false);

    // 12d. glob + models_url with no glob match in the catalog (the stub's ids are all
    // glm-*/gpt-4-turbo, none start with "ptglob-") ⇒ falls back to the glob, BUT the
    // catalog fetch DID happen carrying the CLIENT's own auth header (passthrough — no
    // backend key to swap in for this route).
    const ptglobEntries = byMatch("ptglob-*");
    check("expand: zero-match passthrough route falls back to the glob", ptglobEntries.length, 1);
    check("expand: zero-match passthrough route is concrete:false", ptglobEntries[0].concrete, false);
    const ptCatalogReq = catalogStub.received.find((r) => r.headers["x-api-key"] === "CLIENT-FRONT-KEY");
    check("expand: passthrough route's catalog fetch carried the CLIENT's own auth header, not a backend key",
      Boolean(ptCatalogReq), true);

    // 12e. routes with NO models_url stay an unexpanded glob, concrete:false, regardless
    // of expand=1 (e.g. claude-*, deepseek-*) — same as the non-expand response.
    const claudeEntries = byMatch("claude-*");
    check("expand: a route with no models_url stays the glob", claudeEntries.length, 1);
    check("expand: a route with no models_url is concrete:false", claudeEntries[0].concrete, false);

    // 12f. glob + models_url, but the CATALOG BACKEND itself fails (500 / unparseable
    // body): falls back to the unexpanded glob — fail-safe, the endpoint stays 200
    // rather than failing the whole listing over one backend's outage.
    const errEntries = byMatch("errglob-*");
    check("expand: catalog backend 500 ⇒ falls back to exactly one (glob) entry", errEntries.length, 1);
    check("expand: catalog backend 500 ⇒ concrete:false", errEntries[0].concrete, false);
    const badJsonEntries = byMatch("badjsonglob-*");
    check("expand: catalog backend bad JSON ⇒ falls back to exactly one (glob) entry", badJsonEntries.length, 1);
    check("expand: catalog backend bad JSON ⇒ concrete:false", badJsonEntries[0].concrete, false);
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
    await close(catalogStub.server);
    await close(catalogErrorStub.server);
    await close(catalogBadJsonStub.server);
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
