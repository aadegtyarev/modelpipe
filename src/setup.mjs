// modelpipe interactive setup — `modelpipe init` (also reachable as
// `npx github:aadegtyarev/modelpipe init`). Asks a short guided set of questions and writes
// a valid routes.json + .env into the target directory, then prints how to run it. Zero
// dependencies (node:readline/promises). Never logs a key beyond writing it to .env.

import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfig } from "./router.mjs";

// Friendly provider catalog: the sensible defaults a newcomer picks from. Endpoints/auth
// mirror providers.json; `defaultModel` is a concrete id suggestion for the Claude Code recipe.
const PROVIDERS = [
  { id: "anthropic", label: "Anthropic (Claude)", match: "claude-*", base_url: "https://api.anthropic.com",
    header: "x-api-key", keyEnv: "ANTHROPIC_API_KEY", canPassthrough: true, billing: "subscription", defaultModel: "claude-opus-4-8" },
  { id: "glm", label: "z.ai GLM (Coding Plan)", match: "glm-*", base_url: "https://api.z.ai/api/anthropic",
    header: "Authorization", scheme: "Bearer", keyEnv: "ZAI_API_KEY", billing: "subscription", defaultModel: "glm-5.2" },
  { id: "deepseek", label: "DeepSeek", match: "deepseek-*", base_url: "https://api.deepseek.com/anthropic",
    header: "x-api-key", keyEnv: "DEEPSEEK_API_KEY", vision: false, defaultModel: "deepseek-v4-pro" },
  { id: "openrouter", label: "OpenRouter (also the vision fallback)", match: "*/*", base_url: "https://openrouter.ai/api",
    header: "Authorization", scheme: "Bearer", keyEnv: "OPENROUTER_API_KEY", defaultModel: "anthropic/claude-sonnet-4.6" },
];

function parseArg(argv, name) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : null;
}

// How to invoke the installed router in the "next steps" text: the local bin path when run
// from a clone, or the npx-from-github form when run from an npx cache.
function runHint() {
  const self = fileURLToPath(import.meta.url);
  if (/[\\/](_npx|\.npm[\\/]_npx|node_modules)[\\/]/.test(self)) {
    return "npx github:aadegtyarev/modelpipe";
  }
  const bin = path.join(path.dirname(self), "..", "bin", "modelpipe.mjs");
  return `node ${bin}`;
}

export async function runSetup(argv = []) {
  const dir = path.resolve(parseArg(argv, "--dir") || process.cwd());
  const routesPath = path.join(dir, "routes.json");
  const envPath = path.join(dir, ".env");

  // A line reader that BUFFERS lines as they arrive — robust for both an interactive TTY
  // and a piped stdin (readline/promises' question() stalls once a pipe hits EOF). After
  // the stream closes, further prompts resolve to "" (accept the default).
  const rl = createInterface({ input: process.stdin });
  const pending = [];
  let waiting = null;
  let closed = false;
  rl.on("line", (l) => { if (waiting) { const w = waiting; waiting = null; w(l); } else pending.push(l); });
  rl.on("close", () => { closed = true; if (waiting) { const w = waiting; waiting = null; w(""); } });
  const readLine = () => new Promise((res) => {
    if (pending.length) res(pending.shift());
    else if (closed) res("");
    else waiting = res;
  });
  const ask = async (q, def) => {
    process.stdout.write(def !== undefined && def !== "" ? `${q} [${def}]: ` : `${q}: `);
    const a = (await readLine()).trim();
    return a || def || "";
  };
  const yesno = async (q, defYes) => {
    const a = (await ask(q, defYes ? "Y/n" : "y/N")).toLowerCase();
    return a ? a.startsWith("y") : defYes;
  };

  try {
    process.stdout.write("\nmodelpipe setup — I'll write routes.json + .env here:\n  " + dir + "\n\n");

    if (fs.existsSync(routesPath) && !(await yesno(`${routesPath} exists — overwrite?`, false))) {
      process.stdout.write("Aborted (kept your routes.json).\n");
      return 0;
    }

    const chosen = [];
    const envKeys = new Map(); // keyEnv -> value ("" = fill later)
    process.stdout.write("Pick the backends to route to (keys can be pasted now or filled in .env later):\n\n");
    for (const p of PROVIDERS) {
      if (!(await yesno(`Route via ${p.label}?`, p.id === "anthropic"))) continue;
      let auth;
      if (p.canPassthrough) {
        const mode = await ask(`  ${p.id}: (1) subscription/OAuth passthrough  (2) API key`, "1");
        if (mode.trim() === "1") auth = "passthrough";
      }
      if (!auth) {
        auth = { header: p.header, keyEnv: p.keyEnv };
        if (p.scheme) auth.scheme = p.scheme;
        const key = await ask(`  paste ${p.keyEnv} (or leave blank to fill in .env later)`, "");
        envKeys.set(p.keyEnv, key);
      }
      const match = await ask(`  model glob for ${p.id}`, p.match);
      const route = { match, base_url: p.base_url, auth };
      if (p.billing) route.billing = p.billing;
      if (p.vision === false) route.vision = false;
      chosen.push({ p, route });
      process.stdout.write("\n");
    }

    if (chosen.length === 0) {
      process.stdout.write("No backends selected — nothing to write.\n");
      return 1;
    }

    // Optional vision fallback via OpenRouter, if it was chosen.
    const or = chosen.find((c) => c.p.id === "openrouter");
    if (or && await yesno("Use OpenRouter as the image/vision fallback (forImages)?", true)) {
      or.route.forImages = true;
      or.route.forImagesModel = await ask("  vision model id", "google/gemini-2.5-flash-lite");
    }

    const port = Number(await ask("Listen port", "8787")) || 8787;
    const dashboard = await yesno("Enable the dashboard (/dashboard)?", true);

    // Order specific globs before the OpenRouter */* catch-all (first match wins).
    const routes = chosen.map((c) => c.route).sort((a, b) => (a.match === "*/*" ? 1 : 0) - (b.match === "*/*" ? 1 : 0));
    const config = { listen: { host: "127.0.0.1", port }, dashboard, routes };
    validateConfig(config); // fail loudly before writing anything

    fs.writeFileSync(routesPath, JSON.stringify(config, null, 2) + "\n", "utf8");

    // .env: create with the chosen keys; if it already exists, only APPEND missing names
    // (never clobber existing secrets).
    if (envKeys.size > 0) {
      const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
      const have = new Set([...existing.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((m) => m[1]));
      let add = "";
      for (const [k, v] of envKeys) if (!have.has(k)) add += `${k}=${v}\n`;
      if (existing && add) fs.writeFileSync(envPath, existing.replace(/\n?$/, "\n") + add, "utf8");
      else if (!existing) fs.writeFileSync(envPath, "# modelpipe backend keys — do not commit\n" + add, "utf8");
    }

    // Next steps.
    const run = runHint();
    const blanks = [...envKeys].filter(([, v]) => !v).map(([k]) => k);
    process.stdout.write("\n✓ wrote " + routesPath + (envKeys.size ? " and " + envPath : "") + "\n\n");
    if (blanks.length) process.stdout.write("→ Fill these keys in .env before starting: " + blanks.join(", ") + "\n\n");
    process.stdout.write("Run it:\n  " + run + " " + routesPath + "\n\n");
    process.stdout.write("Point your client at it:\n  export ANTHROPIC_BASE_URL=http://127.0.0.1:" + port + "\n");
    const sugg = chosen.map((c) => `${c.p.id}→${c.p.defaultModel}`).join("  ");
    process.stdout.write("  # for Claude Code, set ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL to concrete ids your routes match, e.g.: " + sugg + "\n");
    if (dashboard) process.stdout.write("Dashboard: http://127.0.0.1:" + port + "/dashboard\n");
    process.stdout.write("Always-on: see README → \"Run in the background (systemd)\".\n");
    return 0;
  } finally {
    rl.close();
  }
}
