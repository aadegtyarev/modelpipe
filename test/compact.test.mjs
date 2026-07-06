// Self-test for modelpipe context fitting (src/compact.mjs). Pure — NO network, NO disk.
// Run: node test/compact.test.mjs

import {
  estimateTokens, overheadTokens, messagesTokens, bodyTokens,
  blocksOf, isRealUserPrompt, tailIsToolClosed, findCheckpoints, chooseCut,
  prependNote, mechanicalTrim, truncateOversizedBlocks, fitToWindow,
  isContextOverflow, parseOverflowLimit, resolveWindow, COMPACT_DEFAULTS,
} from "../src/compact.mjs";

let pass = 0;
const fails = [];
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; return; }
  fails.push(`  ✗ ${name}: got ${g}, want ${w}`);
}
const ok = (name, cond) => check(name, !!cond, true);

// --- fixtures: a conversation with tool cycles -----------------------------------------
const pad = (n) => "x".repeat(n);
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

// --- token estimate + block helpers ---
check("estimateTokens string", estimateTokens("abcd"), 1);
ok("bodyTokens counts system+tools+messages",
  bodyTokens({ system: pad(40), tools: [{ x: pad(40) }], messages: [u(pad(40))] }) > messagesTokens([u(pad(40))]));
check("blocksOf normalizes string", blocksOf({ content: "hi" }), [{ type: "text", text: "hi" }]);
ok("isRealUserPrompt text-user", isRealUserPrompt(u("hi")));
ok("isRealUserPrompt rejects tool_result-user", !isRealUserPrompt(ur("T1")));
ok("isRealUserPrompt rejects assistant", !isRealUserPrompt(a("hi")));

// --- checkpoints & tool pairing ---
check("findCheckpoints indices", findCheckpoints(convo), [0, 4, 7]);
ok("tailIsToolClosed at a fresh prompt", tailIsToolClosed(convo, 4));
ok("tailIsToolClosed false mid-cycle (orphan tool_result)", !tailIsToolClosed(convo, 2));

// --- chooseCut ---
const cps = findCheckpoints(convo);
check("chooseCut tiny budget -> deepest checkpoint 7", chooseCut(convo, cps, 130, 0), 7);
check("chooseCut huge budget -> keep all (0)", chooseCut(convo, cps, 100000, 0), 0);

// --- prependNote / mechanicalTrim ---
const noted = prependNote(convo, 4, "NOTE");
check("prependNote length", noted.length, convo.length - 4);
ok("prependNote carries note", blocksOf(noted[0])[0].text === "NOTE");
ok("prependNote keeps original prompt", blocksOf(noted[0]).some((b) => b.text && b.text.includes("task two")));
ok("prependNote tool-closed", tailIsToolClosed(noted, 0));

const mt = mechanicalTrim(convo, 130, 0);
ok("mechanicalTrim applied", mt.applied);
ok("mechanicalTrim retained slice fits budget", messagesTokens(convo.slice(mt.cut)) <= 130);
ok("mechanicalTrim tool-closed", tailIsToolClosed(mt.messages, 0));

// --- truncateOversizedBlocks: a single giant turn shrinks under budget ---
const giant = [u("small"), u("q " + pad(8000))];
const tb = truncateOversizedBlocks(giant, 200, 0);
ok("truncateOversizedBlocks shrinks", messagesTokens(tb) < messagesTokens(giant));

// --- fitToWindow ---
const fitsBody = { system: "", tools: [], messages: convo }; // ~300 tok
const rFits = fitToWindow(fitsBody, 100000, 0.95);
ok("fitToWindow no-op when it fits", rFits.trimmed === false && rFits.parsed === fitsBody);

const overBody = { system: "", tools: [], messages: convo };
const rOver = fitToWindow(overBody, 200, 0.95); // budget 190 < ~300
ok("fitToWindow trims when over", rOver.trimmed === true);
ok("fitToWindow result tool-closed", tailIsToolClosed(rOver.parsed.messages, 0));
ok("fitToWindow result smaller", messagesTokens(rOver.parsed.messages) < messagesTokens(convo));

// giant single turn → falls to block truncation, still produces a body
const rGiant = fitToWindow({ system: "", tools: [], messages: [u("q " + pad(20000))] }, 500, 0.95);
ok("fitToWindow handles un-cuttable giant turn", rGiant.trimmed === true);
ok("fitToWindow giant under budget-ish", bodyTokens(rGiant.parsed) <= 600);

// --- isContextOverflow ---
const errBody = (m) => Buffer.from(JSON.stringify({ error: { message: m } }));
ok("overflow: anthropic prompt too long", isContextOverflow(400, errBody("prompt is too long: 250000 tokens > 200000 maximum")));
ok("overflow: openai context_length_exceeded", isContextOverflow(400, errBody("This model's maximum context length is 128000 tokens")));
ok("overflow: 413", isContextOverflow(413, errBody("input too long, reduce the length")));
ok("overflow: rejects rate limit", !isContextOverflow(429, errBody("rate limit exceeded")));
ok("overflow: rejects unrelated 400", !isContextOverflow(400, errBody("invalid api key")));

// --- parseOverflowLimit ---
check("parseOverflowLimit '> N maximum'", parseOverflowLimit(errBody("prompt is too long: 250000 tokens > 200000 maximum")), 200000);
check("parseOverflowLimit 'maximum context length is N'", parseOverflowLimit(errBody("This model's maximum context length is 128000 tokens")), 128000);
check("parseOverflowLimit none", parseOverflowLimit(errBody("something went wrong")), null);

// --- resolveWindow ---
check("resolveWindow glob", resolveWindow({ window: { "claude-*": 1000000 }, windowDefault: 200000 }, "claude-opus-4-8"), 1000000);
check("resolveWindow default", resolveWindow({ window: { "glm-*": 200000 }, windowDefault: 128000 }, "deepseek-v4"), 128000);
check("resolveWindow order (specific before glob)", resolveWindow({ window: { "glm-5.2": 1000000, "glm-*": 200000 }, windowDefault: 128000 }, "glm-5.2"), 1000000);

// --- defaults sane ---
ok("defaults enabled + safetyPct", COMPACT_DEFAULTS.enabled === true && COMPACT_DEFAULTS.safetyPct > 0 && COMPACT_DEFAULTS.safetyPct <= 1);

if (fails.length) { console.error(`compact.test: ${pass} passed, ${fails.length} FAILED:\n` + fails.join("\n")); process.exit(1); }
console.log(`compact.test: all ${pass} checks passed`);
