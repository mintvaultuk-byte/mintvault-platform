#!/bin/bash
#
# MintVault Scanner — install the menu-bar app as a single LaunchAgent.
# Idempotent: re-running kicks the existing service rather than failing.
#
# This installer DOES NOT tear down the old com.mintvault.scanner-watcher
# or com.mintvault.scanner-guide agents. Run uninstall.sh BEFORE this
# script (or use the cutover steps in CUTOVER.md) to fully replace them.

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Label UNIFIED with lib/agent-plist.js (the app's single source of truth) —
# previously this installed com.mintvault.scanner-app while the app's own
# self-repair managed com.mintvault.scanner, leaving two competing agents.
LABEL="com.mintvault.scanner"
PLIST_NAME="$LABEL.plist"
PLIST_SOURCE="$SCRIPT_DIR/$PLIST_NAME"
WRAPPER="$SCRIPT_DIR/launchd-wrapper.sh"
LAUNCHAGENTS="$HOME/Library/LaunchAgents"
PLIST_TARGET="$LAUNCHAGENTS/$PLIST_NAME"
BASE="$HOME/mintvault-scans"
ENV_FILE="$HOME/.mintvault-scanner.env"
UID_VAL="$(id -u)"

echo "[install] MintVault scanner-app install"
echo "[install]   App dir:  $SCRIPT_DIR"
echo "[install]   Service:  $LABEL"

# Sanity
[ -f "$WRAPPER"      ] || { echo "[install] FATAL: wrapper missing at $WRAPPER" >&2; exit 1; }

# 1) Scan folders (matches watcher.mjs convention)
for sub in inbox processed failed rejected discarded; do
  mkdir -p "$BASE/$sub"
done
echo "[install] ✓ Ensured $BASE/{inbox,processed,failed,discarded}"

# 2) App Support directory (state.json lives there)
mkdir -p "$HOME/Library/Application Support/MintVaultScanner"
echo "[install] ✓ Ensured Application Support directory"

# 3) Env file template (never clobber an existing token)
if [ -f "$ENV_FILE" ]; then
  echo "[install] ✓ $ENV_FILE already exists — leaving as-is"
else
  cat > "$ENV_FILE" <<'EOF_ENV'
# MintVault scanner-app — same env file as the old watcher.
# SCANNER_API_TOKEN must match the server's Fly secret.
SCANNER_API_TOKEN=
# Phase 1 — per-operator identity. Set to THIS Mac's operator login email so the
# server attributes scans to them (certificates.scanned_by). Leave unset to scan
# anonymously (scanned_by NULL). e.g. SCANNER_OPERATOR=ashleybarnes@example.com
# SCANNER_OPERATOR=
# Optional override (defaults to https://mintvaultuk.com)
# MINTVAULT_API_BASE=https://mintvault-v2.fly.dev
EOF_ENV
  chmod 600 "$ENV_FILE"
  echo "[install] ✓ Created $ENV_FILE template (token placeholder empty)"
fi

# 4) npm install (Electron + chokidar + form-data + node-fetch)
echo "[install] npm install (pulls Electron, ~150MB on first run)…"
( cd "$SCRIPT_DIR" && npm install --silent )
echo "[install] ✓ Deps installed"

# 5) Wrapper executable
chmod +x "$WRAPPER"
echo "[install] ✓ Wrapper marked executable"

# 6) Render plist from the SINGLE source of truth (lib/agent-plist.js) — the
# same renderer the app's self-repair uses, so install and repair can never
# drift onto different labels/paths again.
mkdir -p "$LAUNCHAGENTS"
if command -v node >/dev/null 2>&1; then
  node "$SCRIPT_DIR/lib/agent-plist.js" --write >/dev/null
else
  ELECTRON_RUN_AS_NODE=1 "$SCRIPT_DIR/node_modules/.bin/electron" "$SCRIPT_DIR/lib/agent-plist.js" --write >/dev/null
fi
echo "[install] ✓ Rendered plist → $PLIST_TARGET (via lib/agent-plist.js)"

# 7) Bootstrap or kickstart
if launchctl print "gui/$UID_VAL/$LABEL" >/dev/null 2>&1; then
  echo "[install] $LABEL already loaded — kickstart to reload"
  launchctl kickstart -k "gui/$UID_VAL/$LABEL"
else
  launchctl bootstrap "gui/$UID_VAL" "$PLIST_TARGET"
  echo "[install] ✓ Bootstrapped $LABEL into launchd (gui/$UID_VAL)"
fi

# 8) Verify state (non-fatal)
sleep 1
STATE_LINE="$(launchctl print "gui/$UID_VAL/$LABEL" 2>/dev/null | grep -E '^[[:space:]]*state = ' | head -1 || true)"
if [ -n "$STATE_LINE" ]; then
  echo "[install] ✓ $LABEL → $STATE_LINE"
else
  echo "[install] ⚠ Could not read service state — check $BASE/scanner-app.log"
fi

echo ""
echo "──────────────────────────────────────────────────────────────"
echo "Install complete. Next steps:"
echo ""
echo "  1. Put the token into $ENV_FILE (matches the server Fly secret)"
echo "       open -e $ENV_FILE"
echo "       launchctl kickstart -k gui/$UID_VAL/$LABEL"
echo ""
echo "  2. The tray icon should appear in the menu bar — left-click for popover."
echo ""
echo "  3. SilverFast SE output folder still: $BASE/inbox/"
echo ""
echo "  4. Tail the log if needed:"
echo "       tail -f $BASE/scanner-app.log"
echo ""
echo "To uninstall (and tear down old watcher/guide agents): $SCRIPT_DIR/uninstall.sh"
echo "──────────────────────────────────────────────────────────────"
