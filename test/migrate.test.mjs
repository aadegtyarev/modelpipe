// Self-test for the legacy→profiles config migration (src/migrate.mjs). Hermetic — fixtures
// only, no I/O. The central guarantee is TRAFFIC EQUIVALENCE: the migrated profile config routes
// every model to the same backend the old failover pairs did, in both the normal and shifted
// states. Run: node test/migrate.test.mjs

import { migrateConfig, legacyBackup, routingFingerprint, routeFor } from "../src/migrate.mjs";
import { resolveAlias } from "../src/profiles.mjs";

let pass = 0;
const fails = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fails.push(`FAIL ${name}\n   expected ${e}\n   got      ${a}`);
}

// A fixture modelled on the real live proxy: routes in routes.json, failover pairs + prices +
// compact in the runtime overrides (the authoritative live state).
const FILE = {
  listen: { host: "127.0.0.1", port: 8787 },
  dashboard: true,
  concurrency: { "glm-5.2": 10, "glm-4.7": 3, "glm-5-turbo": 1 },
  glmPlan: "max",
  plans: { glm: 64.8 },
  routes: [
    { match: "claude-*", base_url: "https://api.anthropic.com", auth: "passthrough" },
    { match: "glm-5-turbo", base_url: "https://api.z.ai/api/anthropic", accounts: [{ label: "a", auth: { header: "Authorization", scheme: "Bearer", keyEnv: "ZAI_API_KEY" } }] },
    { match: "glm-*", base_url: "https://api.z.ai/api/anthropic", accounts: [{ label: "a", auth: { header: "Authorization", scheme: "Bearer", keyEnv: "ZAI_API_KEY" } }] },
    { match: "deepseek-*", base_url: "https://api.deepseek.com/anthropic", auth: { header: "x-api-key", keyEnv: "DEEPSEEK_API_KEY" } },
    { match: "google/*", base_url: "https://openrouter.ai/api", forImages: true, forImagesModel: "google/gemini-2.5-flash-lite", auth: { header: "Authorization", scheme: "Bearer", keyEnv: "OPENROUTER_API_KEY" } },
    { match: "*/*", base_url: "https://openrouter.ai/api", auth: { header: "Authorization", scheme: "Bearer", keyEnv: "OPENROUTER_API_KEY" } },
  ],
};
const OVERRIDES = {
  tokenPrices: { "deepseek-v4-pro": { input: 0.435, output: 0.87 } },
  failover: {
    "glm-5.2": "claude-sonnet-5",
    "glm-5.1": "claude-sonnet-5",
    "glm-4.7": "deepseek-v4-pro",
    "glm-4.5-air": "deepseek-v4-flash",
    "glm-5-turbo": "deepseek-v4-flash",
  },
  failoverGroups: [],
  failoverBackoffMs: [60000, 300000, 600000],
  schedules: [],
  compact: { enabled: true, safetyPct: 0.95, windowDefault: 128000, window: { "glm-5.2": 1000000 }, maxOverflowRetries: 2 },
  concurrency: null,
};

const NEW = migrateConfig(FILE, OVERRIDES);

// ── shape ──────────────────────────────────────────────────────────────────
check("profiles native + failover", Object.keys(NEW.profiles).sort(), ["failover", "native"]);
check("defaultProfile native", NEW.defaultProfile, "native");
check("auto.steps", NEW.auto.steps, [{ profile: "native" }, { profile: "failover", when: "limit" }]);
check("auto.recover", NEW.auto.recover, true);
check("failover bind = pairs", NEW.profiles.failover.bind, OVERRIDES.failover);
check("routes carried verbatim", NEW.routes, FILE.routes);
check("concurrency from file (override null)", NEW.concurrency, FILE.concurrency);
check("tokenPrices from overrides", NEW.tokenPrices, OVERRIDES.tokenPrices);
check("compact from overrides", NEW.compact, OVERRIDES.compact);
check("backoff from overrides", NEW.failoverRecoveryBackoffMs, OVERRIDES.failoverBackoffMs);
check("glmPlan/plans carried", [NEW.glmPlan, NEW.plans], ["max", { glm: 64.8 }]);
check("no legacy keys", ["failover", "failoverGroups", "schedules"].filter((k) => k in NEW), []);

// ── TRAFFIC EQUIVALENCE (the core guarantee) ─────────────────────────────────
const models = ["glm-5.2", "glm-5.1", "glm-4.7", "glm-4.5-air", "glm-5-turbo", "glm-4.5",
  "claude-opus-4-8", "deepseek-v4-pro", "qwen/x", "google/gemini-2.5-flash-lite"];
const routes = FILE.routes;
const oldFp = routingFingerprint(models, { routes, normal: (m) => m, failover: (m) => legacyBackup(OVERRIDES.failover, m) ?? m });
const newFp = routingFingerprint(models, { routes, normal: (m) => resolveAlias(NEW, "native", m), failover: (m) => resolveAlias(NEW, "failover", m) });
check("routing fingerprint OLD === NEW (all models, both states)", newFp, oldFp);

// spot-checks of intent
check("glm-5.2 failover → anthropic", newFp["glm-5.2"].failover.host, "api.anthropic.com");
check("glm-4.7 failover → deepseek", newFp["glm-4.7"].failover.host, "api.deepseek.com");
check("glm-4.5 (no pair) failover stays z.ai", newFp["glm-4.5"].failover.host, "api.z.ai");
check("normal glm-5.2 → z.ai", newFp["glm-5.2"].normal.host, "api.z.ai");

// ── schedule migration ────────────────────────────────────────────────────────
const withSched = migrateConfig(FILE, { ...OVERRIDES, schedules: [{ match: "glm-5.2", to: "minimax/minimax-m3", tz: "+03:00", windows: [["14:00", "18:00"]] }] });
check("schedule → a scheduled profile", withSched.auto.schedules.length, 1);
check("scheduled profile binds the target", resolveAlias(withSched, withSched.auto.schedules[0].profile, "glm-5.2"), "minimax/minimax-m3");

// ── report ─────────────────────────────────────────────────────────────────
if (fails.length) {
  console.log("MIGRATE SELF-TEST:");
  fails.forEach((f) => console.log(f));
  console.log(`\nFAIL — ${fails.length} case(s) failed`);
  process.exit(1);
}
console.log(`PASS — ${pass} passed`);
