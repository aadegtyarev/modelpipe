#!/usr/bin/env node
// modelpipe — start the passthrough Anthropic-format model router from a routes config.
//
//   modelpipe <config.json> [--port N]
//
// Loads + validates the routes config (fail-closed: a missing/bad config exits non-zero
// with a clear message and serves nothing), starts the router, prints the listen URL to
// STDERR, and runs until killed (Ctrl-C / SIGTERM). The config's listen.host/port are the
// default; --port overrides the port. No secret/body logging (set MODEL_ROUTER_LOG=1 for
// the opt-in `model -> host` routing line on stderr).

import { createRouter, loadConfig } from "../src/router.mjs";

const USAGE = "usage: modelpipe <config.json> [--port N]";

function fail(message) {
  process.stderr.write(`modelpipe: ${message}\n${USAGE}\n`);
  process.exit(2);
}

// Parse argv: a single positional config path, an optional --port N (or --port=N).
function parseArgs(argv) {
  let configPath = null;
  let port = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") {
      const val = argv[++i];
      if (val === undefined) fail("--port requires a value");
      port = val;
    } else if (arg.startsWith("--port=")) {
      port = arg.slice("--port=".length);
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (arg.startsWith("-")) {
      fail(`unknown option "${arg}"`);
    } else if (configPath === null) {
      configPath = arg;
    } else {
      fail(`unexpected extra argument "${arg}"`);
    }
  }
  return { configPath, port };
}

function resolvePort(rawPort, config) {
  if (rawPort !== null) {
    const n = Number(rawPort);
    if (!Number.isInteger(n) || n < 0 || n > 65535) fail(`--port must be an integer 0-65535, got "${rawPort}"`);
    return n;
  }
  return (config.listen && config.listen.port) || 8787;
}

function main() {
  const { configPath, port: rawPort } = parseArgs(process.argv.slice(2));
  if (!configPath) fail("a routes config file is required");

  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    // Covers a missing file, unreadable file, bad JSON, and a config that fails
    // validateConfig — all fail-closed: report and exit, never serve a half-valid config.
    fail(`could not load config "${configPath}": ${err.message}`);
  }

  const host = (config.listen && config.listen.host) || "127.0.0.1";
  const port = resolvePort(rawPort, config);

  const server = createRouter(config);
  server.on("error", (err) => {
    process.stderr.write(`modelpipe: server error: ${err.message}\n`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    const addr = server.address();
    process.stderr.write(
      `modelpipe: listening on http://${host}:${addr.port} (${config.routes.length} route${config.routes.length === 1 ? "" : "s"})\n`,
    );
    process.stderr.write(
      `modelpipe: point your client at it — export ANTHROPIC_BASE_URL=http://${host}:${addr.port}\n`,
    );
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
