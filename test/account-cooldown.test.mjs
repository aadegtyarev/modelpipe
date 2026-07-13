// Self-test for PROGRESSIVE account-pool cooldown (src/router.mjs). When an account in a pool
// hits a rate-limit it is parked; the park now climbs the SAME 1→5→10-min ladder
// (failoverRecoveryBackoffMs) that model failover rides, instead of a flat 60s — and resets to
// the first rung the moment the account serves a request cleanly again.
//
// Drives the real router http path against a stub that answers 429 (then 200 for recovery),
// inspecting the live pool state via server._modelpipe.accountPools. Time is not mocked — we
// simulate an elapsed cooldown by zeroing exhaustedUntil (leaving attempts) between requests,
// which is exactly what the passive recovery does when the wall clock advances.
//
// Run: node test/account-cooldown.test.mjs

import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

process.env.MODELPIPE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "modelpipe-acct-test-"));

const { createRouter } = await import("../src/router.mjs");

let pass = 0;
const fails = [];
function check(name, got, want) {
  if (got === want) { pass++; return; }
  fails.push(`  ✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
// Assert a measured cooldown is within ±3s of the expected rung (requests are sub-100ms).
function checkNear(name, got, want, tol = 3000) {
  if (Math.abs(got - want) <= tol) { pass++; return; }
  fails.push(`  ✗ ${name}: got ${got}, want ~${want} (±${tol})`);
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}
function close(server) { return new Promise((resolve) => server.close(resolve)); }

// A stub whose status is switchable at runtime (429 to exhaust, 200 to recover).
function makeStatusStub(initial = 429) {
  let status = initial;
  let message = "rate limited";
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (status >= 400) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message } })); }
      else { res.writeHead(200, { "content-type": "text/event-stream" }); res.end("ok"); }
    });
  });
  return { server, setStatus: (s) => { status = s; }, setMessage: (m) => { message = m; } };
}

function fire(port, model) {
  const data = Buffer.from(JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }));
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST",
        headers: { "content-type": "application/json", "content-length": data.length } },
      (res) => { const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => resolve({ status: res.statusCode })); },
    );
    req.on("error", reject); req.write(data); req.end();
  });
}

async function main() {
  const keepAlive = setInterval(() => {}, 1000);
  process.env.ACC_A = "a"; process.env.ACC_B = "b";
  const stub = makeStatusStub(429);
  const sPort = await listen(stub.server);
  const router = createRouter({
    listen: { host: "127.0.0.1", port: 0 },
    // The same ladder model failover rides; the account pool must now climb it too.
    failoverRecoveryBackoffMs: [60000, 300000, 600000],
    routes: [{
      match: "glm-*", base_url: `http://127.0.0.1:${sPort}`, strategy: "failover",
      accounts: [
        { label: "acctA", auth: { header: "x-api-key", keyEnv: "ACC_A" } },
        { label: "acctB", auth: { header: "x-api-key", keyEnv: "ACC_B" } },
      ],
    }],
  });
  const rPort = await listen(router);
  const pool = [...router._modelpipe.accountPools.values()][0];
  const acctA = () => pool.accounts[0];

  try {
    // A fresh account starts at rung 0.
    check("fresh account: attempts 0", acctA().attempts, 0);

    // Rung 1: first limit-hit parks for 1 min (recoveryWaitMs(0)).
    let t0 = Date.now();
    await fire(rPort, "glm-5.2");
    check("after 1st 429: attempts incremented to 1", acctA().attempts, 1);
    checkNear("after 1st 429: parked ~1 min (rung 0)", acctA().exhaustedUntil - t0, 60000);

    // Simulate the cooldown elapsing (wall clock would do this) WITHOUT clearing attempts —
    // the account becomes eligible again but remembers how far up the ladder it climbed.
    for (const a of pool.accounts) a.exhaustedUntil = 0;

    // Rung 2: parked for 5 min (recoveryWaitMs(1)).
    t0 = Date.now();
    await fire(rPort, "glm-5.2");
    check("after 2nd 429: attempts 2", acctA().attempts, 2);
    checkNear("after 2nd 429: parked ~5 min (rung 1)", acctA().exhaustedUntil - t0, 300000);

    for (const a of pool.accounts) a.exhaustedUntil = 0;

    // Rung 3: parked for 10 min (recoveryWaitMs(2)).
    t0 = Date.now();
    await fire(rPort, "glm-5.2");
    check("after 3rd 429: attempts 3", acctA().attempts, 3);
    checkNear("after 3rd 429: parked ~10 min (rung 2)", acctA().exhaustedUntil - t0, 600000);

    for (const a of pool.accounts) a.exhaustedUntil = 0;

    // Rung 4+: caps at the last ladder rung (10 min), never grows unbounded.
    t0 = Date.now();
    await fire(rPort, "glm-5.2");
    check("after 4th 429: attempts 4", acctA().attempts, 4);
    checkNear("after 4th 429: still capped at ~10 min (last rung)", acctA().exhaustedUntil - t0, 600000);

    // Recovery: the account answers cleanly → its ladder counter resets to 0, so the NEXT
    // limit-hit starts back at the 1-min rung rather than 10 min.
    for (const a of pool.accounts) a.exhaustedUntil = 0;
    stub.setStatus(200);
    const ok = await fire(rPort, "glm-5.2");
    check("recovery request succeeds (200)", ok.status, 200);
    check("recovery resets the account's ladder to 0", acctA().attempts, 0);

    // And after the reset, a fresh limit-hit is back to the first rung.
    stub.setStatus(429);
    t0 = Date.now();
    await fire(rPort, "glm-5.2");
    check("post-recovery 429: attempts back to 1", acctA().attempts, 1);
    checkNear("post-recovery 429: parked ~1 min again (rung 0)", acctA().exhaustedUntil - t0, 60000);

    // Sanity: with NO backoff schedule, the park falls back to the flat cooldown.
    {
      const stub2 = makeStatusStub(429);
      const s2 = await listen(stub2.server);
      const r2 = createRouter({
        listen: { host: "127.0.0.1", port: 0 },
        failoverRecoveryIntervalMs: 60000, // flat, no backoff array
        routes: [{
          match: "glm-*", base_url: `http://127.0.0.1:${s2}`, strategy: "failover",
          accounts: [
            { label: "a1", auth: { header: "x-api-key", keyEnv: "ACC_A" } },
            { label: "a2", auth: { header: "x-api-key", keyEnv: "ACC_B" } },
          ],
        }],
      });
      const rp2 = await listen(r2);
      const p2 = [...r2._modelpipe.accountPools.values()][0];
      const t = Date.now();
      await fire(rp2, "glm-5.2");
      for (const a of p2.accounts) a.exhaustedUntil = 0;
      const t2 = Date.now();
      await fire(rp2, "glm-5.2");
      checkNear("no backoff schedule: park stays flat at the cooldown", p2.accounts[0].exhaustedUntil - t2, 60000);
      await close(r2); await close(stub2.server);
    }

    // HARD exhaustion (weekly/monthly wording): confirmed to be a genuine multi-day block in
    // practice, so it must NOT climb the short rate-limit ladder (that would just re-hammer a
    // dead account every few minutes for days) and must NOT ratchet `attempts` (a later GENUINE
    // transient hit on this account should still start the ordinary ladder at its first rung).
    {
      const stub3 = makeStatusStub(429);
      stub3.setMessage("[1310][Weekly/Monthly Limit Exhausted. Your limit will reset at 2099-01-01 00:00:00]");
      const s3 = await listen(stub3.server);
      const r3 = createRouter({
        listen: { host: "127.0.0.1", port: 0 },
        failoverRecoveryBackoffMs: [60000, 300000, 600000],
        routes: [{
          match: "glm-*", base_url: `http://127.0.0.1:${s3}`, strategy: "failover",
          accounts: [
            { label: "a1", auth: { header: "x-api-key", keyEnv: "ACC_A" } },
            { label: "a2", auth: { header: "x-api-key", keyEnv: "ACC_B" } },
          ],
        }],
      });
      const rp3 = await listen(r3);
      const p3 = [...r3._modelpipe.accountPools.values()][0];
      const t3 = Date.now();
      await fire(rp3, "glm-5.2");
      check("hard exhaustion: attempts NOT incremented", p3.accounts[0].attempts, 0);
      // Message quotes a reset ~73 years out — sanity-capped at MAX_HARD_PARK_MS (3 days), not
      // trusted verbatim, and far longer than the ordinary rate-limit ladder's 10-min ceiling.
      checkNear("hard exhaustion: parked at the 3-day sanity cap, not the quoted date",
        p3.accounts[0].exhaustedUntil - t3, 3 * 24 * 60 * 60 * 1000, 5000);
      await close(r3); await close(stub3.server);
    }

    // HARD exhaustion with a near reset quoted in the message: trusted directly (the only
    // authoritative signal available), not forced to the 3-day sanity cap.
    {
      const stub4 = makeStatusStub(429);
      const resetAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min out
      stub4.setMessage(`[1310][Weekly/Monthly Limit Exhausted. Your limit will reset at ${resetAt.toISOString().slice(0, 19).replace("T", " ")}]`);
      const s4 = await listen(stub4.server);
      const r4 = createRouter({
        listen: { host: "127.0.0.1", port: 0 },
        failoverRecoveryBackoffMs: [60000, 300000, 600000],
        routes: [{
          match: "glm-*", base_url: `http://127.0.0.1:${s4}`, strategy: "failover",
          accounts: [
            { label: "a1", auth: { header: "x-api-key", keyEnv: "ACC_A" } },
            { label: "a2", auth: { header: "x-api-key", keyEnv: "ACC_B" } },
          ],
        }],
      });
      const rp4 = await listen(r4);
      const p4 = [...r4._modelpipe.accountPools.values()][0];
      const t4 = Date.now();
      await fire(rp4, "glm-5.2");
      checkNear("hard exhaustion: a near quoted reset is trusted directly", p4.accounts[0].exhaustedUntil - t4, 5 * 60 * 1000, 5000);
      await close(r4); await close(stub4.server);
    }
  } finally {
    delete process.env.ACC_A; delete process.env.ACC_B;
    await close(router); await close(stub.server);
  }

  clearInterval(keepAlive);
  if (fails.length) {
    console.log("MODELPIPE ACCOUNT-COOLDOWN SELF-TEST:");
    fails.forEach((f) => console.log(f));
    console.log(`\nFAIL — ${fails.length} case(s) failed`);
    process.exit(1);
  }
  console.log(`account-cooldown.test: all ${pass} checks passed`);
}

main().catch((err) => {
  console.log(`FAIL — unexpected error: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
