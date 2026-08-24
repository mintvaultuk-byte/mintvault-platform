# MintVault Scanner — Canon CanoScan LiDE 400

The MintVault Electron menu-bar app is the single workstation-side process for target-bound Canon LiDE 400 capture. It uses macOS ImageCaptureCore directly; it does not automate Canon IJ Scan Utility, SilverFast, or any other GUI.

## Normal capture flow

1. The server creates one Card Job and arms the exact required side for the provisioned workstation.
2. This app displays that server-owned card and side. **It does not scan automatically.** Press **PREVIEW FRONT** or **PREVIEW BACK** to check placement; Preview is free and has no evidence or credit authority.
3. When the target-bound placement pass is green, press **SCAN FRONT** or **SCAN BACK**. The current fixed Canon profile is automatic: the operator cannot move, reset, save, or otherwise edit its geometry.
4. After the server accepts FRONT, flip the card and follow the explicit **PREVIEW BACK** then **SCAN BACK** instruction. Both sides remain on the same Card Job and use the same one-credit reservation.
5. The target-bound flow makes one locked 1200 DPI RGB TIFF capture using that station's fixed 100 × 130 mm hardware acquisition region, then generates a fast JPEG preview from that same TIFF. It does not perform a second low-resolution scan during normal card capture. Card-edge detection must prove visible scanner background around all four sides before evidence is admitted.
6. The server verifies TIFF identity, 1200 DPI, geometry, profile provenance, station, selected side, and immutable storage before it marks the capture authoritative. Grading uses derivatives only; the master TIFF remains immutable evidence.

The browser never reads the scanner filesystem or controls a physical scanner. The scanner never supplies a free-form certificate, card, or side with a TIFF.

## Required station provisioning

The production app does **not** use a shared scanner API token or a manually
assigned station ID. On first launch it shows **Sign in to MintVault**:

1. An authorised operator signs in and completes MFA.
2. The operator selects only a server-authorised location (automatic when there is one).
3. The app creates an Ed25519 Mac identity in macOS Keychain-backed storage and requests enrolment.
4. A Super Admin approves the server-assigned `MV-STN-…` station code.
5. The station reports its Canon hardware/profile. MintVault provisions and adopts the approved fixed Canon profile automatically, then the station can claim target-bound captures.

The non-secret `~/.mintvault-scanner.env` can contain only a controlled API-base override. The Scanner obtains its fixed capture geometry from the current server-owned Canon profile; it accepts no operator-supplied X/Y capture coordinates.

Install a new station with:

```sh
cd ~/mintvault-platform/scripts/scanner-app
./setup-new-mac.sh
```

It renders the one canonical LaunchAgent (`com.mintvault.scanner`) and starts the Electron app. It does not prompt staff for a secret, station ID or X/Y values: sign in, wait for station approval, then let MintVault apply the fixed profile before starting the target-bound **PREVIEW FRONT** flow. The app builds its small ImageCaptureCore adapter locally with Xcode command-line tools; it adds no scanner npm dependency.

For an isolated local compatibility proof only, both client and server require
`MINTVAULT_ALLOW_LEGACY_SCANNER_TOKEN=1` in addition to a non-production
environment. That bridge is rejected by production server code and must not be
used for a deployed station.

## Device health

The popover's Canon LiDE status is device/profile health, not merely server reachability:

- `ready` — Canon device visible and the automatic fixed profile is available.
- `profile_unprovisioned` — device is visible while MintVault is still preparing or adopting the automatic fixed profile.
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
