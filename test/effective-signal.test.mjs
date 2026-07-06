// Self-test for the `effective` downshift signal (issue #18): GET /v1/failover exposes a
// ready-to-consume view of the head slot's current state so a consumer (statusline, an
// out-of-harness compaction trigger, the dashboard) reads one field instead of re-deriving
// `effective[offset]` and keeping its own model→window table.
//
// Two halves: computeEffectiveHead in isolation (pure), and the live GET /v1/failover path.
//
// Run: node test/effective-signal.test.mjs

import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

process.env.MODELPIPE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "modelpipe-eff-test-"));

const { computeEffectiveHead, createRouter, validateCompact } = await import("../src/router.mjs");

let pass = 0;
const fails = [];
function check(name, got, want) {
  if (got === want) { pass++; return; }
  fails.push(`  ✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}
function close(server) { return new Promise((resolve) => server.close(resolve)); }
function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: urlPath, method: "GET" },
      (res) => { const c = []; res.on("data", (x) => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString("utf8") })); });
    req.on("error", reject); req.end();
  });
}

async function main() {
  const keepAlive = setInterval(() => {}, 1000);

  const compact = validateCompact({ window: { "glm-5.2": 1000000, "glm-5.1": 200000, "glm-4.7": 128000 }, windowDefault: 200000 });
  const baseConfig = {
    routes: [{ match: "glm-*", base_url: "http://127.0.0.1:9", auth: "passthrough" }],
    failoverGroups: [{ ladder: ["glm-5.2", "glm-5.1", "glm-4.7"], mode: "shift" }],
    failoverRecoveryBackoffMs: [60000, 300000, 600000],
    compact,
  };
  const NOW = 1_000_000_000_000; // fixed epoch for deterministic ETAs

  // ── UNIT: no failover group → null (no coordinated head to speak of) ───────
  {
    const eff = computeEffectiveHead({ routes: baseConfig.routes, compact }, [], {}, new Map(), NOW);
    check("no group → effective is null", eff, null);
  }

  // ── UNIT: healthy head (offset 0) ─────────────────────────────────────────
  {
    const gstate = [{ offset: 0, shiftedAt: 0, attempts: 0, nextProbeAt: 0 }];
    const eff = computeEffectiveHead(baseConfig, gstate, {}, new Map(), NOW);
    check("offset 0: head === believed", eff.head, eff.believed);
    check("offset 0: believed is the configured head", eff.believed, "glm-5.2");
    check("offset 0: not shifted", eff.shifted, false);
    check("offset 0: recoversInSec null (healthy)", eff.recoversInSec, null);
    check("offset 0: window is the head's, from resolveWindow", eff.window, 1000000);
    check("offset 0: accountCooldown null (single-key backend)", eff.accountCooldown, null);
  }

  // ── UNIT: shifted head (offset 2) ─────────────────────────────────────────
  {
    const gstate = [{ offset: 2, shiftedAt: NOW - 10000, attempts: 1, nextProbeAt: 0 }];
    const eff = computeEffectiveHead(baseConfig, gstate, {}, new Map(), NOW);
    check("offset 2: believed still the configured head", eff.believed, "glm-5.2");
    check("offset 2: head is the actually-serving tier", eff.head, "glm-4.7");
    check("offset 2: shifted true", eff.shifted, true);
    check("offset 2: window is the SHIFTED head's window, not believed's", eff.window, 128000);
    // shiftedAt = NOW-10s, attempts=1 → recoveryWaitMs = 300000ms; due = NOW+290000 → 290s.
    check("offset 2: recoversInSec from shiftedAt + recoveryWaitMs(attempts)", eff.recoversInSec, 290);
  }

  // ── UNIT: learned window lowers the reported head window ───────────────────
  {
    const gstate = [{ offset: 1, shiftedAt: NOW, attempts: 0, nextProbeAt: 0 }];
    // head = glm-5.1 (configured 200000); a learned ceiling of 150000 must win (min).
    const eff = computeEffectiveHead(baseConfig, gstate, { "glm-5.1": 150000 }, new Map(), NOW);
    check("learned window: reported window is min(configured, learned)", eff.window, 150000);
  }

  // ── UNIT: accountCooldown when the head's whole pool is parked ─────────────
  {
    const gstate = [{ offset: 0, shiftedAt: 0, attempts: 0, nextProbeAt: 0 }];
    const route = baseConfig.routes[0];
    const pools = new Map();
    // All keys parked → soonest frees in 120s.
    pools.set(route, { accounts: [{ exhaustedUntil: NOW + 120000 }, { exhaustedUntil: NOW + 300000 }] });
    const eff = computeEffectiveHead(baseConfig, gstate, {}, pools, NOW);
    check("pool all parked: accountCooldown is secs to soonest free", eff.accountCooldown, 120);
    // One key live → not in cooldown.
    pools.set(route, { accounts: [{ exhaustedUntil: 0 }, { exhaustedUntil: NOW + 300000 }] });
    const eff2 = computeEffectiveHead(baseConfig, gstate, {}, pools, NOW);
    check("pool has a live key: accountCooldown null", eff2.accountCooldown, null);
  }

  // ── INTEGRATION: GET /v1/failover carries `effective` ─────────────────────
  {
    const router = createRouter({
      listen: { host: "127.0.0.1", port: 0 }, dashboard: true,
      failoverGroups: [{ ladder: ["glm-5.2", "glm-5.1", "glm-4.7"], mode: "shift" }],
      failoverRecoveryBackoffMs: [60000, 300000, 600000],
      compact: { window: { "glm-5.2": 1000000, "glm-5.1": 200000, "glm-4.7": 128000 }, windowDefault: 200000 },
      routes: [{ match: "glm-*", base_url: "http://127.0.0.1:9", auth: "passthrough" }],
    });
    const port = await listen(router);
    try {
      const healthy = JSON.parse((await get(port, "/v1/failover")).body).effective;
      check("endpoint: effective present", typeof healthy === "object" && healthy !== null, true);
      check("endpoint: healthy head === believed", healthy.head, healthy.believed);
      check("endpoint: healthy not shifted", healthy.shifted, false);
      check("endpoint: healthy window from resolveWindow", healthy.window, 1000000);

      // Force a shift via the exposed group state (as the reactive path would).
      const gs = router._modelpipe.groupState[0];
      gs.offset = 1; gs.shiftedAt = Date.now(); gs.attempts = 0;
      const shifted = JSON.parse((await get(port, "/v1/failover")).body).effective;
      check("endpoint: after shift head advances", shifted.head, "glm-5.1");
      check("endpoint: after shift believed unchanged", shifted.believed, "glm-5.2");
      check("endpoint: after shift shifted:true", shifted.shifted, true);
      check("endpoint: after shift window tracks head", shifted.window, 200000);
      check("endpoint: after shift recoversInSec is a number", typeof shifted.recoversInSec, "number");
    } finally {
      await close(router);
    }
  }

  // ── INTEGRATION: no group → effective null on the wire ─────────────────────
  {
    const router = createRouter({
      listen: { host: "127.0.0.1", port: 0 }, dashboard: true,
      failover: { "glm-5.2": "glm-5.1" }, // plain pair, no group
      routes: [{ match: "glm-*", base_url: "http://127.0.0.1:9", auth: "passthrough" }],
    });
    const port = await listen(router);
    try {
      const eff = JSON.parse((await get(port, "/v1/failover")).body).effective;
      check("endpoint: no group → effective null", eff, null);
    } finally {
      await close(router);
    }
  }

  clearInterval(keepAlive);
  if (fails.length) {
    console.log("MODELPIPE EFFECTIVE-SIGNAL SELF-TEST:");
    fails.forEach((f) => console.log(f));
    console.log(`\nFAIL — ${fails.length} case(s) failed`);
    process.exit(1);
  }
  console.log(`effective-signal.test: all ${pass} checks passed`);
}

main().catch((err) => {
  console.log(`FAIL — unexpected error: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
