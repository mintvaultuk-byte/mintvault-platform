#!/bin/bash
#
# update.sh — one-click scanner-app update, launched DETACHED from the app's
# "Update app" button (main.js "update-app" IPC). Must outlive the app process:
# the final kickstart kills the running Electron app and launchd restarts it
# on the new code.
#
#   1. git pull --ff-only on the repo this app lives in
#   2. npm install in scripts/scanner-app (deps may have changed)
#   3. launchctl kickstart the LaunchAgent (com.mintvault.scanner — the label
#      lib/agent-plist.js owns)
#
# All output appends to the scanner log so the operator can see what happened.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG="$HOME/mintvault-scans/scanner-app.log"
LABEL="com.mintvault.scanner"
UID_VAL="$(id -u)"

exec >>"$LOG" 2>&1
echo "[update] $(date -u +%FT%TZ) starting — repo=$REPO_ROOT"

# Give the app a moment to finish writing state before we yank it.
sleep 2

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

if ! git -C "$REPO_ROOT" pull --ff-only; then
  echo "[update] FAILED: git pull (local changes or diverged branch?) — app NOT restarted"
  exit 1
fi

if ! (cd "$SCRIPT_DIR" && npm install --silent --no-audit --no-fund); then
  echo "[update] FAILED: npm install — app NOT restarted (still on old deps)"
  exit 1
fi

NEW_VERSION="$(node -p "require('$SCRIPT_DIR/package.json').version" 2>/dev/null || echo '?')"
echo "[update] pulled + deps installed — restarting app (new version: v$NEW_VERSION)"
launchctl kickstart -k "gui/$UID_VAL/$LABEL"
echo "[update] $(date -u +%FT%TZ) done"
