# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-07-01

### Added
- `GET /v1/models?expand=1` (and `GET /models?expand=1`): resolves a glob route's
  `match` into the **concrete** model ids it currently matches, by fetching the
  backend's own model-listing endpoint (the new optional per-route `models_url` +
  `models_format` config fields — `base_url` is the messages endpoint and doesn't tell
  modelpipe where a provider's catalog lives, so this is stated explicitly, never
  guessed). Each entry gains `match` (the route's glob) and `concrete` (bool). Fail-safe
  per route: no `models_url`, a network error, a non-200, an unparseable body, or an
  unset key env all fall back to the unexpanded glob (`concrete: false`) — one backend's
  catalog being down never fails the whole listing. A passthrough route's catalog fetch
  carries the client's own incoming auth header, same rule as a normal passthrough hop.
  The plain (non-`expand`) response is byte-for-byte unchanged — opt-in only. Catalog
  fetches are cached per router process for a few minutes to avoid hammering a backend's
  listing endpoint. Exported as `expandModels(config, req, cache)` and the pure parser
  `parseModelsCatalog(body)`.

## [0.5.0] - 2026-07-01

### Added
- `GET /v1/models` (and the bare `GET /models`) returns the configured routes as a
  **secret-free** model listing over HTTP: each route's `match` glob (as `id`), backend
  `host`, auth **mode** (`"passthrough"` | `"key"`), and vision flags. It is the
  network-facing, **stricter** counterpart to `--list` (which is localhost/operator scope
  and exposes the key env-var name): over the wire it never leaks a key value, a key
  env-var name, an auth header, or a base path. Exposed as the exported pure function
  `listModels(config)` — a projection of `listConfig` (one source of truth) — and
  intercepted before body reading/routing, so it needs no request body and never reaches a
  backend. `POST /v1/messages`, passthrough, and the vision-reroute are unchanged.
- `CHANGELOG.md` (this file), seeded with the prior release history.

## [0.4.0] - 2026-06-30

### Added
- `--list` CLI mode: prints a safe JSON summary of the route table to stdout and exits
  (no server, no network) — for a setup dialog or sanity check. Backed by the exported
  `listConfig(config)`.

## [0.3.0] - 2026-06-30

### Added
- Per-route `vision` flag (default `true`): a route declared `vision: false` has its
  image-bearing requests pre-routed to the `forImages` target without trying the backend
  first — reliable where a backend does not 400 on an image (a soft-refusal 200, or its
  own server-side image tool).

## [0.1.0] - 2026-06-30

### Added
- Standalone passthrough Anthropic-format model router: model-id routing, per-backend
  auth swap (key-swap and `passthrough`), reactive `forImages` vision fallback,
  fail-closed error handling, and log safety. No dependencies (Node built-ins only).
