// Self-test for modelpipe context compaction (src/compact.mjs). Pure — NO network, NO disk:
// the orchestrator's summarizer and store are stubbed. Run: node test/compact.test.mjs

import {
  estimateTokens, overheadTokens, messagesTokens, bodyTokens,
  blocksOf, isRealUserPrompt, tailIsToolClosed, findCheckpoints, chooseCut,
  spliceSummary, mechanicalTrim, headHash, resolveWindow, compactBody,
  SESSION_HEADER, COMPACT_DEFAULTS,
} from "../src/compact.mjs";

let pass = 0;
const fails = [];
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fails.push(`  ✗ ${name}: got ${g}, want ${w}`);
}
function ok(name, cond) { check(name, !!cond, true); }

// --- fixtures: a conversation with tool cycles -----------------------------------------
const pad = (n) => "x".repeat(n); // n chars ≈ n/4 tokens
const u = (t) => ({ role: "user", content: [{ type: "text", text: t }] });
const ur = (id) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] });
const a = (t, id) => ({ role: "assistant", content: id ? [{ type: "text", text: t }, { type: "tool_use", id, name: "Bash", input: {} }] : [{ type: "text", text: t }] });

const convo = [
  u("task one " + pad(400)),   // 0  checkpoint
  a("working", "T1"),          // 1
  ur("T1"),                    // 2
  a("done"),                   // 3
  u("task two " + pad(400)),   // 4  checkpoint
  a("working", "T2"),          // 5
  ur("T2"),                    // 6
  u("task three " + pad(400)), // 7  checkpoint
];

// --- token estimate ---
check("estimateTokens string", estimateTokens("abcd"), 1);
ok("bodyTokens counts system+tools+messages",
  bodyTokens({ system: pad(40), tools: [{ x: pad(40) }], messages: [u(pad(40))] }) >
  messagesTokens([u(pad(40))]));

// --- block helpers ---
check("blocksOf normalizes string", blocksOf({ content: "hi" }), [{ type: "text", text: "hi" }]);
ok("isRealUserPrompt text-user", isRealUserPrompt(u("hi")));
ok("isRealUserPrompt rejects tool_result-user", !isRealUserPrompt(ur("T1")));
ok("isRealUserPrompt rejects assistant", !isRealUserPrompt(a("hi")));

// --- checkpoints & tool pairing ---
check("findCheckpoints indices", findCheckpoints(convo), [0, 4, 7]);
ok("tailIsToolClosed at a fresh prompt", tailIsToolClosed(convo, 4));
ok("tailIsToolClosed false mid-cycle (orphan tool_result)", !tailIsToolClosed(convo, 2));

// --- chooseCut: earliest checkpoint whose tail fits budget ---
// tail sizes (msgs only): from 7 ≈ 100+, from 4 ≈ 200+, from 0 ≈ 300+ tokens.
const cps = findCheckpoints(convo);
check("chooseCut tiny budget -> deepest checkpoint 7", chooseCut(convo, cps, 130, 0), 7);
check("chooseCut huge budget -> keep all (0)", chooseCut(convo, cps, 100000, 0), 0);

// --- spliceSummary: folds summary into first retained msg, preserves tool pairing ---
const spliced = spliceSummary(convo, 4, "SUMMARY-TEXT");
check("spliceSummary length", spliced.length, convo.length - 4);
ok("spliceSummary first block carries summary", blocksOf(spliced[0])[0].text.includes("SUMMARY-TEXT"));
ok("spliceSummary keeps original prompt block", blocksOf(spliced[0]).some((b) => b.text && b.text.includes("task two")));
ok("spliceSummary result is tool-closed", tailIsToolClosed(spliced, 0));

// --- mechanicalTrim ---
const mt = mechanicalTrim(convo, 130, 0);
ok("mechanicalTrim applied", mt.applied);
ok("mechanicalTrim retained original slice fits budget", messagesTokens(convo.slice(mt.cut)) <= 130);
ok("mechanicalTrim actually shrank", messagesTokens(mt.messages) < messagesTokens(convo));
ok("mechanicalTrim tool-closed", tailIsToolClosed(mt.messages, 0));

// --- headHash stability / sensitivity ---
check("headHash stable", headHash(convo, 4), headHash(convo.slice(0), 4));
ok("headHash changes with count", headHash(convo, 4) !== headHash(convo, 5));

// --- resolveWindow ---
check("resolveWindow glob", resolveWindow({ window: { "claude-*": 1000000 }, windowDefault: 200000 }, "claude-opus-4-8"), 1000000);
check("resolveWindow default", resolveWindow({ window: { "glm-*": 200000 }, windowDefault: 128000 }, "deepseek-v4"), 128000);

// --- orchestrator: passthrough / summarized / reuse / mechanical ---
const smallWindow = { ...COMPACT_DEFAULTS, windowDefault: 1000 }; // trigger 700, verbatim ~70 tok
const bigBody = { system: "", tools: [], messages: convo }; // ~300 tok msgs — under trigger 700
await (async () => {
  const r = await compactBody(bigBody, {}, smallWindow, "m", { store: memStore(), summarize: async () => "S" });
  check("passthrough under trigger", r.action, "passthrough");
})();

// Force over-trigger: window 300 -> trigger 210, msgs ~300 tok.
const tinyWindow = { ...COMPACT_DEFAULTS, windowDefault: 300 };
await (async () => {
  let calls = 0;
  const store = memStore();
  const headers = { [SESSION_HEADER]: "sess-abc" };
  const deps = { store, summarize: async () => { calls++; return "SUMMARY"; } };
  const r1 = await compactBody({ system: "", tools: [], messages: convo }, headers, tinyWindow, "m", deps);
  check("summarized over trigger", r1.action, "summarized");
  ok("summary spliced into forwarded messages", JSON.stringify(r1.messages).includes("SUMMARY"));
  ok("cached after summarize", !!store.get("sess-abc"));
  // Same request again → reuse cache, NO second summarizer call.
  const r2 = await compactBody({ system: "", tools: [], messages: convo }, headers, tinyWindow, "m", deps);
  ok("second call reused or summarized", r2.action === "reuse" || r2.action === "summarized");
  check("summarizer called exactly once on identical repeat", calls, 1);
})();

// Summarizer failure → mechanical safety net.
await (async () => {
  const deps = { store: memStore(), summarize: async () => { throw new Error("down"); } };
  const r = await compactBody({ system: "", tools: [], messages: convo }, { [SESSION_HEADER]: "s2" }, tinyWindow, "m", deps);
  ok("mechanical fallback on summarizer failure", r.action === "mechanical" || r.action === "passthrough");
  ok("fallback still tool-closed", tailIsToolClosed(r.messages, 0));
})();

function memStore() {
  const m = new Map();
  return { get: (k) => m.get(k) || null, set: (k, v) => m.set(k, v) };
}

// --- report ---
if (fails.length) {
  console.error(`compact.test: ${pass} passed, ${fails.length} FAILED:\n` + fails.join("\n"));
  process.exit(1);
}
console.log(`compact.test: all ${pass} checks passed`);
