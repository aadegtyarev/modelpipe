// modelpipe stats — per-provider usage tracking, SSE parsing, quota polling, dashboard.
//
// StatsCollector — in-memory accumulator of per-provider token/request stats.
// createUsageTracker — Transform stream that parses the Anthropic SSE stream as it
//   passes through, extracting input_tokens / output_tokens and recording them on
//   stream end. Zero buffering — data is pushed through immediately.
// QuotaPoller — periodic external API calls for balance/quota info (DeepSeek,
//   OpenRouter, Anthropic ratelimit headers).
// dashboardHtml — the embedded HTML dashboard page with auto-refresh.
//
// All fields are PURE — no secrets ever logged or exposed.

import { Transform } from "node:stream";
import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";

// Persistence file for session history (survives restarts)
const SESSIONS_FILE = path.join(os.homedir(), ".modelpipe", "sessions.json");
const MAX_SESSIONS = 20;

// ── StatsCollector ──────────────────────────────────────────────────────────
// Single in-memory store. Thread-safe as long as Node's event loop is the only
// concurrency (no Workers touching this).

const WINDOW_SEC = 60;
const MAX_TIMELINE = 1000;

// Model pricing per 1M tokens (USD). Only known models need an entry;
// unknown models show "—" for price.
const PRICE_MAP = {
  "claude-opus-4-8":       { input: 15,   output: 75   },
  "claude-sonnet-5":       { input: 3,    output: 15   },
  "claude-sonnet-4-6":     { input: 3,    output: 15   },
  "claude-sonnet-4-5":     { input: 3,    output: 15   },
  "claude-haiku-4-5":      { input: 0.8,  output: 4    },
  "deepseek-v4-pro":       { input: 0.435, output: 0.87 },
  "deepseek-v4-flash":     { input: 0.14, output: 0.28 },
  "deepseek-chat":         { input: 0.14, output: 0.28 },
  "GLM-5.2":               { input: 1.4,  output: 4.4  },
  "glm-5.2":               { input: 1.4,  output: 4.4  },
  "GLM-5-Turbo":           { input: 1.2,  output: 4.0  },
  "glm-5-turbo":           { input: 1.2,  output: 4.0  },
  "GLM-5.1":               { input: 1.4,  output: 4.4  },
  "glm-5.1":               { input: 1.4,  output: 4.4  },
  "GLM-5":                 { input: 1.0,  output: 3.2  },
  "glm-5":                 { input: 1.0,  output: 3.2  },
  "GLM-4.7":               { input: 0.6,  output: 2.2  },
  "glm-4.7":               { input: 0.6,  output: 2.2  },
  "google/gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "google/gemini-2.5-flash": { input: 0.3, output: 1.5 },
  "google/gemini-2.5-pro":  { input: 2.5, output: 10  },
};

export function modelPrice(model) {
  return PRICE_MAP[model] || null;
}

export class StatsCollector {
  #providers = new Map();
  #models = new Map();
  #timeline = [];
  #ratelimitHeaders = new Map();
  #startedAt = Date.now();
  #sessions = [];

  constructor() {
    this.#loadSessions();
  }

  record(entry) {
    const pid = entry.providerId;
    const mid = entry.model || "unknown";
    entry.ts = entry.ts || Date.now();

    // per-provider
    let p = this.#providers.get(pid);
    if (!p) {
      p = { requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, lastRequestAt: 0 };
      this.#providers.set(pid, p);
    }
    p.requests++;
    if (entry.status >= 400) p.errors++;
    p.inputTokens += entry.inputTokens || 0;
    p.outputTokens += entry.outputTokens || 0;
    p.lastRequestAt = entry.ts;

    // per-model
    let m = this.#models.get(mid);
    if (!m) {
      m = { providerId: pid, requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, lastRequestAt: 0 };
      this.#models.set(mid, m);
    }
    m.requests++;
    if (entry.status >= 400) m.errors++;
    m.inputTokens += entry.inputTokens || 0;
    m.outputTokens += entry.outputTokens || 0;
    m.lastRequestAt = entry.ts;

    this.#timeline.push(entry);
    if (this.#timeline.length > MAX_TIMELINE) this.#timeline.shift();
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

  snapshot() {
    const now = Date.now();
    const cutoff = now - WINDOW_SEC * 1000;
    const recent = this.#timeline.filter((e) => e.ts >= cutoff);

    const perModel = {};
    for (const [mid, m] of this.#models) {
      const r = recent.filter((e) => e.model === mid);
      const price = modelPrice(mid);
      const cost = price
        ? (m.inputTokens * price.input / 1_000_000) + (m.outputTokens * price.output / 1_000_000)
        : 0;
      perModel[mid] = {
        providerId: m.providerId,
        priceInput: price ? price.input : null,
        priceOutput: price ? price.output : null,
        requests: m.requests,
        errors: m.errors,
        inputTokens: m.inputTokens,
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
      sessionTokens += m.inputTokens + m.outputTokens;
      sessionReqs += m.requests;
    }

    const ratelimits = {};
    for (const [id, rl] of this.#ratelimitHeaders) ratelimits[id] = rl;

    // Attach cost to each timeline entry so the dashboard JS doesn't need price lookup
    const timeline = this.#timeline.slice(-200).map((e) => {
      const pr = modelPrice(e.model);
      const cost = pr ? (e.inputTokens * pr.input + e.outputTokens * pr.output) / 1_000_000 : 0;
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
    // Archive current session before clearing
    if (this.#models.size > 0 || this.#timeline.length > 0) {
      this.#archiveSession();
    }
    this.#providers.clear();
    this.#models.clear();
    this.#timeline.length = 0;
    this.#ratelimitHeaders.clear();
    this.#startedAt = Date.now();
  }

  // Session history — up to 20 archived sessions, persisted to disk.

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
    this.#saveSessions();
  }

  #loadSessions() {
    try {
      const dir = path.dirname(SESSIONS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(SESSIONS_FILE)) {
        this.#sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
      }
    } catch {
      this.#sessions = [];
    }
  }

  #saveSessions() {
    try {
      const dir = path.dirname(SESSIONS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const clean = this.#sessions.map((s) => ({
        id: s.id, startedAt: s.startedAt, endedAt: s.endedAt,
        session: s.session, models: s.models,
      }));
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(clean), "utf8");
    } catch {
      /* best-effort */
    }
  }

  sessionHistory() {
    return this.#sessions;
  }

  shutdown() {
    // Archive current session before process exit (best-effort)
    if (this.#models.size > 0 || this.#timeline.length > 0) {
      this.#archiveSession();
    }
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

export function createUsageTracker(stats, { providerId, model, startTime }) {
  let buffer = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let totalBuffer = "";

  return new Transform({
    transform(chunk, _encoding, callback) {
      this.push(chunk);
      const text = chunk.toString("utf8");
      buffer += text;
      totalBuffer += text;
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
            inputTokens += data.message.usage.input_tokens || 0;
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
      if (inputTokens === 0 && outputTokens === 0) {
        if (totalBuffer.trim().startsWith("{")) {
          // Non-streaming JSON response
          try {
            const json = JSON.parse(totalBuffer.trim());
            if (json.usage) {
              inputTokens = json.usage.input_tokens || 0;
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
                  inputTokens += data.message.usage.input_tokens || 0;
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

// ── GLM Coding Plan quota computation ────────────────────────────────────────
// Artificially computed from proxy-side token counts. The GLM plan docs define
// quota in VALUE (dollar-equivalent of API calls), not prompts or tokens.
// Prompts are an approximation ("1 prompt ≈ 15–20 API invocations").
// GLM-5.2 has multipliers: 3× peak (14:00–18:00 UTC+8), 1× off-peak (promo
// until Sep 2026, normally 2×). The dashboard is approximate — exact % is on
// https://z.ai/manage-apikey/subscription.

// GLM-5.2 API pricing (per 1M tokens)
const GLM_PRICE_INPUT = 1.4;   // $1.4 / 1M input tokens
const GLM_PRICE_OUTPUT = 4.4;  // $4.4 / 1M output tokens

// Plan implied monthly budget: subscription fee × 15–30 (per GLM docs).
// Pro plan: $64.8 → roughly $1,000–$2,000 monthly API value.
// We use $1,000 as a conservative estimate.
const GLM_PLAN_BUDGET = {
  lite:   { monthly: 270,   fiveHour: 2.25,  weekly: 11.25 },  // $18 × 15
  pro:    { monthly: 972,   fiveHour: 8.10,  weekly: 40.50 },  // $64.8 × 15
  max:    { monthly: 2700,  fiveHour: 22.50, weekly: 112.50 }, // $180 × 15 (rough)
};

export function glmMultiplier() {
  const now = new Date();
  const hour = now.getUTCHours() + 8;
  const isPeak = hour >= 14 && hour < 18;
  // GLM-5.2: 3× peak, 1× off-peak (promo through Sep 2026)
  return isPeak ? 3 : 1;
}

export function glmMultiplierLabel() {
  const now = new Date();
  const hour = now.getUTCHours() + 8;
  const isPeak = hour >= 14 && hour < 18;
  // Convert peak window to local time for display
  const peakStart = new Date();
  peakStart.setUTCHours(6, 0, 0, 0); // 14:00 UTC+8 = 06:00 UTC
  const peakEnd = new Date();
  peakEnd.setUTCHours(10, 0, 0, 0);  // 18:00 UTC+8 = 10:00 UTC
  const fmtLocal = (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const peakLocal = `${fmtLocal(peakStart)}–${fmtLocal(peakEnd)}`;
  return isPeak
    ? `3× PEAK (${fmtLocal(now)}, next off-peak at ${fmtLocal(peakEnd)})`
    : `1× off-peak (${fmtLocal(now)}, peak ${peakLocal})`;
}

export function computeGlmQuota(timeline, planType = "pro") {
  const budget = GLM_PLAN_BUDGET[planType] || GLM_PLAN_BUDGET.pro;
  const now = Date.now();
  const fiveHourAgo = now - 5 * 3600 * 1000;
  const weekAgo = now - 7 * 24 * 3600 * 1000;

  let fiveHourIn = 0, fiveHourOut = 0, fiveHourReqs = 0;
  let weeklyIn = 0, weeklyOut = 0, weeklyReqs = 0;
  let totalIn = 0, totalOut = 0, totalReqs = 0;
  for (const e of timeline) {
    if (e.providerId !== "glm") continue;
    totalIn += e.inputTokens || 0;
    totalOut += e.outputTokens || 0;
    totalReqs++;
    if (e.ts >= fiveHourAgo) {
      fiveHourIn += e.inputTokens || 0;
      fiveHourOut += e.outputTokens || 0;
      fiveHourReqs++;
    }
    if (e.ts >= weekAgo) {
      weeklyIn += e.inputTokens || 0;
      weeklyOut += e.outputTokens || 0;
      weeklyReqs++;
    }
  }

  const mult = glmMultiplier();
  const fiveHourRawCost = (fiveHourIn * GLM_PRICE_INPUT / 1_000_000) + (fiveHourOut * GLM_PRICE_OUTPUT / 1_000_000);
  const weeklyRawCost = (weeklyIn * GLM_PRICE_INPUT / 1_000_000) + (weeklyOut * GLM_PRICE_OUTPUT / 1_000_000);
  const totalRawCost = (totalIn * GLM_PRICE_INPUT / 1_000_000) + (totalOut * GLM_PRICE_OUTPUT / 1_000_000);
  // Plan-deducted cost (with multiplier)
  const fiveHourCost = fiveHourRawCost * mult;
  const weeklyCost = weeklyRawCost * mult;
  const fiveHourPct = budget.fiveHour > 0 ? Math.min(100, (fiveHourCost / budget.fiveHour) * 100) : 0;
  const weeklyPct = budget.weekly > 0 ? Math.min(100, (weeklyCost / budget.weekly) * 100) : 0;

  // Monthly subscription cost (used for plan-vs-API comparison)
  const SUB_COST = { lite: 18, pro: 64.8, max: 180 };
  const subMonthly = SUB_COST[planType] || SUB_COST.pro;
  // Extrapolate weekly API cost to monthly (×4.33 weeks)
  const apiMonthlyEstimate = weeklyRawCost * 4.33;

  return {
    plan: planType,
    multiplier: mult,
    multiplierLabel: glmMultiplierLabel(),
    fiveHour: {
      inputTokens: fiveHourIn, outputTokens: fiveHourOut, requests: fiveHourReqs,
      costEstimate: fiveHourCost, budget: budget.fiveHour, rawCost: fiveHourRawCost,
      pct: Math.round(fiveHourPct * 10) / 10,
    },
    weekly: {
      inputTokens: weeklyIn, outputTokens: weeklyOut, requests: weeklyReqs,
      costEstimate: weeklyCost, budget: budget.weekly, rawCost: weeklyRawCost,
      pct: Math.round(weeklyPct * 10) / 10,
    },
    total: {
      inputTokens: totalIn, outputTokens: totalOut, requests: totalReqs,
      rawCost: totalRawCost,
    },
    comparison: {
      subscriptionMonthly: subMonthly,
      apiMonthlyEstimate: apiMonthlyEstimate,
      verdict: apiMonthlyEstimate > subMonthly ? `plan saves ~$${(apiMonthlyEstimate - subMonthly).toFixed(2)}/mo` : `raw API ~$${apiMonthlyEstimate.toFixed(2)}/mo`,
    },
    _ts: now,
  };
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
  anthropic: {
    url: "https://api.anthropic.com/v1/rate_limits",
    headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
    parse: (json) => {
      // The rate_limits API returns an array of limit objects keyed by model/limiter type.
      // We flatten to a summary: per-model RPM + ITPM + OTPM remaining / limit.
      if (!Array.isArray(json)) return json;
      const summary = {};
      for (const entry of json) {
        const key = entry.model || entry.limiter || "global";
        summary[key] = {
          requests: entry.requests_remaining != null ? `${entry.requests_remaining}/${entry.requests_limit}` : null,
          inputTokens: entry.input_tokens_remaining != null ? `${entry.input_tokens_remaining}/${entry.input_tokens_limit}` : null,
          outputTokens: entry.output_tokens_remaining != null ? `${entry.output_tokens_remaining}/${entry.output_tokens_limit}` : null,
        };
      }
      return summary;
    },
  },
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

// ── Dashboard HTML ──────────────────────────────────────────────────────────

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>modelpipe</title>
<style>
:root {
  --bg:#0d1117; --card-bg:#161b22; --border:#30363d;
  --text:#c9d1d9; --muted:#8b949e; --green:#3fb950; --red:#f85149;
  --blue:#58a6ff; --orange:#d2991d; --purple:#bc8cff;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font:20px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;padding:14px 18px;max-width:940px}
h1{font-size:26px;margin-bottom:14px;display:flex;align-items:center;gap:10px}
h1 .badge{font-size:14px;padding:2px 8px;border-radius:4px;color:var(--green);border:1px solid var(--green);font-weight:400}
.error{padding:8px 12px;color:var(--red);border:1px solid var(--red);border-radius:6px;margin-bottom:12px;display:none;font-size:14px}

/* Session bar */
.session{display:flex;gap:20px;padding:12px 16px;background:var(--card-bg);border:1px solid var(--border);border-radius:8px;margin-bottom:14px;flex-wrap:wrap}
.session .stat{font-size:22px;font-weight:600}
.session .stat .lbl{font-size:13px;color:var(--muted);font-weight:400;display:block}

.sessctl{display:flex;align-items:center;gap:10px;margin-bottom:14px}
.sessctl button:hover{background:var(--border)!important}

/* Model cards */
.models{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;margin-bottom:14px}
.card{background:var(--card-bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px}
.card .head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px}
.card .name{font-size:16px;font-weight:600}
.card .provider{font-size:13px;color:var(--muted)}
.card .price{font-size:13px;color:var(--muted);margin-bottom:4px}
.card .bar-wrap{margin:6px 0}
.card .bar{height:6px;background:var(--border);border-radius:2px;overflow:hidden;display:flex}
.card .bar .in{background:var(--blue);transition:width .3s}
.card .bar .out{background:var(--purple);transition:width .3s}
.card .metrics{display:flex;justify-content:space-between;font-size:16px}
.card .metrics .val{font-weight:600}
.card .metrics .unit{color:var(--muted);font-size:12px}

/* Chart */
.chart-wrap{background:var(--card-bg);border:1px solid var(--border);border-radius:8px;padding:10px 14px;margin-bottom:14px}
.chart-wrap h2{font-size:16px;color:var(--muted);margin-bottom:4px}
.chart-legend{display:flex;gap:14px;font-size:14px;margin-bottom:6px}
.chart-legend span{display:flex;align-items:center;gap:5px}
.chart-legend .dot{width:10px;height:10px;border-radius:50%;display:inline-block}
canvas{display:block;width:100%;height:200px}

/* Quotas row */
.quotas{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin-bottom:14px}
.qcard{background:var(--card-bg);border:1px solid var(--border);border-radius:8px;padding:10px 14px}
.qhead{font-size:15px;font-weight:600;margin-bottom:6px}
.qrow{display:flex;justify-content:space-between;font-size:13px;padding:1px 0}
.qrow .l{color:var(--muted);min-width:75px}
.qrow .l+.l{text-align:right}

/* Log */
.log{font-size:14px;color:var(--muted)}
.log .row{display:flex;gap:10px;padding:3px 0;border-bottom:1px solid var(--border)}
.log .row.er{color:var(--red)}
.log .row .t{min-width:75px}
.log .row .m{flex:1;min-width:140px}
.log .row .tok{min-width:120px;text-align:right}
.log .row .cost{min-width:60px;text-align:right}
.log .row .ms{min-width:55px;text-align:right}

.bar-fill{transition:width .5s,background .5s}
.refresh{color:var(--muted);font-size:13px;margin-top:14px;cursor:pointer}
.refresh:hover{color:var(--text)}
</style>
</head>
<body>
<h1>modelpipe <span class="badge">live</span></h1>
<div class="error" id="e"></div>

<div class="session" id="session"></div>
<div class="sessctl" id="sessctl">
  <button id="btnReset" onclick="newSession()" style="background:var(--card-bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 12px;font-size:13px;cursor:pointer">New session</button>
  <span style="font-size:13px;color:var(--muted)">History:</span>
  <select id="sessSelect" onchange="showHistory()" style="background:var(--card-bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:13px">
    <option value="">live</option>
  </select>
  <button onclick="toggleSettings()" style="background:var(--card-bg);color:var(--muted);border:1px solid var(--border);border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;margin-left:auto">⚙</button>
</div>
<div id="settings" style="display:none;background:var(--card-bg);border:1px solid var(--border);border-radius:8px;padding:10px 14px;margin-bottom:10px;font-size:13px;gap:10px;flex-wrap:wrap">
  <span style="color:var(--muted)">Plan prices ($/mo):</span>
  <label>anthropic <input id="planPrice_anthropic" size="5" style="background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-size:13px"></label>
  <label>glm <input id="planPrice_glm" size="5" style="background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-size:13px"></label>
  <label>deepseek <input id="planPrice_deepseek" size="5" style="background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-size:13px"></label>
  <label>openrouter <input id="planPrice_openrouter" size="5" style="background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-size:13px"></label>
  <button onclick="savePrices()" style="background:var(--blue);color:#fff;border:none;border-radius:4px;padding:4px 10px;font-size:12px;cursor:pointer">Save</button>
</div>
<div class="models" id="models"></div>

<div class="chart-wrap">
<h2>Tokens over time (last 200 requests)</h2>
<div class="chart-legend" id="legend"></div>
<canvas id="chart"></canvas>
</div>

<div class="quotas" id="quotas"></div>
<div class="log" id="log"></div>

<div class="refresh" id="r" onclick="auto=!auto;if(auto)load()"></div>

<script>
const $=s=>document.getElementById(s);
let auto=true;

function fmt(n){return n!=null?Number(n).toLocaleString():"—"}
function ago(ts){const s=Math.floor((Date.now()-ts)/1000);return s<5?"now":s<60?s+"s ago":s<3600?Math.floor(s/60)+"m ago":Math.floor(s/3600)+"h ago"}
function usd(v){return'$'+v.toFixed(3)}
function pricestr(pin,pout){if(pin==null)return'price —';return'$'+pin+'/$'+pout+' per 1M in/out'}

function getPlanPrice(pid,stats,glmQ){
  // Direct price from config.plans — works for any provider
  if(stats.plans&&stats.plans[pid]!=null)return stats.plans[pid];
  // Default tier-based prices
  const defs={anthropic:{pro:20,max:200,team:25},glm:{lite:18,pro:64.8,max:180}};
  const planName=pid==='anthropic'?stats.anthropicPlan:(pid==='glm'?glmQ.plan:null);
  return (defs[pid]||{})[planName]||0;
}

const COLORS=['#58a6ff','#3fb950','#d2991d','#f85149','#bc8cff','#79c0ff','#f0883e','#56d364'];
const colors={};

let histMode=null; // null = live, id = viewing historical session

// Settings: save prices to server config
async function savePrices(){
  const p={};
  for(const pid of['anthropic','glm','deepseek','openrouter']){
    const v=parseFloat($('planPrice_'+pid).value);
    if(!isNaN(v)&&v>=0)p[pid]=v;
  }
  await fetch("/v1/plans",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(p)});
  load();
}
function toggleSettings(){
  const s=$('settings');
  s.style.display=s.style.display==='none'?'flex':'none';
  if(s.style.display==='flex'){
    fetch("/v1/stats").then(r=>r.json()).then(st=>{
      const pp=st.plans||{};
      for(const pid of['anthropic','glm','deepseek','openrouter'])
        $('planPrice_'+pid).value=pp[pid]!=null?pp[pid]:'';
    });
  }
}

async function newSession(){
  await fetch("/v1/sessions/reset",{method:"POST"});
  histMode=null;$("sessSelect").value="";
  load();
}

async function showHistory(){
  const v=$("sessSelect").value;
  histMode=v||null;
  load();
}

async function load(){
  try{
    const[stats,quotas,sessions]=await Promise.all([
      fetch("/v1/stats").then(r=>r.json()),
      fetch("/v1/quotas").then(r=>r.json()),
      fetch("/v1/sessions").then(r=>r.json()),
    ]);
    // Populate session history dropdown
    let sel='<option value="">live</option>';
    for(const s of (sessions||[])){
      const t=new Date(s.startedAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",hour12:false});
      sel+='<option value="'+s.id+'"'+(histMode===String(s.id)?' selected':'')+'>'+t+' ('+s.session.requests+' reqs, $'+s.session.cost.toFixed(3)+')</option>';
    }
    $("sessSelect").innerHTML=sel;

    // If viewing a historical session, replace stats with archived data
    if(histMode){
      const arch=sessions.find(s=>String(s.id)===histMode);
      if(arch){
        stats.session=arch.session;
        stats.models=arch.models;
        stats.timeline=[];
      }
    }

    render(stats,quotas);
    $("e").style.display="none";
  }catch(err){$("e").style.display="block";$("e").textContent="fetch error: "+err.message}
  $("r").textContent="Updated: "+new Date().toLocaleTimeString()+"  —  auto-refresh "+(auto?"ON":"OFF");
  if(auto)setTimeout(load,2000);
}

async function render(stats,quotas){
  const s=stats.session||{};

  // Fetch configured providers from /v1/models
  let cfgModels=[];
  try{const r=await fetch("/v1/models").then(r=>r.json());cfgModels=(r.data||[]).map(m=>{const h=m.host||'';let pid=h;if(h.includes('anthropic'))pid='anthropic';else if(h.includes('z.ai'))pid='glm';else if(h.includes('deepseek'))pid='deepseek';else if(h.includes('openrouter'))pid='openrouter';return{...m,pid};});}catch{}

  // Session bar — effective cost based on subscriptions
  const hours=Math.max(0.1,(Date.now()-(s.startedAt||Date.now()))/3600000);
  const modelArr=Object.values(stats.models||{});
  const doneProviders=new Set();
  let effectiveCost=0;
  for(const m of modelArr){
    if(doneProviders.has(m.providerId))continue;
    doneProviders.add(m.providerId);
    const price=getPlanPrice(m.providerId,stats,glmQ);
    if(price>0){
      effectiveCost+=price/720*hours;
    }else{
      effectiveCost+=modelArr.filter(x=>x.providerId===m.providerId).reduce((s,x)=>s+(x.cost||0),0);
    }
  }

  $("session").innerHTML=
    '<div class="stat">'+usd(s.cost||0)+'<span class="lbl">raw API</span></div>'+
    '<div class="stat">'+usd(effectiveCost)+'<span class="lbl">effective</span></div>'+
    '<div class="stat">'+fmt(s.requests||0)+'<span class="lbl">requests</span></div>'+
    '<div class="stat">'+fmt(s.tokens||0)+'<span class="lbl">tokens</span></div>'+
    (s.startedAt?'<div class="stat">'+(new Date(s.startedAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",hour12:false}))+'<span class="lbl">started</span></div>':'');

  // Model cards
  let mhtml='';
  const models=stats.models||{};
  const sorted=Object.entries(models).sort((a,b)=>b[1].cost-a[1].cost);
  for(const[mid,m]of sorted){
    const online=m.lastRequestAt>Date.now()-300000;
    mhtml+='<div class="card">'+
      '<div class="head"><span class="name" style="color:'+(online?'var(--green)':'var(--muted)')+'">'+(online?'● ':'○ ')+mid+'</span></div>'+
      '<div class="provider">'+m.providerId+'</div>'+
      '<div class="price">'+pricestr(m.priceInput,m.priceOutput)+'</div>'+
      '<div class="bar-wrap"><div class="bar" style="height:'+(m.priceInput?4:2)+'px">'+
        '<div class="in" style="width:'+(m.inputTokens/(m.inputTokens+m.outputTokens||1)*100)+'%"></div>'+
        '<div class="out" style="width:'+(m.outputTokens/(m.inputTokens+m.outputTokens||1)*100)+'%"></div></div></div>'+
      '<div class="metrics">'+
        '<span><span class="val">'+fmt(m.inputTokens+m.outputTokens)+'</span> <span class="unit">tok</span></span>'+
        '<span><span class="val">'+usd(m.cost)+'</span></span>'+
        '<span><span class="val">'+m.requests+'</span> <span class="unit">req</span></span></div>'+
      '</div>';
  }
  if(!mhtml)mhtml='<div class="card"><span style="color:var(--muted)">No data yet</span></div>';
  $("models").innerHTML=mhtml;

  // Chart
  drawChart(stats.timeline||[]);

  // Quotas — unified provider cards from configured routes
  let qhtml='';
  const qs=quotas||{};
  const rl=(stats.ratelimits||{}).anthropic||{};
  const glmQ=stats.glmQuota||{};

  const providerSet=new Set();
  const providers=[];
  cfgModels.forEach(m=>{
    if(!m.pid||providerSet.has(m.pid))return;
    providerSet.add(m.pid);
    const sm=Object.values(stats.models||{}).filter(m2=>m2.providerId===m.pid);
    const totalCost=sm.reduce((s,m2)=>s+(m2.cost||0),0);
    const totalReqs=sm.reduce((s,m2)=>s+(m2.requests||0),0);
    const totalTokens=sm.reduce((s,m2)=>s+(m2.inputTokens||0)+(m2.outputTokens||0),0);
    const online=sm.some(m2=>m2.lastRequestAt>Date.now()-300000);
    providers.push({id:m.pid,host:m.host,cost:totalCost,requests:totalReqs,tokens:totalTokens,online});
  });

  for(const p of providers){
    qhtml+='<div class="qcard"><div class="qhead">'+
      '<span style="color:'+(p.online?'var(--green)':'var(--muted)')+'">'+(p.online?'●':'○')+'</span> '+
      p.id+'</div>';

    const rows=[];
    // Session cost (always available)
    rows.push('<span class="l">session</span> <span>'+usd(p.cost)+' · '+fmt(p.requests)+' req · '+fmt(p.tokens)+' tok</span>');

    // Provider-specific data
    // 1. Limits/balance/credits
    if(p.id==='anthropic'){
      const rem=Number(rl["anthropic-ratelimit-requests-remaining"]||0);
      const lim=Number(rl["anthropic-ratelimit-requests-limit"]||0);
      if(lim)rows.push('<span class="l">RPM</span> <span>'+fmt(rem)+' / '+fmt(lim)+'</span>');
      const irem=Number(rl["anthropic-ratelimit-input-tokens-remaining"]||0);
      const ilim=Number(rl["anthropic-ratelimit-input-tokens-limit"]||0);
      if(ilim)rows.push('<span class="l">ITPM</span> <span>'+fmt(irem)+' / '+fmt(ilim)+'</span>');
      const orem=Number(rl["anthropic-ratelimit-output-tokens-remaining"]||0);
      const olim=Number(rl["anthropic-ratelimit-output-tokens-limit"]||0);
      if(olim)rows.push('<span class="l">OTPM</span> <span>'+fmt(orem)+' / '+fmt(olim)+'</span>');
      if(!lim&&!ilim&&!olim)rows.push('<span class="l">limits</span> <span style="color:var(--muted)">— (no traffic yet)</span>');
    }
    if(p.id==='deepseek'&&qs.deepseek){
      rows.push('<span class="l">balance</span> <span>$'+qs.deepseek.total_balance+'</span>');
    }
    if(p.id==='openrouter'&&qs.openrouter){
      const o=qs.openrouter;
      rows.push('<span class="l">credits</span> <span>'+o.limit_remaining.toFixed(4)+' / '+o.limit+' '+o.limit_reset+'</span>');
    }
    // 2. Quotas (GLM)
    if(p.id==='glm'){
      if(glmQ.fiveHour){
        rows.push('<span class="l">5h quota</span> <span>'+glmQ.fiveHour.pct+'% · '+fmt(glmQ.fiveHour.inputTokens+glmQ.fiveHour.outputTokens)+' tok</span>');
        rows.push('<span class="l">week quota</span> <span>'+glmQ.weekly.pct+'% · '+fmt(glmQ.weekly.inputTokens+glmQ.weekly.outputTokens)+' tok</span>');
      }
      rows.push('<span class="l">multiplier</span> <span style="color:'+(glmQ.multiplier>1?'var(--orange)':'var(--green)')+'">'+glmQ.multiplierLabel+'</span>');
    }
    // 3. Plan vs API (any provider with a price)
    const pp=getPlanPrice(p.id,stats,glmQ);
    if(pp>0&&p.requests>0){
      const planRate=pp/720;
      const apiRate=p.cost/hours;
      const v=apiRate>planRate?'plan saves ~$'+(apiRate*720-pp).toFixed(0)+'/mo':'API ~$'+(apiRate*720).toFixed(0)+'/mo';
      rows.push('<span class="l">plan vs API</span> <span style="color:'+(apiRate>planRate?'var(--green)':'var(--orange)')+'">'+v+' ($'+pp+'/mo)</span>');
    }
    // 4. Pricing
    const prices=[...new Set(Object.values(stats.models||{}).filter(m=>m.providerId===p.id&&m.priceInput!=null).map(m=>'$'+m.priceInput+'/$'+m.priceOutput))];
    if(prices.length)rows.push('<span class="l">pricing</span> <span style="color:var(--muted)">'+prices.join(' · ')+' per 1M</span>');

    qhtml+='</div>';
  }
  $("quotas").innerHTML=qhtml||'<span style="color:var(--muted)">quota data pending…</span>';

  // Log
  let lhtml='<div class="row" style="color:var(--muted);font-weight:600">'+
    '<span class="t">Time</span>'+
    '<span class="m">Model</span>'+
    '<span class="tok">Tokens in / out</span>'+
    '<span class="cost">Cost</span>'+
    '<span class="ms">Duration</span></div>';
  const tl=stats.timeline||[];
  for(let i=tl.length-1;i>=Math.max(0,tl.length-50);i--){
    const e=tl[i];
    const cls=e.status>=400?' er':'';
    const cost=e.cost||0;
    const timeStr=new Date(e.ts).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false});
    lhtml+='<div class="row'+cls+'">'+
      '<span class="t">'+timeStr+'</span>'+
      '<span class="m">'+e.model+'</span>'+
      '<span class="tok">'+fmt(e.inputTokens)+' in / '+fmt(e.outputTokens)+' out</span>'+
      '<span class="cost">'+usd(cost)+'</span>'+
      '<span class="ms">'+fmt(e.durationMs)+'ms</span></div>';
  }
  if(!lhtml)lhtml='<div class="row">No requests yet</div>';
  $("log").innerHTML=lhtml;
}

function drawChart(timeline){
  const canvas=$("chart"),ctx=canvas.getContext("2d");
  const dpr=window.devicePixelRatio||1;
  const w=canvas.clientWidth,h=canvas.clientHeight;
  canvas.width=w*dpr;canvas.height=h*dpr;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  if(!timeline.length){ctx.fillStyle="#8b949e";ctx.font="14px sans-serif";ctx.fillText("No data",10,h/2);return}

  // Bucket by model in 10-second bins
  const start=timeline[0].ts;
  const end=timeline[timeline.length-1].ts;
  const span=Math.max(end-start,60000);
  const bins=Math.min(60,Math.max(10,Math.floor(span/10000)));
  const binMs=span/bins;

  const series={};
  for(const e of timeline){
    const bin=Math.floor((e.ts-start)/binMs);
    const key=e.model||'?';
    if(!series[key])series[key]=new Array(bins).fill(0);
    const s=series[key];
    if(bin>=s.length)continue;
    s[bin]+=(e.inputTokens||0)+(e.outputTokens||0);
  }

  // Cumulative per model
  Object.values(series).forEach(s=>{for(let i=1;i<s.length;i++)s[i]+=s[i-1]});

  // Draw
  const pad={l:40,r:10,t:8,b:20};
  const pw=w-pad.l-pad.r,ph=h-pad.t-pad.b;
  ctx.clearRect(0,0,w,h);

  // Grid
  ctx.strokeStyle="#21262d";ctx.lineWidth=1;
  const maxVal=Math.max(1,...Object.values(series).flat());
  const ySteps=4;
  for(let i=0;i<=ySteps;i++){
    const y=pad.t+(ph/ySteps)*i;
    ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(w-pad.r,y);ctx.stroke();
    ctx.fillStyle="#8b949e";ctx.font="11px sans-serif";ctx.textAlign="right";
    const val=Math.round(maxVal*(1-i/ySteps));
    ctx.fillText(fmt(val),pad.l-5,y+4);
  }

  // Lines
  ctx.lineWidth=2;
  let ci=0;
  const legend=[];
  for(const[id,vals]of Object.entries(series)){
    const color=colors[id]||(colors[id]=COLORS[ci++%COLORS.length]);
    legend.push({id,color});
    ctx.beginPath();ctx.strokeStyle=color;
    for(let i=0;i<vals.length;i++){
      const x=pad.l+(pw/(bins-1))*i;
      const y=pad.t+ph-(vals[i]/maxVal*ph);
      i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
    }
    ctx.stroke();
  }

  // X axis time labels
  ctx.fillStyle="#8b949e";ctx.font="11px sans-serif";ctx.textAlign="center";
  const fmtT=d=>new Date(d).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false});
  const step=Math.max(1,Math.floor(bins/6));
  for(let i=0;i<bins;i+=step){
    if(i%step!==0)continue;
    const x=pad.l+(pw/(bins-1))*i;
    ctx.fillText(fmtT(start+i*binMs),x,pad.t+ph+12);
  }

  // Legend
  $("legend").innerHTML=legend.map(l=>'<span><span class="dot" style="background:'+l.color+'"></span>'+l.id+'</span>').join("");
}

load();
</script>
</body>
</html>`;

