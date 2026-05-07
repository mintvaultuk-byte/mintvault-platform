# Scanner Watcher Runbook

> **Owner:** Cornelius (single-grader workflow)
> **Services:** `com.mintvault.scanner-watcher` + `com.mintvault.scanner-guide` (two LaunchAgents)
> **Purpose:** Always-on hot-folder daemon — watches `~/mintvault-scans/inbox/`,
> pairs front+back `.tif` scans **strict-alternating** (no timer), POSTs each
> pair to `/api/admin/scan-ingest` on prod, AI grading kicks in server-side.
> An always-on-top Guide Window tells the operator which side to scan next.

This is a **local-machine** service. No server-side changes, no deploys.

## How a scan flows

```
┌─────────────────────────┐                  ┌─────────────────────────┐
│  SilverFast SE          │                  │  Guide Window           │
│  saves .tif → inbox/    │                  │  (always-on-top         │
└──────────┬──────────────┘                  │   Electron, ~420×320)   │
           │                                  └────────────┬────────────┘
           ▼                                               │ polls 1s
┌──────────────────────┐                                   ▼
│  watcher.mjs         │  writes  ┌──────────────────────────────────┐
│  (LaunchAgent #1,    │ ────────►│  ~/mintvault-scans/              │
│   strict alternating)│          │   watcher-state.json             │
└──────────┬───────────┘          └──────────────────────────────────┘
           │ POST /api/admin/scan-ingest
           ▼
   prod server (cert created, AI graded)

           ┌─────────────────────┐                  ┌─────────────────────┐
           │  SwiftBar           │   reads same →   │  watcher-state.json │
           │  status.1s.sh       │                  │                     │
           │  (menu-bar quick    │                  └─────────────────────┘
           │   glance)           │
           └─────────────────────┘
```

**State machine** — strict alternating, no timeout:

```
   IDLE  ─────────► (scan arrives) ─────────► FRONT_BUFFERED
    ▲                                              │
    │                                              ▼
    │                                       (next scan arrives)
    │                                              │
    │                                              ▼
    └────────── (200 OK) ────────  UPLOADING ──────┘
                                       │
                                       ▼ (non-200)
                                    ERROR
```

The watcher waits **forever** for the back. Take all the time you need to
grade between scans — the second TIF that lands is always paired with the
buffered front. From `FRONT_BUFFERED`, the operator can also:

- **Reset card** — discards the buffered front to `discarded/<date>/` and
  goes back to IDLE for the same cert id.
- **Upload front-only** — proceeds with just the front (rare).

After upload errors, the operator can **Retry** from the guide window.

## Components

| Process | LaunchAgent label | Source | Responsibility |
|---|---|---|---|
| Watcher | `com.mintvault.scanner-watcher` | `scripts/scanner-watcher/watcher.mjs` | hot-folder watch + upload |
| Guide window | `com.mintvault.scanner-guide` | `scripts/scanner-watcher/guide-window/` | always-on-top status panel + control buttons |
| SwiftBar plugin | (no agent — SwiftBar process) | `~/.mintvault-scanner-tools/status.1s.sh` (symlinked from `~/SwiftBarPlugins/`) | menu-bar quick-glance |

The watcher exposes a tiny localhost-only HTTP control server on
**127.0.0.1:54871** with three POST routes (`/control/reset`,
`/control/upload-front-only`, `/control/retry`). The guide window's buttons
fire fetches against these. No auth — loopback only, single-user machine.

## Status at a glance

The SwiftBar plugin reads `~/mintvault-scans/watcher-state.json` once a
second:

| Icon | Meaning |
|---|---|
| 📷 MV | idle / ready for next FRONT scan |
| ⏸ BACK | front captured — scan BACK to pair (no timeout) |
| ⬆ MV44 | uploading the pair |
| ✓ MV44 | success — cert MV44 created |
| ⚠ MV | last upload errored (click for details) |
| ❓ MV "State stale — Ns old" | `watcher-state.json` hasn't been touched in 5+ minutes — see *State stale* below |

The Guide Window is the primary UI; SwiftBar is just a glance-check.

## Start / stop / restart

Both agents have `RunAtLoad: true` + `KeepAlive: true`, so they run on
login and auto-restart on any exit (including crashes). `ThrottleInterval`
is 30s. You should rarely need the manual commands below.

```bash
# Stop both (boot out, plist files stay in place)
launchctl bootout gui/$(id -u)/com.mintvault.scanner-watcher
launchctl bootout gui/$(id -u)/com.mintvault.scanner-guide

# Restart both (pick up code changes without re-bootstrap)
launchctl kickstart -k gui/$(id -u)/com.mintvault.scanner-watcher
launchctl kickstart -k gui/$(id -u)/com.mintvault.scanner-guide

# Bootstrap fresh (use after a `bootout`)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mintvault.scanner-watcher.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mintvault.scanner-guide.plist

# Inspect
launchctl print gui/$(id -u)/com.mintvault.scanner-watcher
launchctl print gui/$(id -u)/com.mintvault.scanner-guide
```

To re-install both from a clean slate:
```bash
cd ~/mintvault-platform/scripts/scanner-watcher
./install.sh
```

## Logs

| Path | What |
|---|---|
| `~/mintvault-scans/watcher.log` | Watcher daemon output (chokidar events, uploads, control-server requests). |
| `~/mintvault-scans/guide.log` | Electron guide-window output (stdout/stderr from main + renderer). Mostly quiet. |
| `~/mintvault-scans/watcher-state.json` | Current state snapshot. The guide and SwiftBar both poll this. |
| `~/mintvault-scans/processed/YYYY-MM-DD/` | TIFs that uploaded successfully, grouped by date. |
| `~/mintvault-scans/failed/YYYY-MM-DD/` | TIFs that failed, with sibling `.error.txt` files. |
| `~/mintvault-scans/discarded/YYYY-MM-DD/` | Fronts the operator hit "Reset card" on. |

```bash
tail -f ~/mintvault-scans/watcher.log
tail -f ~/mintvault-scans/guide.log
```

## Guide Window

The guide is a frameless 420×320 always-on-top Electron window. Drag the
top strip to move it; position is persisted to
`~/.mintvault-scanner-tools/guide-window-position.json` and restored on
next launch. The window is set to be visible across spaces and on top of
fullscreen apps.

The window auto-hides nothing — pressing the macOS red close-button (which
the frameless window doesn't expose) isn't an option, by design. To
temporarily hide for screen-recording or screenshots:
```bash
launchctl bootout gui/$(id -u)/com.mintvault.scanner-guide
```
Re-bootstrap when done.

If the guide window doesn't appear after install:
```bash
tail -50 ~/mintvault-scans/guide.log
```
Most-likely cause: missing `electron` binary. Re-run `./install.sh` to
re-`npm install` the guide-window deps.

## "State stale" in SwiftBar — what to do

The plugin marks state stale when `watcher-state.json` hasn't been touched
in 300+ seconds. With strict alternating (no periodic write — only on
state transitions), staleness now means one of:

1. **Watcher process is dead and launchd never respawned it.** Rare —
   `KeepAlive: true` should always restart. Check:
   ```bash
   launchctl print gui/$(id -u)/com.mintvault.scanner-watcher | grep state
   ```
   If service is missing entirely, re-run `install.sh` (idempotent).

2. **Watcher up but stuck mid-upload.** Check `watcher.log` for the most
   recent entry. If the upload has been "uploading" for >2 min, kickstart:
   ```bash
   launchctl kickstart -k gui/$(id -u)/com.mintvault.scanner-watcher
   ```
   Note: hydration on restart preserves `buffered_front` if the file still
   exists, so kickstarting in `FRONT_BUFFERED` returns to that state.

3. **Just been a quiet morning.** With strict alternating, watcher-state.json
   only updates on transitions (a scan arriving, an upload completing).
   If you haven't scanned in 5+ minutes, of course it's "stale" — but the
   watcher is fine. The Guide Window will still say "SCAN FRONT" or
   "FRONT CAPTURED" and respond instantly to the next scan.

If something genuinely seems wedged, full reset:
```bash
cd ~/mintvault-platform/scripts/scanner-watcher
./uninstall.sh
./install.sh
```

User data (`~/mintvault-scans/`), the env file, and the guide-window
position are all preserved.

## Disable for development

Useful when running the server locally and you don't want every desk scan
hitting localhost (or worse, prod):

```bash
launchctl bootout gui/$(id -u)/com.mintvault.scanner-watcher
launchctl bootout gui/$(id -u)/com.mintvault.scanner-guide
```

Re-enable when done by re-bootstrapping (commands above).

To run the watcher manually against staging instead of prod:
```bash
cd ~/mintvault-platform/scripts/scanner-watcher
export $(cat ~/.mintvault-scanner.env | xargs)
MINTVAULT_INGEST_URL=https://mintvault-v2.fly.dev/api/admin/scan-ingest \
  npm start
```

## Switching prod ↔ staging via SwiftBar

The dropdown's "Switch to staging / Switch to prod" buttons call
`~/.mintvault-scanner-tools/switch-env.sh`, which edits the env file and
kickstarts the watcher. One click. The menu-bar icon turns yellow (`🧪`)
when targeting staging.

## Inbox hygiene

The watcher only ingests scans that land while it's running (chokidar
`ignoreInitial: true`). Files dropped into `inbox/` while the watcher
was off, or `.jpg` clutter from SilverFast dual-saving, stay there. With
strict alternating, **don't** dump multiple `.tif` files at once — the
order they land becomes the front/back/front/back pairing order, so a
batch dump scrambles into wrong cert pairings.

To bulk-clear stale inbox entries before a fresh session:
```bash
mkdir -p ~/mintvault-scans/processed/_manual-cleanup-$(date +%F)
mv ~/mintvault-scans/inbox/*.tif ~/mintvault-scans/processed/_manual-cleanup-$(date +%F)/
```

## Files behind the services

| Path | Role |
|---|---|
| `scripts/scanner-watcher/watcher.mjs` | Daemon — chokidar + strict-alternating pair logic + uploader + localhost control server |
| `scripts/scanner-watcher/launchd-wrapper.sh` | Sources `.mintvault-scanner.env`, sets PATH, execs node |
| `scripts/scanner-watcher/com.mintvault.scanner-watcher.plist` | Watcher LaunchAgent template |
| `scripts/scanner-watcher/com.mintvault.scanner-guide.plist` | Guide-window LaunchAgent template |
| `scripts/scanner-watcher/guide-window/main.js` | Electron main process (BrowserWindow + IPC + control HTTP proxy) |
| `scripts/scanner-watcher/guide-window/index.html` | Window markup |
| `scripts/scanner-watcher/guide-window/style.css` | Vanilla CSS, dark-mode aware |
| `scripts/scanner-watcher/guide-window/poll.js` | Renderer poll loop, swaps panel by state |
| `scripts/scanner-watcher/guide-window/preload.js` | IPC bridge (readState + control) |
| `scripts/scanner-watcher/install.sh` | Idempotent installer for both agents |
| `scripts/scanner-watcher/uninstall.sh` | Idempotent uninstaller for both agents |
| `scripts/scanner-watcher/status.mjs` | Standalone fullscreen ANSI banner (separate Terminal — backup of the Electron guide) |
| `~/.mintvault-scanner.env` | Token: `SCANNER_API_TOKEN=<64-char hex>` |
| `~/SwiftBarPlugins/status.1s.sh` | SwiftBar plugin (symlink → `~/.mintvault-scanner-tools/status.1s.sh`) |
| `~/.mintvault-scanner-tools/guide-window-position.json` | Persisted guide-window position |
| `~/Library/LaunchAgents/com.mintvault.scanner-watcher.plist` | Rendered watcher agent |
| `~/Library/LaunchAgents/com.mintvault.scanner-guide.plist` | Rendered guide agent |

## Verification commands

```bash
# Both services registered + running?
launchctl print gui/$(id -u)/com.mintvault.scanner-watcher | grep -E "state|pid"
launchctl print gui/$(id -u)/com.mintvault.scanner-guide   | grep -E "state|pid"

# Processes alive?
pgrep -f watcher.mjs
pgrep -f "Electron .*guide-window"

# State file exists + parseable?
cat ~/mintvault-scans/watcher-state.json | python3 -m json.tool

# Self-heal works? (kill -9 watcher; wait; expect new pid)
kill -9 $(pgrep -f watcher.mjs); sleep 6; pgrep -f watcher.mjs

# Control server reachable?
curl -s -X POST http://127.0.0.1:54871/control/reset | python3 -m json.tool
# (will 409 if state isn't front_buffered — that's correct)
```

## State file schema (current)

`~/mintvault-scans/watcher-state.json` — written atomically (tmp + rename)
on every transition.

```json
{
  "state":                "idle | front_buffered | uploading | success | error",
  "expected_next_side":   "front | back | null",
  "buffered_front":       "absolute path | null",
  "buffered_front_name":  "basename | null",
  "next_cert_guess":      "MV<n+1> | null",
  "last_uploaded_cert":   "MV<n> | null",
  "session_paired_count": 0,
  "last_error":           "string | null",
  "ingest_url":           "https://...",
  "control_port":         54871,
  "updated_at":           "ISO8601",
  "pairing_window_expires_at": null,   // legacy — always null now
  "last_cert":            "MV<n> | null",
  "last_side":            "front | back | null"
}
```
