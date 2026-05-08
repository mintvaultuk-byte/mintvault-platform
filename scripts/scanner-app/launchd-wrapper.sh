#!/bin/bash
# launchd-wrapper.sh
#
# Launched by com.mintvault.scanner-app plist. Sources the user's env file
# (SCANNER_API_TOKEN, optional MINTVAULT_API_BASE), expands PATH so
# node/electron are findable under launchd's minimal env, then execs the
# app via the local Electron binary.

set -u

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$HOME/.mintvault-scanner.env"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
else
  echo "[wrapper] WARN: $ENV_FILE not found — token will be empty, watcher will refuse to start."
fi

ELECTRON_BIN="$SCRIPT_DIR/node_modules/.bin/electron"
if [ ! -x "$ELECTRON_BIN" ]; then
  echo "[wrapper] FATAL: electron not installed at $ELECTRON_BIN. Run install.sh." >&2
  exit 1
fi

echo "[wrapper] electron=$ELECTRON_BIN cwd=$SCRIPT_DIR"
exec "$ELECTRON_BIN" "$SCRIPT_DIR"
