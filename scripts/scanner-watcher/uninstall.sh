#!/bin/bash
#
# MintVault Scanner Watcher — launchd uninstaller (idempotent).
#
# Boots the agent out of launchd and removes the plist from
# ~/Library/LaunchAgents. Intentionally leaves ~/mintvault-scans/ and
# ~/.mintvault-scanner.env in place — user data and credentials are never
# auto-deleted. Prints manual cleanup commands at the end.

set -eu

AGENT_LABEL="com.mintvault.scanner-watcher"
PLIST_NAME="com.mintvault.scanner-watcher.plist"
LAUNCHAGENTS="$HOME/Library/LaunchAgents"
PLIST_TARGET="$LAUNCHAGENTS/$PLIST_NAME"
UID_VAL="$(id -u)"
BASE="$HOME/mintvault-scans"
ENV_FILE="$HOME/.mintvault-scanner.env"

echo "[uninstall] MintVault scanner watcher uninstall"

# 1) Bootout if loaded
if launchctl print "gui/$UID_VAL/$AGENT_LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$UID_VAL/$AGENT_LABEL"
  echo "[uninstall] ✓ Booted out service (gui/$UID_VAL/$AGENT_LABEL)"
else
  echo "[uninstall] Service wasn't loaded — skipping bootout"
fi

# 2) Remove plist
if [ -f "$PLIST_TARGET" ]; then
  rm "$PLIST_TARGET"
  echo "[uninstall] ✓ Removed $PLIST_TARGET"
else
  echo "[uninstall] Plist not present at $PLIST_TARGET — nothing to remove"
fi

echo ""
echo "───────────────────────────────────────────────────────────"
echo "Uninstall complete. User data preserved — nothing auto-deleted:"
echo ""
echo "  $BASE/        (scans: inbox/processed/failed + watcher.log)"
echo "  $ENV_FILE     (SCANNER_API_TOKEN)"
echo ""
echo "To fully clean up, run manually:"
echo ""
echo "  rm -rf $BASE"
echo "  rm $ENV_FILE"
echo ""
echo "───────────────────────────────────────────────────────────"
