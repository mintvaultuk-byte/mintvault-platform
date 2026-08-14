# WP0 source verification

## Repository and lineage

| Evidence ID | Fact | Evidence |
|---|---|---|
| WP0-SV-01 | Isolated Scanner base is the last committed Partner snapshot | `d44a2c5363e702bb5aeb54157d7ad6a2af30546c`; every prompt-listed SHA and later AG-1/2/3, P8/P9 commits are ancestors |
| WP0-SV-02 | Canonical configured Git origin | `git@github.com:mintvaultuk-byte/mintvault-platform.git`; no fetch performed |
| WP0-SV-03 | Base is not final release authority | 30 ahead / 1 behind local `origin/main`; Partner pass2 has active dirty P10 work and no P14 closeout |

## Existing Scanner implementation

| Evidence ID | Fact | Authoritative source/result |
|---|---|---|
| WP0-SV-04 | Native capture exists but is runtime-compiled | `scripts/scanner-app/lib/lide400-controller.js` `ensureBridge()` invokes `/usr/bin/xcrun clang` against `native/mintvault-lide-bridge.m`; the Objective-C helper uses ImageCaptureCore and requests 1200-DPI 8-bit RGB TIFF |
| WP0-SV-05 | Current install/update path is not a production package | `scripts/scanner-app/install.sh` runs `npm install` and installs a LaunchAgent; `update.sh` only refuses mutable Git/npm update; no DMG/ZIP/latest-mac/sign/notarise config exists |
| WP0-SV-06 | Current identity is not the required clone-resistant design | `station-identity.js` generates Ed25519 in main, exports PKCS8, stores it with session/nonce inside an Electron `safeStorage` envelope under Application Support; signing occurs in main |
| WP0-SV-07 | Current evidence queue is not encrypted-at-rest | `watcher.js` uses `targeted-capture-queue.json` / `pending-queue.json` and plaintext TIFF paths; it has valuable target-bound safety but not the required SE-wrapped encrypted queue/disposition state machine |
| WP0-SV-08 | Renderer bridge is narrow but not schema-versioned | `preload.js` exposes a fixed set of methods/events; current IPC lacks a formal versioned schema validator at every boundary |
| WP0-SV-09 | Server foundations exist | Committed Partner source contains station signatures, NEW/Card Job/credit authority, FIX authority, staged evidence and finalisation services; these remain server authority and are not forked into Electron |

## Engineering OS and Graphify

- `engineering` path: `/Users/cornelius/.local/bin/engineering`, version 1.0.10, self-check `{ok:true}`.
- `graphify` path: `/Users/cornelius/.local/bin/graphify`, version 0.9.39.
- MintVault had no `.engineering/project.yaml`, OS registry entry or graph metadata before WP0.
- Enrollment profile: `high-security`; preflight: risk `CRITICAL`, required mode `HOSTILE`.
- Code graph: source `d44a2c53`, 11,275 nodes, 25,295 edges; call-flow architecture generated locally under ignored `graphify-out/`.
- The graph is navigation evidence only. Every blocker claim above was verified against real source.

## Source-to-work-package routing

| WP | Starting authority | Immediate correction |
|---|---|---|
| WP1 | `scripts/scanner-app/lib/lide400-controller.js`, `native/mintvault-lide-bridge.m` | Precompile/bundle arm64 `mv-capture-helper`; signature verification; eliminate runtime compiler |
| WP2 | `station-identity.js`, Partner station signature/service/routes | Native Secure-Enclave/Keychain helper, identity migration, epoch/resync and station-bound refresh contracts |
| WP3 | Partner auth/MFA/session/permissions and Scanner login renderer | Current-human/station/min-version status and exact scanner-role state machine |
| WP4 | Card Job/credit/FIX/staging/finalisation services | Capture authorisation, semantic operation IDs, cancel/release, profile revision |
| WP5 | `watcher.js`, `server-client.js`, staging/finalisation services | Authenticated encrypted queue, plaintext sweep, dispositions, fresh grants |
| WP6/7 | Scanner package/install/update shell | DMG/ZIP/update feed/hardened runtime/updater/rollback/login item |
| WP8 | renderer/preload/main | Sandboxed appliance UI, schema-versioned IPC, fail-closed states |
| WP9/10 | tests plus final P14 HEAD | Full non-vacuous matrix, hostile review, semantic reconciliation |
