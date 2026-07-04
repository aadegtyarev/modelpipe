#!/usr/bin/env node
// modelpipe — start the passthrough Anthropic-format model router from a routes config.
//
//   modelpipe <config.json> [--port N]
//   modelpipe <config.json> --list
//
// Loads + validates the routes config (fail-closed: a missing/bad config exits non-zero
// with a clear message and serves nothing), starts the router, prints the listen URL to
// STDERR, and runs until killed (Ctrl-C / SIGTERM). The config's listen.host/port are the
// default; --port overrides the port. No secret/body logging (set MODEL_ROUTER_LOG=1 for
// the opt-in `model -> host` routing line on stderr).
//
// --list: load + validate the config, print a SAFE JSON summary of the route table to
// STDOUT, and exit — no server, no network. Lets a client setup dialog discover what
// this modelpipe is configured for. The summary carries the keyEnv NAME only, never a
// key value (listConfig in src/router.mjs is the safe-surface whitelist).

import { createRouter, loadConfig, listConfig } from "../src/router.mjs";

const USAGE = "usage: modelpipe <config.json> [--port N] | modelpipe <config.json> --list";

function fail(message) {
  process.stderr.write(`modelpipe: ${message}\n${USAGE}\n`);
  process.exit(2);
}

// Parse argv: a single positional config path, an optional --port N (or --port=N).
function parseArgs(argv) {
  let configPath = null;
  let port = null;
  let list = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") {
      const val = argv[++i];
      if (val === undefined) fail("--port requires a value");
      port = val;
    } else if (arg.startsWith("--port=")) {
      port = arg.slice("--port=".length);
    } else if (arg === "--list") {
      list = true;
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
  return { configPath, port, list };
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
  const { configPath, port: rawPort, list } = parseArgs(process.argv.slice(2));
  if (!configPath) fail("a routes config file is required");

  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    // Covers a missing file, unreadable file, bad JSON, and a config that fails
    // validateConfig — all fail-closed: report and exit, never serve a half-valid config.
    fail(`could not load config "${configPath}": ${err.message}`);
  }

  // --list: print the safe route-table summary to STDOUT and exit — no server, no
  // network. The summary is secret-free (keyEnv NAME only — listConfig is the whitelist).
  if (list) {
    process.stdout.write(`${JSON.stringify(listConfig(config), null, 2)}\n`);
    return;
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
    if (config.dashboard === true) {
      process.stderr.write(
        `modelpipe: dashboard → http://${host}:${addr.port}/dashboard\n`,
      );
    }
  });

  // Graceful shutdown that actually terminates. server.close() alone WAITS for every
  // open connection to end first — and a client like Claude Code holds a keep-alive
  // socket open indefinitely, so close() never fires its callback and the process hangs
  // under `systemctl restart` (stuck "deactivating" until the stop timeout SIGKILLs it).
  // So: stop accepting new connections, immediately free IDLE keep-alive sockets (lets
  // close() complete once in-flight requests finish), and keep a short hard backstop that
  // force-closes anything still lingering. (closeIdleConnections/closeAllConnections exist
  // on Node >= 18.2; optional-chained so an older 18.x still exits cleanly via the timer.)
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
    setTimeout(() => {
      server.closeAllConnections?.();
      process.exit(0);
    }, 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
