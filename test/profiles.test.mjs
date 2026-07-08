// Self-test for the routing-profile resolver (src/profiles.mjs). PURE functions only —
// no network, no I/O. Run: node test/profiles.test.mjs

import {
  globToRegExp, parseTzOffset, parseHHMM, inWindow,
  profileBind, resolveAlias, stepIndex, defaultProfile, scheduleProfile,
  intendedHead, effectiveProfile, stepAdvancesOn, bindingDelta, routingSummary,
} from "../src/profiles.mjs";

let pass = 0;
const fails = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fails.push(`FAIL ${name}\n   expected ${e}\n   got      ${a}`);
}

// ── config under test ───────────────────────────────────────────────────────
const CONFIG = {
  profiles: {
    native:          { bind: {} },
    "glm-on-sonnet": { bind: { "glm-5.2": "claude-sonnet-5" } },
    "econ-opus":     { bind: { "claude-opus-*": "glm-5.2", "glm-5.2": "claude-sonnet-5" } },
    budget:          { bind: { "glm-5.2": "minimax/minimax-m3" } },
  },
  defaultProfile: "native",
  auto: {
    steps: [
      { profile: "native" },
      { profile: "glm-on-sonnet", when: "limit" },
    ],
    recover: true,
    schedules: [
      { profile: "budget", tz: "+03:00", windows: [["14:00", "18:00"]] },
    ],
  },
};

// Provider stub: map a concrete model id to a provider label.
const providerOf = (m) =>
  /^claude-/.test(m) ? "anthropic"
  : /^glm-/.test(m) ? "glm"
  : /minimax|deepseek|\//.test(m) ? "openrouter"
  : null;

// ── glob & time helpers ──────────────────────────────────────────────────────
check("glob literal id matches", globToRegExp("glm-5.2").test("glm-5.2"), true);
check("glob dot is literal", globToRegExp("glm-5.2").test("glm-5x2"), false);
check("glob star", globToRegExp("claude-*").test("claude-opus-4-8"), true);
check("parseTzOffset +03:00", parseTzOffset("+03:00"), 180);
check("parseTzOffset Z", parseTzOffset("Z"), 0);
check("parseTzOffset bad", parseTzOffset("bogus"), null);
check("parseHHMM", parseHHMM("14:00"), 840);
check("inWindow inside", inWindow(900, 840, 1080), true);
check("inWindow end exclusive", inWindow(1080, 840, 1080), false);
check("inWindow wrap past midnight", inWindow(30, 1320, 120), true);

// ── bindings ─────────────────────────────────────────────────────────────────
check("profileBind native empty", profileBind(CONFIG, "native"), {});
check("profileBind missing ⇒ {}", profileBind(CONFIG, "nope"), {});
check("resolveAlias native no-op", resolveAlias(CONFIG, "native", "glm-5.2"), "glm-5.2");
check("resolveAlias glm-on-sonnet rewrites", resolveAlias(CONFIG, "glm-on-sonnet", "glm-5.2"), "claude-sonnet-5");
check("resolveAlias glm-on-sonnet leaves others", resolveAlias(CONFIG, "glm-on-sonnet", "claude-opus-4-8"), "claude-opus-4-8");
check("resolveAlias econ-opus glob alias", resolveAlias(CONFIG, "econ-opus", "claude-opus-4-8"), "glm-5.2");
check("resolveAlias empty model", resolveAlias(CONFIG, "budget", ""), "");

// ── chain membership & default ────────────────────────────────────────────────
check("stepIndex head", stepIndex(CONFIG, "native"), 0);
check("stepIndex step 1", stepIndex(CONFIG, "glm-on-sonnet"), 1);
check("stepIndex manual-only ⇒ -1", stepIndex(CONFIG, "econ-opus"), -1);
check("defaultProfile explicit", defaultProfile(CONFIG), "native");
check("defaultProfile falls to head", defaultProfile({ auto: { steps: [{ profile: "h" }] }, profiles: { h: {} } }), "h");

// ── schedule selection ─────────────────────────────────────────────────────────
// 15:00 +03:00 → inside the 14:00–18:00 window. Build an epoch whose UTC minute-of-day at
// +03:00 lands at 15:00 (12:00 UTC).
const peak = Date.UTC(2026, 6, 8, 12, 0, 0);   // 12:00Z = 15:00 +03:00
const off = Date.UTC(2026, 6, 8, 20, 0, 0);    // 20:00Z = 23:00 +03:00 (closed)
check("scheduleProfile in window", scheduleProfile(CONFIG, peak), "budget");
check("scheduleProfile off window ⇒ null", scheduleProfile(CONFIG, off), null);

// ── intended head & effective profile ──────────────────────────────────────────
check("intendedHead default off-window", intendedHead(CONFIG, {}, off), "native");
check("intendedHead schedule wins in-window", intendedHead(CONFIG, {}, peak), "budget");
check("intendedHead manual pin wins over schedule", intendedHead(CONFIG, { pinned: "econ-opus" }, peak), "econ-opus");
check("intendedHead bad pin ignored", intendedHead(CONFIG, { pinned: "ghost" }, off), "native");

check("effective default", effectiveProfile(CONFIG, {}, off),
  { active: "native", intended: "native", source: "default", shifted: false, offset: 0 });
check("effective error-shift on native", effectiveProfile(CONFIG, { offset: 1 }, off),
  { active: "glm-on-sonnet", intended: "native", source: "default", shifted: true, offset: 1 });
check("effective offset clamps to last step", effectiveProfile(CONFIG, { offset: 9 }, off),
  { active: "glm-on-sonnet", intended: "native", source: "default", shifted: true, offset: 9 });
check("effective manual pin, non-chain ⇒ no shift", effectiveProfile(CONFIG, { pinned: "econ-opus", offset: 3 }, off),
  { active: "econ-opus", intended: "econ-opus", source: "manual", shifted: false, offset: 0 });
check("effective schedule source in-window", effectiveProfile(CONFIG, {}, peak),
  { active: "budget", intended: "budget", source: "schedule", shifted: false, offset: 0 });

// ── step-advance condition ──────────────────────────────────────────────────────
check("stepAdvancesOn limit → step 1", stepAdvancesOn(CONFIG, 0, "limit"), true);
check("stepAdvancesOn 5xx does not (when=limit)", stepAdvancesOn(CONFIG, 0, "5xx"), false);
check("stepAdvancesOn no next step", stepAdvancesOn(CONFIG, 1, "limit"), false);
const CFG5XX = { auto: { steps: [{ profile: "a" }, { profile: "b", when: "5xx" }] }, profiles: { a: {}, b: {} } };
check("stepAdvancesOn 5xx step", stepAdvancesOn(CFG5XX, 0, "5xx"), true);
check("stepAdvancesOn omitted when defaults limit", stepAdvancesOn({ auto: { steps: [{ profile: "a" }, { profile: "b" }] }, profiles: { a: {}, b: {} } }, 0, "limit"), true);

// ── binding delta (what moved) ───────────────────────────────────────────────────
check("bindingDelta native ⇒ empty", bindingDelta(CONFIG, "native", providerOf), []);
check("bindingDelta glm-on-sonnet", bindingDelta(CONFIG, "glm-on-sonnet", providerOf),
  [{ alias: "glm-5.2", from: "glm-5.2", to: "claude-sonnet-5", fromProvider: "glm", toProvider: "anthropic" }]);
check("bindingDelta budget", bindingDelta(CONFIG, "budget", providerOf),
  [{ alias: "glm-5.2", from: "glm-5.2", to: "minimax/minimax-m3", fromProvider: "glm", toProvider: "openrouter" }]);

// ── routing summary (banner payload) ──────────────────────────────────────────────
check("routingSummary default is silent (no changes)", routingSummary(CONFIG, {}, off, { providerOf }).changes, []);
const shiftSummary = routingSummary(CONFIG, { offset: 1, shiftedAt: off - 30000 }, off, { providerOf, recoveryMs: 60000 });
check("routingSummary shifted active", shiftSummary.active, "glm-on-sonnet");
check("routingSummary shifted flag", shiftSummary.shifted, true);
check("routingSummary shifted source", shiftSummary.source, "default");
check("routingSummary recovers eta", shiftSummary.recoversInSec, 30);
check("routingSummary change line", shiftSummary.changes,
  [{ alias: "glm-5.2", from: "glm-5.2", to: "claude-sonnet-5", fromProvider: "glm", toProvider: "anthropic" }]);
check("routingSummary manual pin summary", routingSummary(CONFIG, { pinned: "econ-opus" }, off, { providerOf }).source, "manual");

// ── report ───────────────────────────────────────────────────────────────────
if (fails.length) {
  console.log("PROFILES SELF-TEST:");
  fails.forEach((f) => console.log(f));
  console.log(`\nFAIL — ${fails.length} case(s) failed`);
  process.exit(1);
}
console.log(`PASS — ${pass} passed`);
