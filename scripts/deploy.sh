#!/usr/bin/env bash
# modelpipe deploy — install a RELEASED artifact (not a git clone) and run it as a
# systemd --user service, keeping config OUTSIDE the artifact so upgrades never touch it.
#
#   scripts/deploy.sh [<tag>]     # e.g. v0.9.0 ; default: latest release
#
# Layout (under $MODELPIPE_HOME, default ~/appimages/modelpipe-deploy):
#   releases/<tag>/   unpacked artifact (bin/, src/, public/, …) — immutable per version
#   current           symlink → the active release (atomic flip on upgrade)
#   config/           routes.json + .env — PRESERVED across upgrades (git-ignored territory)
# Live routing state (profile pin/offset, learned windows, overrides) stays in ~/.modelpipe.
#
# Idempotent: re-running installs/points at the requested version and restarts. First run
# seeds config/ from an existing git-clone deploy (~/appimages/modelpipe) if present, and
# never overwrites an existing config file.
set -euo pipefail

REPO="${MODELPIPE_REPO:-aadegtyarev/modelpipe}"
BASE="${MODELPIPE_HOME:-$HOME/appimages/modelpipe-deploy}"
REL="$BASE/releases"; CFG="$BASE/config"; CUR="$BASE/current"
TAG="${1:-latest}"
NODE_BIN="$(command -v node)"

command -v gh >/dev/null || { echo "deploy: needs the GitHub CLI (gh), authenticated" >&2; exit 1; }
[ -n "$NODE_BIN" ] || { echo "deploy: needs node on PATH" >&2; exit 1; }
mkdir -p "$REL" "$CFG"

# 1. Resolve the tag (latest → the newest published release).
if [ "$TAG" = latest ]; then
  TAG="$(gh release view --repo "$REPO" --json tagName -q .tagName)"
fi
echo "deploy: target release $TAG"

# 2. Download + unpack the tarball once per version (npm pack nests everything under package/).
DEST="$REL/$TAG"
if [ ! -d "$DEST" ]; then
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  gh release download "$TAG" --repo "$REPO" --pattern '*.tgz' --dir "$tmp"
  mkdir -p "$DEST"
  tar -xzf "$tmp"/*.tgz -C "$DEST" --strip-components=1
  echo "deploy: unpacked → $DEST"
else
  echo "deploy: $TAG already unpacked, reusing"
fi

# 3. Seed config on first run from an existing git-clone deploy; NEVER overwrite.
OLD="$HOME/appimages/modelpipe"
for f in routes.json .env; do
  if [ ! -e "$CFG/$f" ] && [ -e "$OLD/$f" ]; then
    cp -p "$OLD/$f" "$CFG/$f"
    echo "deploy: seeded config/$f from $OLD/$f (preserved as-is)"
  fi
done
[ -e "$CFG/routes.json" ] || echo "deploy: WARNING — no $CFG/routes.json yet; copy your config there before the service will route."

# 4. Atomic flip to the new version.
ln -sfn "$DEST" "$CUR"
echo "deploy: current → $(readlink "$CUR")"

# 5. Write/refresh the systemd --user unit (points at current + external config).
UNIT_DIR="$HOME/.config/systemd/user"; mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/modelpipe.service" <<UNIT
[Unit]
Description=modelpipe — Anthropic-format model router (released artifact)
After=network-online.target

[Service]
ExecStart=$NODE_BIN $CUR/bin/modelpipe.mjs $CFG/routes.json --env-file $CFG/.env
Restart=on-failure

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now modelpipe >/dev/null 2>&1 || true
systemctl --user restart modelpipe
sleep 1
if systemctl --user is-active --quiet modelpipe; then
  echo "deploy: modelpipe active on $TAG ✅"
else
  echo "deploy: service failed to start — check: journalctl --user -u modelpipe -n 40" >&2
  exit 1
fi
