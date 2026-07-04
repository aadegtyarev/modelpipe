#!/usr/bin/env bash
# modelpipe installer — clone (or update) the repo and run the setup wizard.
#
#   curl -fsSL https://raw.githubusercontent.com/aadegtyarev/modelpipe/main/install.sh | bash
#
# Installs into ~/modelpipe by default (override with MODELPIPE_HOME=/path). Zero deps —
# just Node.js >= 18 and git. The wizard writes routes.json + .env into the install dir.
set -euo pipefail

REPO="https://github.com/aadegtyarev/modelpipe.git"
DIR="${MODELPIPE_HOME:-$HOME/modelpipe}"

command -v git  >/dev/null 2>&1 || { echo "modelpipe: git is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "modelpipe: Node.js >= 18 is required" >&2; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "modelpipe: Node.js >= 18 required (found $(node -v))" >&2; exit 1
fi

if [ -d "$DIR/.git" ]; then
  echo "modelpipe: updating existing install at $DIR"
  git -C "$DIR" pull --ff-only
else
  echo "modelpipe: cloning into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"

# Run the wizard against the terminal. Under `curl | bash`, stdin is the piped script, so
# attach /dev/tty for the interactive prompts (falls back to plain stdin if there's no tty).
if [ -e /dev/tty ]; then
  node bin/modelpipe.mjs init --dir "$DIR" < /dev/tty
else
  node bin/modelpipe.mjs init --dir "$DIR"
fi

echo
echo "modelpipe installed at $DIR"
echo "Start it:  node $DIR/bin/modelpipe.mjs $DIR/routes.json"
echo "Always-on: see $DIR/README.md → \"Run in the background (systemd)\""
