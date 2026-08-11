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
for sub in inbox processed failed rejected discarded capture-staging; do
  mkdir -p "$BASE/$sub"
done
echo "[install] ✓ Ensured $BASE/{inbox,processed,failed,rejected,discarded,capture-staging}"

# 2) App Support directory (state.json lives there)
mkdir -p "$HOME/Library/Application Support/MintVaultScanner"
echo "[install] ✓ Ensured Application Support directory"

# 3) Non-secret local configuration. Station approval happens in the app: its
# per-Mac private key and short-lived operator session live in macOS Keychain,
# never in this file. Never clobber an existing local-development config.
if [ -f "$ENV_FILE" ]; then
  echo "[install] ✓ $ENV_FILE already exists — leaving as-is"
else
  cat > "$ENV_FILE" <<'EOF_ENV'
# MintVault Scanner — non-secret local configuration only.
# On first launch, sign in with an authorised MintVault account and register
# this Mac. The server assigns the MV-STN station code; do not add tokens,
# passwords or a hand-made station ID here.
# Optional controlled development endpoint override:
# MINTVAULT_API_BASE=http://127.0.0.1:5000
# Allow the Scanner's local Preview → Detect flow to persist only this station's
# measured hardware origin after the operator visibly confirms a safe placement.
# MINTVAULT_STATION_CONFIG_PATH=/Users/your-user/.mintvault-scanner.env
# Locked 100x130 mm hardware-region origin in millimetres. Do not guess or
# expose these as day-to-day operator controls; Preview writes them only after
# it shows a detected card with the required surrounding safety margin.
# MINTVAULT_LIDE_SCAN_X_MM=
# MINTVAULT_LIDE_SCAN_Y_MM=
EOF_ENV
  chmod 600 "$ENV_FILE"
  echo "[install] ✓ Created non-secret station configuration"
fi

# The Scanner can persist a measured jig only when the station explicitly opts
# into its own non-secret configuration file. This is not an X/Y prompt: the
# visible Preview → Detect flow writes both coordinates atomically after it
# confirms a safe card boundary.
if ! grep -qE '^MINTVAULT_STATION_CONFIG_PATH=.+' "$ENV_FILE"; then
  printf 'MINTVAULT_STATION_CONFIG_PATH=%s\n' "$ENV_FILE" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
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
echo "  1. Open the tray app and sign in with an authorised MintVault account."
echo "     Register this Mac; a Super Admin approves the server-assigned station."
echo ""
echo "  2. The tray icon should appear in the menu bar — left-click for popover."
echo ""
echo "  3. Once approved, run PREVIEW with a disposable card."
echo "     It visibly detects the card and saves the local LiDE jig origin before target-bound SCAN FRONT / FLIP CARD / SCAN BACK."
echo "     Hot-folder TIFFs are retained only in quarantine and are never ingested."
echo ""
echo "  4. Tail the log if needed:"
echo "       tail -f $BASE/scanner-app.log"
echo ""
echo "To uninstall (and tear down old watcher/guide agents): $SCRIPT_DIR/uninstall.sh"
echo "──────────────────────────────────────────────────────────────"
