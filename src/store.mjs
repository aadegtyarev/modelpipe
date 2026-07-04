// modelpipe persistence — a tiny JSON file store under ~/.modelpipe/ that survives
// restarts. Three files live here:
//   • sessions.json  — archived session history (up to MAX_SESSIONS)
//   • state.json     — the CURRENT live session (providers/models/timeline/startedAt),
//                      flushed periodically + on shutdown so a crash loses at most a
//                      few seconds instead of the whole session
//   • overrides.json — dashboard-set config overrides (tokenPrices, failover pairs) so
//                      runtime edits survive a restart without touching the config FILE
//
// The directory is overridable via MODELPIPE_DIR (used by tests for a hermetic temp dir).
// Every read/write is best-effort: a failure returns the fallback / false, never throws —
// persistence must never take the proxy down.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const MODELPIPE_DIR = process.env.MODELPIPE_DIR || path.join(os.homedir(), ".modelpipe");

function ensureDir() {
  try { fs.mkdirSync(MODELPIPE_DIR, { recursive: true }); } catch { /* best-effort */ }
}

// Read a JSON file from the store dir; returns `fallback` on any miss (absent, unreadable,
// or malformed). Never throws.
export function readJson(name, fallback = null) {
  try {
    const p = path.join(MODELPIPE_DIR, name);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

// Write a JSON file to the store dir (creating it if needed). Atomic: write a temp file
// then rename over the target, so a crash mid-write can't leave a half-written (corrupt)
// file. Returns true on success, false on any failure. Never throws.
export function writeJson(name, data) {
  try {
    ensureDir();
    const target = path.join(MODELPIPE_DIR, name);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
    fs.renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

export const SESSIONS_FILE = "sessions.json";
export const STATE_FILE = "state.json";
export const OVERRIDES_FILE = "overrides.json";
