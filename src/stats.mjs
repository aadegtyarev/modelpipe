// modelpipe stats — per-provider usage tracking, SSE parsing, quota polling, dashboard.
//
// StatsCollector — in-memory accumulator of per-provider token/request stats.
// createUsageTracker — Transform stream that parses the Anthropic SSE stream as it
//   passes through, extracting input_tokens / output_tokens and recording them on
//   stream end. Zero buffering — data is pushed through immediately.
// QuotaPoller — periodic calls to provider billing APIs that actually exist (DeepSeek
//   balance, OpenRouter credits). Anthropic has no such GET endpoint — its limits come
//   from live response headers (recordRatelimitHeaders), not a poll.
// DASHBOARD_HTML — the dashboard page, read from public/dashboard.html at load.
//
// All exposed data is real: measured tokens/requests, real per-token cost for metered
// providers, and real provider-API balances. No fabricated quota/subscription estimates.

import { Transform } from "node:stream";
import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { readJson, writeJson, SESSIONS_FILE, STATE_FILE } from "./store.mjs";

const MAX_SESSIONS = 20;

// ── StatsCollector ──────────────────────────────────────────────────────────
// Single in-memory store. Thread-safe as long as Node's event loop is the only
// concurrency (no Workers touching this).

const WINDOW_SEC = 60;
const MAX_TIMELINE = 1000;

// Model pricing per 1M tokens (USD). Only known models need an entry;
// unknown models show "—" for price.
// cacheRead (optional): price per 1M cache_read_input_tokens, when known — otherwise
// the cost calc falls back to the full input rate for that model (see usageCost).
const PRICE_MAP = {
  "claude-opus-4-8":       { input: 15,   output: 75   },
  "claude-sonnet-5":       { input: 3,    output: 15   },
  "claude-sonnet-4-6":     { input: 3,    output: 15   },
  "claude-sonnet-4-5":     { input: 3,    output: 15   },
  "claude-haiku-4-5":      { input: 0.8,  output: 4    },
  "deepseek-v4-pro":       { input: 0.435, output: 0.87, cacheRead: 0.003625 },
  "deepseek-v4-flash":     { input: 0.14, output: 0.28 },
  "deepseek-chat":         { input: 0.14, output: 0.28 },
  "GLM-5.2":               { input: 1.4,  output: 4.4,  cacheRead: 0.26  },
  "glm-5.2":               { input: 1.4,  output: 4.4,  cacheRead: 0.26  },
  "GLM-5-Turbo":           { input: 1.2,  output: 4.0  },
  "glm-5-turbo":           { input: 1.2,  output: 4.0  },
  "GLM-5.1":               { input: 1.4,  output: 4.4,  cacheRead: 0.26  },
  "glm-5.1":               { input: 1.4,  output: 4.4,  cacheRead: 0.26  },
  "GLM-5":                 { input: 1.0,  output: 3.2  },
  "glm-5":                 { input: 1.0,  output: 3.2  },
  "GLM-4.7":               { input: 0.6,  output: 2.2  },
  "glm-4.7":               { input: 0.6,  output: 2.2  },
  "google/gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "google/gemini-2.5-flash": { input: 0.3, output: 1.5 },
  "google/gemini-2.5-pro":  { input: 2.5, output: 10  },
};

// Direct API token prices — overridable via config.tokenPrices.
// Priority: config.tokenPrices > PRICE_MAP.
export function modelPrice(model, tokenPrices = null) {
  if (tokenPrices && tokenPrices[model]) return tokenPrices[model];
  // Fuzzy: try matching by prefix (e.g. "claude-opus-*" matches any claude-opus variant)
  if (tokenPrices) {
    for (const [key, p] of Object.entries(tokenPrices)) {
      if (key.includes("*") && globMatch(key, model)) return p;
    }
  }
  return PRICE_MAP[model] || null;
}

function globMatch(pattern, str) {
  return new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(str);
}

// cache_read_input_tokens are billed at price.cacheRead when the price entry sets it;
// otherwise fall back to the full input rate (conservative — avoids under-counting cost
// for models nobody has bothered to add a cacheRead rate for yet).
function usageCost(inputTokens, cacheReadTokens, outputTokens, price) {
  if (!price) return 0;
  const cacheReadRate = price.cacheRead != null ? price.cacheRead : price.input;
  return (inputTokens * price.input + (cacheReadTokens || 0) * cacheReadRate + outputTokens * price.output) / 1_000_000;
}

// PURE STATS

export class StatsCollector {
  #providers = new Map();
  #models = new Map();
  #timeline = [];
  #ratelimitHeaders = new Map();
  #startedAt = Date.now();
  #sessions = [];
  #autosave = null;
  #dirty = false;

  constructor() {
    this.#loadSessions();
    this.#loadState(); // resume the live session from disk (survives a crash/restart)
  }

  record(entry) {
    const pid = entry.providerId;
    const mid = entry.model || "unknown";
    entry.ts = entry.ts || Date.now();

    // per-provider
    let p = this.#providers.get(pid);
    if (!p) {
      p = { requests: 0, errors: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, lastRequestAt: 0 };
      this.#providers.set(pid, p);
    }
    p.requests++;
    if (entry.status >= 400) p.errors++;
    p.inputTokens += entry.inputTokens || 0;
    p.cacheReadTokens += entry.cacheReadTokens || 0;
    p.outputTokens += entry.outputTokens || 0;
    p.lastRequestAt = entry.ts;

    // per-model
    let m = this.#models.get(mid);
    if (!m) {
      m = { providerId: pid, requests: 0, errors: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, lastRequestAt: 0 };
      this.#models.set(mid, m);
    }
    m.requests++;
    if (entry.status >= 400) m.errors++;
    m.inputTokens += entry.inputTokens || 0;
    m.cacheReadTokens += entry.cacheReadTokens || 0;
    m.outputTokens += entry.outputTokens || 0;
    m.lastRequestAt = entry.ts;

    this.#timeline.push(entry);
    if (this.#timeline.length > MAX_TIMELINE) this.#timeline.shift();
    this.#dirty = true;
  }

  // Capture anthropic-ratelimit-* response headers for the Anthropic provider.
  recordRatelimitHeaders(providerId, headers) {
    const rl = {};
    for (const [k, v] of Object.entries(headers)) {
      if (k.startsWith("anthropic-ratelimit-")) rl[k] = v;
    }
    if (Object.keys(rl).length > 0) {
      this.#ratelimitHeaders.set(providerId, { ...rl, _ts: Date.now() });
    }
  }

  snapshot(tokenPrices = null) {
    const now = Date.now();
    const cutoff = now - WINDOW_SEC * 1000;
    const recent = this.#timeline.filter((e) => e.ts >= cutoff);

    const perModel = {};
    for (const [mid, m] of this.#models) {
      const r = recent.filter((e) => e.model === mid);
      const price = modelPrice(mid, tokenPrices);
      const cost = usageCost(m.inputTokens, m.cacheReadTokens, m.outputTokens, price);
      perModel[mid] = {
        providerId: m.providerId,
        priceInput: price ? price.input : null,
        priceOutput: price ? price.output : null,
        priceCacheRead: price && price.cacheRead != null ? price.cacheRead : null,
        requests: m.requests,
        errors: m.errors,
        inputTokens: m.inputTokens,
        cacheReadTokens: m.cacheReadTokens || 0,
        outputTokens: m.outputTokens,
        cost,
        rps: r.length > 0 ? Number((r.length / WINDOW_SEC).toFixed(2)) : 0,
        lastRequestAt: m.lastRequestAt,
      };
    }

    // Session totals
    let sessionCost = 0, sessionTokens = 0, sessionReqs = 0;
    for (const m of Object.values(perModel)) {
      sessionCost += m.cost;
      sessionTokens += m.inputTokens + m.cacheReadTokens + m.outputTokens;
      sessionReqs += m.requests;
    }

    const ratelimits = {};
    for (const [id, rl] of this.#ratelimitHeaders) ratelimits[id] = rl;

    const timeline = this.#timeline.slice(-200).map((e) => {
      const pr = modelPrice(e.model, tokenPrices);
      const cost = usageCost(e.inputTokens || 0, e.cacheReadTokens || 0, e.outputTokens || 0, pr);
      return { ...e, cost };
    });

    return {
      session: { cost: sessionCost, requests: sessionReqs, tokens: sessionTokens, startedAt: this.#startedAt },
      models: perModel,
      timeline,
      ratelimits,
      windowSec: WINDOW_SEC,
      updatedAt: now,
    };
  }

  reset() {
    // Archive current session before clearing, then start a fresh live session.
    if (this.#models.size > 0 || this.#timeline.length > 0) {
      this.#archiveSession();
    }
    this.#providers.clear();
    this.#models.clear();
    this.#timeline.length = 0;
    this.#ratelimitHeaders.clear();
    this.#startedAt = Date.now();
    this.#dirty = true;
    this.saveState(); // persist the empty fresh session immediately
  }

  // ── Live-session persistence (survives crash/restart) ──────────────────────
  // The current session is flushed to STATE_FILE periodically (startAutosave) and on
  // shutdown, and restored on construction — so a crash loses at most a few seconds of
  // traffic instead of the whole session. Distinct from session HISTORY (sessions.json),
  // which holds explicitly-archived past sessions.

  #loadState() {
    const st = readJson(STATE_FILE, null);
    if (!st || typeof st !== "object") return;
    try {
      if (Array.isArray(st.providers)) this.#providers = new Map(st.providers);
      if (Array.isArray(st.models)) this.#models = new Map(st.models);
      if (Array.isArray(st.timeline)) this.#timeline = st.timeline.slice(-MAX_TIMELINE);
      if (typeof st.startedAt === "number") this.#startedAt = st.startedAt;
    } catch {
      // Corrupt state — start clean rather than crash.
      this.#providers = new Map();
      this.#models = new Map();
      this.#timeline = [];
      this.#startedAt = Date.now();
    }
  }

  // Flush the live session to disk (best-effort). Called by the autosave timer and on
  // shutdown; also directly after reset().
  saveState() {
    if (!this.#dirty) return;
    const ok = writeJson(STATE_FILE, {
      providers: [...this.#providers],
      models: [...this.#models],
      timeline: this.#timeline,
      startedAt: this.#startedAt,
    });
    if (ok) this.#dirty = false;
  }

  startAutosave(intervalMs = 10000) {
    if (this.#autosave) return;
    this.#autosave = setInterval(() => this.saveState(), intervalMs);
    this.#autosave.unref(); // never keep the process alive just to autosave
  }

  stopAutosave() {
    if (this.#autosave) { clearInterval(this.#autosave); this.#autosave = null; }
  }

  // ── Session history — up to MAX_SESSIONS archived sessions, persisted to disk ──

  #archiveSession() {
    const snap = this.snapshot();
    this.#sessions.unshift({
      id: this.#startedAt,
      startedAt: this.#startedAt,
      endedAt: Date.now(),
      session: snap.session,
      models: snap.models,
    });
    if (this.#sessions.length > MAX_SESSIONS) this.#sessions.length = MAX_SESSIONS;
    writeJson(SESSIONS_FILE, this.#sessions);
  }

  #loadSessions() {
    const s = readJson(SESSIONS_FILE, []);
    this.#sessions = Array.isArray(s) ? s : [];
  }

  sessionHistory() {
    return this.#sessions;
  }

  shutdown() {
    // Flush the live session so the next start resumes it (best-effort).
    this.stopAutosave();
    this.#dirty = true;
    this.saveState();
  }
}

// ── SSE usage tracker ───────────────────────────────────────────────────────
// A Transform stream that passes data through immediately. Parses the SSE
// byte-stream on the fly (accumulating incomplete last event in a buffer) and
// extracts usage from message_start (input_tokens) + message_delta
// (output_tokens). On stream end (flush), records the aggregated usage.
//
// NEVER buffers the full response — each chunk is pushed through as soon as it
// arrives.

// Wrap upstream response with gunzip if it's compressed, returning the readable
// stream to pipe from and a headers object with Content-Encoding stripped.
export function decompressIfNeeded(upstreamRes) {
  const ce = (upstreamRes.headers["content-encoding"] || "").toLowerCase();
  if (ce.includes("gzip") || ce.includes("deflate") || ce.includes("br")) {
    const headers = { ...upstreamRes.headers };
    delete headers["content-encoding"];
    delete headers["content-length"];
    let stream = upstreamRes;
    if (ce.includes("gzip") || ce.includes("deflate")) {
      stream = upstreamRes.pipe(zlib.createUnzip());
    } else if (ce.includes("br")) {
      stream = upstreamRes.pipe(zlib.createBrotliDecompress());
    }
    return { stream, headers, decompressed: true };
  }
  return { stream: upstreamRes, headers: upstreamRes.headers, decompressed: false };
}

// An SSE stream has its tokens extracted incrementally (from `buffer`), so we never hold
// it in full — that is the module's zero-buffer promise. Only a NON-streaming JSON reply
// needs the whole body (its usage is one top-level object the flush fallback parses), so
// `totalBuffer` accumulates ONLY for that case, bounded so a pathological body can't OOM.
const JSON_FALLBACK_CAP = 10 * 1024 * 1024;

// Anthropic-shape usage splits input into three buckets: fresh `input_tokens`,
// `cache_creation_input_tokens` (written to cache, billed at the input rate), and
// `cache_read_input_tokens` (served from cache, billed at the cheaper cacheRead rate —
// see modelPrice). Folding creation into inputTokens and keeping cacheReadTokens
// separate is what lets the cost calc price each bucket correctly.
function extractUsage(usage) {
  return {
    inputTokens: (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
    cacheReadTokens: usage.cache_read_input_tokens || 0,
  };
}

export function createUsageTracker(stats, { providerId, model, startTime }) {
  let buffer = "";
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let totalBuffer = "";
  let started = false;
  let looksJson = false;

  return new Transform({
    transform(chunk, _encoding, callback) {
      this.push(chunk);
      const text = chunk.toString("utf8");
      buffer += text;
      // Decide streaming-vs-JSON from the first non-empty chunk: an SSE stream starts with
      // `event:`/`data:`, a non-streaming reply with `{`. Accumulate the full body only for
      // the JSON case (needed by the flush fallback); an SSE stream never grows totalBuffer.
      if (!started && text.trim().length > 0) {
        started = true;
        looksJson = text.replace(/^﻿/, "").trimStart().startsWith("{");
      }
      if (looksJson && totalBuffer.length < JSON_FALLBACK_CAP) totalBuffer += text;
      // Split on double-newline (handles \n\n and \r\n\r\n)
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() || "";
      for (const raw of parts) {
        let eventType = null, dataStr = null;
        for (const line of raw.split(/\r?\n/)) {
          const m = line.match(/^event:\s*(.+)/);
          if (m) eventType = m[1].trim();
          else {
            const d = line.match(/^data:\s*(.+)/);
            if (d) dataStr = d[1];
          }
        }
        if (!eventType || !dataStr) continue;
        try {
          const data = JSON.parse(dataStr);
          if (eventType === "message_start" && data.message && data.message.usage) {
            const u = extractUsage(data.message.usage);
            inputTokens += u.inputTokens;
            cacheReadTokens += u.cacheReadTokens;
          } else if (eventType === "message_delta" && data.usage) {
            outputTokens += data.usage.output_tokens || 0;
          }
        } catch {
          /* malformed JSON — skip */
        }
      }
      callback();
    },

    flush(callback) {
      // If the SSE parser didn't catch tokens, try fallback parsing
      if (inputTokens === 0 && cacheReadTokens === 0 && outputTokens === 0) {
        if (totalBuffer.trim().startsWith("{")) {
          // Non-streaming JSON response
          try {
            const json = JSON.parse(totalBuffer.trim());
            if (json.usage) {
              const u = extractUsage(json.usage);
              inputTokens = u.inputTokens;
              cacheReadTokens = u.cacheReadTokens;
              outputTokens = json.usage.output_tokens || 0;
            }
          } catch { /* not parseable */ }
        } else if (totalBuffer.includes("data:")) {
          // SSE stream — parse accumulated events as a last resort
          try {
            for (const raw of totalBuffer.split(/\r?\n\r?\n/)) {
              let eventType = null, dataStr = null;
              for (const line of raw.split(/\r?\n/)) {
                const m = line.match(/^event:\s*(.+)/);
                if (m) eventType = m[1].trim();
                else {
                  const d = line.match(/^data:\s*(.+)/);
                  if (d) dataStr = d[1];
                }
              }
              if (!eventType || !dataStr) continue;
              try {
                const data = JSON.parse(dataStr);
                if (eventType === "message_start" && data.message && data.message.usage) {
                  const u = extractUsage(data.message.usage);
                  inputTokens += u.inputTokens;
                  cacheReadTokens += u.cacheReadTokens;
                } else if (eventType === "message_delta" && data.usage) {
                  outputTokens += data.usage.output_tokens || 0;
                }
              } catch { /* skip malformed */ }
            }
          } catch { /* ignore parse errors */ }
        }
      }
      if (stats && providerId) {
        stats.record({
          providerId,
          model,
          durationMs: Date.now() - startTime,
          inputTokens,
          cacheReadTokens,
          outputTokens,
          status: 200,
        });
      }
      callback();
    },
  });
}

// ── Provider name from base_url ──────────────────────────────────────────────

export function providerIdFromUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).host;
    if (host.includes("anthropic.com")) return "anthropic";
    if (host.includes("z.ai")) return "glm";
    if (host.includes("deepseek.com")) return "deepseek";
    if (host.includes("openrouter.ai")) return "openrouter";
    return host;
  } catch {
    return "unknown";
  }
}

// ── QuotaPoller ─────────────────────────────────────────────────────────────
// Periodically calls provider billing/balance APIs. Stores results keyed by
// providerId. On failure, retains the last successful result.

const QUOTA_ENDPOINTS = {
  deepseek: {
    url: "https://api.deepseek.com/user/balance",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    parse: (json) => {
      const info = json && json.balance_infos && json.balance_infos[0];
      if (!info) return json;
      return {
        total_balance: info.total_balance,
        granted_balance: info.granted_balance,
        topped_up_balance: info.topped_up_balance,
        currency: info.currency,
      };
    },
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/auth/key",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    parse: (json) => {
      const d = json && json.data;
      if (!d) return json;
      return {
        limit: d.limit,
        limit_remaining: d.limit_remaining,
        limit_reset: d.limit_reset,
        usage: d.usage,
        usage_daily: d.usage_daily,
        usage_weekly: d.usage_weekly,
        usage_monthly: d.usage_monthly,
      };
    },
  },
  // NOTE: Anthropic has no public "get rate limits" GET endpoint — the real, honest
  // source is the anthropic-ratelimit-* RESPONSE headers, captured live in
  // StatsCollector.recordRatelimitHeaders. So there is deliberately no anthropic poller.
};

export class QuotaPoller {
  #data = new Map();
  #interval = null;
  #keyEnvs = {};

  constructor(keyEnvs) {
    this.#keyEnvs = keyEnvs;
  }

  async #fetch(providerId, ep) {
    const envName = this.#keyEnvs[providerId];
    if (!envName) return;
    const key = process.env[envName];
    if (!key) return;

    try {
      const url = new URL(ep.url);
      const client = url.protocol === "http:" ? http : https;
      const json = await new Promise((resolve, reject) => {
        const req = client.request(
          { protocol: url.protocol, hostname: url.hostname, port: url.port, path: url.pathname, method: "GET", headers: ep.headers(key) },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
              catch (e) { reject(e); }
            });
          },
        );
        req.on("error", reject);
        req.end();
      });
      this.#data.set(providerId, { ...ep.parse(json), _ts: Date.now() });
    } catch {
      /* keep last successful data */
    }
  }

  async poll() {
    for (const [id, ep] of Object.entries(QUOTA_ENDPOINTS)) {
      await this.#fetch(id, ep);
    }
  }

  start(intervalMs = 30000) {
    this.poll();
    this.#interval = setInterval(() => this.poll(), intervalMs);
    this.#interval.unref(); // don't keep the process alive
  }

  stop() {
    if (this.#interval) { clearInterval(this.#interval); this.#interval = null; }
  }

  snapshot() {
    const quotas = {};
    for (const [id, d] of this.#data) quotas[id] = d;
    return quotas;
  }
}

// ── Dashboard HTML ────────────────────────────────────────────────────────────
// The dashboard page lives as a real, editable file at public/dashboard.html and is
// read once at module load — no longer a giant template literal buried in this module.
const DASHBOARD_HTML_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "dashboard.html");
export const DASHBOARD_HTML = (() => {
  try {
    return fs.readFileSync(DASHBOARD_HTML_PATH, "utf8");
  } catch {
    return "<!doctype html><meta charset=utf-8><title>modelpipe</title><p>dashboard.html not found</p>";
  }
})();

