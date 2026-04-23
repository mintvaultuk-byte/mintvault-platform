#!/bin/bash
# launchd-wrapper.sh
#
# Launched by com.mintvault.scanner-watcher plist. Sources the user's env
# file (SCANNER_API_TOKEN, optional MINTVAULT_INGEST_URL), expands PATH so
# node is findable under launchd's minimal environment, then execs the
# watcher. Self-locates relative to this script so the repo can live
# anywhere on disk.

set -u

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$HOME/.mintvault-scanner.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "[wrapper] FATAL: $ENV_FILE not found." >&2
  echo "[wrapper] Put SCANNER_API_TOKEN=<hex> in that file and reload via:" >&2
  echo "[wrapper]   launchctl kickstart -k gui/\$(id -u)/com.mintvault.scanner-watcher" >&2
  exit 1
fi

# Source env — export each assignment
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

if ! command -v node >/dev/null 2>&1; then
  echo "[wrapper] FATAL: node not found on PATH: $PATH" >&2
  echo "[wrapper] Install node or add its bin dir to PATH in this wrapper." >&2
  exit 1
fi

echo "[wrapper] node=$(command -v node) watcher=$SCRIPT_DIR/watcher.mjs"
exec node "$SCRIPT_DIR/watcher.mjs"
