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
//
// Hermetic: points the persistence store at a throwaway temp dir via MODELPIPE_DIR
// (set BEFORE importing router.mjs, since store.mjs reads it at import time), so the
// dashboard endpoints that persist overrides never touch the real ~/.modelpipe.

import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

process.env.MODELPIPE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "modelpipe-router-test-"));

const {
  createRouter,
  pickRoute,
  listModels,
  globToRegExp,
  clientLabel,
  modelFromBody,
  rewriteModelInBody,
  stripThinkingBlocks,
  stripBadServerToolUseBlocks,
  resolveAuthHeader,
  isPassthrough,
  bodyHasImageBlock,
  currentTurnHasImage,
  stripImageBlocks,
  isImageUnsupported400,
  isFailoverTrigger,
  pickVisionRoute,
  validateConfig,
  listConfig,
  isFallbackAuth,
  clientHasAuth,
  pickAccountIndex,
  accountEligible,
  routeBilling,
  parseTzOffset,
  parseHHMM,
  inWindow,
} = await import("../src/router.mjs");

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

// A bare POST with a JSON body to an arbitrary path (management endpoints).
function postJson(port, urlPath, obj) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(obj));
    const req = http.request(
      { hostname: "127.0.0.1", port, path: urlPath, method: "POST", headers: { "content-type": "application/json", "content-length": data.length } },
      (res) => { const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString("utf8") })); },
    );
    req.on("error", reject); req.write(data); req.end();
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

  // stripThinkingBlocks — drop thinking/redacted_thinking from history so a signature-validating
  // backend doesn't 400 on a foreign/cross-provider thinking-block signature.
  {
    const withThinking = Buffer.from(JSON.stringify({
      model: "claude-opus-4-8",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [
          { type: "thinking", thinking: "hmm", signature: "sig-from-glm" },
          { type: "text", text: "hello" },
        ] },
      ],
    }));
    const stripped = JSON.parse(stripThinkingBlocks(withThinking).toString());
    check("stripThinkingBlocks removes the thinking block",
      stripped.messages[1].content.length, 1);
    check("stripThinkingBlocks keeps the text block",
      stripped.messages[1].content[0].type, "text");
    check("stripThinkingBlocks leaves the user turn untouched",
      stripped.messages[0].content[0].text, "hi");
  }
  check("stripThinkingBlocks redacted_thinking also dropped",
    JSON.parse(stripThinkingBlocks(Buffer.from(JSON.stringify({
      messages: [{ role: "assistant", content: [
        { type: "redacted_thinking", data: "x" }, { type: "text", text: "y" },
      ] }],
    }))).toString()).messages[0].content.length, 1);
  check("stripThinkingBlocks no thinking ⇒ same buffer reference (no re-serialize)",
    (() => { const b = Buffer.from('{"messages":[{"role":"user","content":[{"type":"text","text":"a"}]}]}'); return stripThinkingBlocks(b) === b; })(), true);
  check("stripThinkingBlocks thinking-only turn is KEPT (never empties content)",
    JSON.parse(stripThinkingBlocks(Buffer.from(JSON.stringify({
      messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }] }],
    }))).toString()).messages[0].content.length, 1);
  check("stripThinkingBlocks bad json ⇒ body unchanged (fail-safe)",
    stripThinkingBlocks(Buffer.from("not json")).toString(), "not json");
  check("stripThinkingBlocks no messages array ⇒ unchanged",
    stripThinkingBlocks(Buffer.from('{"model":"x"}')).toString(), '{"model":"x"}');

  // stripBadServerToolUseBlocks — drop a server_tool_use block (+ its paired *_tool_result) whose
  // id doesn't match Anthropic's own `srvtoolu_...` shape, so a strict backend doesn't 400 on a
  // foreign/cross-provider server_tool_use id.
  {
    // Server-side tool results (unlike client tool_use/tool_result) live in the SAME assistant
    // turn as the tool_use block — Anthropic executes the tool inline and appends the result.
    const withForeignId = Buffer.from(JSON.stringify({
      model: "claude-opus-4-8",
      messages: [
        { role: "user", content: [{ type: "text", text: "search the web" }] },
        { role: "assistant", content: [
          { type: "server_tool_use", id: "call_from_glm_123", name: "web_search", input: { query: "x" } },
          { type: "web_search_tool_result", tool_use_id: "call_from_glm_123", content: [] },
          { type: "text", text: "here's what I found" },
        ] },
      ],
    }));
    const stripped = JSON.parse(stripBadServerToolUseBlocks(withForeignId).toString());
    check("stripBadServerToolUseBlocks removes the bad server_tool_use block + its paired result",
      stripped.messages[1].content.length, 1);
    check("stripBadServerToolUseBlocks keeps the text block",
      stripped.messages[1].content[0].type, "text");
  }
  check("stripBadServerToolUseBlocks valid Anthropic id ⇒ left alone",
    (() => {
      const b = Buffer.from(JSON.stringify({
        messages: [{ role: "assistant", content: [
          { type: "server_tool_use", id: "srvtoolu_01AbCd23", name: "web_search", input: {} },
          { type: "text", text: "y" },
        ] }],
      }));
      return stripBadServerToolUseBlocks(b) === b;
    })(), true);
  check("stripBadServerToolUseBlocks no bad ids ⇒ same buffer reference (no re-serialize)",
    (() => { const b = Buffer.from('{"messages":[{"role":"user","content":[{"type":"text","text":"a"}]}]}'); return stripBadServerToolUseBlocks(b) === b; })(), true);
  check("stripBadServerToolUseBlocks server_tool_use-only turn is KEPT (never empties content)",
    JSON.parse(stripBadServerToolUseBlocks(Buffer.from(JSON.stringify({
      messages: [{ role: "assistant", content: [{ type: "server_tool_use", id: "call_bad", name: "web_search", input: {} }] }],
    }))).toString()).messages[0].content.length, 1);
  check("stripBadServerToolUseBlocks bad json ⇒ body unchanged (fail-safe)",
    stripBadServerToolUseBlocks(Buffer.from("not json")).toString(), "not json");
  check("stripBadServerToolUseBlocks no messages array ⇒ unchanged",
    stripBadServerToolUseBlocks(Buffer.from('{"model":"x"}')).toString(), '{"model":"x"}');

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

  // currentTurnHasImage: true only for an image AFTER the last assistant reply (or on the
  // first turn), so a historical image the model already answered is NOT a current-turn image.
  const curTurnImg = Buffer.from(JSON.stringify({ model: "m", messages: [
    { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A" } }, { type: "text", text: "look" }] },
  ] }));
  check("currentTurnHasImage true on the first turn", currentTurnHasImage(curTurnImg), true);
  const historicalImg = Buffer.from(JSON.stringify({ model: "m", messages: [
    { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A" } }] },
    { role: "assistant", content: [{ type: "text", text: "I see a cat" }] },
    { role: "user", content: [{ type: "text", text: "and now?" }] },
  ] }));
  check("currentTurnHasImage false when the image precedes the last assistant reply", currentTurnHasImage(historicalImg), false);
  check("bodyHasImageBlock still true for that historical image", bodyHasImageBlock(historicalImg), true);
  const newImgAfterReply = Buffer.from(JSON.stringify({ model: "m", messages: [
    { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A" } }] },
    { role: "assistant", content: [{ type: "text", text: "I see a cat" }] },
    { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "B" } }, { type: "text", text: "and this?" }] },
  ] }));
  check("currentTurnHasImage true for a fresh image after the last reply", currentTurnHasImage(newImgAfterReply), true);
  check("currentTurnHasImage false for bad json", currentTurnHasImage(Buffer.from("not json")), false);

  // stripImageBlocks: replaces image blocks with a text placeholder, preserves other blocks,
  // returns a new buffer only when something changed, fail-safe on bad json.
  const strippedBuf = stripImageBlocks(historicalImg);
  const strippedParsed = JSON.parse(strippedBuf.toString());
  check("stripImageBlocks replaces the image block with a text placeholder", strippedParsed.messages[0].content[0].type, "text");
  check("stripImageBlocks placeholder text is the omitted marker", strippedParsed.messages[0].content[0].text, "[image omitted]");
  check("stripImageBlocks leaves text turns untouched", strippedParsed.messages[2].content[0].text, "and now?");
  check("stripImageBlocks preserves the model id", strippedParsed.model, "m");
  const textOnly = Buffer.from('{"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}');
  check("stripImageBlocks returns the SAME buffer when there is nothing to strip", stripImageBlocks(textOnly), textOnly);
  check("stripImageBlocks returns body unchanged for bad json (fail-safe)", stripImageBlocks(Buffer.from("not json")).toString(), "not json");

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

  // ── profiles / auto config validation + legacy rejection ────────────────────
  const R = [{ match: "glm-*", base_url: "https://z.example", auth: { header: "Authorization", scheme: "Bearer", keyEnv: "K" } },
             { match: "claude-*", base_url: "https://a.example", auth: "passthrough" }];
  const mkc = (extra) => ({ routes: R, ...extra });
  const rej = (extra) => { try { validateConfig(mkc(extra)); return false; } catch { return true; } };
  // ── clientLabel: the "who sent it" trace label (user-agent · auth fingerprint) ──
  check("clientLabel: no headers ⇒ unknown", clientLabel(null), "unknown");
  check("clientLabel: empty headers ⇒ unknown", clientLabel({}), "unknown");
  check("clientLabel: user-agent product token only", clientLabel({ "user-agent": "claude-cli/1.0.83 (external, cli)" }), "claude-cli/1.0.83");
  check("clientLabel: no ua, only auth ⇒ 6-hex fingerprint", /^[0-9a-f]{6}$/.test(clientLabel({ authorization: "Bearer sk-tok" })), true);
  check("clientLabel: ua · fingerprint, and stable", clientLabel({ "user-agent": "cli/1", "x-api-key": "K" }), clientLabel({ "user-agent": "cli/1", "x-api-key": "K" }));
  check("clientLabel: never leaks the token", clientLabel({ "user-agent": "cli/1", "x-api-key": "supersecret" }).includes("supersecret"), false);
  check("clientLabel: different keys ⇒ different labels", clientLabel({ "x-api-key": "A" }) === clientLabel({ "x-api-key": "B" }), false);

  check("validateConfig accepts profiles + auto",
    validateConfig(mkc({ profiles: { native: { bind: {} }, sonnet: { bind: { "glm-5.2": "claude-sonnet-5" } } },
      auto: { steps: [{ profile: "native" }, { profile: "sonnet", when: "limit" }] } })).profiles.sonnet.bind["glm-5.2"], "claude-sonnet-5");
  check("validateConfig rejects legacy failover", rej({ failover: { "glm-*": "x" } }), true);
  check("validateConfig rejects legacy failoverGroups", rej({ failoverGroups: [{ ladder: ["a", "b"] }] }), true);
  check("validateConfig rejects legacy schedules", rej({ schedules: [] }), true);
  check("validateConfig rejects unknown step profile", rej({ profiles: { native: { bind: {} } }, auto: { steps: [{ profile: "ghost" }] } }), true);
  check("validateConfig rejects when on head step", rej({ profiles: { a: { bind: {} } }, auto: { steps: [{ profile: "a", when: "limit" }] } }), true);
  check("validateConfig rejects bad when value", rej({ profiles: { a: { bind: {} }, b: { bind: {} } }, auto: { steps: [{ profile: "a" }, { profile: "b", when: "sometimes" }] } }), true);
  check("validateConfig rejects unknown defaultProfile", rej({ profiles: { a: { bind: {} } }, defaultProfile: "ghost" }), true);
  check("validateConfig rejects non-string bind target", rej({ profiles: { a: { bind: { "glm-*": 5 } } } }), true);
  check("validateConfig rejects a shadowed binding (broad glob before specific)", rej({ profiles: { a: { bind: { "glm-*": "x", "glm-5.2": "y" } } } }), true);
  check("validateConfig accepts specific-before-broad bindings",
    validateConfig(mkc({ profiles: { a: { bind: { "glm-5.2": "y", "glm-*": "x" } } } })).profiles.a.bind["glm-5.2"], "y");
  check("validateConfig accepts per-binding notes",
    validateConfig(mkc({ profiles: { a: { bind: { "glm-5.2": "x" }, notes: { "glm-5.2": "paid reserve" } } } })).profiles.a.notes["glm-5.2"], "paid reserve");
  check("validateConfig rejects non-string note", rej({ profiles: { a: { bind: { "glm-5.2": "x" }, notes: { "glm-5.2": 7 } } } }), true);
  check("validateConfig rejects unknown schedule profile", rej({ profiles: { a: { bind: {} } }, auto: { steps: [{ profile: "a" }], schedules: [{ profile: "ghost", tz: "Z", windows: [["1:00", "2:00"]] }] } }), true);
  check("validateConfig accepts auto.schedules",
    validateConfig(mkc({ profiles: { a: { bind: {} }, b: { bind: {} } }, auto: { steps: [{ profile: "a" }], schedules: [{ profile: "b", tz: "+03:00", windows: [["14:00", "18:00"]] }] } })).auto.schedules.length, 1);
  let foBadCooldownThrew = false;
  try { validateConfig(mkc({ failoverRecoveryIntervalMs: 500 })); } catch { foBadCooldownThrew = true; }
  check("validateConfig rejects failoverRecoveryIntervalMs < 1000", foBadCooldownThrew, true);
  check("validateConfig accepts failoverRecoveryIntervalMs",
    validateConfig(mkc({ failoverRecoveryIntervalMs: 5000 })).failoverRecoveryIntervalMs, 5000);

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
  check("isFailoverTrigger: 400 + EMPTY body triggers (looks like a network break, not a real rejection)",
    isFailoverTrigger(400, Buffer.from("")), true);
  check("isFailoverTrigger: 400 + non-empty bad json does NOT trigger (unchanged)",
    isFailoverTrigger(400, Buffer.from("not json")), false);
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

  // ── time-window pure helpers ────────────────────────────────────────────────
  check("parseTzOffset +08:00", parseTzOffset("+08:00"), 480);
  check("parseTzOffset +08 (no minutes)", parseTzOffset("+08"), 480);
  check("parseTzOffset -0530", parseTzOffset("-0530"), -330);
  check("parseTzOffset Z ⇒ 0", parseTzOffset("Z"), 0);
  check("parseTzOffset empty ⇒ 0", parseTzOffset(""), 0);
  check("parseTzOffset garbage ⇒ null", parseTzOffset("nope"), null);
  check("parseHHMM 14:00", parseHHMM("14:00"), 840);
  check("parseHHMM 9:05 (1-digit hour)", parseHHMM("9:05"), 545);
  check("parseHHMM 24:00 ⇒ null", parseHHMM("24:00"), null);
  check("parseHHMM 12:60 ⇒ null", parseHHMM("12:60"), null);
  check("inWindow inside [from,to)", inWindow(9 * 60, 8 * 60, 10 * 60), true);
  check("inWindow at from (inclusive)", inWindow(8 * 60, 8 * 60, 10 * 60), true);
  check("inWindow at to (exclusive)", inWindow(10 * 60, 8 * 60, 10 * 60), false);
  check("inWindow wraps midnight @23:00", inWindow(23 * 60, 22 * 60, 2 * 60), true);
  check("inWindow wraps midnight @01:00", inWindow(1 * 60, 22 * 60, 2 * 60), true);
  check("inWindow wraps midnight @12:00 outside", inWindow(12 * 60, 22 * 60, 2 * 60), false);
  check("inWindow empty (from==to)", inWindow(9 * 60, 9 * 60, 9 * 60), false);

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

  // ── routeBilling (honest defaults) ──────────────────────────────────────────
  check("routeBilling: explicit wins", routeBilling({ base_url: "https://api.deepseek.com", billing: "subscription", auth: { header: "x", keyEnv: "K" } }), "subscription");
  check("routeBilling: passthrough → subscription", routeBilling({ base_url: "https://api.anthropic.com", auth: "passthrough" }), "subscription");
  check("routeBilling: z.ai/GLM key-swap → subscription (Coding Plan)", routeBilling({ base_url: "https://api.z.ai/api/anthropic", auth: { header: "Authorization", keyEnv: "ZAI_API_KEY" } }), "subscription");
  check("routeBilling: deepseek key-swap → metered", routeBilling({ base_url: "https://api.deepseek.com/anthropic", auth: { header: "x-api-key", keyEnv: "K" } }), "metered");

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

    // 4. missing model + unparseable body — proxied to the default route (passthrough)
    //    so the upstream responds, rather than the proxy inventing a 400 for a field
    //    it doesn't own. The real upstream would return a proper error for a malformed
    //    messages call; the stub returns 200.
    const r4 = await request(routerPort, { messages: [] });
    check("missing model proxied to default route (200 from stub)", r4.status, 200);
    const r5 = await request(routerPort, null, { raw: "this is not json" });
    check("unparseable body proxied to default route (200 from stub)", r5.status, 200);

    // 4b. A model that genuinely matches no route still fails closed.
    const r4b = await request(routerPort, { model: "gpt-4-turbo", messages: [] });
    check("unknown model with model field ⇒ 4xx", r4b.status >= 400 && r4b.status < 500, true);

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
    //    received[2] because tests #4 (missing model) and #5 (unparseable body) are
    //    now also proxied to the default passthrough route.
    const r7 = await request(routerPort, { model: "passthru-1", messages: [{ role: "user", content: "BODY-SENTINEL-PT" }] });
    check("passthrough status 200", r7.status, 200);
    check("passthrough streamed response intact", r7.body, STREAM_BODY);
    const pReq = passthroughStub.received[passthroughStub.received.length - 1];
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

  // A legacy router: dropProcessedImages:false ⇒ ANY image (even historical) pre-routes to
  // the vision target, the old sticky behaviour.
  const legacyVisionConfig = { ...visionConfig, dropProcessedImages: false };
  const legacyRouter = createRouter(legacyVisionConfig);
  const legacyPort = await listen(legacyRouter);

  // A multi-turn request whose image sits in HISTORY (before the last assistant reply),
  // with a text-only current turn — the "already processed" case.
  const historyImageReq = (model) => ({
    model,
    messages: [
      { role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "IMG-DATA-SENTINEL" } },
        { type: "text", text: "VISION-BODY-SENTINEL" },
      ] },
      { role: "assistant", content: [{ type: "text", text: "seen it" }] },
      { role: "user", content: [{ type: "text", text: "follow-up question" }] },
    ],
  });

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

    // V9. one-shot vision: an image in HISTORY (already answered) + a text current turn on a
    //     vision:false route → NOT pre-routed to B; served natively by A with the historical
    //     image stripped to a placeholder (default dropProcessedImages). Fixes the "stuck on
    //     the vision model" bug where a lingering image pinned every follow-up turn to vision.
    aStub.setMode("ok");
    const aBefore9 = aStub.received.length;
    const bBefore9 = bStub.received.length;
    const v9 = await request(vPort, historyImageReq("declared-hist"));
    check("V9 one-shot: A served the follow-up (no pre-route to vision)", aStub.received.length, aBefore9 + 1);
    check("V9 one-shot: B was NOT touched", bStub.received.length, bBefore9);
    check("V9 one-shot: client gets A's 200", v9.status, 200);
    const v9body = JSON.parse(aStub.received[aStub.received.length - 1].body);
    check("V9 one-shot: the historical image was stripped to a placeholder", v9body.messages[0].content[0].type, "text");
    check("V9 one-shot: placeholder is the omitted marker", v9body.messages[0].content[0].text, "[image omitted]");
    check("V9 one-shot: image bytes never reached A", aStub.received[aStub.received.length - 1].body.includes("IMG-DATA-SENTINEL"), false);
    check("V9 one-shot: the text current turn is preserved", v9body.messages[2].content[0].text, "follow-up question");

    // V10. one-shot vision, fresh image: an image in the CURRENT turn (after the last reply)
    //      still pre-routes to the vision target B — the model has not answered THIS image yet.
    aStub.setMode("reject"); // would 400 if A were hit
    const aBefore10 = aStub.received.length;
    const bBefore10 = bStub.received.length;
    bStub.setMode("ok");
    const freshImageReq = {
      model: "declared-fresh",
      messages: [
        { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "OLD" } }] },
        { role: "assistant", content: [{ type: "text", text: "seen it" }] },
        { role: "user", content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "IMG-DATA-SENTINEL" } },
          { type: "text", text: "and this one?" },
        ] },
      ],
    };
    const v10 = await request(vPort, freshImageReq);
    check("V10 fresh-image: A was NOT hit (current-turn image pre-routes)", aStub.received.length, aBefore10);
    check("V10 fresh-image: B served it directly", bStub.received.length, bBefore10 + 1);
    check("V10 fresh-image: B got the rewritten model id", JSON.parse(bStub.received[bStub.received.length - 1].body).model, "vendor/vision-model");
    check("V10 fresh-image: client gets B's 200", v10.status, 200);

    // V11. legacy sticky vision (dropProcessedImages:false): a HISTORICAL image still pre-routes
    //      to the vision target B, and the image bytes reach B unaltered (no stripping).
    aStub.setMode("reject"); // would 400 if A were hit
    bStub.setMode("ok");
    const aBefore11 = aStub.received.length;
    const bBefore11 = bStub.received.length;
    const v11 = await request(legacyPort, historyImageReq("declared-legacy"));
    check("V11 legacy: A was NOT hit (any image pre-routes)", aStub.received.length, aBefore11);
    check("V11 legacy: B served it directly", bStub.received.length, bBefore11 + 1);
    check("V11 legacy: image bytes reached B unaltered (not stripped)", JSON.parse(bStub.received[bStub.received.length - 1].body).messages[0].content[0].source.data, "IMG-DATA-SENTINEL");
    check("V11 legacy: client gets B's 200", v11.status, 200);

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
    await close(legacyRouter);
    await close(aStub.server);
    await close(bStub.server);
  }

  // ── profile routing e2e (reactive shift, pre-route, cascade, pin, safety, recovery) ──
  {
    process.env.TEST_PF_KEY = "PF-SECRET-999";
    process.env.MODEL_ROUTER_LOG = "1";
    const pfLog = [];
    const pfRealWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => { pfLog.push(String(chunk)); return pfRealWrite(chunk, ...rest); };

    const zStub = makeFlexStub(200);    // glm backend (the "native" default)
    const sonStub = makeFlexStub(200);  // claude-sonnet backend (the "sonnet" safety step)
    const zPort = await listen(zStub.server);
    const sonPort = await listen(sonStub.server);
    const pfConfig = {
      listen: { host: "127.0.0.1", port: 0 },
      dashboard: true,
      failoverRecoveryIntervalMs: 30000, // long, so the BACKGROUND pinger never fires mid-test
      profiles: {
        native: { bind: {} },
        sonnet: { bind: { "glm-5.2": "claude-sonnet-5" } },
        econ: { bind: { "glm-5.2": "claude-sonnet-5" } }, // manual-only (NOT in auto.steps)
      },
      defaultProfile: "native",
      auto: { steps: [{ profile: "native" }, { profile: "sonnet", when: "limit" }], recover: true },
      routes: [
        { match: "glm-*", base_url: `http://127.0.0.1:${zPort}`, auth: { header: "x-api-key", keyEnv: "TEST_PF_KEY" } },
        { match: "claude-*", base_url: `http://127.0.0.1:${sonPort}`, auth: { header: "x-api-key", keyEnv: "TEST_PF_KEY" } },
      ],
    };
    const pfRouter = createRouter(pfConfig);
    const pfPort = await listen(pfRouter);
    const ps = pfRouter._modelpipe.profileState;
    try {
      // P0. default profile: glm-5.2 routes to its own z backend, no rewrite.
      zStub.setStatus(200);
      const p0 = await request(pfPort, { model: "glm-5.2", messages: [{ role: "user", content: "P0" }] });
      check("P0 default: z backend served glm-5.2", zStub.received.length, 1);
      check("P0 default: model id unchanged", JSON.parse(zStub.received[0].body).model, "glm-5.2");
      check("P0 default: client gets 200", p0.status, 200);
      check("P0 default: offset 0", ps.offset, 0);

      // P1. z 429 → reactive shift to the "sonnet" step → claude backend serves it. offset → 1.
      zStub.setStatus(429); zStub.setBody('{"error":{"message":"rate limit exceeded"}}');
      sonStub.setStatus(200);
      const zBefore1 = zStub.received.length;
      const p1 = await request(pfPort, { model: "glm-5.2", messages: [{ role: "user", content: "P1-BODY" }] });
      check("P1 shift: z hit (the failing head)", zStub.received.length, zBefore1 + 1);
      check("P1 shift: claude backend served the reroute", sonStub.received.length, 1);
      check("P1 shift: client gets 200", p1.status, 200);
      check("P1 shift: alias rewritten to claude-sonnet-5", JSON.parse(sonStub.received[0].body).model, "claude-sonnet-5");
      check("P1 shift: backend got its key", sonStub.received[0].headers["x-api-key"], "PF-SECRET-999");
      check("P1 shift: offset -> 1", ps.offset, 1);

      // P2. Pre-route while shifted: glm-5.2 goes straight to claude, z NOT hit.
      const zBefore2 = zStub.received.length;
      const sonBefore2 = sonStub.received.length;
      const p2 = await request(pfPort, { model: "glm-5.2", messages: [{ role: "user", content: "P2" }] });
      check("P2 pre-route: z skipped while shifted", zStub.received.length, zBefore2);
      check("P2 pre-route: claude served directly", sonStub.received.length, sonBefore2 + 1);
      check("P2 pre-route: client gets 200", p2.status, 200);

      // P3. Cascade end: at the last step, a further limit has nowhere lower → relayed.
      sonStub.setStatus(429); sonStub.setBody('{"error":{"message":"rate limit exceeded"}}');
      const p3 = await request(pfPort, { model: "glm-5.2", messages: [{ role: "user", content: "P3" }] });
      check("P3 cascade end: last step's 429 relayed", p3.status, 429);
      check("P3 cascade end: offset stays 1", ps.offset, 1);
      sonStub.setStatus(200);

      // P4. Recovery via the background pinger: z healthy + cooldown elapsed → wind up to 0.
      zStub.setStatus(200);
      ps.shiftedAt = 1; // ancient → cooldown elapsed
      await pfRouter._modelpipe.profilePinger.poll();
      check("P4 recovery: pinger wound offset back to 0", ps.offset, 0);

      // P5. Manual pin (dashboard): pin "sonnet" → glm-5.2 routes to claude even though z is healthy.
      const zBefore5 = zStub.received.length;
      const pin = await postJson(pfPort, "/v1/profiles/pin", { profile: "sonnet" });
      check("P5 pin: endpoint ok", pin.status, 200);
      const sonBefore5 = sonStub.received.length;
      await request(pfPort, { model: "glm-5.2", messages: [{ role: "user", content: "P5" }] });
      check("P5 pin: z NOT hit (pinned to sonnet)", zStub.received.length, zBefore5);
      check("P5 pin: claude served the pinned route", sonStub.received.length, sonBefore5 + 1);
      check("P5 pin: state.pinned = sonnet", ps.pinned, "sonnet");

      // P6. Safety armed: pin the manual-only "econ" (glm-5.2→claude), then claude 429 → the
      //     pin CLEARS and the resolver falls back to default (native → z), which serves it.
      await postJson(pfPort, "/v1/profiles/pin", { profile: "econ" });
      check("P6 setup: pinned econ", ps.pinned, "econ");
      sonStub.setStatus(429); sonStub.setBody('{"error":{"message":"rate limit exceeded"}}');
      zStub.setStatus(200);
      const zBefore6 = zStub.received.length;
      const p6 = await request(pfPort, { model: "glm-5.2", messages: [{ role: "user", content: "P6" }] });
      check("P6 safety: manual pin cleared on failover", ps.pinned, null);
      check("P6 safety: fell back to default → z served", zStub.received.length, zBefore6 + 1);
      check("P6 safety: client gets 200", p6.status, 200);
      sonStub.setStatus(200);

      // P7. GET /v1/profiles surfaces the banner summary (active + alias→target changes).
      await postJson(pfPort, "/v1/profiles/pin", { profile: "sonnet" });
      const view = JSON.parse((await get(pfPort, "/v1/profiles")).body);
      check("P7 view: lists declared profiles", Object.keys(view.profiles).sort().join(","), "econ,native,sonnet");
      check("P7 view: reports active profile", view.summary.active, "sonnet");
      check("P7 view: reports source manual", view.summary.source, "manual");
      check("P7 view: change line alias", view.summary.changes[0].alias, "glm-5.2");
      check("P7 view: change line target", view.summary.changes[0].to, "claude-sonnet-5");

      // P8. POST /v1/profiles/pin {profile:null} clears the pin; unknown profile → 400.
      const clr = await postJson(pfPort, "/v1/profiles/pin", { profile: null });
      check("P8 clear: ok", clr.status, 200);
      check("P8 clear: pinned null", ps.pinned, null);
      const badPin = await postJson(pfPort, "/v1/profiles/pin", { profile: "ghost" });
      check("P8 clear: unknown profile → 400", badPin.status, 400);

      // P-log: names alias -> target, leaks NO key or body.
      const logText = pfLog.join("");
      check("P-log: names alias -> target", logText.includes("glm-5.2 -> claude-sonnet-5"), true);
      check("P-log: leaks NO backend key", logText.includes("PF-SECRET-999"), false);
      check("P-log: leaks NO body sentinel", logText.includes("P1-BODY"), false);
    } finally {
      process.stderr.write = pfRealWrite;
      delete process.env.TEST_PF_KEY;
      delete process.env.MODEL_ROUTER_LOG;
      await close(pfRouter);
      await close(zStub.server);
      await close(sonStub.server);
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

  // ── /v1/profiles/reset endpoint (clear a stuck shift + pin without a restart) ──
  {
    process.env.PR_KEY = "x";
    const prStub = makeFlexStub(200);
    const prPort = await listen(prStub.server);
    const prRouter = createRouter({
      listen: { host: "127.0.0.1", port: 0 },
      dashboard: true,
      profiles: { native: { bind: {} }, sonnet: { bind: { "glm-5.2": "claude-sonnet-5" } } },
      auto: { steps: [{ profile: "native" }, { profile: "sonnet", when: "limit" }] },
      routes: [
        { match: "glm-*", base_url: `http://127.0.0.1:${prPort}`, auth: { header: "x-api-key", keyEnv: "PR_KEY" } },
        { match: "claude-*", base_url: `http://127.0.0.1:${prPort}`, auth: { header: "x-api-key", keyEnv: "PR_KEY" } },
      ],
    });
    const prRouterPort = await listen(prRouter);
    const prPs = prRouter._modelpipe.profileState;
    try {
      // Simulate a stuck shift + a manual pin, then reset both.
      prPs.offset = 1; prPs.pinned = "sonnet";
      const r = await postPath(prRouterPort, "/v1/profiles/reset");
      check("profile reset: endpoint ok", r.status, 200);
      check("profile reset: offset cleared", prPs.offset, 0);
      check("profile reset: pin cleared", prPs.pinned, null);
    } finally {
      delete process.env.PR_KEY;
      await close(prRouter);
      await close(prStub.server);
    }
  }

  // ── scheduled profile e2e (an open window selects a profile as the intended head) ──
  {
    process.env.SC_KEY = "SC-KEY";
    const scZ = makeFlexStub(200);   // glm backend (the "native" default)
    const scC = makeFlexStub(200);   // claude backend (the scheduled "budget" profile's target)
    const scZPort = await listen(scZ.server);
    const scCPort = await listen(scC.server);
    const scRouter = createRouter({
      listen: { host: "127.0.0.1", port: 0 },
      dashboard: true,
      profiles: { native: { bind: {} }, budget: { bind: { "glm-5.2": "claude-sonnet-5" } } },
      defaultProfile: "native",
      // Always-open window (whole day, UTC) so the selection is deterministic regardless
      // of when the test runs.
      auto: { steps: [{ profile: "native" }], schedules: [{ profile: "budget", tz: "Z", windows: [["00:00", "23:59"]] }] },
      routes: [
        { match: "glm-*", base_url: `http://127.0.0.1:${scZPort}`, auth: { header: "x-api-key", keyEnv: "SC_KEY" } },
        { match: "claude-*", base_url: `http://127.0.0.1:${scCPort}`, auth: { header: "x-api-key", keyEnv: "SC_KEY" } },
      ],
    });
    const scRouterPort = await listen(scRouter);
    try {
      await requestH(scRouterPort, { model: "glm-5.2", messages: [] });
      check("schedule e2e: in-window profile routes glm-5.2 → claude", JSON.parse(scC.received[scC.received.length - 1].body).model, "claude-sonnet-5");
      check("schedule e2e: z backend NOT hit in-window", scZ.received.length, 0);
      const view = JSON.parse((await get(scRouterPort, "/v1/profiles")).body);
      check("schedule e2e: GET /v1/profiles reports source schedule", view.summary.source, "schedule");
      check("schedule e2e: active is the scheduled profile", view.summary.active, "budget");
    } finally {
      delete process.env.SC_KEY;
      await close(scRouter);
      await close(scZ.server);
      await close(scC.server);
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

  // ── billing override endpoint (dashboard settings) ─────────────────────────
  {
    process.env.BILL_K = "x";
    const bStub = makeFlexStub(200);
    const bPort = await listen(bStub.server);
    const bRouter = createRouter({
      listen: { host: "127.0.0.1", port: 0 }, dashboard: true,
      routes: [{ match: "deepseek-*", base_url: `http://127.0.0.1:${bPort}`, auth: { header: "x-api-key", keyEnv: "BILL_K" } }],
    });
    const brPort = await listen(bRouter);
    try {
      const before = JSON.parse((await get(brPort, "/v1/models")).body).data[0];
      check("billing: deepseek stub defaults metered", before.billing, "metered");
      // Provider id for a localhost stub host is host:port; override by that id.
      const pid = before.provider;
      await postJson(brPort, "/v1/billing", { provider: pid, mode: "subscription" });
      const after = JSON.parse((await get(brPort, "/v1/models")).body).data[0];
      check("billing override → subscription reflected in /v1/models", after.billing, "subscription");
      await postJson(brPort, "/v1/billing", { provider: pid, mode: "auto" });
      const reset = JSON.parse((await get(brPort, "/v1/models")).body).data[0];
      check("billing override auto → back to derived (metered)", reset.billing, "metered");
    } finally {
      delete process.env.BILL_K;
      await close(bRouter); await close(bStub.server);
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
