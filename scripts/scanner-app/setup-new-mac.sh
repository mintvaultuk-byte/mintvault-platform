#!/bin/bash
#
# setup-new-mac.sh — bring up a NEW scanning station (e.g. a second Mac) to run
# the MintVault menu-bar scanner against PROD, watching its own local inbox.
#
# WHY THIS EXISTS (and not install.sh):
#   install.sh + com.mintvault.scanner-app.plist install a LaunchAgent labelled
#   `com.mintvault.scanner-app`. The app's OWN source of truth (lib/agent-plist.js)
#   and its self-repair (reset-agent.sh, main.js) target `com.mintvault.scanner`.
#   Mixing the two makes the installed agent and the app's repair tier drift into
#   two competing agents. This script installs the SAME label the app manages,
#   rendered from the SAME source of truth, so they can never disagree.
#
# Safe to run on a fresh Mac. Idempotent: re-running fills gaps and kickstarts.
# This is PER-MACHINE — it touches only THIS Mac's launchd domain. It cannot
# reach any other scanning station.
#
# Assumes the repo is already cloned and you are running this from inside it.
# Prereqs (Homebrew, Node 22, git) are NOT installed here — see README.

set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.mintvault.scanner"
PLIST_TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
WRAPPER="$SCRIPT_DIR/launchd-wrapper.sh"
BASE="$HOME/mintvault-scans"
ENV_FILE="$HOME/.mintvault-scanner.env"
UID_VAL="$(id -u)"
DOMAIN="gui/$UID_VAL"
TARGET="$DOMAIN/$LABEL"

echo "[setup] MintVault scanner — new-station setup"
echo "[setup]   App dir:  $SCRIPT_DIR"
echo "[setup]   Service:  $LABEL  (the label the app self-manages)"
echo "[setup]   Target:   PROD (https://mintvaultuk.com — server-client.js default)"

# 1) Scan folders (matches watcher.js convention)
for sub in inbox processed failed discarded; do
  mkdir -p "$BASE/$sub"
done
mkdir -p "$HOME/Library/Application Support/MintVaultScanner"
echo "[setup] ✓ Ensured $BASE/{inbox,processed,failed,discarded} + App Support dir"

# 2) Env file + token. Never clobber an existing token. Prompt history-safely if
#    the file is missing OR the token line is empty.
need_token() {
  [ ! -f "$ENV_FILE" ] || ! grep -qE '^SCANNER_API_TOKEN=.+' "$ENV_FILE"
}
if need_token; then
  echo "[setup] SCANNER_API_TOKEN not set yet — paste it (input hidden)."
  echo "[setup]   (bring this value from the existing station; it matches the server Fly secret)"
  umask 077
  printf '[setup]   Token: '
  read -rs MV_TOK; echo
  if [ -z "${MV_TOK:-}" ]; then
    echo "[setup] FATAL: empty token — re-run and paste the value." >&2
    exit 1
  fi
  # Leave API base unset → server-client.js defaults to PROD (https://mintvaultuk.com).
  printf 'SCANNER_API_TOKEN=%s\n' "$MV_TOK" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  unset MV_TOK
  echo "[setup] ✓ Wrote $ENV_FILE (chmod 600)"
else
  echo "[setup] ✓ $ENV_FILE already has a token — leaving as-is"
fi

# 3) Deps. The app runs under its OWN bundled Electron; npm install also fetches
#    sharp's prebuilt arm64 binary. No separate build step exists.
if [ ! -x "$SCRIPT_DIR/node_modules/.bin/electron" ]; then
  echo "[setup] Electron not present — running npm install (pulls ~150MB on first run)…"
  ( cd "$SCRIPT_DIR" && npm install --silent )
  echo "[setup] ✓ Deps installed"
else
  echo "[setup] ✓ Electron already installed"
fi

chmod +x "$WRAPPER" "$SCRIPT_DIR/reset-agent.sh" 2>/dev/null || true

# 4) Render the plist from the SINGLE source of truth (lib/agent-plist.js), the
#    exact path main.js's Repair tier uses — so installed == self-repaired.
mkdir -p "$HOME/Library/LaunchAgents"
if command -v node >/dev/null 2>&1; then
  node "$SCRIPT_DIR/lib/agent-plist.js" --write >/dev/null
elif [ -x "$SCRIPT_DIR/node_modules/.bin/electron" ]; then
  ELECTRON_RUN_AS_NODE=1 "$SCRIPT_DIR/node_modules/.bin/electron" "$SCRIPT_DIR/lib/agent-plist.js" --write >/dev/null
else
  echo "[setup] FATAL: need node (or installed electron) to render the plist." >&2
  exit 1
fi
plutil -lint "$PLIST_TARGET" >/dev/null
echo "[setup] ✓ Rendered + linted $PLIST_TARGET"

# 5) Load (or reload) the agent.
if launchctl print "$TARGET" >/dev/null 2>&1; then
  echo "[setup] $LABEL already loaded — kickstart to reload"
  launchctl kickstart -k "$TARGET"
else
  launchctl bootstrap "$DOMAIN" "$PLIST_TARGET"
  echo "[setup] ✓ Bootstrapped $LABEL into launchd ($DOMAIN)"
fi

# 6) Verify (non-fatal).
sleep 1
STATE_LINE="$(launchctl print "$TARGET" 2>/dev/null | grep -E '^[[:space:]]*state = ' | head -1 || true)"
echo "[setup] ${STATE_LINE:-⚠ could not read service state}"

echo ""
echo "──────────────────────────────────────────────────────────────"
echo "Setup complete. Verify:"
echo "  launchctl print $TARGET | grep -E 'state|program ='"
echo "  tail -n 30 $BASE/scanner-app.log | grep -Ei 'watching|electron|FATAL'"
echo ""
echo "Expect 'state = running' and a 'watching $BASE/inbox' log line."
echo "Tray icon appears in the menu bar. Point your scanner's output at $BASE/inbox/."
echo "──────────────────────────────────────────────────────────────"
