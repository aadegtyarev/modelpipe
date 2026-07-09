# Routing profiles

> Replaces the older `failover`, `failoverGroups`, `schedules`, and dashboard model-overrides
> with one concept: **profiles**. `modelpipe migrate <config.json>` rewrites an old config in
> place.

## The idea

A client (Claude Code) sends a stable model id — an **alias**, e.g. `glm-5.2`. What that
alias *actually* resolves to is decided by the **active profile**. A profile is a named
snapshot of alias→target bindings — "which model goes where right now". Changing the active
profile re-points every alias at once (one global ladder).

Two levels, stacked:

```
accounts   rotate keys WITHIN one provider (e.g. two z.ai subscriptions)   ← lower
profiles   what each alias resolves to (a whole coherent world)            ← upper
```

A rate-limit is handled bottom-up: first `accounts` rotates keys inside the provider; only
when a provider's whole pool is drained does the profile ladder step.

`routes`, `accounts`, `strategy`, `compact`, `concurrency` are **unchanged** — a profile only
rewrites the incoming `model` id before route matching (the same rewrite primitive the old
`schedules`/`failover` used), then all existing machinery runs.

## Config

```json
{
  "profiles": {
    "native":        { "bind": {} },
    "glm-on-sonnet": { "bind": { "glm-5.2": "claude-sonnet-5" } },
    "econ-opus":     { "bind": { "claude-opus-*": "glm-5.2", "glm-5.2": "claude-sonnet-5" } }
  },
  "defaultProfile": "native",
  "auto": {
    "steps": [
      { "profile": "native" },
      { "profile": "glm-on-sonnet", "when": "limit" }
    ],
    "recover": true,
    "schedules": [
      { "profile": "budget", "tz": "+03:00", "windows": [["14:00", "18:00"]] }
    ],
    "retry": { "attempts": 2, "delayMs": 1500 }
  }
}
```

- **`profiles`** — a flat pool of named worlds. `bind` maps an alias glob (`*` only) to a
  concrete target model id (which must resolve to a `routes` entry). An empty `bind` = every
  alias routes to its own backend (no rewrite). First matching alias glob wins.
- **`auto.steps`** — the ordered subset that steps **automatically**, best→fallback. `steps[0]`
  is the head. Each later step carries `when` (the error class that steps *down to* it):
  `"limit"` (429/529/quota/overload — the failover-trigger; default when omitted) or `"5xx"`.
- **Membership in `auto.steps` = automatic. Absence = manual-only.** `econ-opus` above is
  manual-only. A profile may be both in the chain and hand-pinnable.
- **`auto.recover`** — when true, a background probe winds the pointer back up to the intended
  head once the higher step's backend recovers.
- **`auto.schedules`** — time windows that set the intended profile (proactive cost control).
  `tz` is a fixed UTC offset (`"+03:00"`/`"Z"`), `windows` are `[["HH:MM","HH:MM"]]` pairs.
- **`auto.retry`** — `{ attempts, delayMs? }`, off by default (`attempts: 0`). Before spending a
  failover hop (account rotation or a step down the ladder), retry the identical request against
  the **same** backend/account up to `attempts` times — a one-off blip gets a second chance
  instead of immediately burning the cascade. Gated by `isRetryWorthy`: a **hard**, long-duration
  exhaustion (a weekly/monthly plan quota, a disabled org/account, payment required) is never
  retried — it will fail again regardless — and goes straight to failover; a plain rate-limit/
  overload/5xx blip remains retry-worthy. Editable in the dashboard next to "Switching rules
  (auto chain)", or via `POST /v1/profiles/config`.
- **`defaultProfile`** — the base when nothing else selects; defaults to `auto.steps[0]`.

## The resolver

The active profile is:

```
intendedHead = manual pin  ??  open schedule window  ??  defaultProfile
active       = intendedHead, stepped DOWN auto.steps by error-shift (offset)
```

Priority: **manual > error > schedule > default**.

**Safety is always armed.** A manual pin does *not* silence the error trigger. A failover-error
under any active profile (including a manual-only pin like `econ-opus`) **clears the pin**; the
resolver then falls back to schedule/default (the chain head), and the normal error cascade
walks `auto.steps` down to the safety step. No "stuck on a dead backend", no special-case code —
the existing cascade does it.

### Cascade & recovery

- A step-down only actually re-points aliases whose `bind` **differs** between the two steps; an
  alias on a healthy independent provider keeps the same target across steps → untouched.
- Recovery probes only the **delta** backends between adjacent steps. Healthy → wind up.
- One global ladder assumes a dominant failure axis. Two providers failing *independently*, each
  needing a private fallback, is out of scope by design (that was independent groups). Within-
  provider key/quota exhaustion is handled below the ladder by `accounts`.

### Runtime state (per process, persisted under `~/.modelpipe/`)

```
{ pinned: string|null, offset: number, shiftedAt: number, attempts: number }
```

`effectiveProfile(config, state, now)` resolves this to
`{ active, intended, source, shifted, offset }` (source: `manual|schedule|error|default`),
consumed by the dashboard banner, the statusline, and compaction (window of `active`'s targets).

## Dashboard banner (the redesign)

The old banner said `glm-5.2 → rerouted to backup` — it never knew the target because the
failover-pair state stored only `{ enteredAt }`. The profile state knows the active profile and
every binding, so the banner shows **which alias went where**:

**Error-shift (anomaly → orange):**

```
⚠ Failover active — profile “glm-on-sonnet”
   z.ai exhausted 04:32 · recovers in ~2m (probing z.ai)
   glm-5.2        → claude-sonnet-5      z.ai → Anthropic
   claude-opus-*  → glm-5.1              Anthropic → z.ai
```

**Manual pin (operator → blue):**

```
📌 Profile pinned — “econ-opus” (manual)
   claude-opus-*  → glm-5.2             Anthropic → z.ai
   glm-5.2        → claude-sonnet-5     z.ai → Anthropic
   ↓ safety armed — auto-failover still active
```

**Schedule (intentional saving → green):**

```
💸 Scheduled profile — “budget”  (peak 14:00–18:00 +03:00)
   glm-5.2        → minimax/minimax-m3  z.ai → OpenRouter
```

Each line is a binding of the active profile that **differs from the default profile** (only what
moved is shown). `alias → target`, then the `fromProvider → toProvider` transition. Silent when
the active profile is the default (the model cards already show steady-state routing).

## Migration

Clean break: `failover`, `failoverGroups`, `schedules`, and top-level dashboard overrides are
removed. `modelpipe migrate <config.json>` rewrites an old config into `profiles` + `auto` in
place (backup written alongside). A config carrying both old and new fields is a startup error.
