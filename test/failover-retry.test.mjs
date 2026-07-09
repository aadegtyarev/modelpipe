// Self-test for SAME-TARGET RETRY before a failover hop (src/router.mjs, config.auto.retry)
// and for the dashboard trace carrying client/clientModel/errorMessage on ERROR rows too (not
// just successful ones) — a blip on one backend should be retried in place a configured number
// of times before account rotation / a profile step burns a hop, and every recorded row (success
// or error) should carry the full "who sent what, routed to what" trace plus a short human
// reason for a red row. Also covers isRetryWorthy: a HARD, long-duration exhaustion (weekly/
// monthly plan quota, a disabled org/account) must skip retry entirely, never delaying the
// actual fix (account rotation / a profile step) by re-hitting a backend that cannot recover
// until a reset date.
//
// Drives the real router http path against stub backends whose status is switchable at runtime.
//
// Run: node test/failover-retry.test.mjs

import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

process.env.MODELPIPE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "modelpipe-retry-test-"));

const { createRouter, validateConfig, isRetryWorthy } = await import("../src/router.mjs");

let pass = 0;
const fails = [];
function check(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
  fails.push(`  ✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}
function close(server) { return new Promise((resolve) => server.close(resolve)); }

// A stub whose status is switchable at runtime (setStatus) OR driven deterministically by call
// count (statusForCall: 1-based call index -> status), so a "fail N times then recover" sequence
// never races real wall-clock delays. Every call is recorded.
function makeStatusStub(initial = 429, message = "rate limit exceeded", statusForCall = null) {
  let status = initial;
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ body: Buffer.concat(chunks).toString("utf8"), headers: req.headers });
      const s = statusForCall ? statusForCall(received.length) : status;
      if (s >= 400) {
        res.writeHead(s, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message } }));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "ok", model: "x" }));
      }
    });
  });
  return { server, received, setStatus: (s) => { status = s; } };
}

function fire(port, model, headers = {}) {
  const data = Buffer.from(JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }));
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST",
        headers: { "content-type": "application/json", "content-length": data.length, ...headers } },
      (res) => { const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString("utf8") })); },
    );
    req.on("error", reject); req.write(data); req.end();
  });
}

async function main() {
  const keepAlive = setInterval(() => {}, 1000);
  process.env.RETRY_KEY = "retry-secret";
  process.env.RETRY_KEY_A = "acct-a-secret";
  process.env.RETRY_KEY_B = "acct-b-secret";

  // ── config validation ────────────────────────────────────────────────────────
  {
    check("auto.retry: valid { attempts: 2 } passes", (() => {
      try { validateConfig({ routes: [{ match: "*", base_url: "http://x", auth: "passthrough" }], profiles: { p: { bind: {} } }, auto: { steps: [{ profile: "p" }], retry: { attempts: 2, delayMs: 10 } } }); return "ok"; }
      catch (e) { return e.message; }
    })(), "ok");
    check("auto.retry.attempts: negative rejected", (() => {
      try { validateConfig({ routes: [{ match: "*", base_url: "http://x", auth: "passthrough" }], profiles: { p: { bind: {} } }, auto: { steps: [{ profile: "p" }], retry: { attempts: -1 } } }); return "no throw"; }
      catch (e) { return e.message.includes("attempts") ? "ok" : e.message; }
    })(), "ok");
    check("auto.retry.attempts: non-integer rejected", (() => {
      try { validateConfig({ routes: [{ match: "*", base_url: "http://x", auth: "passthrough" }], profiles: { p: { bind: {} } }, auto: { steps: [{ profile: "p" }], retry: { attempts: 1.5 } } }); return "no throw"; }
      catch (e) { return e.message.includes("attempts") ? "ok" : e.message; }
    })(), "ok");
    check("auto.retry.delayMs: negative rejected", (() => {
      try { validateConfig({ routes: [{ match: "*", base_url: "http://x", auth: "passthrough" }], profiles: { p: { bind: {} } }, auto: { steps: [{ profile: "p" }], retry: { attempts: 1, delayMs: -5 } } }); return "no throw"; }
      catch (e) { return e.message.includes("delayMs") ? "ok" : e.message; }
    })(), "ok");
  }

  // ── isRetryWorthy classification ─────────────────────────────────────────────
  {
    const j = (msg) => Buffer.from(JSON.stringify({ error: { message: msg } }));
    check("isRetryWorthy: plain rate limit (429) is retry-worthy", isRetryWorthy(429, j("rate limit exceeded, please try again later")), true);
    check("isRetryWorthy: overloaded (529) is retry-worthy", isRetryWorthy(529, j("overloaded")), true);
    check("isRetryWorthy: bare 5xx (no body needed) is retry-worthy", isRetryWorthy(503, j("")), true);
    check("isRetryWorthy: our own concurrency-queue-timeout synthetic 429 is retry-worthy", isRetryWorthy(429, j("modelpipe: backend concurrency limit reached and the request queue wait timed out")), true);
    check("isRetryWorthy: weekly/monthly plan exhaustion is NOT retry-worthy", isRetryWorthy(429, j("[1310][Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-07-13 07:43:56]")), false);
    check("isRetryWorthy: credit balance exhausted is NOT retry-worthy", isRetryWorthy(400, j("Your credit balance is too low to access the API")), false);
    check("isRetryWorthy: organization disabled is NOT retry-worthy", isRetryWorthy(400, j("This organization is disabled")), false);
  }

  // ── R1: attempts: 0 (default/omitted) — today's behaviour, no retry ─────────────
  {
    const stub = makeStatusStub(429);
    const sPort = await listen(stub.server);
    const router = createRouter({
      listen: { host: "127.0.0.1", port: 0 },
      routes: [{ match: "glm-*", base_url: `http://127.0.0.1:${sPort}`, auth: { header: "x-api-key", keyEnv: "RETRY_KEY" } }],
    });
    const rPort = await listen(router);
    try {
      const r = await fire(rPort, "glm-5.2");
      check("R1 no-retry-config: single attempt reaches the backend", stub.received.length, 1);
      check("R1 no-retry-config: 429 relayed straight to the client", r.status, 429);
    } finally { await close(router); await close(stub.server); }
  }

  // ── R2: attempts: 2 — a transient blip is retried in place, no config beyond auto.retry ──
  {
    // Fails calls 1-2, recovers on call 3 (== the 2nd and last retry) — deterministic, no timing.
    const stub = makeStatusStub(429, "rate limit exceeded", (n) => (n <= 2 ? 429 : 200));
    const sPort = await listen(stub.server);
    const router = createRouter({
      listen: { host: "127.0.0.1", port: 0 },
      auto: { retry: { attempts: 2, delayMs: 1 } },
      routes: [{ match: "glm-*", base_url: `http://127.0.0.1:${sPort}`, auth: { header: "x-api-key", keyEnv: "RETRY_KEY" } }],
    });
    const rPort = await listen(router);
    try {
      const r = await fire(rPort, "glm-5.2");
      check("R2 retry: eventually succeeds (200) without exhausting to the client", r.status, 200);
      check("R2 retry: exactly 1 initial + 2 retries reached the backend", stub.received.length, 3);
    } finally { await close(router); await close(stub.server); }
  }

  // ── R2b: retry configured, but the error is a HARD weekly/monthly exhaustion — must NOT
  // retry (isRetryWorthy gates it), relays immediately on the very first hit ──
  {
    const stub = makeStatusStub(429, "[1310][Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-07-13 07:43:56]");
    const sPort = await listen(stub.server);
    const router = createRouter({
      listen: { host: "127.0.0.1", port: 0 },
      auto: { retry: { attempts: 3, delayMs: 1 } },
      routes: [{ match: "glm-*", base_url: `http://127.0.0.1:${sPort}`, auth: { header: "x-api-key", keyEnv: "RETRY_KEY" } }],
    });
    const rPort = await listen(router);
    try {
      const r = await fire(rPort, "glm-5.2");
      check("R2b hard-exhaustion: NOT retried despite attempts:3 configured", stub.received.length, 1);
      check("R2b hard-exhaustion: 429 relayed straight to the client", r.status, 429);
    } finally { await close(router); await close(stub.server); }
  }

  // ── R3: attempts exhausted on a persistently-429 backend still relays the error honestly ──
  {
    const stub = makeStatusStub(429);
    const sPort = await listen(stub.server);
    const router = createRouter({
      listen: { host: "127.0.0.1", port: 0 },
      auto: { retry: { attempts: 2, delayMs: 1 } },
      routes: [{ match: "glm-*", base_url: `http://127.0.0.1:${sPort}`, auth: { header: "x-api-key", keyEnv: "RETRY_KEY" } }],
    });
    const rPort = await listen(router);
    try {
      const r = await fire(rPort, "glm-5.2");
      check("R3 exhausted: 1 initial + 2 retries = 3 backend hits", stub.received.length, 3);
      check("R3 exhausted: 429 relayed to the client", r.status, 429);
    } finally { await close(router); await close(stub.server); }
  }

  // ── R4: retryCount resets on a NEW target — account rotation gets its OWN full budget ──
  {
    const stubA = makeStatusStub(429); // always fails
    // Deterministic: fails its 1st hit, recovers on its 2nd (== its own retry) — proves the
    // retry budget wasn't already burned by A before B was ever reached.
    const stubB = makeStatusStub(429, "rate limit exceeded", (n) => (n <= 1 ? 429 : 200));
    const portA = await listen(stubA.server);
    const portB = await listen(stubB.server);
    const router = createRouter({
      listen: { host: "127.0.0.1", port: 0 },
      auto: { retry: { attempts: 1, delayMs: 1 } },
      routes: [{
        match: "glm-*", strategy: "failover",
        base_url: `http://127.0.0.1:${portA}`, // unused default; accounts carry their own base_url
        accounts: [
          { label: "A", base_url: `http://127.0.0.1:${portA}`, auth: { header: "x-api-key", keyEnv: "RETRY_KEY_A" } },
          { label: "B", base_url: `http://127.0.0.1:${portB}`, auth: { header: "x-api-key", keyEnv: "RETRY_KEY_B" } },
        ],
      }],
    });
    const rPort = await listen(router);
    try {
      const r = await fire(rPort, "glm-5.2");
      check("R4 reset-on-rotation: A tried initial+retry (2 hits) before rotating away", stubA.received.length, 2);
      check("R4 reset-on-rotation: B got its OWN retry budget (2 hits, not starved)", stubB.received.length, 2);
      check("R4 reset-on-rotation: request eventually succeeds via B", r.status, 200);
    } finally { await close(router); await close(stubA.server); await close(stubB.server); }
  }

  // ── R4b: round-robin pool — retry must NOT advance pool.rr (that would silently make a
  // "retry same target" into a hop to the OTHER account, breaking round-robin's own rotation
  // for every request AFTER the retried one too). ──
  {
    // A fails its 1st hit, recovers on its retry (2nd hit) — so the ORIGINAL request never
    // even needs B. B must stay untouched for the duration of the retried request.
    const stubA = makeStatusStub(429, "rate limit exceeded", (n) => (n <= 1 ? 429 : 200));
    const stubB = makeStatusStub(200);
    const portA = await listen(stubA.server);
    const portB = await listen(stubB.server);
    const router = createRouter({
      listen: { host: "127.0.0.1", port: 0 },
      auto: { retry: { attempts: 1, delayMs: 1 } },
      routes: [{
        match: "glm-*", strategy: "round-robin",
        base_url: `http://127.0.0.1:${portA}`,
        accounts: [
          { label: "A", base_url: `http://127.0.0.1:${portA}`, auth: { header: "x-api-key", keyEnv: "RETRY_KEY_A" } },
          { label: "B", base_url: `http://127.0.0.1:${portB}`, auth: { header: "x-api-key", keyEnv: "RETRY_KEY_B" } },
        ],
      }],
    });
    const rPort = await listen(router);
    try {
      const r = await fire(rPort, "glm-5.2");
      check("R4b round-robin: retry stayed on A, never touched B", stubB.received.length, 0);
      check("R4b round-robin: A got initial + its own retry (2 hits)", stubA.received.length, 2);
      check("R4b round-robin: request succeeds via A's retry", r.status, 200);
    } finally { await close(router); await close(stubA.server); await close(stubB.server); }
  }

  // ── R5: dashboard trace on an error row carries client/clientModel/errorMessage ──
  {
    const stub = makeStatusStub(429, "you have hit the rate limit, please slow down");
    const sPort = await listen(stub.server);
    const router = createRouter({
      listen: { host: "127.0.0.1", port: 0 },
      dashboard: true,
      // A trivial profile chain so this 429 is a failover candidate at all (gets buffered +
      // classified, same as any real deployment with profiles/auto configured) — with no
      // step to advance to, it falls through to a plain honest relay(), which is exactly the
      // path being tested for a properly-populated trace.
      profiles: { native: { bind: {} } },
      defaultProfile: "native",
      auto: { steps: [{ profile: "native" }] },
      routes: [{ match: "glm-*", base_url: `http://127.0.0.1:${sPort}`, auth: { header: "x-api-key", keyEnv: "RETRY_KEY" } }],
    });
    const rPort = await listen(router);
    try {
      await fire(rPort, "glm-5.2", { "user-agent": "claude-cli/9.9.9" });
      const snap = router._modelpipe.stats.snapshot();
      const row = snap.timeline[snap.timeline.length - 1];
      check("R5 error row: status recorded", row.status, 429);
      check("R5 error row: clientModel recorded (was sent as-is)", row.clientModel, "glm-5.2");
      check("R5 error row: client (who) recorded, not blank", typeof row.client === "string" && row.client.startsWith("claude-cli/9.9.9"), true);
      check("R5 error row: human-readable errorMessage recorded", row.errorMessage, "you have hit the rate limit, please slow down");
    } finally { await close(router); await close(stub.server); }
  }

  clearInterval(keepAlive);
  if (fails.length) {
    console.log("MODELPIPE FAILOVER-RETRY SELF-TEST:");
    fails.forEach((f) => console.log(f));
    console.log(`\nFAIL — ${fails.length} case(s) failed`);
    process.exit(1);
  }
  console.log(`failover-retry.test: all ${pass} checks passed`);
}

main().catch((err) => {
  console.log(`FAIL — unexpected error: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
