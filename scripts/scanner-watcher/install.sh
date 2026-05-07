#!/bin/bash
#
# MintVault Scanner Watcher — launchd installer (idempotent).
#
# Installs TWO LaunchAgents:
#   1. com.mintvault.scanner-watcher  — the daemon (watcher.mjs)
#   2. com.mintvault.scanner-guide    — the always-on-top Electron guide window
#
# Creates the scan folders, writes a token env-file template if none exists,
# installs node deps for both watcher and guide-window, renders both plists
# with absolute paths, and bootstraps both LaunchAgents. Safe to re-run —
# already-loaded agents are reloaded via launchctl kickstart rather than
# bootstrap-twice errors.
#
# Exits non-zero with a clear message if anything required isn't in place.

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GUIDE_DIR="$SCRIPT_DIR/guide-window"

WATCHER_LABEL="com.mintvault.scanner-watcher"
WATCHER_PLIST_NAME="com.mintvault.scanner-watcher.plist"
WATCHER_PLIST_SOURCE="$SCRIPT_DIR/$WATCHER_PLIST_NAME"
WRAPPER="$SCRIPT_DIR/launchd-wrapper.sh"

GUIDE_LABEL="com.mintvault.scanner-guide"
GUIDE_PLIST_NAME="com.mintvault.scanner-guide.plist"
GUIDE_PLIST_SOURCE="$SCRIPT_DIR/$GUIDE_PLIST_NAME"

LAUNCHAGENTS="$HOME/Library/LaunchAgents"
WATCHER_PLIST_TARGET="$LAUNCHAGENTS/$WATCHER_PLIST_NAME"
GUIDE_PLIST_TARGET="$LAUNCHAGENTS/$GUIDE_PLIST_NAME"

BASE="$HOME/mintvault-scans"
ENV_FILE="$HOME/.mintvault-scanner.env"
UID_VAL="$(id -u)"

echo "[install] MintVault scanner watcher install (watcher + guide window)"
echo "[install]   Repo watcher dir: $SCRIPT_DIR"
echo "[install]   Guide window dir: $GUIDE_DIR"
echo "[install]   Watcher service:  $WATCHER_LABEL"
echo "[install]   Guide service:    $GUIDE_LABEL"

# Sanity: needed source files exist
[ -f "$WATCHER_PLIST_SOURCE" ] || { echo "[install] FATAL: watcher plist missing at $WATCHER_PLIST_SOURCE" >&2; exit 1; }
[ -f "$WRAPPER"              ] || { echo "[install] FATAL: wrapper missing at $WRAPPER" >&2; exit 1; }
[ -f "$GUIDE_PLIST_SOURCE"   ] || { echo "[install] FATAL: guide plist missing at $GUIDE_PLIST_SOURCE" >&2; exit 1; }
[ -d "$GUIDE_DIR"            ] || { echo "[install] FATAL: guide-window dir missing at $GUIDE_DIR" >&2; exit 1; }

# 1) Scan folders (incl. discarded/ for /control/reset cleanup)
for sub in inbox processed failed discarded; do
  mkdir -p "$BASE/$sub"
done
echo "[install] ✓ Ensured $BASE/{inbox,processed,failed,discarded}"

# 2) Env file template (never clobber an existing token)
if [ -f "$ENV_FILE" ]; then
  echo "[install] ✓ $ENV_FILE already exists — leaving as-is"
else
  cat > "$ENV_FILE" <<'EOF_ENV'
# MintVault scanner watcher — edit SCANNER_API_TOKEN below with the 64-char
# hex value stored in Fly as the SCANNER_API_TOKEN secret. Leave
# MINTVAULT_INGEST_URL commented unless pointing at staging for testing.
SCANNER_API_TOKEN=
# MINTVAULT_INGEST_URL=https://mintvault-v2.fly.dev/api/admin/scan-ingest
EOF_ENV
  chmod 600 "$ENV_FILE"
  echo "[install] ✓ Created $ENV_FILE template (token placeholder empty)"
fi

# 3) Install node deps — watcher + guide-window
echo "[install] npm install (watcher)…"
( cd "$SCRIPT_DIR" && npm install --silent )
echo "[install] ✓ Watcher deps installed"

echo "[install] npm install (guide-window — pulls Electron, ~150MB first run)…"
( cd "$GUIDE_DIR" && npm install --silent )
echo "[install] ✓ Guide-window deps installed"

# 4) Wrapper executable
chmod +x "$WRAPPER"
echo "[install] ✓ Wrapper marked executable"

# 5) Render both plists with absolute paths into ~/Library/LaunchAgents
mkdir -p "$LAUNCHAGENTS"
sed -e "s|__WRAPPER_PATH__|$WRAPPER|g" \
    -e "s|__HOME__|$HOME|g" \
    "$WATCHER_PLIST_SOURCE" > "$WATCHER_PLIST_TARGET"
echo "[install] ✓ Rendered watcher plist → $WATCHER_PLIST_TARGET"

sed -e "s|__GUIDE_DIR__|$GUIDE_DIR|g" \
    -e "s|__HOME__|$HOME|g" \
    "$GUIDE_PLIST_SOURCE" > "$GUIDE_PLIST_TARGET"
echo "[install] ✓ Rendered guide plist → $GUIDE_PLIST_TARGET"

# 6) Bootstrap or kickstart each agent
bootstrap_or_kickstart() {
  local label="$1" plist="$2"
  if launchctl print "gui/$UID_VAL/$label" >/dev/null 2>&1; then
    echo "[install] $label already loaded — kickstart to reload"
    launchctl kickstart -k "gui/$UID_VAL/$label"
  else
    launchctl bootstrap "gui/$UID_VAL" "$plist"
    echo "[install] ✓ Bootstrapped $label into launchd (gui/$UID_VAL)"
  fi
}
bootstrap_or_kickstart "$WATCHER_LABEL" "$WATCHER_PLIST_TARGET"
bootstrap_or_kickstart "$GUIDE_LABEL"   "$GUIDE_PLIST_TARGET"

# 7) Verify state (non-fatal)
sleep 1
for label in "$WATCHER_LABEL" "$GUIDE_LABEL"; do
  STATE_LINE="$(launchctl print "gui/$UID_VAL/$label" 2>/dev/null | grep -E '^[[:space:]]*state = ' | head -1 || true)"
  if [ -n "$STATE_LINE" ]; then
    echo "[install] ✓ $label → $STATE_LINE"
  else
    echo "[install] ⚠ Could not read state for $label — check $BASE/watcher.log + $BASE/guide.log"
  fi
done

echo ""
echo "───────────────────────────────────────────────────────────"
echo "Install complete. Next steps:"
echo ""
echo "  1. Put the token into $ENV_FILE"
echo "     (same hex value stored in Fly as SCANNER_API_TOKEN)"
echo ""
echo "       open -e $ENV_FILE"
echo ""
echo "     Save, then reload the watcher to pick up the new value:"
echo ""
echo "       launchctl kickstart -k gui/$UID_VAL/$WATCHER_LABEL"
echo ""
echo "  2. In SilverFast SE, set the output folder to:"
echo ""
echo "       $BASE/inbox/"
echo ""
echo "  3. The Guide Window appears top-right of your primary display."
echo "     Drag it where you want — position is remembered between launches."
echo ""
echo "  4. Scan a card — front first, then back. The Guide tells you which"
echo "     side is expected next. No timer, no clicks."
echo ""
echo "  5. Tail the logs if needed:"
echo ""
echo "       tail -f $BASE/watcher.log"
echo "       tail -f $BASE/guide.log"
echo ""
echo "To uninstall: $SCRIPT_DIR/uninstall.sh"
echo "───────────────────────────────────────────────────────────"
