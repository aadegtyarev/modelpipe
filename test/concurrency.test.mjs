// Self-test for the per-backend concurrency limiter (src/concurrency.mjs) and its wiring
// into the router (src/router.mjs). Two halves:
//   1. UNIT — the ConcurrencyLimiter semaphore + resolveConcurrencyLimit, in isolation.
//   2. INTEGRATION — real localhost stub backends driven through the real router http path,
//      proving the gate caps simultaneous in-flight requests, queues the overflow, and on a
//      queue-wait timeout falls through to model failover.
//
// NO network, NO real keys. Hermetic: MODELPIPE_DIR points at a throwaway temp dir (set
// BEFORE importing router.mjs) so the dashboard endpoints that persist overrides never touch
// the real ~/.modelpipe.
//
// Run: node test/concurrency.test.mjs

import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

process.env.MODELPIPE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "modelpipe-conc-test-"));

const { ConcurrencyLimiter, resolveConcurrencyLimit } = await import("../src/concurrency.mjs");
const { createRouter } = await import("../src/router.mjs");

let pass = 0;
const fails = [];
function check(name, got, want) {
  if (got === want) { pass++; return; }
  fails.push(`  ✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function waitFor(fn, { timeout = 3000, interval = 5 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const t = setInterval(() => {
      let ok = false;
      try { ok = fn(); } catch { ok = false; }
      if (ok) { clearInterval(t); resolve(); }
      else if (Date.now() - start > timeout) { clearInterval(t); reject(new Error("waitFor timeout")); }
    }, interval);
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}
function close(server) { return new Promise((resolve) => server.close(resolve)); }

// A backend stub that tracks how many requests are simultaneously in flight (measured from the
// moment the full request is received to the moment we answer) and holds each request open
// until released — so a test can freeze N requests at the backend and assert the gate parked
// the rest. `auto` mode answers immediately (for the always-live failover target).
function makeGatedStub() {
  let inFlight = 0, peak = 0, auto = false;
  const received = [];
  const pending = []; // deferred finishers, one per held request
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ url: req.url, body: Buffer.concat(chunks).toString("utf8") });
      inFlight++; if (inFlight > peak) peak = inFlight;
      const finish = () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end("chunk");
        inFlight--;
      };
      if (auto) finish(); else pending.push(finish);
    });
  });
  return {
    server, received,
    get inFlight() { return inFlight; },
    get peak() { return peak; },
    releaseAll() { while (pending.length) pending.shift()(); },
    setAuto(v) { auto = v; },
  };
}

// Fire a POST /v1/messages through the router without awaiting — returns the pending promise.
function fire(port, model) {
  const data = Buffer.from(JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }));
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST",
        headers: { "content-type": "application/json", "content-length": data.length } },
      (res) => { const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString("utf8") })); },
    );
    req.on("error", reject); req.write(data); req.end();
  });
}
function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: urlPath, method: "GET" },
      (res) => { const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString("utf8") })); });
    req.on("error", reject); req.end();
  });
}
function postJson(port, urlPath, obj) {
  const data = Buffer.from(JSON.stringify(obj));
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: urlPath, method: "POST",
      headers: { "content-type": "application/json", "content-length": data.length } },
      (res) => { const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString("utf8") })); });
    req.on("error", reject); req.write(data); req.end();
  });
}

async function main() {
  // Pin the event loop alive for the whole run. The pure-limiter unit blocks have stretches
  // that are all microtasks with no ref'd handle in between, so node can otherwise decide the
  // loop is idle and exit mid-run before an awaited release resolves. Cleared before summary.
  const keepAlive = setInterval(() => {}, 1000);
  // ── UNIT: resolveConcurrencyLimit ─────────────────────────────────────────
  {
    const map = { "glm-5.2": 3, "glm-*": 8 };
    check("resolve: specific id wins (first match)", resolveConcurrencyLimit(map, "glm-5.2"), 3);
    check("resolve: broad glob for other glm", resolveConcurrencyLimit(map, "glm-4.5-air"), 8);
    check("resolve: unmatched → Infinity", resolveConcurrencyLimit(map, "claude-opus-4-8"), Infinity);
    check("resolve: no map → Infinity", resolveConcurrencyLimit(undefined, "glm-5.2"), Infinity);
    check("resolve: non-string model → Infinity", resolveConcurrencyLimit(map, null), Infinity);
  }

  // ── UNIT: ConcurrencyLimiter admission + queueing ─────────────────────────
  {
    const lim = new ConcurrencyLimiter();
    const r1 = await lim.acquire("k", 2);
    const r2 = await lim.acquire("k", 2);
    check("limiter: two acquires under limit both resolve", typeof r1 === "function" && typeof r2 === "function", true);
    let third = "pending";
    const p3 = lim.acquire("k", 2).then((rel) => { third = "resolved"; return rel; });
    await sleep(20);
    check("limiter: third acquire over limit stays pending", third, "pending");
    check("limiter: snapshot reports active+queued", JSON.stringify(lim.snapshot()[0]), JSON.stringify({ key: "k", active: 2, limit: 2, effLimit: 2, queued: 1 }));
    r1(); // free one → the waiter is admitted
    const r3 = await p3;
    check("limiter: releasing one admits the queued waiter", third, "resolved");
    r2(); r3();
    check("limiter: fully drained key is dropped from state", lim.snapshot().length, 0);
  }

  // ── UNIT: empirical self-throttle (reportLimitHit / recoverDue) ───────────
  {
    const lim = new ConcurrencyLimiter();
    const r1 = await lim.acquire("g", 2);
    const r2 = await lim.acquire("g", 2);
    check("throttle: 2 acquires under limit=2 both admitted", typeof r1 === "function" && typeof r2 === "function", true);
    let third = "pending";
    const p3 = lim.acquire("g", 2).then(() => { third = "resolved"; });
    await sleep(20);
    check("throttle: 3rd over configured limit queues (baseline, no hit yet)", third, "pending");

    lim.reportLimitHit("g"); // effLimit 2 -> 1
    check("throttle: a hit lowers effLimit by 1", lim.snapshot().find((s) => s.key === "g").effLimit, 1);
    check("throttle: reportLimitHit is a no-op for a key never acquired", (() => { lim.reportLimitHit("never-touched"); return lim.snapshot().find((s) => s.key === "never-touched"); })(), undefined);

    r1(); // active 2 -> 1; still >= the now-lowered effLimit(1) — the 3rd stays queued
    await sleep(20);
    check("throttle: releasing one does NOT admit the 3rd (learned ceiling already reached)", third, "pending");

    // Repeated hits floor at 1, never fully block a model.
    lim.reportLimitHit("g"); lim.reportLimitHit("g"); lim.reportLimitHit("g");
    check("throttle: repeated hits floor the ceiling at 1 (never 0)", lim.snapshot().find((s) => s.key === "g").effLimit, 1);

    // Not due yet: recovering immediately after the last hit must NOT bump.
    lim.recoverDue(Date.now(), 60000);
    check("throttle: recoverDue is a no-op before the interval elapses", lim.snapshot().find((s) => s.key === "g").effLimit, 1);
    check("throttle: still not admitted before recovery", third, "pending");

    // Recovery: quiet past the interval creeps the ceiling back up by 1 (1 -> 2), crossing
    // above the current active count (1) — admitting the queued 3rd waiter.
    lim.recoverDue(Date.now() + 100000, 60000);
    check("throttle: recoverDue creeps effLimit up by 1 toward configured", lim.snapshot().find((s) => s.key === "g").effLimit, 2);
    await p3;
    check("throttle: the higher ceiling admitted the queued 3rd waiter", third, "resolved");

    r2();
    // recoverDue never lifts the ceiling past the CONFIGURED limit (still 2 here).
    lim.recoverDue(Date.now() + 999999, 60000);
    lim.recoverDue(Date.now() + 1999999, 60000);
    check("throttle: recoverDue never exceeds the configured limit", lim.snapshot().find((s) => s.key === "g").effLimit, 2);

    // reportLimitHit on a key with NO live state (the common real case: the request that just
    // hit the limit already released its own slot before the response handler ran, so the key
    // may have gone fully idle and been dropped) must MATERIALIZE a fresh entry at
    // configuredLimit - 1, not silently no-op.
    check("throttle: a hit on an idle/absent key with a configuredLimit creates it pre-lowered", (() => {
      lim.reportLimitHit("fresh-key", 4);
      return lim.snapshot().find((s) => s.key === "fresh-key")?.effLimit;
    })(), 3);
    check("throttle: NO configuredLimit on an absent key stays a true no-op", (() => {
      lim.reportLimitHit("still-absent"); // no 2nd arg
      return lim.snapshot().find((s) => s.key === "still-absent");
    })(), undefined);
    check("throttle: an unlimited (Infinity) configuredLimit on an absent key is a no-op", (() => {
      lim.reportLimitHit("unlimited-key", Infinity);
      return lim.snapshot().find((s) => s.key === "unlimited-key");
    })(), undefined);
  }

  // ── UNIT: unlimited (Infinity / <=0) is a synchronous no-op ────────────────
  {
    const lim = new ConcurrencyLimiter();
    const rel = await lim.acquire("k", Infinity);
    check("limiter: Infinity limit → immediate release fn", typeof rel, "function");
    check("limiter: unlimited holds no state", lim.snapshot().length, 0);
    rel(); // no-op, must not throw
  }

  // ── UNIT: idempotent release ──────────────────────────────────────────────
  {
    const lim = new ConcurrencyLimiter();
    const a = await lim.acquire("k", 1);
    let admitted = false;
    lim.acquire("k", 1).then(() => { admitted = true; });
    a(); a(); a(); // double/triple release must free exactly ONE slot
    await sleep(20);
    check("limiter: idempotent release admits exactly one waiter", admitted, true);
    check("limiter: no over-release (active stays sane)", lim.snapshot()[0]?.active, 1);
  }

  // ── UNIT: queue-wait timeout rejects with QUEUE_TIMEOUT ────────────────────
  {
    const lim = new ConcurrencyLimiter();
    const held = await lim.acquire("k", 1);
    let code = null;
    await lim.acquire("k", 1, 30).catch((e) => { code = e.code; });
    check("limiter: over-limit waiter times out with QUEUE_TIMEOUT", code, "QUEUE_TIMEOUT");
    check("limiter: timed-out waiter left no queued state", lim.snapshot()[0]?.queued, 0);
    held();
  }

  // ── UNIT: a runtime-lowered limit is respected on drain ────────────────────
  {
    const lim = new ConcurrencyLimiter();
    const a = await lim.acquire("k", 2);
    const b = await lim.acquire("k", 2);
    let admitted = 0;
    lim.acquire("k", 1).then(() => { admitted++; }); // limit now lowered to 1
    a(); // active 2→1, still not under the new limit of 1 → waiter stays parked
    await sleep(20);
    check("limiter: lowered limit blocks admit while still at capacity", admitted, 0);
    b(); // active 1→0, now under limit 1 → admit
    await sleep(20);
    check("limiter: waiter admitted once active drops below lowered limit", admitted, 1);
  }

  // ── INTEGRATION: the gate caps simultaneous in-flight requests ─────────────
  {
    process.env.CONC_KEY = "x";
    const stub = makeGatedStub();
    const sPort = await listen(stub.server);
    const router = createRouter({
      listen: { host: "127.0.0.1", port: 0 },
      concurrency: { "glm-5.2": 2 },
      routes: [{ match: "glm-*", base_url: `http://127.0.0.1:${sPort}`, auth: { header: "x-api-key", keyEnv: "CONC_KEY" } }],
    });
    const rPort = await listen(router);
    try {
      const inflight = [fire(rPort, "glm-5.2"), fire(rPort, "glm-5.2"), fire(rPort, "glm-5.2"), fire(rPort, "glm-5.2")];
      // Exactly 2 should reach the backend; the other 2 are parked in the limiter queue.
      await waitFor(() => stub.inFlight === 2);
      await sleep(40); // give any (wrongly) ungated request time to slip through
      check("gate: caps backend in-flight at the configured limit", stub.inFlight, 2);
      stub.setAuto(true); stub.releaseAll(); // drain the held 2; the queued 2 then flow through
      const results = await Promise.all(inflight);
      check("gate: all queued requests eventually complete", results.every((r) => r.status === 200), true);
      check("gate: backend concurrency never exceeded the limit", stub.peak, 2);
      check("gate: every request actually reached the backend", stub.received.length, 4);
    } finally {
      delete process.env.CONC_KEY;
      await close(router); await close(stub.server);
    }
  }

  // ── INTEGRATION: no configured limit ⇒ no gating (all concurrent) ──────────
  {
    process.env.CONC_KEY = "x";
    const stub = makeGatedStub();
    const sPort = await listen(stub.server);
    const router = createRouter({
      listen: { host: "127.0.0.1", port: 0 },
      routes: [{ match: "glm-*", base_url: `http://127.0.0.1:${sPort}`, auth: { header: "x-api-key", keyEnv: "CONC_KEY" } }],
    });
    const rPort = await listen(router);
    try {
      const inflight = [fire(rPort, "glm-5.2"), fire(rPort, "glm-5.2"), fire(rPort, "glm-5.2")];
      await waitFor(() => stub.inFlight === 3); // all three reach the backend at once — ungated
      check("no-limit: all requests run concurrently (no queue)", stub.inFlight, 3);
      stub.setAuto(true); stub.releaseAll();
      await Promise.all(inflight);
    } finally {
      delete process.env.CONC_KEY;
      await close(router); await close(stub.server);
    }
  }

  // ── INTEGRATION: queue-wait timeout does NOT jump models — it relays a 429 ──
  // A queue-timeout synthetic 429 is a TRANSIENT over-parallelism signal (we sent more than the
  // backend serves at once), never a provider outage. It must NOT step the profile ladder to a
  // weaker model — the request that couldn't get a slot in time is relayed as an honest 429 to the
  // client (which is free to retry), and the backup is left untouched. This is the core contract:
  // over-parallelism queues (and, on timeout, 429s) — it never bounces the caller to a lesser model.
  {
    process.env.CONC_KEY = "x";
    const primary = makeGatedStub();   // glm-5.2 — held, so the 2nd request must wait then time out
    const backup = makeGatedStub();    // deepseek — would-be failover target; must stay untouched
    backup.setAuto(true);
    const pPort = await listen(primary.server);
    const bPort = await listen(backup.server);
    const router = createRouter({
      listen: { host: "127.0.0.1", port: 0 },
      concurrency: { "glm-5.2": 1 },
      concurrencyQueueTimeoutMs: 1000, // the validated floor — short enough to keep the test quick
      profiles: { native: { bind: {} }, backup: { bind: { "glm-5.2": "deepseek-v4-pro" } } },
      auto: { steps: [{ profile: "native" }, { profile: "backup", when: "limit" }] },
      routes: [
        { match: "glm-*", base_url: `http://127.0.0.1:${pPort}`, auth: { header: "x-api-key", keyEnv: "CONC_KEY" } },
        { match: "deepseek-*", base_url: `http://127.0.0.1:${bPort}`, auth: { header: "x-api-key", keyEnv: "CONC_KEY" } },
      ],
    });
    const rPort = await listen(router);
    try {
      const first = fire(rPort, "glm-5.2");         // takes the single slot, held open at the primary
      await waitFor(() => primary.inFlight === 1);
      const second = fire(rPort, "glm-5.2");        // queues, waits ~1s, times out → relayed 429 (no jump)
      const r2 = await second;
      check("timeout-no-jump: queued request relays a 429 (never a model jump)", r2.status, 429);
      check("timeout-no-jump: backup was NOT hit (no downshift to a weaker model)", backup.received.length, 0);
      check("timeout-no-jump: primary still holds only the first request", primary.inFlight, 1);
      check("timeout-no-jump: profile offset stays 0 (no shift)", router._modelpipe.profileState.offset, 0);
      primary.setAuto(true); primary.releaseAll();
      await first;
    } finally {
      delete process.env.CONC_KEY;
      await close(router); await close(primary.server); await close(backup.server);
    }
  }

  // ── INTEGRATION: empirical self-throttle (reportLimitHit / recoverDue wired into the router) ─
  // A stub whose status is driven by call count (1-based) — deterministic, no timing races.
  function makeCountingStub(statusForCall, message = "rate limit exceeded") {
    const received = [];
    const server = http.createServer((req, res) => {
      const c = []; req.on("data", (x) => c.push(x));
      req.on("end", () => {
        received.push(Buffer.concat(c).toString("utf8"));
        const s = statusForCall(received.length);
        if (s >= 400) { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message } })); }
        else { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "ok" })); }
      });
    });
    return { server, received };
  }

  // A) a transient 429 requeues through the SAME limiter (never relayed to the client) and
  // learns a lower ceiling — the request eventually succeeds once the backend recovers.
  {
    process.env.CONC_KEY = "x";
    const stub = makeCountingStub((n) => (n <= 1 ? 429 : 200)); // fails once, then recovers
    const sPort = await listen(stub.server);
    const router = createRouter({
      listen: { host: "127.0.0.1", port: 0 },
      concurrency: { "glm-5.2": 3 },
      routes: [{ match: "glm-*", base_url: `http://127.0.0.1:${sPort}`, auth: { header: "x-api-key", keyEnv: "CONC_KEY" } }],
    });
    const rPort = await listen(router);
    try {
      const r = await fire(rPort, "glm-5.2");
      check("self-throttle: request eventually succeeds (200), never relayed as an error", r.status, 200);
      check("self-throttle: backend hit twice (initial 429 + requeued retry)", stub.received.length, 2);
      const snap = router._modelpipe.limiter.snapshot();
      check("self-throttle: the hit learned a lower ceiling for this key", snap.length > 0 && snap[0].effLimit < snap[0].limit, true);
    } finally { delete process.env.CONC_KEY; await close(router); await close(stub.server); }
  }

  // B) a HARD weekly/monthly exhaustion on a concurrency-limited route must NOT requeue —
  // isRetryWorthy excludes it, so it's relayed straight through on the very first hit.
  {
    process.env.CONC_KEY = "x";
    const stub = makeCountingStub(() => 429, "[1310][Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-07-13 07:43:56]");
    const sPort = await listen(stub.server);
    const router = createRouter({
      listen: { host: "127.0.0.1", port: 0 },
      concurrency: { "glm-5.2": 3 },
      routes: [{ match: "glm-*", base_url: `http://127.0.0.1:${sPort}`, auth: { header: "x-api-key", keyEnv: "CONC_KEY" } }],
    });
    const rPort = await listen(router);
    try {
      const r = await fire(rPort, "glm-5.2");
      check("self-throttle: hard exhaustion is NOT requeued (single hit)", stub.received.length, 1);
      check("self-throttle: hard exhaustion relays 429 straight to the client", r.status, 429);
    } finally { delete process.env.CONC_KEY; await close(router); await close(stub.server); }
  }

  // C) a PERSISTENTLY 429 backend exhausts the requeue budget, then relays an honest 429 —
  // a transient rate-limit is over-parallelism, NOT a reason to jump to a weaker model. Even when
  // it never recovers, the request is capped at the requeue budget and the caller gets a 429 to
  // retry on its own terms; the profile ladder is NOT stepped and the backup stays untouched.
  {
    process.env.CONC_KEY = "x";
    const primary = makeCountingStub(() => 429); // never recovers
    const backup = makeGatedStub(); backup.setAuto(true); // would-be failover target; must stay untouched
    const pPort = await listen(primary.server);
    const bPort = await listen(backup.server);
    const router = createRouter({
      listen: { host: "127.0.0.1", port: 0 },
      concurrency: { "glm-5.2": 3 },
      profiles: { native: { bind: {} }, backup: { bind: { "glm-5.2": "deepseek-v4-pro" } } },
      auto: { steps: [{ profile: "native" }, { profile: "backup", when: "limit" }] },
      routes: [
        { match: "glm-*", base_url: `http://127.0.0.1:${pPort}`, auth: { header: "x-api-key", keyEnv: "CONC_KEY" } },
        { match: "deepseek-*", base_url: `http://127.0.0.1:${bPort}`, auth: { header: "x-api-key", keyEnv: "CONC_KEY" } },
      ],
    });
    const rPort = await listen(router);
    // Fresh chain state — a PRIOR block in this shared-MODELPIPE_DIR file may have persisted a
    // shifted profile-state.json under the same step names, which would otherwise pre-route
    // straight to the backup and never touch primary at all.
    router._modelpipe.profileState.offset = 0;
    router._modelpipe.profileState.shiftedAt = 0;
    try {
      const r = await fire(rPort, "glm-5.2");
      check("self-throttle exhausted: requeue budget capped (1 initial + MAX attempts)", primary.received.length, 1 + 3);
      check("self-throttle exhausted: relays an honest 429 (no jump to a weaker model)", r.status, 429);
      check("self-throttle exhausted: backup was NOT hit (no model jump)", backup.received.length, 0);
      check("self-throttle exhausted: profile offset stays 0 (no shift)", router._modelpipe.profileState.offset, 0);
    } finally { delete process.env.CONC_KEY; await close(router); await close(primary.server); await close(backup.server); }
  }

  // ── INTEGRATION: account pool — each key carries its OWN concurrency budget ─
  {
    process.env.CONC_A = "a"; process.env.CONC_B = "b";
    const stub = makeGatedStub(); // both accounts point here; keys differ by account LABEL
    const sPort = await listen(stub.server);
    const router = createRouter({
      listen: { host: "127.0.0.1", port: 0 },
      concurrency: { "glm-5.2": 1 }, // 1 per account ⇒ a 2-account pool carries 2 at once
      routes: [{
        match: "glm-*", base_url: `http://127.0.0.1:${sPort}`, strategy: "round-robin",
        accounts: [
          { label: "acctA", auth: { header: "x-api-key", keyEnv: "CONC_A" } },
          { label: "acctB", auth: { header: "x-api-key", keyEnv: "CONC_B" } },
        ],
      }],
    });
    const rPort = await listen(router);
    try {
      const inflight = [fire(rPort, "glm-5.2"), fire(rPort, "glm-5.2")]; // round-robin → one per account
      await waitFor(() => stub.inFlight === 2); // both run at once: per-account budget, not global
      check("pool: per-account budget lets the pool exceed a single key's limit", stub.inFlight, 2);
      stub.setAuto(true); stub.releaseAll();
      await Promise.all(inflight);
    } finally {
      delete process.env.CONC_A; delete process.env.CONC_B;
      await close(router); await close(stub.server);
    }
  }

  // ── INTEGRATION: runtime GET/POST /v1/concurrency (edit + persist) ─────────
  {
    process.env.CONC_KEY = "x";
    const stub = makeGatedStub(); stub.setAuto(true);
    const sPort = await listen(stub.server);
    const router = createRouter({
      listen: { host: "127.0.0.1", port: 0 }, dashboard: true,
      routes: [{ match: "glm-*", base_url: `http://127.0.0.1:${sPort}`, auth: { header: "x-api-key", keyEnv: "CONC_KEY" } }],
    });
    const rPort = await listen(router);
    try {
      const before = JSON.parse((await get(rPort, "/v1/concurrency")).body);
      check("endpoint: GET starts with no configured limits", JSON.stringify(before.config), "{}");
      check("endpoint: GET reports the default queue timeout", before.queueTimeoutMs, 45000);
      const ok = await postJson(rPort, "/v1/concurrency", { "glm-5.2": 3, queueTimeoutMs: 5000 });
      check("endpoint: POST accepts a valid limit map", ok.status, 200);
      const after = JSON.parse((await get(rPort, "/v1/concurrency")).body);
      check("endpoint: POST is reflected in GET config", after.config["glm-5.2"], 3);
      check("endpoint: POST updates the queue timeout", after.queueTimeoutMs, 5000);
      const bad = await postJson(rPort, "/v1/concurrency", { "glm-5.2": 0 });
      check("endpoint: POST rejects a non-positive limit", bad.status, 400);
      const bad2 = await postJson(rPort, "/v1/concurrency", { "glm-5.2": 2.5 });
      check("endpoint: POST rejects a non-integer limit", bad2.status, 400);
    } finally {
      delete process.env.CONC_KEY;
      await close(router); await close(stub.server);
    }
  }

  // ── validateConfig rejects malformed concurrency config ────────────────────
  {
    const { validateConfig } = await import("../src/router.mjs");
    const base = { routes: [{ match: "glm-*", base_url: "http://x", auth: "passthrough" }] };
    const rejects = (name, cfg) => {
      let threw = false;
      try { validateConfig({ ...base, ...cfg }); } catch { threw = true; }
      check(name, threw, true);
    };
    rejects("validate: concurrency array is rejected", { concurrency: [1, 2] });
    rejects("validate: non-integer limit is rejected", { concurrency: { "glm-*": 1.5 } });
    rejects("validate: zero limit is rejected", { concurrency: { "glm-*": 0 } });
    rejects("validate: queue timeout below floor is rejected", { concurrencyQueueTimeoutMs: 500 });
    let ok = true;
    try { validateConfig({ ...base, concurrency: { "glm-5.2": 3, "glm-*": 8 }, concurrencyQueueTimeoutMs: 60000 }); } catch { ok = false; }
    check("validate: a well-formed concurrency block passes", ok, true);
  }

  clearInterval(keepAlive);
  if (fails.length) {
    console.log("MODELPIPE CONCURRENCY SELF-TEST:");
    fails.forEach((f) => console.log(f));
    console.log(`\nFAIL — ${fails.length} case(s) failed`);
    process.exit(1);
  }
  console.log(`concurrency.test: all ${pass} checks passed`);
}

main().catch((err) => {
  console.log(`FAIL — unexpected error: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
