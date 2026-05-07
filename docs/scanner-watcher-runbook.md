# Scanner Watcher Runbook

> **Owner:** Cornelius (single-grader workflow)
> **Service:** `com.mintvault.scanner-watcher` LaunchAgent
> **Purpose:** Always-on hot-folder daemon — watches `~/mintvault-scans/inbox/`,
> pairs front+back `.tif` scans within 60s, POSTs each pair to
> `/api/admin/scan-ingest` on prod, AI grading kicks in server-side.

This is a **local-machine** service. No server-side changes, no deploys.

## Status at a glance

The SwiftBar plugin in the menu bar reads `~/mintvault-scans/watcher-state.json`
once a second:

| Icon | Meaning |
|---|---|
| 📷 MV | idle / ready for next scan |
| ⏱ 42s | front received, waiting for back (countdown) |
| ⬆ MV44 | uploading the pair |
| ✓ MV44 | success — cert MV44 created |
| ⚠ MV | last scan errored (click for details) |
| ❓ MV "State stale — Ns old" | `watcher-state.json` hasn't been touched in 5+ minutes — see *State stale* below |

## Start / stop / restart

The plist has `RunAtLoad: true` and `KeepAlive: true`, so the service runs
on login and auto-restarts on any exit (including crashes). `ThrottleInterval`
is 30s — launchd won't loop-restart faster than that. You should rarely need
the manual commands below; they're here for the edge cases.

```bash
# Start (bootstrap from plist)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mintvault.scanner-watcher.plist

# Stop (boot out, plist file stays in place)
launchctl bootout gui/$(id -u)/com.mintvault.scanner-watcher

# Restart (pick up code changes without re-bootstrap)
launchctl kickstart -k gui/$(id -u)/com.mintvault.scanner-watcher

# Inspect (state, pid, paths, throttle)
launchctl print gui/$(id -u)/com.mintvault.scanner-watcher
```

The SwiftBar dropdown also surfaces these as *Pause / Resume / Kickstart*
buttons — same effect as the CLI commands, no terminal needed.

## Logs

| Path | What |
|---|---|
| `~/mintvault-scans/watcher.log` | All watcher output (launchd captures stdout+stderr here). New entries on every scan event + state transition. |
| `~/mintvault-scans/watcher-state.json` | Current state snapshot — written on every transition. The SwiftBar plugin polls this. |
| `~/mintvault-scans/processed/YYYY-MM-DD/` | TIFs that uploaded successfully, grouped by date. |
| `~/mintvault-scans/failed/YYYY-MM-DD/` | TIFs that failed, with sibling `.error.txt` files describing the HTTP code + server message. |

```bash
tail -f ~/mintvault-scans/watcher.log
```

## "State stale" in SwiftBar — what to do

The plugin marks state stale when `watcher-state.json` hasn't been touched
in 300+ seconds. That means one of:

1. **Process is dead and launchd never respawned it.** Rare — `KeepAlive: true`
   should always restart it. Check:
   ```bash
   launchctl print gui/$(id -u)/com.mintvault.scanner-watcher | grep state
   ```
   If service is missing entirely (`Could not find service`), the agent has
   been booted out. Re-run `scripts/scanner-watcher/install.sh` — it's
   idempotent and will re-bootstrap.

2. **Watcher is running but stuck.** Process up but not writing state.
   Check `~/mintvault-scans/watcher.log` for the most recent entry. Common
   causes: API down (look for repeated `[error] upload failed` lines),
   network issue, or token mismatch (every scan 401s).

3. **Wedged on a single scan.** State stuck in `front-received` because the
   back scan never arrived AND the 60s pair-timeout fired but the watcher
   didn't update state. Kickstart to clear:
   ```bash
   launchctl kickstart -k gui/$(id -u)/com.mintvault.scanner-watcher
   ```

If kickstart doesn't fix it, full reset:
```bash
cd ~/mintvault-platform/scripts/scanner-watcher
./uninstall.sh
./install.sh
```

User data (`~/mintvault-scans/`) and the env file (`~/.mintvault-scanner.env`)
are preserved by uninstall. Only the LaunchAgent registration is removed.

## Disable for development

Useful when running the server locally and you don't want every desk scan
hitting localhost (or worse, prod):

```bash
launchctl bootout gui/$(id -u)/com.mintvault.scanner-watcher
```

Re-enable when done:
```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mintvault.scanner-watcher.plist
```

To run the watcher manually against staging instead of prod:
```bash
cd ~/mintvault-platform/scripts/scanner-watcher
export $(cat ~/.mintvault-scanner.env | xargs)
MINTVAULT_INGEST_URL=https://mintvault-v2.fly.dev/api/admin/scan-ingest \
  npm start
```

(The launchd-wrapper.sh sources `~/.mintvault-scanner.env` and does NOT
override `MINTVAULT_INGEST_URL`, so flipping the env file's commented-out
staging URL is the persistent way to switch the LaunchAgent's target.)

## Switching prod ↔ staging via SwiftBar

The dropdown's "Switch to staging / Switch to prod" buttons call
`~/.mintvault-scanner-tools/switch-env.sh`. That script edits the env file
and kickstarts the agent. One click, no terminal. Plugin colours the
menu-bar icon yellow (`🧪`) when targeting staging so you can't forget.

## Inbox hygiene

The watcher only ingests scans that land while it's running (chokidar
`ignoreInitial: true`). Files dropped into `inbox/` while the watcher
was off, or any clutter (`.jpg`s, `.DS_Store`, etc.), stay there until
manually moved.

`.jpg` and other non-TIF formats are silently ignored — safe to leave
in inbox if SilverFast is dual-saving. Old `.tif` files NOT moved out
will only re-ingest if you `mv` them out and back in. To bulk-clear:

```bash
mkdir -p ~/mintvault-scans/processed/_manual-cleanup-$(date +%F)
mv ~/mintvault-scans/inbox/*.tif ~/mintvault-scans/processed/_manual-cleanup-$(date +%F)/
```

## Files behind the service

| Path | Role |
|---|---|
| `scripts/scanner-watcher/watcher.mjs` | The daemon — chokidar + pair logic + uploader |
| `scripts/scanner-watcher/launchd-wrapper.sh` | Sources `.mintvault-scanner.env`, sets PATH, execs node |
| `scripts/scanner-watcher/com.mintvault.scanner-watcher.plist` | LaunchAgent template (install.sh substitutes paths) |
| `scripts/scanner-watcher/install.sh` | Idempotent installer — render plist, bootstrap, npm install |
| `scripts/scanner-watcher/uninstall.sh` | Bootout + remove plist (preserves data + env) |
| `scripts/scanner-watcher/status.mjs` | Standalone fullscreen ANSI banner (separate Terminal — for when you don't have SwiftBar visible) |
| `~/.mintvault-scanner.env` | Token file: `SCANNER_API_TOKEN=<64-char hex>` (must match Fly secret on the target app) |
| `~/SwiftBarPlugins/status.1s.sh` | SwiftBar plugin reading `watcher-state.json` |
| `~/Library/LaunchAgents/com.mintvault.scanner-watcher.plist` | Rendered, bootstrapped LaunchAgent (do not edit by hand — re-render via install.sh) |

## Verification commands (post-install sanity check)

```bash
# Service registered + running?
launchctl print gui/$(id -u)/com.mintvault.scanner-watcher | grep -E "state|pid|throttle"

# Process alive?
pgrep -f watcher.mjs

# State file fresh? (should be < 60s after a kickstart)
echo "$(( $(date +%s) - $(stat -f %m ~/mintvault-scans/watcher-state.json) ))s old"

# Self-heal works? (kill -9; wait; expect new pid)
kill -9 $(pgrep -f watcher.mjs); sleep 6; pgrep -f watcher.mjs
```
