# MintVault Scanner — Canon CanoScan LiDE 400

The MintVault Electron menu-bar app is the single workstation-side process for target-bound Canon LiDE 400 capture. It uses macOS ImageCaptureCore directly; it does not automate Canon IJ Scan Utility, SilverFast, or any other GUI.

## Normal capture flow

1. In the existing MintVault Card Details workstation, choose the preselected card and click **SCAN FRONT**.
2. The server creates a five-minute, certificate/card/submission/side-bound session for the provisioned workstation.
3. This app claims only that session and displays the exact card and required side. **It does not scan automatically.** Position the card and press **SCAN FRONT** or **SCAN BACK** in the scanner app.
4. For initial placement setup only, press **PREVIEW**. The app physically acquires the full platen at 300 DPI as a local JPEG, detects the card, and shows a compact card-centred display crop with visible surrounding scanner background. The broad source image, geometry, and acquisition boundary are under **Service & diagnostics**. Preview has no target, TIFF, upload, certificate mutation, or evidence capability. Save only a visibly detected, safe zone.
5. The normal target-bound flow then makes one locked 1200 DPI RGB TIFF capture using that station's fixed 100 × 130 mm hardware acquisition region, then generates a fast JPEG preview from that same TIFF. It does not perform a second low-resolution scan during normal card capture. Card-edge detection must prove visible scanner background around all four sides before Accept is offered.
6. Review the explicitly labelled non-authoritative preview. **ACCEPT FRONT/BACK** uploads that exact TIFF to the session-aware evidence branch; **RESCAN FRONT/BACK** archives the candidate locally and retains the same server-owned card-side target.
7. The server verifies TIFF identity, 1200 DPI, geometry, profile provenance, station, selected side, and immutable storage before it marks the accepted capture authoritative. Flip only after an accepted front. Grading uses derivatives only; the master TIFF remains immutable evidence.

The browser never reads the scanner filesystem or controls a physical scanner. The scanner never supplies a free-form certificate, card, or side with a TIFF.

## Required station provisioning

The production app does **not** use a shared scanner API token or a manually
assigned station ID. On first launch it shows **Sign in to MintVault**:

1. An authorised operator signs in and completes MFA.
2. The operator selects only a server-authorised location (automatic when there is one).
3. The app creates an Ed25519 Mac identity in macOS Keychain-backed storage and requests enrolment.
4. A Super Admin approves the server-assigned `MV-STN-…` station code.
5. The station reports its Canon hardware/profile, saves its own approved calibration, then can claim target-bound captures.

The non-secret `~/.mintvault-scanner.env` can contain only a controlled API-base override and `MINTVAULT_STATION_CONFIG_PATH` for local calibration storage. Leave X/Y values absent until a disposable card has been visibly detected in **PREVIEW**. Saving that safe proposal writes `MINTVAULT_LIDE_SCAN_X_MM` and `MINTVAULT_LIDE_SCAN_Y_MM` only to the explicit local station configuration path. They locate one fixed 100 × 130 mm hardware acquisition box for a simple bottom-left jig; they are not day-to-day controls.

Install a new station with:

```sh
cd ~/mintvault-platform/scripts/scanner-app
./setup-new-mac.sh
```

It renders the one canonical LaunchAgent (`com.mintvault.scanner`) and starts the Electron app. It does not prompt staff for a secret, station ID or X/Y values: sign in, wait for station approval, then run **PREVIEW** with a disposable card. The app builds its small ImageCaptureCore adapter locally with Xcode command-line tools; it adds no scanner npm dependency.

For an isolated local compatibility proof only, both client and server require
`MINTVAULT_ALLOW_LEGACY_SCANNER_TOKEN=1` in addition to a non-production
environment. That bridge is rejected by production server code and must not be
used for a deployed station.

## Device health

The popover's Canon LiDE status is device/profile health, not merely server reachability:

- `ready` — Canon device visible and jig origin provisioned.
- `profile_unprovisioned` — device is visible but fixture calibration is absent.
- `disconnected`, `busy`, or `control_unavailable` — do not capture until corrected.

## Retired hot-folder path

`~/mintvault-scans/inbox` is quarantined for forensic recovery only. Any TIFF placed there is moved to `rejected/` with a reason; it cannot mint a certificate or attach/rewrite evidence. AUTO pairing, one-shot attachment, SilverFast export, synthetic test scans, and unbound TIFF attachment are retired because they cannot establish target binding.

The app preserves `processed/`, `failed/`, `rejected/`, and `capture-staging/` locally. It does not delete evidence.

## Operations

```sh
launchctl print gui/$(id -u)/com.mintvault.scanner
tail -f ~/mintvault-scans/scanner-app.log
./uninstall.sh
```

Do not load a legacy scanner watcher alongside `com.mintvault.scanner`.

## Tests

```sh
npm test
```

The scanner-client tests prove that claiming never scans, a Scan creates only a non-authoritative derivative preview, only Accept posts the original TIFF, and stale/double/expired preview actions cannot duplicate or cross card sides.
