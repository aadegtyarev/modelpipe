#!/usr/bin/env bash
# modelpipe installer / updater — clone (or update) the repo and, on a fresh install,
# run the setup wizard.
#
#   curl -fsSL https://raw.githubusercontent.com/aadegtyarev/modelpipe/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- /opt/modelpipe      # choose the install dir
#   ./install.sh [dir] [--reconfigure]                         # from a checkout
#
# Install dir resolution (first match wins):
#   1. the DIR positional argument
#   2. $MODELPIPE_HOME
#   3. the checkout this script lives in (so re-running ./install.sh updates it in place)
#   4. ~/modelpipe
#
# Fresh install: clone + run the wizard (writes routes.json + .env into the dir).
# Existing install: `git pull --ff-only` only — the wizard is NOT re-run, so your
# routes.json/.env are left untouched. Pass --reconfigure to run the wizard anyway.
# If a systemd --user `modelpipe` service exists, it's restarted after the update.
# Zero deps — just Node.js >= 18 and git.
set -euo pipefail

REPO="${MODELPIPE_REPO:-https://github.com/aadegtyarev/modelpipe.git}"

# --- parse args: one optional positional DIR, plus --reconfigure -----------------------
DIR_ARG=""
RECONFIGURE=0
for arg in "$@"; do
  case "$arg" in
    --reconfigure) RECONFIGURE=1 ;;
    --help|-h)
      sed -n '2,19p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'
      exit 0 ;;
    -*) echo "modelpipe: unknown option: $arg" >&2; exit 1 ;;
    *)
      if [ -n "$DIR_ARG" ]; then echo "modelpipe: too many arguments" >&2; exit 1; fi
      DIR_ARG="$arg" ;;
  esac
done

# --- where does this script live? (a checkout, or a piped `curl | bash`?) --------------
SELF_DIR=""
src="${BASH_SOURCE[0]:-}"
if [ -n "$src" ] && [ -f "$src" ]; then
  SELF_DIR="$(cd "$(dirname "$src")" && pwd)"
  # Only treat it as a modelpipe checkout if it actually is one.
  if ! { [ -d "$SELF_DIR/.git" ] && [ -f "$SELF_DIR/package.json" ] \
      && grep -q '"name": *"modelpipe"' "$SELF_DIR/package.json" 2>/dev/null; }; then
    SELF_DIR=""
  fi
fi

# --- resolve the install dir ----------------------------------------------------------
if   [ -n "$DIR_ARG" ];             then DIR="$DIR_ARG"
elif [ -n "${MODELPIPE_HOME:-}" ];  then DIR="$MODELPIPE_HOME"
elif [ -n "$SELF_DIR" ];            then DIR="$SELF_DIR"
else                                     DIR="$HOME/modelpipe"
fi
# Absolutise without requiring the dir to exist yet.
DIR="$(cd "$(dirname "$DIR")" 2>/dev/null && printf '%s/%s' "$(pwd)" "$(basename "$DIR")" || echo "$DIR")"

# --- prerequisites --------------------------------------------------------------------
command -v git  >/dev/null 2>&1 || { echo "modelpipe: git is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "modelpipe: Node.js >= 18 is required" >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "modelpipe: Node.js >= 18 required (found $(node -v))" >&2; exit 1
fi

# --- clone (fresh) or pull (existing) -------------------------------------------------
FRESH=0
if [ -d "$DIR/.git" ]; then
  echo "modelpipe: updating existing install at $DIR"
  # A shallow clone can still fast-forward its own branch; unshallow lazily if needed.
  git -C "$DIR" pull --ff-only || {
    echo "modelpipe: fast-forward pull failed (local changes or diverged history)." >&2
    echo "           Resolve them in $DIR, then re-run." >&2
    exit 1
  }
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  echo "modelpipe: $DIR exists but is not a git clone — refusing to touch it." >&2
  echo "           Pick another dir or remove it, then re-run." >&2
  exit 1
else
  echo "modelpipe: cloning into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
  FRESH=1
fi

cd "$DIR"

# --- wizard: only on a fresh install, when config is missing, or on --reconfigure -----
run_wizard() {
  # Under `curl | bash`, stdin is the piped script — attach /dev/tty for the prompts.
  # Test that /dev/tty is actually readable (it exists but errors on open in a
  # non-interactive/headless run), else fall back to plain stdin.
  if { : < /dev/tty; } 2>/dev/null; then
    node bin/modelpipe.mjs init --dir "$DIR" < /dev/tty
  else
    node bin/modelpipe.mjs init --dir "$DIR"
  fi
}
if [ "$RECONFIGURE" = 1 ] || [ "$FRESH" = 1 ] || [ ! -e "$DIR/routes.json" ]; then
  run_wizard
else
  echo "modelpipe: existing routes.json kept (pass --reconfigure to re-run the wizard)"
fi

# --- restart the systemd --user service if the user runs modelpipe that way -----------
RESTARTED=0
if command -v systemctl >/dev/null 2>&1 \
   && systemctl --user list-unit-files modelpipe.service >/dev/null 2>&1 \
   && systemctl --user cat modelpipe.service >/dev/null 2>&1; then
  echo "modelpipe: restarting systemd --user service"
  if systemctl --user restart modelpipe; then RESTARTED=1; fi
fi

echo
if [ "$FRESH" = 1 ]; then
  echo "modelpipe installed at $DIR"
else
  echo "modelpipe updated at $DIR ($(git -C "$DIR" describe --tags --always 2>/dev/null || git -C "$DIR" rev-parse --short HEAD))"
fi
if [ "$RESTARTED" = 1 ]; then
  echo "service restarted:  systemctl --user status modelpipe"
else
  echo "Start it:  node $DIR/bin/modelpipe.mjs $DIR/routes.json"
  echo "Always-on: see $DIR/README.md → \"Run in the background (systemd)\""
fi
