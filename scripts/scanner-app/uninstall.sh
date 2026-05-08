#!/bin/bash
#
# MintVault Scanner — uninstall the menu-bar app AND tear down the legacy
# watcher + guide-window LaunchAgents in one shot. Designed to be safe to
# run on a clean machine (every step ignores "not loaded" errors).

set -u

UID_VAL="$(id -u)"
LAUNCHAGENTS="$HOME/Library/LaunchAgents"

NEW_LABEL="com.mintvault.scanner-app"
OLD_WATCHER_LABEL="com.mintvault.scanner-watcher"
OLD_GUIDE_LABEL="com.mintvault.scanner-guide"
SWIFTBAR_PLUGIN="$HOME/Library/Application Support/SwiftBar/Plugins/mintvault-scanner.5s.sh"

bootout() {
  local label="$1"
  if launchctl print "gui/$UID_VAL/$label" >/dev/null 2>&1; then
    echo "[uninstall] booting out $label"
    launchctl bootout "gui/$UID_VAL/$label" 2>/dev/null || true
  else
    echo "[uninstall] $label not loaded — skip"
  fi
}

remove_plist() {
  local label="$1"
  local plist="$LAUNCHAGENTS/$label.plist"
  if [ -f "$plist" ]; then
    rm -f "$plist"
    echo "[uninstall] removed $plist"
  else
    echo "[uninstall] $plist not present — skip"
  fi
}

# 1) Bootout in this order: new app first (to avoid races with anything it
#    might be holding open), then the two old agents.
bootout "$NEW_LABEL"
bootout "$OLD_WATCHER_LABEL"
bootout "$OLD_GUIDE_LABEL"

# 2) Remove plist files for all three.
remove_plist "$NEW_LABEL"
remove_plist "$OLD_WATCHER_LABEL"
remove_plist "$OLD_GUIDE_LABEL"

# 3) SwiftBar plugin file (if present).
if [ -f "$SWIFTBAR_PLUGIN" ]; then
  rm -f "$SWIFTBAR_PLUGIN"
  echo "[uninstall] removed SwiftBar plugin: $SWIFTBAR_PLUGIN"
else
  echo "[uninstall] no SwiftBar plugin present — skip"
fi

# 4) Sanity report.
echo ""
echo "──────────────────────────────────────────────────────────────"
echo "Uninstall complete. Verification:"
launchctl list | grep mintvault || echo "  (no MintVault agents loaded — clean)"
echo "──────────────────────────────────────────────────────────────"
echo ""
echo "Left untouched on disk (recoverable):"
echo "  ~/.mintvault-scanner.env       (token)"
echo "  ~/mintvault-scans/             (inbox/processed/failed/discarded)"
echo "  ~/Library/Application Support/MintVaultScanner/state.json"
echo ""
echo "Old code still in repo at scripts/scanner-watcher/ — kept for rollback."
