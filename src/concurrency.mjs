// ── Per-backend concurrency limiter ─────────────────────────────────────────
// Some providers cap SIMULTANEOUS requests per subscription/key — e.g. the z.ai GLM
// Coding Plan allows only a handful of glm-5.2 requests in flight at once. Firing the
// N+1th request just earns a 429, which the failover path then "fixes" by DEGRADING to a
// weaker backup model. That's the wrong cure for a transient over-parallelism: the model
// isn't down, it's momentarily busy.
//
// This limiter instead HOLDS the N+1th request in a FIFO queue until an in-flight slot
// frees, so the client keeps the strong model — it just waits a moment. The limit is per
// `${providerId}::${model}` (the caller builds the key): with an account pool each
// account/key gets its own N, because providerId resolves to the account label — matching
// how a provider actually meters the limit (per subscription/key), and letting a pool of
// two accounts carry 2×N concurrent for free.
//
// No configured limit for a model ⇒ Infinity ⇒ acquire() resolves synchronously with a
// no-op release: zero overhead and zero added state on the hot path. When a limit IS set,
// the queue is bounded only by a per-request wait timeout — a waiter not served within
// timeoutMs rejects with { code: "QUEUE_TIMEOUT" }, and the caller treats that exactly like
// a 429 from the backend (account rotation → model failover), the "wait, then failover"
// safety valve so a saturated backend can't hang a request past the client's own timeout.

export class ConcurrencyLimiter {
  constructor() {
    // key -> { active: number, limit: number, waiters: [{ resolve, reject, timer }] }
    // An entry exists only while a key has active holders or queued waiters; it is deleted
    // when both reach zero, so an idle limiter holds no per-model state.
    this.slots = new Map();
  }

  // Acquire a slot for `key` bounded by `limit`. Resolves to a release() function once a
  // slot is free (immediately if under the limit). `limit` <= 0 or Infinity means unlimited
  // — resolves synchronously with a no-op release. When `timeoutMs` > 0, a waiter that
  // isn't served in time rejects with an Error whose `.code` is "QUEUE_TIMEOUT".
  acquire(key, limit, timeoutMs = 0) {
    if (!(limit > 0) || limit === Infinity) return Promise.resolve(() => {});
    let s = this.slots.get(key);
    if (!s) { s = { active: 0, limit, waiters: [] }; this.slots.set(key, s); }
    else { s.limit = limit; } // pick up a runtime-edited limit for future admission decisions

    if (s.active < s.limit) {
      s.active++;
      return Promise.resolve(this.#makeRelease(key, s));
    }

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const i = s.waiters.indexOf(waiter);
          if (i >= 0) s.waiters.splice(i, 1);
          if (s.active === 0 && s.waiters.length === 0) this.slots.delete(key);
          const e = new Error(`concurrency queue wait exceeded ${timeoutMs}ms for ${key}`);
          e.code = "QUEUE_TIMEOUT";
          reject(e);
        }, timeoutMs);
        // Don't let a pending queue timer keep the process alive on shutdown.
        if (typeof waiter.timer.unref === "function") waiter.timer.unref();
      }
      s.waiters.push(waiter);
    });
  }

  // Build a single-use release for one acquired slot. Idempotent — safe to wire onto several
  // terminal events (upstream end/close/error, client disconnect); only the first call frees
  // the slot, the rest are no-ops.
  #makeRelease(key, s) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      s.active--;
      this.#drain(key, s);
    };
  }

  // Admit as many queued waiters as the (possibly runtime-lowered) limit now allows, then
  // drop the key entry if it went fully idle.
  #drain(key, s) {
    while (s.waiters.length > 0 && s.active < s.limit) {
      const w = s.waiters.shift();
      if (w.timer) clearTimeout(w.timer);
      s.active++;
      w.resolve(this.#makeRelease(key, s));
    }
    if (s.active <= 0 && s.waiters.length === 0) this.slots.delete(key);
  }

  // Honest live snapshot for the dashboard — real active/queued counts, never a guess.
  // [{ key, active, limit, queued }], busiest first.
  snapshot() {
    const out = [];
    for (const [key, s] of this.slots) {
      out.push({ key, active: s.active, limit: s.limit, queued: s.waiters.length });
    }
    out.sort((a, b) => (b.active + b.queued) - (a.active + a.queued));
    return out;
  }
}

// First-match-wins resolution of a model id to its configured concurrency limit. Mirrors
// compact.window semantics: the concurrency map is { modelGlob: maxInt }, iterated in
// insertion order so a specific id (glm-5.2) must precede a broad glob (glm-*). An unmatched
// model has no limit (Infinity) — the gate is opt-in per model, never a global throttle.
export function resolveConcurrencyLimit(concurrency, model) {
  if (!concurrency || typeof concurrency !== "object" || typeof model !== "string") return Infinity;
  for (const [glob, limit] of Object.entries(concurrency)) {
    if (globMatch(glob, model)) return limit;
  }
  return Infinity;
}

function globMatch(glob, s) {
  if (typeof s !== "string") return false;
  return new RegExp("^" + glob.split("*").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(s);
}
