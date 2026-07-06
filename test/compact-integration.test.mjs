// End-to-end compaction test: drives the REAL router over a socket. A single stub backend
// answers both the summarizer sub-call (internal, non-stream → returns a summary) and the
// main forwarded request (streamed → records the body that reached it). Proves the whole
// wiring: over-trigger detection → self-call summarizer → splice → compacted body forwarded.
// Run: node test/compact-integration.test.mjs

import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

process.env.MODELPIPE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "modelpipe-compact-it-"));
const { createRouter } = await import("../src/router.mjs");
const { SESSION_HEADER } = await import("../src/compact.mjs");

let pass = 0; const fails = [];
const ok = (name, cond) => { if (cond) pass++; else fails.push(`  ✗ ${name}`); };

function listen(server) { return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))); }
function close(server) { return new Promise((r) => server.close(r)); }

// Stub backend: internal summarizer call → JSON summary; main call → streamed, body recorded.
const mainReqs = [], internalReqs = [];
const stub = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    if (req.headers["x-modelpipe-internal"]) {
      internalReqs.push({ body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "sum", type: "message", role: "assistant", content: [{ type: "text", text: "SUMMARY-OK checkpoint" }] }));
    } else {
      mainReqs.push({ body });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("event: done\ndata: {}\n\n");
    }
  });
});

const stubPort = await listen(stub);

const config = {
  listen: { host: "127.0.0.1", port: 0 },
  routes: [{ match: "*", base_url: `http://127.0.0.1:${stubPort}`, auth: "passthrough" }],
  // tiny window so a modest history trips the 70% trigger
  compact: { enabled: true, triggerPct: 0.7, targetPct: 0.15, summaryMaxPct: 0.08, windowDefault: 2000, window: {}, summarizerModel: null },
};
const router = createRouter(config, { log: () => {} });
const routerPort = await listen(router);

// Build a history well over trigger (~1400 tok): several real user prompts + tool cycles.
const pad = (n) => "x".repeat(n);
const msgs = [];
for (let i = 0; i < 10; i++) {
  msgs.push({ role: "user", content: [{ type: "text", text: `step ${i} ` + pad(700) }] });
  msgs.push({ role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: `T${i}`, name: "Bash", input: {} }] });
  msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `T${i}`, content: "done" }] });
}
msgs.push({ role: "user", content: [{ type: "text", text: "final question " + pad(100) }] });

function post(port, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(bodyObj));
    const r = http.request({ host: "127.0.0.1", port, method: "POST", path: "/v1/messages", headers: { "content-type": "application/json", "content-length": payload.length, authorization: "Bearer test", ...headers } }, (res) => {
      const cs = []; res.on("data", (c) => cs.push(c)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(cs).toString("utf8") }));
    });
    r.on("error", reject); r.end(payload);
  });
}

const sid = "test-session-123";
const res1 = await post(routerPort, { [SESSION_HEADER]: sid }, { model: "deepseek-v4", stream: true, messages: msgs });

ok("main request succeeded", res1.status === 200);
ok("summarizer sub-call happened", internalReqs.length === 1);
ok("main request reached backend", mainReqs.length === 1);

const forwarded = mainReqs.length ? JSON.parse(mainReqs[0].body) : { messages: [] };
ok("forwarded body carries the summary", JSON.stringify(forwarded.messages).includes("SUMMARY-OK"));
ok("forwarded body is shorter than the input", forwarded.messages.length < msgs.length);
ok("summary cached for the session", fs.existsSync(path.join(process.env.MODELPIPE_DIR, `compact-${sid}.json`)));

// Second identical request → cache reuse, NO second summarizer call.
const res2 = await post(routerPort, { [SESSION_HEADER]: sid }, { model: "deepseek-v4", stream: true, messages: msgs });
ok("second request succeeded", res2.status === 200);
ok("no extra summarizer call on repeat (cache reused)", internalReqs.length === 1);
ok("second main request also compacted", mainReqs.length === 2 && JSON.stringify(JSON.parse(mainReqs[1].body).messages).includes("SUMMARY-OK"));

// Small request under trigger → passthrough (no compaction, no summarizer).
const before = internalReqs.length;
const res3 = await post(routerPort, { [SESSION_HEADER]: "other" }, { model: "deepseek-v4", stream: true, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
ok("small request succeeded", res3.status === 200);
ok("small request not summarized", internalReqs.length === before);
const small = JSON.parse(mainReqs[mainReqs.length - 1].body);
ok("small request forwarded unchanged", small.messages.length === 1 && !JSON.stringify(small.messages).includes("SUMMARY-OK"));

await close(router); await close(stub);

if (fails.length) { console.error(`compact-integration: ${pass} passed, ${fails.length} FAILED:\n` + fails.join("\n")); process.exit(1); }
console.log(`compact-integration: all ${pass} checks passed`);
