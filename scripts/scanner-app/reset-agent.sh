#!/bin/bash
#
# reset-agent.sh — escalating recovery for the LIVE scanner LaunchAgent
# (com.mintvault.scanner). Spawned DETACHED by main.js's reset after the
# in-process "Soft" tier, because the launchctl tiers below kill+relaunch the
# app itself (the app IS com.mintvault.scanner), so the escalation must outlive
# the app. Restart is via the agent's KeepAlive; this script then exits.
#
# Tiers (escalate ONLY on failure of the prior tier):
#   Reload  : kickstart -k ; on failure → bootout → bootstrap
#   Repair  : regenerate the plist from the SINGLE source of truth
#             (lib/agent-plist.js) → bootstrap → kickstart
#
# Every tier is logged with a timestamp + reason to scanner-app.log, and a
# plain-English status is written to last-reset.json for the app to surface on
# relaunch: "Reloaded agent" / "Repaired + reinstalled agent" /
# "Manual fix needed: <reason>". No raw exit codes reach the UI.

set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.mintvault.scanner"
UID_VAL="$(id -u)"
DOMAIN="gui/$UID_VAL"
TARGET="$DOMAIN/$LABEL"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/mintvault-scans/scanner-app.log"
STATUS="$HOME/mintvault-scans/last-reset.json"
ELECTRON_BIN="$APP_DIR/node_modules/.bin/electron"
# A packaged Scanner has no development Electron dependency. The renamed bundle executable is
# still Electron and can run the plist renderer with ELECTRON_RUN_AS_NODE=1.
PACKAGED_ELECTRON="$APP_DIR/../../MacOS/MintVault Scanner"
REASON="${1:-manual reset}"

mkdir -p "$HOME/mintvault-scans"

log() { printf '[%s] [reset] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG"; }

# JSON-escape a string for the status file (quotes + backslashes).
json_esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

write_status() { # tier, status, reason
  printf '{"tier":"%s","status":"%s","reason":"%s","ts":"%s"}\n' \
    "$(json_esc "$1")" "$(json_esc "$2")" "$(json_esc "$3")" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATUS"
}

is_running() {
  launchctl print "$TARGET" 2>/dev/null | grep -Eq '^[[:space:]]*state = running'
}

plist_ok() {
  [ -f "$PLIST" ] && plutil -lint "$PLIST" >/dev/null 2>&1
}

regen_plist() {
  # Single source of truth — render via lib/agent-plist.js using the app's own
  # Electron as node (always present; no system-node dependency).
  if [ -x "$ELECTRON_BIN" ]; then
    ELECTRON_RUN_AS_NODE=1 "$ELECTRON_BIN" "$APP_DIR/lib/agent-plist.js" --write >/dev/null 2>>"$LOG"
  elif [ -x "$PACKAGED_ELECTRON" ]; then
    ELECTRON_RUN_AS_NODE=1 "$PACKAGED_ELECTRON" "$APP_DIR/lib/agent-plist.js" --write >/dev/null 2>>"$LOG"
  elif command -v node >/dev/null 2>&1; then
    node "$APP_DIR/lib/agent-plist.js" --write >/dev/null 2>>"$LOG"
  else
    return 1
  fi
  chmod 644 "$PLIST" 2>/dev/null
  plist_ok
}

log "=== reset escalation start (reason: $REASON) ==="

# ── Tier 2: Reload ────────────────────────────────────────────────────────
log "Reload: kickstart -k $TARGET"
launchctl kickstart -k "$TARGET" >>"$LOG" 2>&1
KC=$?
sleep 1
if [ "$KC" -eq 0 ] && is_running; then
  log "Reload OK (kickstart) → running"
  write_status "reload" "Reloaded agent" "kickstart"
  exit 0
fi

log "Reload: kickstart exit $KC (or not running) → bootout + bootstrap"
launchctl bootout "$TARGET" >>"$LOG" 2>&1 || true
sleep 1
if plist_ok; then
  launchctl bootstrap "$DOMAIN" "$PLIST" >>"$LOG" 2>&1
  BS=$?
  sleep 1
  if [ "$BS" -eq 0 ] && is_running; then
    log "Reload OK (bootout→bootstrap) → running"
    write_status "reload" "Reloaded agent" "bootout+bootstrap"
    exit 0
  fi
  log "Reload: bootstrap exit $BS (or not running) → escalate to Repair"
else
  log "Reload: plist missing/invalid at $PLIST → escalate to Repair"
fi

# ── Tier 3: Repair ────────────────────────────────────────────────────────
log "Repair: regenerate plist from source-of-truth (lib/agent-plist.js)"
if ! regen_plist; then
  log "Repair: FAILED to regenerate a valid plist"
  write_status "repair" "Manual fix needed: could not regenerate a valid plist" "regen failed"
  exit 1
fi
log "Repair: plist regenerated + lint OK → bootout + bootstrap + kickstart"
launchctl bootout "$TARGET" >>"$LOG" 2>&1 || true
sleep 1
launchctl bootstrap "$DOMAIN" "$PLIST" >>"$LOG" 2>&1
RBS=$?
launchctl kickstart -k "$TARGET" >>"$LOG" 2>&1 || true
sleep 1
if is_running; then
  log "Repair OK → running"
  write_status "repair" "Repaired + reinstalled agent" "regen+bootstrap"
  exit 0
fi

log "Repair: agent still not running after reinstall (bootstrap exit $RBS)"
write_status "repair" "Manual fix needed: agent not running after reinstall" "bootstrap exit $RBS"
exit 1
