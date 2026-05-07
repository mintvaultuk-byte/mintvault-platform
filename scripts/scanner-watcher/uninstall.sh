#!/bin/bash
#
# MintVault Scanner Watcher — launchd uninstaller (idempotent).
#
# Boots out BOTH agents (watcher + guide window) and removes their plists
# from ~/Library/LaunchAgents. Leaves user data + token in place.

set -eu

WATCHER_LABEL="com.mintvault.scanner-watcher"
WATCHER_PLIST_NAME="com.mintvault.scanner-watcher.plist"
GUIDE_LABEL="com.mintvault.scanner-guide"
GUIDE_PLIST_NAME="com.mintvault.scanner-guide.plist"

LAUNCHAGENTS="$HOME/Library/LaunchAgents"
WATCHER_PLIST_TARGET="$LAUNCHAGENTS/$WATCHER_PLIST_NAME"
GUIDE_PLIST_TARGET="$LAUNCHAGENTS/$GUIDE_PLIST_NAME"
UID_VAL="$(id -u)"
BASE="$HOME/mintvault-scans"
ENV_FILE="$HOME/.mintvault-scanner.env"

echo "[uninstall] MintVault scanner watcher uninstall (watcher + guide)"

bootout() {
  local label="$1" plist="$2"
  if launchctl print "gui/$UID_VAL/$label" >/dev/null 2>&1; then
    launchctl bootout "gui/$UID_VAL/$label"
    echo "[uninstall] ✓ Booted out $label"
  else
    echo "[uninstall] $label wasn't loaded — skipping"
  fi
  if [ -f "$plist" ]; then
    rm "$plist"
    echo "[uninstall] ✓ Removed $plist"
  else
    echo "[uninstall] $plist not present"
  fi
}

bootout "$WATCHER_LABEL" "$WATCHER_PLIST_TARGET"
bootout "$GUIDE_LABEL"   "$GUIDE_PLIST_TARGET"

echo ""
echo "───────────────────────────────────────────────────────────"
echo "Uninstall complete. User data preserved — nothing auto-deleted:"
echo ""
echo "  $BASE/        (scans + logs)"
echo "  $ENV_FILE     (SCANNER_API_TOKEN)"
echo "  $HOME/.mintvault-scanner-tools/   (guide window position)"
echo ""
echo "To fully clean up, run manually:"
echo ""
echo "  rm -rf $BASE"
echo "  rm $ENV_FILE"
echo "  rm -rf $HOME/.mintvault-scanner-tools"
echo ""
echo "───────────────────────────────────────────────────────────"
