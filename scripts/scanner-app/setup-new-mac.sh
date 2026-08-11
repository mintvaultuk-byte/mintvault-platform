#!/bin/bash
#
# setup-new-mac.sh — install the common Scanner application on a new Mac.
# The app itself performs operator sign-in, server-assigned station enrolment
# and approval; this script never asks for an API token or human-made ID.
#
# WHY THIS EXISTS (and not install.sh):
#   install.sh + com.mintvault.scanner-app.plist install a LaunchAgent labelled
#   `com.mintvault.scanner-app`. The app's OWN source of truth (lib/agent-plist.js)
#   and its self-repair (reset-agent.sh, main.js) target `com.mintvault.scanner`.
#   Mixing the two makes the installed agent and the app's repair tier drift into
#   two competing agents. This script installs the SAME label the app manages,
#   rendered from the SAME source of truth, so they can never disagree.
#
# Safe to run on a fresh Mac. Idempotent: re-running fills gaps and kickstarts.
# This is PER-MACHINE — it touches only THIS Mac's launchd domain. It cannot
# reach any other scanning station.
#
# Assumes the repo is already cloned and you are running this from inside it.
# Prereqs (Homebrew, Node 22, git) are NOT installed here — see README.

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.mintvault.scanner"
PLIST_TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
WRAPPER="$SCRIPT_DIR/launchd-wrapper.sh"
BASE="$HOME/mintvault-scans"
ENV_FILE="$HOME/.mintvault-scanner.env"
UID_VAL="$(id -u)"
DOMAIN="gui/$UID_VAL"
TARGET="$DOMAIN/$LABEL"

echo "[setup] MintVault scanner — new-station setup"
echo "[setup]   App dir:  $SCRIPT_DIR"
echo "[setup]   Service:  $LABEL  (the label the app self-manages)"
echo "[setup]   Target:   configured by first-run MintVault sign-in"

# 1) Scan folders (matches watcher.js convention)
for sub in inbox processed failed rejected discarded capture-staging; do
  mkdir -p "$BASE/$sub"
done
mkdir -p "$HOME/Library/Application Support/MintVaultScanner"
echo "[setup] ✓ Ensured $BASE/{inbox,processed,failed,rejected,discarded,capture-staging} + App Support dir"

# 2) Non-secret local calibration path. Credentials and station identity are
# created after sign-in and protected by the app's Keychain storage.
if [ ! -f "$ENV_FILE" ]; then
  umask 077
  printf '# MintVault Scanner non-secret local configuration\n' > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi
if ! grep -qE '^MINTVAULT_STATION_CONFIG_PATH=.+' "$ENV_FILE"; then
  printf 'MINTVAULT_STATION_CONFIG_PATH=%s\n' "$ENV_FILE" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

# 3) Deps. The app runs under its OWN bundled Electron; npm install also fetches
#    sharp's prebuilt arm64 binary. No separate build step exists.
if [ ! -x "$SCRIPT_DIR/node_modules/.bin/electron" ]; then
  echo "[setup] Electron not present — running npm install (pulls ~150MB on first run)…"
  ( cd "$SCRIPT_DIR" && npm install --silent )
  echo "[setup] ✓ Deps installed"
else
  echo "[setup] ✓ Electron already installed"
fi

chmod +x "$WRAPPER" "$SCRIPT_DIR/reset-agent.sh" 2>/dev/null || true

# 4) Render the plist from the SINGLE source of truth (lib/agent-plist.js), the
#    exact path main.js's Repair tier uses — so installed == self-repaired.
mkdir -p "$HOME/Library/LaunchAgents"
if command -v node >/dev/null 2>&1; then
  node "$SCRIPT_DIR/lib/agent-plist.js" --write >/dev/null
elif [ -x "$SCRIPT_DIR/node_modules/.bin/electron" ]; then
  ELECTRON_RUN_AS_NODE=1 "$SCRIPT_DIR/node_modules/.bin/electron" "$SCRIPT_DIR/lib/agent-plist.js" --write >/dev/null
else
  echo "[setup] FATAL: need node (or installed electron) to render the plist." >&2
  exit 1
fi
plutil -lint "$PLIST_TARGET" >/dev/null
echo "[setup] ✓ Rendered + linted $PLIST_TARGET"

# 5) Load (or reload) the agent.
if launchctl print "$TARGET" >/dev/null 2>&1; then
  echo "[setup] $LABEL already loaded — kickstart to reload"
  launchctl kickstart -k "$TARGET"
else
  launchctl bootstrap "$DOMAIN" "$PLIST_TARGET"
  echo "[setup] ✓ Bootstrapped $LABEL into launchd ($DOMAIN)"
fi

# 6) Verify (non-fatal).
sleep 1
STATE_LINE="$(launchctl print "$TARGET" 2>/dev/null | grep -E '^[[:space:]]*state = ' | head -1 || true)"
echo "[setup] ${STATE_LINE:-⚠ could not read service state}"

echo ""
echo "──────────────────────────────────────────────────────────────"
echo "Setup complete. Verify:"
echo "  launchctl print $TARGET | grep -E 'state|program ='"
echo "  tail -n 30 $BASE/scanner-app.log | grep -Ei 'watching|electron|FATAL'"
echo ""
echo "Expect 'state = running' and a LiDE device/profile health line."
echo "Tray icon appears in the menu bar. Sign in with your MintVault account, register this Mac and wait for approval. Then use PREVIEW with a disposable card; it visibly detects and saves the jig origin. Do not configure a hot-folder export."
echo "──────────────────────────────────────────────────────────────"
