// modelpipe stats self-test — the previously-untested module: pricing, SSE token
// parsing, live-session persistence, and provider identification. Hermetic: points the
// persistence store at a throwaway temp dir via MODELPIPE_DIR (set BEFORE importing the
// module, since store.mjs reads it at import time), so it never touches ~/.modelpipe.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "modelpipe-stats-test-"));
process.env.MODELPIPE_DIR = TMP;

const { StatsCollector, modelPrice, providerIdFromUrl, createUsageTracker, decompressIfNeeded } =
  await import("../src/stats.mjs");

let pass = 0;
const fails = [];
function check(name, got, want) {
  if (got === want) { pass++; return; }
  fails.push(`  ✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

function drain(stream) {
  return new Promise((resolve) => { stream.on("data", () => {}); stream.on("end", resolve); });
}

async function run() {
  // ── modelPrice ──────────────────────────────────────────────────────────────
  check("modelPrice known model", modelPrice("claude-opus-4-8").input, 15);
  check("modelPrice unknown model ⇒ null", modelPrice("no-such-model"), null);
  check("modelPrice exact override wins", modelPrice("glm-5.2", { "glm-5.2": { input: 9, output: 9 } }).input, 9);
  check("modelPrice glob override matches", modelPrice("claude-opus-4-8", { "claude-opus-*": { input: 1, output: 2 } }).output, 2);
  check("modelPrice built-in cacheRead rate", modelPrice("glm-5.2").cacheRead, 0.26);

  // ── providerIdFromUrl ─────────────────────────────────────────────────────────
  check("providerId anthropic", providerIdFromUrl("https://api.anthropic.com"), "anthropic");
  check("providerId glm (z.ai)", providerIdFromUrl("https://api.z.ai/api/anthropic"), "glm");
  check("providerId deepseek", providerIdFromUrl("https://api.deepseek.com/anthropic"), "deepseek");
  check("providerId openrouter", providerIdFromUrl("https://openrouter.ai/api"), "openrouter");
  check("providerId falls back to host", providerIdFromUrl("https://example.com/x"), "example.com");
  check("providerId bad url ⇒ unknown", providerIdFromUrl("not a url"), "unknown");

  // ── record + snapshot ─────────────────────────────────────────────────────────
  const sc = new StatsCollector();
  sc.record({ providerId: "deepseek", model: "deepseek-chat", inputTokens: 1_000_000, outputTokens: 1_000_000, status: 200 });
  const snap = sc.snapshot();
  check("snapshot tracks the model", snap.models["deepseek-chat"].requests, 1);
  check("snapshot sums tokens", snap.session.tokens, 2_000_000);
  // deepseek-chat = 0.14 in / 0.28 out per 1M → 0.42 for 1M+1M.
  check("snapshot computes real cost", Number(snap.session.cost.toFixed(2)), 0.42);
  check("snapshot marks errors", (() => { sc.record({ providerId: "deepseek", model: "deepseek-chat", status: 500 }); return sc.snapshot().models["deepseek-chat"].errors; })(), 1);

  // ── cache_read_input_tokens billed at the cheaper cacheRead rate, not the input rate ─
  const scCache = new StatsCollector();
  scCache.record({ providerId: "glm", model: "glm-5.2", inputTokens: 0, cacheReadTokens: 1_000_000, outputTokens: 0, status: 200 });
  const cacheSnap = scCache.snapshot();
  check("cacheReadTokens tracked separately", cacheSnap.models["glm-5.2"].cacheReadTokens, 1_000_000);
  // glm-5.2 cacheRead = $0.26/1M, not the $1.4/1M input rate.
  check("cacheReadTokens billed at cacheRead rate", Number(cacheSnap.models["glm-5.2"].cost.toFixed(2)), 0.26);
  check("session tokens include cacheReadTokens", cacheSnap.session.tokens, 1_000_000);
  // A model with no configured cacheRead rate falls back to the input rate (conservative).
  const scNoCacheRate = new StatsCollector();
  scNoCacheRate.record({ providerId: "deepseek", model: "deepseek-chat", inputTokens: 0, cacheReadTokens: 1_000_000, outputTokens: 0, status: 200 });
  check("cacheRead falls back to input rate when unset", Number(scNoCacheRate.snapshot().models["deepseek-chat"].cost.toFixed(2)), 0.14);

  // ── live-session persistence (resume across restart) ───────────────────────────
  sc.saveState();
  check("saveState wrote state.json", fs.existsSync(path.join(TMP, "state.json")), true);
  const sc2 = new StatsCollector(); // simulates a restart — should resume the live session
  const snap2 = sc2.snapshot();
  check("restart resumes model totals", snap2.models["deepseek-chat"].inputTokens, 1_000_000);
  check("restart resumes request count", snap2.models["deepseek-chat"].requests, 2);

  // ── reset archives to session history, then clears live ─────────────────────────
  sc2.reset();
  check("reset archives one session", sc2.sessionHistory().length, 1);
  check("reset clears live models", Object.keys(sc2.snapshot().models).length, 0);
  const sc3 = new StatsCollector(); // reset persisted the empty live state + the archive
  check("archived session survives restart", sc3.sessionHistory().length, 1);
  check("empty live session survives restart", Object.keys(sc3.snapshot().models).length, 0);

  // ── SSE usage tracker: streaming input/output tokens ────────────────────────────
  const rec = [];
  const tr = createUsageTracker({ record: (e) => rec.push(e) }, { providerId: "anthropic", model: "claude-opus-4-8", startTime: Date.now() });
  const drained = drain(tr);
  tr.write('event: message_start\ndata: {"message":{"usage":{"input_tokens":123}}}\n\n');
  tr.write('event: message_delta\ndata: {"usage":{"output_tokens":45}}\n\n');
  tr.end();
  await drained;
  check("SSE tracker records once on stream end", rec.length, 1);
  check("SSE tracker extracts input_tokens", rec[0].inputTokens, 123);
  check("SSE tracker extracts output_tokens", rec[0].outputTokens, 45);
  check("SSE tracker tags status 200", rec[0].status, 200);

  // ── request trace: client alias, routed model, provider-returned model ──────────
  const recT = [];
  const trT = createUsageTracker({ record: (e) => recT.push(e) }, { providerId: "anthropic", model: "claude-sonnet-5", clientModel: "glm-5.2", startTime: Date.now() });
  const drainedT = drain(trT);
  // provider echoes a DIFFERENT model id (a provider-side redirect) than we routed to
  trT.write('event: message_start\ndata: {"message":{"model":"claude-sonnet-5-20260101","usage":{"input_tokens":100}}}\n\n');
  trT.write('event: message_delta\ndata: {"usage":{"output_tokens":42}}\n\n');
  trT.end();
  await drainedT;
  check("trace: records the client alias", recT[0].clientModel, "glm-5.2");
  check("trace: records the routed model", recT[0].model, "claude-sonnet-5");
  check("trace: records the provider-returned model", recT[0].providerModel, "claude-sonnet-5-20260101");

  // trace via the non-streaming JSON fallback (provider model from top-level .model)
  const recTJ = [];
  const trTJ = createUsageTracker({ record: (e) => recTJ.push(e) }, { providerId: "deepseek", model: "deepseek-v4-pro", clientModel: "deepseek-v4-pro", startTime: Date.now() });
  const drainedTJ = drain(trTJ);
  trTJ.write('{"model":"deepseek-v4-pro-0711","usage":{"input_tokens":5,"output_tokens":7}}');
  trTJ.end();
  await drainedTJ;
  check("trace(json): provider-returned model from JSON body", recTJ[0].providerModel, "deepseek-v4-pro-0711");

  // ── SSE usage tracker: cache_creation folds into inputTokens, cache_read stays separate ─
  const recCache = [];
  const trCache = createUsageTracker({ record: (e) => recCache.push(e) }, { providerId: "openrouter", model: "z-ai/glm-5.2", startTime: Date.now() });
  const drainedCache = drain(trCache);
  trCache.write('event: message_start\ndata: {"message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":90000}}}\n\n');
  trCache.write('event: message_delta\ndata: {"usage":{"output_tokens":45}}\n\n');
  trCache.end();
  await drainedCache;
  check("cache_creation folds into inputTokens", recCache[0].inputTokens, 30);
  check("cache_read_input_tokens tracked separately", recCache[0].cacheReadTokens, 90000);

  // ── non-streaming JSON fallback ─────────────────────────────────────────────────
  const rec2 = [];
  const tr2 = createUsageTracker({ record: (e) => rec2.push(e) }, { providerId: "deepseek", model: "deepseek-chat", startTime: Date.now() });
  const drained2 = drain(tr2);
  tr2.end('{"usage":{"input_tokens":7,"output_tokens":9},"content":[]}');
  await drained2;
  check("JSON fallback extracts input_tokens", rec2[0].inputTokens, 7);
  check("JSON fallback extracts output_tokens", rec2[0].outputTokens, 9);

  // ── LARGE non-streaming JSON still records tokens (regression guard for the buffer cap) ─
  const rec3 = [];
  const tr3 = createUsageTracker({ record: (e) => rec3.push(e) }, { providerId: "deepseek", model: "deepseek-chat", startTime: Date.now() });
  const drained3 = drain(tr3);
  const bigText = "x".repeat(400 * 1024); // ~400 KB — over the old 256 KB cap
  tr3.write('{"content":[{"type":"text","text":"' + bigText + '"}],');
  tr3.end('"usage":{"input_tokens":11,"output_tokens":22}}');
  await drained3;
  check("large JSON body still records input_tokens", rec3[0].inputTokens, 11);
  check("large JSON body still records output_tokens", rec3[0].outputTokens, 22);

  // ── decompressIfNeeded ──────────────────────────────────────────────────────────
  const plain = decompressIfNeeded({ headers: { "content-type": "text/event-stream" } });
  check("decompress: uncompressed passes through", plain.decompressed, false);

  if (fails.length) {
    console.log("MODELPIPE STATS SELF-TEST:");
    fails.forEach((f) => console.log(f));
    console.log(`\nFAIL — ${fails.length} case(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`PASS — ${pass} passed`);
  }
  // Clean up the temp store dir.
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
}

run();
