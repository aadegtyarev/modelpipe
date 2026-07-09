// End-to-end context-fitting test: drives the REAL router over sockets.
//   1. DOWNSHIFT — primary (1M window) fails (529) → failover to a small-window backup; the
//      body forwarded to the backup must be trimmed to fit that smaller window.
//   2. OVERFLOW — a backend rejects an oversized request (400 context-length); the proxy learns
//      the real window, hard-trims, and retries; the retry (smaller) succeeds.
// Run: node test/compact-integration.test.mjs

import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

process.env.MODELPIPE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "modelpipe-compact-it-"));
const { createRouter } = await import("../src/router.mjs");

let pass = 0; const fails = [];
const ok = (name, cond) => { if (cond) pass++; else fails.push(`  ✗ ${name}`); };
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
const close = (s) => new Promise((r) => s.close(r));

const pad = (n) => "x".repeat(n);
const convo = [];
for (let i = 0; i < 8; i++) {
  convo.push({ role: "user", content: [{ type: "text", text: `step ${i} ` + pad(500) }] });
  convo.push({ role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: `T${i}`, name: "Bash", input: {} }] });
  convo.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `T${i}`, content: "done" }] });
}
convo.push({ role: "user", content: [{ type: "text", text: "final " + pad(200) }] });

function post(port, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(bodyObj));
    const r = http.request({ host: "127.0.0.1", port, method: "POST", path: "/v1/messages", headers: { "content-type": "application/json", "content-length": payload.length, authorization: "Bearer t" } }, (res) => {
      const cs = []; res.on("data", (c) => cs.push(c)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(cs).toString("utf8") }));
    });
    r.on("error", reject); r.end(payload);
  });
}

// ===== 1. DOWNSHIFT =====
await (async () => {
  const bigReqs = [], smallReqs = [];
  const stubBig = http.createServer((req, res) => { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => { bigReqs.push(1); res.writeHead(529, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "overloaded, try again later" } })); }); });
  const stubSmall = http.createServer((req, res) => { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => { smallReqs.push(Buffer.concat(c).toString("utf8")); res.writeHead(200, { "content-type": "text/event-stream" }); res.end("event: done\ndata: {}\n\n"); }); });
  const [pBig, pSmall] = [await listen(stubBig), await listen(stubSmall)];

  const router = createRouter({
    routes: [
      { match: "big-model", base_url: `http://127.0.0.1:${pBig}`, auth: "passthrough" },
      { match: "small-model", base_url: `http://127.0.0.1:${pSmall}`, auth: "passthrough" },
    ],
    // Profile ladder: the "small" step rebinds big-model → small-model, so a 529 on the
    // 1M-window primary downshifts to the 200-token backup (exercising the compact trim).
    profiles: { primary: { bind: {} }, small: { bind: { "big-model": "small-model" } } },
    auto: { steps: [{ profile: "primary" }, { profile: "small", when: "limit" }] },
    compact: { enabled: true, safetyPct: 0.95, windowDefault: 1000000, window: { "big-model": 1000000, "small-model": 200 }, maxOverflowRetries: 2 },
  }, { log: () => {} });
  const port = await listen(router);

  const res = await post(port, { model: "big-model", stream: true, messages: convo });
  ok("downshift: request ultimately succeeds on backup", res.status === 200);
  ok("downshift: primary was tried (then failed over)", bigReqs.length === 1);
  ok("downshift: backup received the request", smallReqs.length === 1);
  if (smallReqs.length) {
    const got = JSON.parse(smallReqs[0]);
    ok("downshift: body trimmed to fit small window", got.messages.length < convo.length);
    // tool-closed: no tool_result whose tool_use is absent
    const ids = new Set(); for (const m of got.messages) for (const b of (Array.isArray(m.content) ? m.content : [])) if (b.type === "tool_use") ids.add(b.id);
    let closed = true; for (const m of got.messages) for (const b of (Array.isArray(m.content) ? m.content : [])) if (b.type === "tool_result" && !ids.has(b.tool_use_id)) closed = false;
    ok("downshift: trimmed body is tool-closed (no dangling pair)", closed);
  }
  await close(router); await close(stubBig); await close(stubSmall);
})();

// ===== 2. OVERFLOW (reactive) =====
await (async () => {
  const LIMIT = 1000; // the stub's real window (tokens); configured window is much higher
  const reqs = []; // estimated tokens per received request
  const stub = http.createServer((req, res) => {
    const c = []; req.on("data", (x) => c.push(x));
    req.on("end", () => {
      const raw = Buffer.concat(c).toString("utf8");
      const est = Math.ceil(raw.length / 4);
      reqs.push(est);
      if (est > LIMIT) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `prompt is too long: ${est} tokens > ${LIMIT} maximum` } }));
      } else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end("event: done\ndata: {}\n\n");
      }
    });
  });
  const pStub = await listen(stub);
  const router = createRouter({
    routes: [{ match: "of-model", base_url: `http://127.0.0.1:${pStub}`, auth: "passthrough" }],
    // configured window deliberately too high (1M) — the stub's real limit is LIMIT
    compact: { enabled: true, safetyPct: 0.95, windowDefault: 1000000, window: {}, maxOverflowRetries: 2 },
  }, { log: () => {} });
  const port = await listen(router);

  const res = await post(port, { model: "of-model", stream: true, messages: convo });
  ok("overflow: request ultimately succeeds after hard-trim+retry", res.status === 200);
  ok("overflow: first attempt overflowed, at least one retry happened", reqs.length >= 2);
  ok("overflow: a retry sent a request that fit the real window", reqs[reqs.length - 1] <= LIMIT);
  ok("overflow: real window learned + persisted", (() => {
    const p = path.join(process.env.MODELPIPE_DIR, "compact-learned-windows.json");
    if (!fs.existsSync(p)) return false;
    const w = JSON.parse(fs.readFileSync(p, "utf8"));
    return w["of-model"] === LIMIT;
  })());
  await close(router); await close(stub);
})();

// ===== 3. PRE-ROUTE DOWNSHIFT (a FRESH request landing on an ALREADY-shifted step) =====
// Unlike case 1 (the request that TRIGGERS the shift, mid-request, inside makeResponseHandler's
// reroute), this drives a request that arrives AFTER the ladder already sits on the small-window
// step — forward() pre-routes it straight there before ever touching makeResponseHandler. It
// still gets trimmed because dispatch() is the SOLE send choke-point (forward()'s tail calls it
// for the primary hop too) — this pins that down as a regression guard.
await (async () => {
  const smallReqs = [];
  const stubSmall = http.createServer((req, res) => { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => { smallReqs.push(Buffer.concat(c).toString("utf8")); res.writeHead(200, { "content-type": "text/event-stream" }); res.end("event: done\ndata: {}\n\n"); }); });
  const pSmall = await listen(stubSmall);

  const router = createRouter({
    routes: [{ match: "small-model", base_url: `http://127.0.0.1:${pSmall}`, auth: "passthrough" }],
    profiles: { primary: { bind: {} }, small: { bind: { "big-model": "small-model" } } },
    auto: { steps: [{ profile: "primary" }, { profile: "small", when: "limit" }] },
    compact: { enabled: true, safetyPct: 0.95, windowDefault: 1000000, window: { "big-model": 1000000, "small-model": 200 }, maxOverflowRetries: 2 },
  }, { log: () => {} });
  const port = await listen(router);

  // Force the ladder onto the "small" step WITHOUT going through a live failover (simulates a
  // request arriving well after some earlier request already shifted it).
  router._modelpipe.profileState.offset = 1;
  router._modelpipe.profileState.shiftedAt = Date.now(); // inside the recovery backoff — no live re-probe

  const res = await post(port, { model: "big-model", stream: true, messages: convo });
  ok("pre-route downshift: request succeeds", res.status === 200);
  ok("pre-route downshift: pre-routed straight to the backup", smallReqs.length === 1);
  if (smallReqs.length) {
    const got = JSON.parse(smallReqs[0]);
    ok("pre-route downshift: body trimmed to fit the small window", got.messages.length < convo.length);
  }
  await close(router); await close(stubSmall);
})();

if (fails.length) { console.error(`compact-integration: ${pass} passed, ${fails.length} FAILED:\n` + fails.join("\n")); process.exit(1); }
console.log(`compact-integration: all ${pass} checks passed`);
