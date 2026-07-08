// modelpipe — routing PROFILES (pure resolver).
//
// A PROFILE is a named snapshot of alias→target bindings ("which model goes where right
// now"). A client sends a stable alias (e.g. `glm-5.2`); the ACTIVE profile decides what
// that alias actually resolves to. The active profile is chosen by a resolver whose priority
// is: manual pin > error-shift > schedule > default. This module is PURE — it owns no I/O and
// mutates nothing; the router drives state transitions and passes state in. See docs/profiles.md.
//
// This module OWNS the small time-window helpers (parseTzOffset/parseHHMM/inWindow) and a local
// globToRegExp so it stays cycle-free (router.mjs imports FROM here, never the reverse).

// ── glob (only `*`) ───────────────────────────────────────────────────────────
// Local copy so this module has no import from router.mjs (which imports this one).
export function globToRegExp(glob) {
  const escaped = String(glob).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

// ── time windows (fixed UTC offset, evaluated against the system clock) ─────────
// Parse a fixed UTC offset ("+08:00" | "+08" | "-0530" | "Z" | "UTC" | "") into minutes east
// of UTC. null when malformed. Empty / "Z" / "UTC" ⇒ 0.
export function parseTzOffset(tz) {
  if (tz == null || tz === "" || tz === "Z" || tz === "UTC") return 0;
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(String(tz));
  if (!m) return null;
  const hh = Number(m[2]);
  const mm = Number(m[3] || 0);
  if (hh > 23 || mm > 59) return null;
  return (m[1] === "-" ? -1 : 1) * (hh * 60 + mm);
}

// Parse "H:MM" / "HH:MM" into minute-of-day (0..1439); null when malformed.
export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

// Is minute-of-day `minute` inside [from, to)? from > to wraps past midnight; from === to is
// an empty window (never active).
export function inWindow(minute, from, to) {
  if (from === to) return false;
  return from < to ? (minute >= from && minute < to) : (minute >= from || minute < to);
}

function minuteOfDayAt(nowMs, offsetMinutes) {
  const shifted = nowMs + offsetMinutes * 60000;
  const dayMs = ((shifted % 86400000) + 86400000) % 86400000;
  return Math.floor(dayMs / 60000);
}

// ── profile bindings ────────────────────────────────────────────────────────────
// The `bind` map of a named profile, or {} when the profile is absent/shapeless.
export function profileBind(config, name) {
  const p = config && config.profiles && config.profiles[name];
  return (p && p.bind && typeof p.bind === "object") ? p.bind : {};
}

// Resolve an incoming model id through a profile's bindings: the target of the FIRST alias
// glob that matches, else the model unchanged (no rewrite). This is what the router feeds to
// rewriteModelInBody before route matching.
export function resolveAlias(config, profileName, model) {
  if (typeof model !== "string" || model.length === 0) return model;
  const bind = profileBind(config, profileName);
  for (const [alias, target] of Object.entries(bind)) {
    if (typeof target === "string" && target.length && globToRegExp(alias).test(model)) return target;
  }
  return model;
}

// ── auto-chain helpers ────────────────────────────────────────────────────────
function steps(config) {
  const s = config && config.auto && config.auto.steps;
  return Array.isArray(s) ? s : [];
}

// The index of a profile name in the auto chain, or -1 when it is not a chain member
// (i.e. a manual-only profile).
export function stepIndex(config, name) {
  return steps(config).findIndex((s) => s && s.profile === name);
}

// The base profile when nothing else selects: explicit defaultProfile, else the chain head,
// else the first declared profile, else null.
export function defaultProfile(config) {
  // Only honor an explicit defaultProfile that actually names a declared profile — else fall
  // through (chain head / first). validateConfig enforces this at load, but a stale value on any
  // unguarded path would otherwise make resolveAlias a silent no-op instead of routing sanely.
  if (config && typeof config.defaultProfile === "string" && config.profiles && config.profiles[config.defaultProfile]) return config.defaultProfile;
  const st = steps(config);
  if (st.length && st[0] && typeof st[0].profile === "string") return st[0].profile;
  const names = config && config.profiles ? Object.keys(config.profiles) : [];
  return names.length ? names[0] : null;
}

// The profile selected by an open schedule window at epoch `nowMs`, else null. First entry
// with an open window wins.
export function scheduleProfile(config, nowMs) {
  const scheds = config && config.auto && Array.isArray(config.auto.schedules) ? config.auto.schedules : [];
  for (const s of scheds) {
    if (!s || typeof s.profile !== "string") continue;
    const off = parseTzOffset(s.tz);
    if (off == null) continue;
    const minute = minuteOfDayAt(nowMs, off);
    const windows = Array.isArray(s.windows) ? s.windows : [];
    for (const w of windows) {
      const from = parseHHMM(w && w[0]);
      const to = parseHHMM(w && w[1]);
      if (from == null || to == null) continue;
      if (inWindow(minute, from, to)) return s.profile;
    }
  }
  return null;
}

// The intended head: manual pin > open schedule > default. A pin to a name that does not exist
// as a profile is ignored (falls through) — fail-safe.
export function intendedHead(config, state, nowMs) {
  const pin = state && state.pinned;
  if (typeof pin === "string" && config && config.profiles && config.profiles[pin]) return pin;
  return scheduleProfile(config, nowMs) ?? defaultProfile(config);
}

// The effective active profile given the intended head and the error-shift offset.
//   { active, intended, source, shifted, offset }
// source is why `intended` is what it is (manual|schedule|default). `shifted` (offset moved
// the active BELOW the intended along the chain) is tracked separately, so a manual pin that
// is ALSO error-shifted reads source:"manual", shifted:true.
// An intended profile that is NOT a chain member cannot shift (offset forced to 0) — on error
// the router clears the pin, so a live offset only ever applies to a chain profile.
export function effectiveProfile(config, state, nowMs) {
  const intended = intendedHead(config, state, nowMs);
  const pin = state && state.pinned;
  const source = (typeof pin === "string" && config && config.profiles && config.profiles[pin]) ? "manual"
    : (scheduleProfile(config, nowMs) != null ? "schedule" : "default");
  const st = steps(config);
  const pos = stepIndex(config, intended);
  const offset = pos < 0 ? 0 : Math.max(0, (state && state.offset) || 0);
  let active = intended;
  let shifted = false;
  if (pos >= 0 && st.length) {
    const eff = Math.min(pos + offset, st.length - 1);
    active = st[eff].profile;
    shifted = eff > pos;
  }
  return { active, intended, source, shifted, offset };
}

// Does an error of `errorClass` ("limit" | "5xx") advance the chain from the step at
// `fromIndex` to the next step? True only when a next step exists and its `when` matches the
// class (a step's `when` defaults to "limit" when omitted).
export function stepAdvancesOn(config, fromIndex, errorClass) {
  const st = steps(config);
  const next = st[fromIndex + 1];
  if (!next) return false;
  const when = next.when || "limit";
  return when === errorClass;
}

// ── banner / statusline summary ─────────────────────────────────────────────────
// The list of alias bindings where the ACTIVE profile differs from the DEFAULT profile — i.e.
// what actually moved. Each entry: { alias, from, to, fromProvider, toProvider }. `providerOf`
// is an optional (modelId) => providerLabel callback (the router supplies one via routes);
// absent ⇒ providers are null. `from` is the alias's target under the default profile (what the
// client still "believes"), `to` its target under the active profile.
export function bindingDelta(config, activeName, providerOf = null) {
  const base = defaultProfile(config);
  const activeBind = profileBind(config, activeName);
  const baseBind = profileBind(config, base);
  const aliases = new Set([...Object.keys(activeBind), ...Object.keys(baseBind)]);
  const out = [];
  for (const alias of aliases) {
    // Resolve the alias glob itself through each profile: an alias key is used verbatim as the
    // sample model id, so a literal id maps cleanly and a glob shows its own pattern.
    const from = resolveAlias(config, base, alias);
    const to = resolveAlias(config, activeName, alias);
    if (from === to) continue;
    out.push({
      alias,
      from,
      to,
      fromProvider: providerOf ? providerOf(from) : null,
      toProvider: providerOf ? providerOf(to) : null,
    });
  }
  return out;
}

// The full banner payload for the dashboard. Pure: reads config + state + clock, plus optional
// callbacks the router injects (providerOf for labels, recoveryMsOf for the recovery ETA).
//   { active, intended, source, shifted, changes, recoversInSec }
// `changes` is bindingDelta(active). `recoversInSec` is the ETA to the next recovery probe when
// shifted, else null. Silent-when-default is the CALLER's choice (changes may be empty).
export function routingSummary(config, state, nowMs, { providerOf = null, recoveryMs = 0 } = {}) {
  const eff = effectiveProfile(config, state, nowMs);
  const changes = bindingDelta(config, eff.active, providerOf);
  let recoversInSec = null;
  if (eff.shifted && recoveryMs > 0) {
    const due = ((state && state.shiftedAt) || 0) + recoveryMs;
    recoversInSec = Math.max(0, Math.ceil((due - nowMs) / 1000));
  }
  return { active: eff.active, intended: eff.intended, source: eff.source, shifted: eff.shifted, changes, recoversInSec };
}
