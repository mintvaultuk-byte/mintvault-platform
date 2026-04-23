#!/bin/bash
#
# MintVault Scanner Watcher — launchd installer (idempotent).
#
# Creates the scan folders, writes a token env-file template if none exists,
# installs node deps, renders the plist with absolute paths, and bootstraps
# the LaunchAgent. Safe to re-run — already-loaded agents are reloaded via
# launchctl kickstart rather than a double-bootstrap error.
#
# Exits non-zero with a clear message if anything required isn't in place.

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

AGENT_LABEL="com.mintvault.scanner-watcher"
PLIST_NAME="com.mintvault.scanner-watcher.plist"
PLIST_SOURCE="$SCRIPT_DIR/$PLIST_NAME"
WRAPPER="$SCRIPT_DIR/launchd-wrapper.sh"

LAUNCHAGENTS="$HOME/Library/LaunchAgents"
PLIST_TARGET="$LAUNCHAGENTS/$PLIST_NAME"

BASE="$HOME/mintvault-scans"
ENV_FILE="$HOME/.mintvault-scanner.env"
UID_VAL="$(id -u)"

echo "[install] MintVault scanner watcher install"
echo "[install]   Repo watcher dir: $SCRIPT_DIR"
echo "[install]   Service label:    $AGENT_LABEL"

# Sanity: needed source files exist
if [ ! -f "$PLIST_SOURCE" ]; then
  echo "[install] FATAL: plist template missing at $PLIST_SOURCE" >&2
  exit 1
fi
if [ ! -f "$WRAPPER" ]; then
  echo "[install] FATAL: wrapper script missing at $WRAPPER" >&2
  exit 1
fi

# 1) Scan folders
for sub in inbox processed failed; do
  mkdir -p "$BASE/$sub"
done
echo "[install] ✓ Ensured $BASE/{inbox,processed,failed}"

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

# 3) Install node deps
echo "[install] Running npm install in watcher dir..."
( cd "$SCRIPT_DIR" && npm install --silent )
echo "[install] ✓ Node deps installed"

# 4) Wrapper executable
chmod +x "$WRAPPER"
echo "[install] ✓ Wrapper marked executable"

# 5) Render plist with absolute paths into ~/Library/LaunchAgents
mkdir -p "$LAUNCHAGENTS"
# Use | as sed separator since paths contain /
sed -e "s|__WRAPPER_PATH__|$WRAPPER|g" \
    -e "s|__HOME__|$HOME|g" \
    "$PLIST_SOURCE" > "$PLIST_TARGET"
echo "[install] ✓ Rendered plist → $PLIST_TARGET"

# 6) Bootstrap or kickstart
if launchctl print "gui/$UID_VAL/$AGENT_LABEL" >/dev/null 2>&1; then
  echo "[install] Service already loaded — kickstart to reload"
  launchctl kickstart -k "gui/$UID_VAL/$AGENT_LABEL"
else
  launchctl bootstrap "gui/$UID_VAL" "$PLIST_TARGET"
  echo "[install] ✓ Bootstrapped into launchd (gui/$UID_VAL)"
fi

# 7) Verify state (non-fatal)
sleep 1
STATE_LINE="$(launchctl print "gui/$UID_VAL/$AGENT_LABEL" 2>/dev/null | grep -E '^[[:space:]]*state = ' | head -1 || true)"
if [ -n "$STATE_LINE" ]; then
  echo "[install] ✓ $STATE_LINE"
else
  echo "[install] ⚠ Could not read service state — check $BASE/watcher.log"
fi

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
echo "       launchctl kickstart -k gui/$UID_VAL/$AGENT_LABEL"
echo ""
echo "  2. In SilverFast SE, set the output folder to:"
echo ""
echo "       $BASE/inbox/"
echo ""
echo "  3. Scan a card pair (front, then back within 60 seconds) to test."
echo ""
echo "  4. Watch the log for activity:"
echo ""
echo "       tail -f $BASE/watcher.log"
echo ""
echo "To uninstall: $SCRIPT_DIR/uninstall.sh"
echo "───────────────────────────────────────────────────────────"
