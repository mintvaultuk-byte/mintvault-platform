# Cutover — old watcher → new menu-bar app

> Run this on the scanner Mac when you're ready to switch. Cards off the desk, calm window. **Do not run during a grading session.**

## Pre-flight (once)

You need the server changes deployed first. The new app calls two new endpoints:

- `GET /api/admin/next-cert-id`
- `GET /api/admin/orphan-certs`

Verify they're reachable from the scanner Mac:

```
curl -H "x-scanner-token: $(grep SCANNER_API_TOKEN ~/.mintvault-scanner.env | cut -d= -f2)" \
     https://mintvaultuk.com/api/admin/next-cert-id
```

Should return `{"next":"MV<n>","next_numeric":<n>}`. If 401, your token is wrong. If 404, the server hasn't been deployed yet.

## 1. Backup current state

```
cp ~/mintvault-scans/watcher-state.json ~/mintvault-scans/watcher-state.backup.json 2>/dev/null || true
```

(May not exist — that's fine.)

## 2. Confirm no scan is mid-flight

```
launchctl list | grep mintvault
ls -la ~/mintvault-scans/inbox/
```

If `inbox/` is empty and the watcher is in `idle` state in its log (`tail -n 20 ~/mintvault-scans/watcher.log`), you're safe to proceed.

## 3. Tear down the old setup + install the new app

```
cd ~/mintvault-platform   # or wherever the repo lives
git checkout main
git pull
./scripts/scanner-app/uninstall.sh   # removes ALL three old agents
./scripts/scanner-app/install.sh
```

`uninstall.sh` is safe to run before anything new is installed — it bootouts whatever exists and ignores not-loaded errors. `install.sh` then bootstraps the new agent fresh.

## 4. Verify only the new agent is loaded

```
launchctl list | grep mintvault
```

Should show **only** `com.mintvault.scanner-app`. If you see `scanner-watcher` or `scanner-guide`, something's off — re-run `uninstall.sh`.

## 5. Verify the tray icon appeared

Look at the macOS menu bar (top-right). The tray slot should be present. Click it — popover should open. If it doesn't:

```
tail -n 50 ~/mintvault-scans/scanner-app.log
```

Common issues:

- `SCANNER_API_TOKEN missing` → edit `~/.mintvault-scanner.env`, then `launchctl kickstart -k gui/$(id -u)/com.mintvault.scanner-app`.
- `electron not installed at .../node_modules/.bin/electron` → re-run `install.sh` (npm install may have failed silently).

## 6. Smoke test with a non-grading card

Pick a junk card, scan front + back through SilverFast as normal. Watch the tray indicator transition idle → buffering → uploading → success. Verify the cert appears in the admin UI with both images.

If the upload fails, the popover's "Recent" panel will show the error and the tray turns red. The popover header `↻` button restarts chokidar without restarting the whole app.

## 7. Resume normal grading

That's it. Everything else (AUTO mode pairing, manual mode for misses, the orphan picker for the MV57/58/59 cleanup that motivated this rebuild) lives in the same one tray icon now.

## Rollback

If anything goes wrong:

```
./scripts/scanner-app/uninstall.sh
cd scripts/scanner-watcher
./install.sh
```

The old `scripts/scanner-watcher/` folder is kept on `main` exactly as it was. Rollback restores the previous three-process setup in ~30s.

## What gets left behind on disk after uninstall

- `~/.mintvault-scanner.env` — token. Reused by both old and new.
- `~/mintvault-scans/` — inbox/processed/failed/discarded. Both setups use the same paths.
- `~/Library/Application Support/MintVaultScanner/state.json` — new app state. Harmless if old setup is restored (it ignores it).
- `~/mintvault-scans/watcher-state.json` — old watcher state. Harmless if new app is running (it ignores it).

Both setups can technically coexist on disk. Just don't have both LaunchAgents loaded at the same time — they'd race for inbox files. `uninstall.sh` enforces that.
