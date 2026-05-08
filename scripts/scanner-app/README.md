# MintVault Scanner — Menu-Bar App

Single-process Electron app replacing `scripts/scanner-watcher/`'s three-piece setup (watcher.mjs daemon + Electron guide window + SwiftBar plugin) with one tray icon and one LaunchAgent.

> **Why?** The old setup was three processes, three LaunchAgents, three failure modes. When any one died silently, the others kept lying. This is one process: if it dies, LaunchAgent restarts the whole thing — tray icon either appears or it doesn't, no silent drift.

## Phase 0 — Investigation findings

Mapped before coding (per spec §5 Phase 0). Source files referenced:

- `scripts/scanner-watcher/watcher.mjs` — strict-alternating state machine (idle → front_buffered → uploading → success/error → idle), chokidar on `~/mintvault-scans/inbox/*.tif`, FormData multipart POST to `/api/admin/scan-ingest` with `front` (required), `back` (optional), `client_source` fields. Auth via `x-scanner-token` header reading `SCANNER_API_TOKEN` from `~/.mintvault-scanner.env`. Manual mode added later: `manual_pending` state + control endpoints.
- `scripts/scanner-watcher/guide-window/main.js` — Electron main pattern: hidden Dock icon, BrowserWindow with `frame: false`, IPC handlers via `ipcMain.handle`, polls `watcher-state.json` from disk every 1s.
- `scripts/scanner-watcher/com.mintvault.scanner-watcher.plist` — `RunAtLoad: true`, `KeepAlive: true`, `ThrottleInterval: 30`, paths templated with `__WRAPPER_PATH__` / `__HOME__` substituted at install time.
- `server/lib/scanner-auth.ts` — `requireScannerOrAdmin` middleware: timing-safe match of `x-scanner-token` header against `SCANNER_API_TOKEN` env, falls through to admin cookie auth if header absent.
- `server/routes.ts` — endpoints in use:
  - `POST /api/admin/scan-ingest` — multipart `front`/`back`, returns `{ certId, ... }`
  - `POST /api/admin/certs/:certId/image` — multipart `image`, fields `side` + `replace_existing`
  - `GET /api/admin/certs/:certId/preview`
  - `DELETE /api/admin/certs/:certId` (body `{ reason: string ≥10 chars }`)

**New endpoints added by this PR** (`server/routes.ts`):

- `GET /api/admin/next-cert-id` — read-only allocation hint, returns `{ next: "MV61", next_numeric: 61 }`
- `GET /api/admin/orphan-certs` — certs missing front or back, ordered newest-first, limit 50

Both gated `requireScannerOrAdmin`, identical pattern to the existing per-cert endpoints.

## Architecture

```
~/.mintvault-scanner.env  ──reads──>  scanner-app  ──HTTPS──>  api.mintvaultuk.com
       SCANNER_API_TOKEN                  │
                                          │
                          chokidar  ──>   │   ──>  Tray icon
                          ~/mintvault-    │        Popover (BrowserWindow)
                          scans/inbox     │
                                          │
                                          ▼
                                   ~/Library/Application Support/
                                   MintVaultScanner/state.json
```

One Electron process. One LaunchAgent (`com.mintvault.scanner-app`). Renderer talks to main via `contextBridge` exposing a `scanner` global.

## Files

```
scanner-app/
├── package.json                     electron + chokidar + form-data + node-fetch
├── main.js                          Electron main, tray, IPC, BrowserWindow
├── preload.js                       contextBridge for renderer
├── lib/
│   ├── watcher.js                   chokidar + state machine (port of watcher.mjs)
│   ├── server-client.js             HTTPS to mintvaultuk.com, auth, all endpoints
│   └── state.js                     persistence to App Support/state.json
├── renderer/
│   ├── index.html                   popover layout
│   ├── styles.css                   dark + gold theme
│   └── app.js                       state rendering, modals, IPC client
├── assets/                          tray icons (PNGs — see "Tray icons" below)
├── launchd-wrapper.sh               sources env file, execs electron
├── com.mintvault.scanner-app.plist  LaunchAgent template (paths substituted)
├── install.sh                       npm install + render plist + launchctl bootstrap
├── uninstall.sh                     bootout new + old agents, remove plists
├── README.md                        ← you are here
└── CUTOVER.md                       step-by-step swap from old watcher
```

## Operator runbook

### First install

```
cd ~/mintvault-platform
git pull
./scripts/scanner-app/install.sh
```

The installer:
1. Creates `~/mintvault-scans/{inbox,processed,failed,discarded}` if missing.
2. Creates `~/Library/Application Support/MintVaultScanner/`.
3. Creates `~/.mintvault-scanner.env` template if missing (won't overwrite existing).
4. Runs `npm install` in the app directory (downloads Electron, ~150MB first time).
5. Renders the LaunchAgent plist with absolute paths into `~/Library/LaunchAgents/`.
6. `launchctl bootstrap`s the agent into `gui/$(id -u)`.

After install, edit the env file with the SCANNER_API_TOKEN value:

```
open -e ~/.mintvault-scanner.env
launchctl kickstart -k gui/$(id -u)/com.mintvault.scanner-app
```

### Daily operation

- **Tray icon**: left-click opens popover. Right-click for native menu (Restart watcher, Show logs, Open inbox, Quit).
- **AUTO mode** (default): scan front → scan back → upload. Same workflow as the old watcher.
- **MANUAL mode**: every detected `.tif` opens a prompt — pick a cert + side. Cancelling leaves the file in inbox; nothing auto-deleted.
- **Fix orphan…**: lists certs missing a side or with no images. "Attach back" arms a one-shot manual upload — next scan attaches to that cert. "Soft-delete" requires a reason (≥10 chars).
- **Forward to cert…**: cosmetic override of the displayed "Next cert" line. Server still allocates via `/api/admin/next-cert-id` on the actual scan.

### Logs

```
tail -f ~/mintvault-scans/scanner-app.log
```

Both stdout and stderr from the Electron process are captured here by launchd.

### Restart / kickstart

```
launchctl kickstart -k gui/$(id -u)/com.mintvault.scanner-app
```

Or use the popover header's `↻` button (calls `chokidar.close()` then re-`watch()` without restarting Electron itself).

### Uninstall

```
./scripts/scanner-app/uninstall.sh
```

Tears down `com.mintvault.scanner-app`, `com.mintvault.scanner-watcher`, `com.mintvault.scanner-guide`, and removes the SwiftBar plugin if present. Leaves env file, `~/mintvault-scans/`, and state.json untouched (recoverable).

## Tray icons

Assets at `assets/tray-{idle,busy,error}.png` are template PNGs (16×16 + 32×32 @2x). On first install they may not exist — main.js falls back to an empty `nativeImage` so the tray slot still appears, but the icon will be invisible.

To add icons, drop PNG files at:

```
scripts/scanner-app/assets/tray-idle.png    # 16×16, template
scripts/scanner-app/assets/tray-idle@2x.png # 32×32, template
scripts/scanner-app/assets/tray-busy.png    # 16×16, non-template
scripts/scanner-app/assets/tray-busy@2x.png # 32×32, non-template
scripts/scanner-app/assets/tray-error.png   # 16×16, non-template
scripts/scanner-app/assets/tray-error@2x.png # 32×32, non-template
```

Template images auto-tint with the menu bar (dark/light); non-template images keep their source colour.

## Manual decisions made during build

Per spec §9: "make a call, document it, keep moving". Calls made:

- **node-fetch v3 (ESM-only) loaded via dynamic `import()` from CommonJS**. node-fetch 3.x dropped CommonJS support; staying on v3 avoids the v2 deprecation warnings. Lazy-load preserves CJS interop without rewriting the whole app as ESM.
- **Recent-scans list capped at 5** (matching the spec mockup), kept in state.json so it survives crashes.
- **Session counter resets at process boot, not at midnight.** A "session" = one continuous run of the app. Matches the old watcher's behaviour.
- **No DB index migration.** The orphan-certs query filters on `deleted_at IS NULL` and `front_image_url IS NULL OR back_image_url IS NULL`. With ~150 rows in production, a sequential scan is fast enough; an index isn't justified yet.
- **Forward-to-cert is purely cosmetic** (per spec §3.5). It updates the displayed "Next cert" but does not bypass the server's allocation. Spec called this out explicitly.
- **Old `scripts/scanner-watcher/` left in place** (not deleted) so the rollback path in CUTOVER.md works. It's deprecated, not removed.

## Known limitations / open items

- No tray icon PNGs shipped yet — see "Tray icons" above. App works, just no glyph.
- No notification sounds. The old watcher used `osascript display notification`. Could be added later via `new Notification()` from the renderer or `Notification` from Node, but launchd-spawned processes can't emit user notifications without entitlements; not worth it for v1.
- The popover uses `popover.on("blur", () => popover.hide())` — clicking the dock to switch focus closes it. This matches the spec's "behave like a menu-bar popover" intent but means the operator can't keep it open while interacting with another app. If that's a problem in practice, change to a sticky window with manual close.
- `chokidar.close()` + `watch()` on the existing watcher path is a bit slow (~1s) because the previous chokidar instance has to release its FSEvents subscription. Acceptable for a manual restart action.

## What the spec said NOT to do (and didn't)

- ✗ No new database tables.
- ✗ No change to scan-ingest signature.
- ✗ No R2 layout change.
- ✗ No electron-builder packaging — ships as raw Electron under launchd.
- ✗ No auto-cutover. Operator runs `uninstall.sh` then `install.sh` manually per CUTOVER.md.
- ✗ Not deleting `scripts/scanner-watcher/` — kept for rollback.
- ✗ No telemetry.
- ✗ No login UI in the app — reads existing scanner credentials.
