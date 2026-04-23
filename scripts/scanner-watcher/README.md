# MintVault Scanner Watcher

Daemon that watches a local folder for `.tif` scans from SilverFast SE, pairs
them as front + back, and uploads each pair to MintVault's `/api/admin/scan-ingest`
endpoint. A new certificate is created and AI grading fires automatically.

## Setup

```bash
cd scripts/scanner-watcher
npm install
```

Create `~/.mintvault-scanner.env` with your token (the same 64-char hex value
you stored in Fly secrets as `SCANNER_API_TOKEN`):

```
SCANNER_API_TOKEN=ed9ff...your-token...
# Optional: point at staging for test runs
# MINTVAULT_INGEST_URL=https://mintvault-v2.fly.dev/api/admin/scan-ingest
```

To run manually (foreground, logs to terminal):

```bash
export $(cat ~/.mintvault-scanner.env | xargs)
npm start
```

For auto-start on login via launchd, see the **Install as launchd service** section below.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SCANNER_API_TOKEN` | **Yes** | — | Must match the `SCANNER_API_TOKEN` Fly secret on the target app. Watcher refuses to start if missing. |
| `MINTVAULT_INGEST_URL` | No | `https://mintvault.fly.dev/api/admin/scan-ingest` | Override to hit staging during testing. |

The old cookie-based env var `MINTVAULT_ADMIN_COOKIE` is no longer used.

## How it works

1. Configure SilverFast SE to save scans to `~/mintvault-scans/inbox/` as `.tif`.
2. Scan the **front** of a card — the watcher sees a new `.tif` and starts a 60-second pair window.
3. Scan the **back** of the same card within 60s — the watcher pairs front + back and uploads them together.
4. A new cert is created, AI grading runs async, files move to `~/mintvault-scans/processed/YYYY-MM-DD/`.
5. If no second scan arrives within 60s, the single scan uploads as front-only.
6. If the upload fails (network, 5xx, auth error), files move to `~/mintvault-scans/failed/YYYY-MM-DD/` with a sibling `.error.txt` explaining why.

## File filtering

**Accepted:** `.tif`, `.tiff` only.

**Ignored** (silently, logged at debug level):
- `.jpg`, `.jpeg`, `.png`, `.bmp`, `.gif` — SilverFast often saves JPEG duplicates alongside TIF; we use TIF for its richer data.
- Dotfiles (`.DS_Store`, anything starting with `.`).
- Anything else with an unknown extension.

Drop `SILVERFAST_OUTPUT_FORMAT=TIF` in your SilverFast settings if it's dual-saving.

## Folder structure (what Cornelius will see on his Mac)

```
~/mintvault-scans/
├── inbox/                            ← SilverFast saves here
├── processed/
│   └── 2026-04-23/                   ← successful uploads, grouped by date
│       ├── pokemon (1).tif
│       └── pokemon (2).tif
├── failed/
│   └── 2026-04-23/                   ← failures, with sibling .error.txt
│       ├── pokemon (3).tif
│       └── pokemon (3).tif.error.txt ← contains HTTP code + server message
├── watcher.log                       ← current day's log (also echoes to stdout)
├── watcher-2026-04-22.log            ← previous days (auto-archived at startup)
└── watcher-2026-04-21.log            ← auto-purged after 7 days
```

All folders are auto-created on first run. The log file rotates daily on startup
and archives older than 7 days are deleted — no external rotation tool needed.

## Pairing rules

- **First TIF** starts a 60-second pair window.
- **Second TIF within 60s** becomes the back; pair uploads as one cert.
- **60s elapses with no second TIF** — the first uploads alone as front-only.
- **Rapid succession** (3+ TIFs within 60s of each other): naturally FIFO — TIF 1+2 pair, TIF 3 starts a new 60s window waiting for TIF 4, etc. No scans are lost.
- **No filename suffix logic** (`_front` / `_back` no longer detected). Pair by time order only.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Refuses to start with "SCANNER_API_TOKEN env var is required" | Token not exported | `source ~/.mintvault-scanner.env` or check launchd env file |
| Every scan 401s | Token doesn't match server | Compare `SCANNER_API_TOKEN` in env file vs Fly secret; re-set secret with `fly secrets set SCANNER_API_TOKEN=...` |
| Files accumulate in `inbox/` and never move | Watcher not running, or permissions problem | Check `~/mintvault-scans/watcher.log` and `launchctl list \| grep mintvault` |
| `.jpg` duplicates filling up the inbox | SilverFast configured to save both formats | Turn off JPEG output in SilverFast; watcher ignores them but they clutter |
| Cert created but wrong images paired together | Files landed >60s apart | Scan front + back consecutively; the watcher pairs by arrival order |

## Install as launchd service

Auto-starts on login, restarts on crash, logs to `~/mintvault-scans/watcher.log`.

```bash
cd ~/mintvault-platform/scripts/scanner-watcher
./install.sh
```

The installer is idempotent — safe to re-run. It creates the scan folders,
writes a token-file template if none exists, `npm install`s dependencies,
renders the plist with the correct paths, and bootstraps the service via
`launchctl bootstrap gui/$(id -u)`.

After install, three manual steps finish the setup:

```bash
# 1. Put the token into the env file (empty placeholder was created for you)
open -e ~/.mintvault-scanner.env
#    Paste: SCANNER_API_TOKEN=<your-64-char-hex>
#    Save, then reload the agent so the new value is read:
launchctl kickstart -k gui/$(id -u)/com.mintvault.scanner-watcher

# 2. In SilverFast SE, change the output folder to:
#      ~/mintvault-scans/inbox/

# 3. Scan a card pair (front, then back within 60s) and watch the log:
tail -f ~/mintvault-scans/watcher.log
```

Expected log shape on first successful scan:

```
[wrapper] node=/opt/homebrew/bin/node watcher=.../watcher.mjs
[2026-04-23T…] [info] MintVault Scanner Watcher starting
[2026-04-23T…] [info] New scan: pokemon (1).tif
[2026-04-23T…] [info]   Waiting up to 60s for a pair...
[2026-04-23T…] [info] New scan: pokemon (2).tif
[2026-04-23T…] [info]   Paired with pokemon (1).tif (4200ms since front)
[2026-04-23T…] [info] Uploading: front=pokemon (1).tif back=pokemon (2).tif
[2026-04-23T…] [info] SUCCESS pokemon (1).tif: MV144 (processing) — …
```

## Uninstall

```bash
cd ~/mintvault-platform/scripts/scanner-watcher
./uninstall.sh
```

Boots the agent out of launchd and removes the plist. User data
(`~/mintvault-scans/`) and the token file (`~/.mintvault-scanner.env`) are
intentionally preserved — remove them manually if fully cleaning up. The
uninstaller prints the `rm` commands at the end.

## Stopping the watcher (without uninstalling)

```bash
launchctl bootout gui/$(id -u)/com.mintvault.scanner-watcher
```

To start again without re-running `install.sh`:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mintvault.scanner-watcher.plist
```

If running manually (`npm start`), `Ctrl+C` — SIGINT is handled gracefully
(any unpaired scan remains in `inbox/` for the next run).
