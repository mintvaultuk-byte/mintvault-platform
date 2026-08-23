#!/bin/bash
#
# MintVault Scanner — "shop games" STAGING instance, with proof.
#
# WHY A SEPARATE INSTANCE. This Mac is enrolled as MV-STN-6DIISWMIEU2IKRG4 for "pokemon kings"
# (Shop 0), with a VALID calibration the capture-authority work depends on. MINTVAULT_SCANS_DIR
# gives this run its own station identity, its own app state and (since 1.4.0) its own Electron
# profile and single-instance lock — so shop games can enrol without touching, clearing or
# re-homing the Shop 0 station.
#
# WHY THIS SCRIPT VERIFIES INSTEAD OF ASSUMING. Twice, a launch that did nothing looked like a
# launch that worked:
#   1. Electron keys its single-instance lock on the userData path. The isolated run asked for the
#      SHARED lock, lost it to the running Scanner, quit instantly and merely re-opened the OTHER
#      shop's window. A window appeared, so it looked like success.
#   2. The app is menu-bar-only and its tray had no Quit item, so "quit it first" asked for a
#      control that did not exist.
# Both are fixed in the app. This script's job is to make the remaining failure modes impossible to
# mistake for success: it identifies every running Scanner, terminates only a genuinely conflicting
# one, waits for the PID to actually exit, launches the exact build, then reads the NEW process back
# and fails loudly if any field differs from what was asked for.
#
# Everything this instance owns lives under one folder. Deleting that folder undoes it entirely.
set -uo pipefail

# Overridable so this is a repo tool rather than one machine's script. The defaults are the
# shop games staging acceptance instance; MINTVAULT_INSTANCE_DIR and MINTVAULT_APP_BUNDLE point it
# anywhere else. The app bundle defaults to the build produced by this checkout.
# realpath, because the machine's copy is a SYMLINK to this file: dirname of the link resolves to
# the link's folder, not to the checkout, and the bundle path below is relative to the checkout.
SELF="$(/usr/bin/python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "${BASH_SOURCE[0]}")"
HERE="$(cd "$(dirname "$SELF")" && pwd)"
INSTANCE="${MINTVAULT_INSTANCE_DIR:-$HOME/mintvault-shopgames}"
APP_BUNDLE="${MINTVAULT_APP_BUNDLE:-$HERE/../dist/mac-arm64/MintVault Scanner.app}"
# Normalised, because the manifest records the process's canonical execPath. A default carrying
# "acceptance/../dist" compares unequal to the same file named plainly, so every run would decide
# the running instance was the wrong executable and replace a perfectly correct one.
APP="$(/usr/bin/python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$APP_BUNDLE/Contents/MacOS/MintVault Scanner")"
APP_PKG="$APP_BUNDLE/Contents/Resources/app/package.json"
PATTERN='MintVault Scanner.app/Contents/MacOS/MintVault Scanner'
WANT_PROFILE="$INSTANCE/electron-profile"
WANT_ENV="staging"
WANT_URL="https://mintvault-v2.fly.dev"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '\n'; red "  STOP: $*"; printf '\n  Nothing was launched. No server state was changed.\n\n'; exit 1; }

printf '\n  MintVault Scanner — shop games (STAGING)\n\n'

[ -x "$APP" ]     || die "Scanner build missing at $APP"
[ -f "$APP_PKG" ] || die "Scanner build is incomplete — no package.json at $APP_PKG"
WANT_VERSION="$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$APP_PKG" 2>/dev/null)"
[ -n "$WANT_VERSION" ] || die "could not read the version out of $APP_PKG"

# WHICH BUILD, not merely which version — the same hash the app computes over its own executing
# files, in the same order. A version string is bumped by a person and lags: two different builds
# carried 1.5.0 within a minute, and comparing versions alone left the older code running while
# reporting success.
APP_DIR="$APP_BUNDLE/Contents/Resources/app"
WANT_BUILD="$(cat "$APP_DIR/main.js" "$APP_DIR/preload.js" "$APP_DIR/renderer/app.js" "$APP_DIR/renderer/index.html" 2>/dev/null | shasum -a 256 | cut -c1-16)"
[ -n "$WANT_BUILD" ] || die "could not fingerprint the build at $APP_DIR"

info "requested build   : $WANT_VERSION ($WANT_BUILD)"
info "requested app     : $APP"
info "requested profile : $WANT_PROFILE"
info "requested scans   : $INSTANCE"
printf '\n'

# ── 1. enumerate every running Scanner, with the profile each one is actually using ────────────
scanner_pids() { pgrep -f "$PATTERN" 2>/dev/null; }
pid_exe() { /bin/ps -o command= -p "$1" 2>/dev/null | sed 's/ --.*//'; }

# WHERE THE FACTS COME FROM. macOS does not expose another process's environment — `ps eww` prints
# the command and nothing more — so a running Scanner's profile cannot be read from outside. Since
# 1.4.0 each instance writes app-state/runtime.json naming its own pid, executable, version,
# userData and scans dir, and removes it on a clean quit. That file is the Scanner's own claim, and
# it is what this script verifies against.
manifest_field() { # <manifest-path> <field>
  [ -f "$1" ] || return 1
  /usr/bin/python3 -c 'import json,sys
try:
    v=json.load(open(sys.argv[1])).get(sys.argv[2])
    print("" if v is None else v)
except Exception:
    sys.exit(1)' "$1" "$2" 2>/dev/null
}
OUR_MANIFEST="$INSTANCE/app-state/runtime.json"

# A pid belongs to THIS instance only if our own manifest names it. Anything else is a conflict —
# including a Scanner whose manifest we cannot read, because an instance we cannot identify is
# exactly the one that must not be assumed harmless.
OURS=""
if [ -f "$OUR_MANIFEST" ]; then
  OURS="$(manifest_field "$OUR_MANIFEST" pid || true)"
  # A manifest left behind by a crash names a pid that is no longer running.
  if [ -n "$OURS" ] && ! kill -0 "$OURS" 2>/dev/null; then
    info "clearing a stale manifest for pid $OURS (that process is gone)"
    rm -f "$OUR_MANIFEST"
    OURS=""
  fi
fi

CONFLICTS=""
FOUND=0
for pid in $(scanner_pids); do
  FOUND=1
  exe="$(pid_exe "$pid")"
  info "running Scanner   : pid $pid"
  info "  executable      : ${exe:-unknown}"
  if [ "$pid" = "$OURS" ]; then
    info "  instance        : this one (shop games) — already running"
  else
    info "  instance        : NOT this one — conflicts with the requested profile"
    CONFLICTS="$CONFLICTS $pid"
  fi
done
[ "$FOUND" = "1" ] && printf '\n'

# ALREADY RUNNING IS NOT THE SAME AS ALREADY CORRECT.
#
# This short-circuit used to check only "is that pid ours". It was, and it was also an older build
# without the fix being tested — so the launcher reported success and left the stale instance up.
# "Ours" answers the isolation question; it says nothing about which build is running. Both must
# match, or the running instance is replaced like any other conflict.
if [ -n "$OURS" ]; then
  RUNNING_VER="$(manifest_field "$OUR_MANIFEST" version || true)"
  RUNNING_BUILD="$(manifest_field "$OUR_MANIFEST" buildId || true)"
  RUNNING_EXE="$(pid_exe "$OURS")"
  if [ "$RUNNING_VER" = "$WANT_VERSION" ] && [ "$RUNNING_BUILD" = "$WANT_BUILD" ] && [ "$RUNNING_EXE" = "$APP" ]; then
    if [ -z "$(echo "$CONFLICTS" | tr -d ' ')" ]; then
      ok "the shop games Scanner is already running (pid $OURS, $RUNNING_VER) — nothing to do"
      printf '\n'
      exit 0
    fi
  else
    info "the running shop games Scanner is pid $OURS at ${RUNNING_VER:-unknown} (${RUNNING_BUILD:-unknown}), but ${WANT_VERSION} (${WANT_BUILD}) was requested"
    info "  replacing it so the verified build is what actually runs"
    CONFLICTS="$CONFLICTS $OURS"
  fi
fi

# ── 2. terminate only the conflicting instances, and prove each one exited ─────────────────────
if [ -n "$(echo "$CONFLICTS" | tr -d ' ')" ]; then
  info "stopping conflicting Scanner(s):$CONFLICTS"
  info "(their station identity, calibration and logs are untouched; the server is told nothing)"
  osascript -e 'quit app "MintVault Scanner"' >/dev/null 2>&1 || true
  for pid in $CONFLICTS; do
    for _ in $(seq 1 12); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      for _ in $(seq 1 12); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    fi
    kill -0 "$pid" 2>/dev/null && die "pid $pid would not exit. Quit it from Activity Monitor and run this again."
    ok "pid $pid exited"
  done
  printf '\n'
fi

# ── 3. launch the exact build, in the exact isolated profile ───────────────────────────────────
BEFORE="$(scanner_pids | tr '\n' ' ')"
export MINTVAULT_SCANS_DIR="$INSTANCE"
export MINTVAULT_ENV="$WANT_ENV"
mkdir -p "$INSTANCE/app-state"

"$APP" >>"$INSTANCE/launch.log" 2>&1 &
LAUNCHED=$!

# ── 4. read the NEW process back and verify every field ────────────────────────────────────────
NEWPID=""
for _ in $(seq 1 20); do
  sleep 1
  for pid in $(scanner_pids); do
    case " $BEFORE " in *" $pid "*) continue;; esac
    NEWPID="$pid"; break
  done
  [ -n "$NEWPID" ] && break
done

if [ -z "$NEWPID" ]; then
  kill -0 "$LAUNCHED" 2>/dev/null && kill -TERM "$LAUNCHED" 2>/dev/null
  die "the Scanner did not start. See $INSTANCE/launch.log"
fi

# The manifest is written last, once startup has finished — so wait for it rather than racing it.
for _ in $(seq 1 20); do
  [ -f "$OUR_MANIFEST" ] && [ "$(manifest_field "$OUR_MANIFEST" pid || true)" = "$NEWPID" ] && break
  sleep 1
done

GOT_PID="$(manifest_field "$OUR_MANIFEST" pid || true)"
[ "$GOT_PID" = "$NEWPID" ] || die "the Scanner started as pid $NEWPID but never declared itself (no runtime.json for that pid). See $INSTANCE/launch.log"

GOT_EXE="$(pid_exe "$NEWPID")"
GOT_VER="$(manifest_field "$OUR_MANIFEST" version || true)"
GOT_BUILD="$(manifest_field "$OUR_MANIFEST" buildId || true)"
GOT_DIR="$(manifest_field "$OUR_MANIFEST" scansDir || true)"
GOT_UD="$(manifest_field "$OUR_MANIFEST" userDataPath || true)"
GOT_ENV="$(manifest_field "$OUR_MANIFEST" environment || true)"
GOT_URL="$(manifest_field "$OUR_MANIFEST" apiBase || true)"

printf '  verifying the process that is actually running (from its own manifest):\n'
FAIL=0
[ "$GOT_EXE" = "$APP" ]           && ok "executable  $GOT_EXE"       || { red "  ✗ executable  wanted $APP, got ${GOT_EXE:-unknown}"; FAIL=1; }
[ "$GOT_VER" = "$WANT_VERSION" ]  && ok "version     $GOT_VER"       || { red "  ✗ version     wanted $WANT_VERSION, got ${GOT_VER:-unknown}"; FAIL=1; }
[ "$GOT_BUILD" = "$WANT_BUILD" ]  && ok "build       $GOT_BUILD"     || { red "  ✗ build       wanted $WANT_BUILD, got ${GOT_BUILD:-unknown}"; FAIL=1; }
[ "$GOT_DIR" = "$INSTANCE" ]      && ok "scans dir   $GOT_DIR"       || { red "  ✗ scans dir   wanted $INSTANCE, got ${GOT_DIR:-<shared>}"; FAIL=1; }
[ "$GOT_UD" = "$WANT_PROFILE" ]   && ok "userData    $GOT_UD"        || { red "  ✗ userData    wanted $WANT_PROFILE, got ${GOT_UD:-unknown}"; FAIL=1; }
[ "$GOT_URL" = "$WANT_URL" ]      && ok "server      $GOT_URL"       || { red "  ✗ server      wanted $WANT_URL, got ${GOT_URL:-unresolved}"; FAIL=1; }
case "$GOT_ENV" in
  STAGING|staging) ok "environment $GOT_ENV";;
  *) red "  ✗ environment wanted STAGING, got ${GOT_ENV:-unknown}"; FAIL=1;;
esac
ok "pid         $NEWPID"

if [ "$FAIL" = "1" ]; then
  kill -TERM "$NEWPID" 2>/dev/null || true
  die "the running process is not the one that was asked for (stopped it again)."
fi

printf '\n  Sign in as the shop games Owner. Enrolment should start on its own:\n'
printf '  "Connecting this Mac", then "Waiting for MintVault approval".\n\n'
printf '  If you ever need out: the tray menu now has Quit MintVault Scanner,\n'
printf '  and the setup window has REFRESH STATUS / SIGN OUT / DIAGNOSTICS / QUIT.\n\n'
printf '  Log: %s\n\n' "$INSTANCE/launch.log"
wait "$LAUNCHED"
