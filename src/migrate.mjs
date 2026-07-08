// modelpipe — one-shot config migration: legacy failover/failoverGroups/schedules (+ the live
// runtime overrides persisted in ~/.modelpipe/overrides.json) → routing PROFILES (docs/profiles.md).
//
// PURE transform (no I/O, no router.mjs dependency): migrateConfig(fileConfig, overrides) → newConfig.
// The CLI wrapper (bin/) reads the files, calls this, and writes the result with a backup.
//
// TRAFFIC-PRESERVING by construction: the legacy `failover` pairs become ONE `failover` profile
// whose `bind` is exactly those pairs; `native` (empty bind) is the head. Because every glm-* model
// shares the SAME z.ai account pool, a provider exhaustion hits them together, so the coordinated
// profile shift reaches the SAME per-model destinations the independent pairs did. Routes, accounts,
// concurrency, compact, tokenPrices, and plan metadata are carried over verbatim (live overrides win).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { globToRegExp } from "./profiles.mjs";

// First route whose match glob covers `model` (the router's pickRoute, replicated here so this
// module needs no import from router.mjs while the router is being refactored).
export function routeFor(model, routes) {
  if (typeof model !== "string" || !model.length || !Array.isArray(routes)) return null;
  for (const r of routes) {
    if (r && typeof r.match === "string" && globToRegExp(r.match).test(model)) return r;
  }
  return null;
}

// The legacy per-model failover backup for `model` — same semantics as the old pickFailoverModel
// (keys are model globs; first match wins).
export function legacyBackup(failover, model) {
  if (!failover || typeof failover !== "object" || typeof model !== "string") return null;
  for (const [pattern, backup] of Object.entries(failover)) {
    if (typeof pattern === "string" && typeof backup === "string" && globToRegExp(pattern).test(model)) return backup;
  }
  return null;
}

// Build the new config. `overrides` is the parsed ~/.modelpipe/overrides.json (the AUTHORITATIVE
// live state — the file's own _failover_doc says failover lives there, not in routes.json); a
// missing field falls back to the file config. Legacy keys are dropped from the output.
export function migrateConfig(fileConfig, overrides = {}) {
  const ov = overrides || {};
  const out = {};

  // 1. Verbatim carry-over (live override wins where present).
  if (fileConfig.listen) out.listen = fileConfig.listen;
  if (fileConfig.dashboard !== undefined) out.dashboard = fileConfig.dashboard;
  const concurrency = ov.concurrency != null ? ov.concurrency : fileConfig.concurrency;
  if (concurrency) out.concurrency = concurrency;
  if (fileConfig.glmPlan !== undefined) out.glmPlan = fileConfig.glmPlan;
  if (fileConfig.plans !== undefined) out.plans = fileConfig.plans;
  // tokenPrices: MERGE file + live override (override wins per key) — mirrors the running router
  // (createRouter does `{...file, ...override}`), so a file-only price entry isn't dropped.
  const tokenPrices = { ...(fileConfig.tokenPrices || {}), ...(ov.tokenPrices || {}) };
  if (Object.keys(tokenPrices).length) out.tokenPrices = tokenPrices;
  // compact: the live override wins only when it's a NON-EMPTY object (an empty {} is not a real
  // config and must not clobber the file's compaction settings).
  const compact = (ov.compact && Object.keys(ov.compact).length) ? ov.compact : fileConfig.compact;
  if (compact) out.compact = compact;
  if (Array.isArray(ov.failoverBackoffMs) && ov.failoverBackoffMs.length) out.failoverRecoveryBackoffMs = ov.failoverBackoffMs;
  else if (Array.isArray(fileConfig.failoverRecoveryBackoffMs)) out.failoverRecoveryBackoffMs = fileConfig.failoverRecoveryBackoffMs;
  if (typeof fileConfig.failoverRecoveryIntervalMs === "number") out.failoverRecoveryIntervalMs = fileConfig.failoverRecoveryIntervalMs;
  if (typeof fileConfig.maxBodyBytes === "number") out.maxBodyBytes = fileConfig.maxBodyBytes;
  if (typeof fileConfig.proxyUrl === "string") out.proxyUrl = fileConfig.proxyUrl;

  // 2. Routes are unchanged — the backend catalog is untouched by the profile layer.
  out.routes = fileConfig.routes;

  // 3. Legacy failover pairs → a single `failover` profile whose bind IS those pairs.
  const failover = (ov.failover && Object.keys(ov.failover).length) ? ov.failover
    : (fileConfig.failover && Object.keys(fileConfig.failover).length) ? fileConfig.failover : {};
  const bind = {};
  for (const [alias, backup] of Object.entries(failover)) {
    if (typeof alias === "string" && typeof backup === "string" && backup !== alias) bind[alias] = backup;
  }

  out.profiles = { native: { bind: {} } };
  out.defaultProfile = "native";
  const steps = [{ profile: "native" }];
  if (Object.keys(bind).length) {
    out.profiles.failover = { bind };
    steps.push({ profile: "failover", when: "limit" });
  }

  // 4. Legacy schedules → auto.schedules (map { match,to } pairs to profiles). Rare; here usually
  //    empty. Each distinct `to` target gets its own scheduled profile.
  const schedules = [];
  const legacyScheds = (Array.isArray(ov.schedules) && ov.schedules.length) ? ov.schedules
    : (Array.isArray(fileConfig.schedules) ? fileConfig.schedules : []);
  for (const [i, s] of legacyScheds.entries()) {
    if (!s || typeof s.to !== "string" || typeof s.match !== "string") continue;
    const pname = `sched-${i}-${s.to.replace(/[^a-z0-9]+/gi, "-")}`;
    out.profiles[pname] = { bind: { [s.match]: s.to } };
    schedules.push({ profile: pname, tz: s.tz == null ? "Z" : s.tz, windows: s.windows || [] });
  }

  out.auto = { steps, recover: true };
  if (schedules.length) out.auto.schedules = schedules;

  return out;
}

// A routing FINGERPRINT for equivalence checking: for a set of client model ids, the destination
// (route match + backend host) in the NORMAL and FAILOVER states, computed for BOTH configs so a
// diff proves traffic is (un)changed. Pure. `hostOf(route)` extracts the backend host.
export function routingFingerprint(models, { routes, normal, failover }) {
  // normal(model) → the effective model id in the normal state; failover(model) → in the shifted state.
  const fp = {};
  for (const m of models) {
    const nModel = normal(m);
    const fModel = failover(m);
    const nRoute = routeFor(nModel, routes);
    const fRoute = routeFor(fModel, routes);
    fp[m] = {
      normal:   { model: nModel, match: nRoute ? nRoute.match : null, host: hostOf(nRoute) },
      failover: { model: fModel, match: fRoute ? fRoute.match : null, host: hostOf(fRoute) },
    };
  }
  return fp;
}

function hostOf(route) {
  if (!route || typeof route.base_url !== "string") return null;
  try { return new URL(route.base_url).host; } catch { return null; }
}

// ── CLI: `modelpipe migrate [config.json] [--overrides <path>] [--dry-run] [--out <path>]` ──
// Reads the legacy config + the live runtime overrides (~/.modelpipe/overrides.json — the
// authoritative live state), migrates to profiles, validates with the REAL validateConfig, and
// (unless --dry-run) backs up the original next to it and writes the migrated config in place.
function timestamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function runMigrate(argv = []) {
  const flags = argv.filter((a) => a.startsWith("--"));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const flagVal = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const dryRun = flags.includes("--dry-run");
  const configPath = positional[0] || "routes.json";
  const outPath = flagVal("--out") || configPath;
  const modelpipeDir = process.env.MODELPIPE_DIR || path.join(os.homedir(), ".modelpipe");
  const overridesPath = flagVal("--overrides") || path.join(modelpipeDir, "overrides.json");

  if (!fs.existsSync(configPath)) { process.stderr.write(`migrate: config not found: ${configPath}\n`); return 1; }
  const fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  let overrides = {};
  if (fs.existsSync(overridesPath)) {
    try { overrides = JSON.parse(fs.readFileSync(overridesPath, "utf8")); process.stderr.write(`migrate: merged live overrides from ${overridesPath}\n`); }
    catch { process.stderr.write(`migrate: could not parse ${overridesPath} — migrating file config only\n`); }
  } else {
    process.stderr.write(`migrate: no overrides at ${overridesPath} — migrating file config only\n`);
  }

  const migrated = migrateConfig(fileConfig, overrides);

  // Validate with the REAL validator (dynamic import avoids any load-order coupling with router).
  const { validateConfig } = await import("./router.mjs");
  try { validateConfig(migrated); }
  catch (e) { process.stderr.write(`migrate: the migrated config FAILED validation — nothing written: ${e.message}\n`); return 1; }

  const out = JSON.stringify(migrated, null, 2) + "\n";
  if (dryRun) { process.stdout.write(out); return 0; }

  // Back up the original before overwriting (only when writing over it in place).
  if (fs.existsSync(outPath)) {
    const bak = `${outPath}.bak-${timestamp()}`;
    fs.copyFileSync(outPath, bak);
    process.stderr.write(`migrate: backed up ${outPath} -> ${bak}\n`);
  }
  fs.writeFileSync(outPath, out, "utf8");
  const pnames = Object.keys(migrated.profiles || {});
  process.stderr.write(`migrate: wrote ${outPath} — profiles [${pnames.join(", ")}], default "${migrated.defaultProfile}"\n`);
  process.stderr.write(`migrate: restart the proxy to apply (systemctl --user restart modelpipe).\n`);
  return 0;
}
