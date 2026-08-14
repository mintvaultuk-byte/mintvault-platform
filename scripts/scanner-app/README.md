# MintVault Scanner — Canon CanoScan LiDE 400

The MintVault Electron menu-bar app is the single workstation-side process for target-bound Canon LiDE 400 capture. It uses macOS ImageCaptureCore directly; it does not automate Canon IJ Scan Utility, SilverFast, or any other GUI.

## Normal capture flow

1. In the existing MintVault Card Details workstation, choose the preselected card and click **SCAN FRONT**.
2. The server creates a five-minute, certificate/card/submission/side-bound session for the provisioned workstation.
3. This app claims only that session and displays the exact card and required side. **It does not scan automatically.** Position the card and press **SCAN FRONT** or **SCAN BACK** in the scanner app.
4. For initial placement setup only, press **PREVIEW**. The app physically acquires the full platen at 300 DPI as a local JPEG, detects the card, and shows a compact card-centred display crop with visible surrounding scanner background. The broad source image, geometry, and acquisition boundary are under **Service & diagnostics**. Preview has no target, TIFF, upload, certificate mutation, or evidence capability. Save only a visibly detected, safe zone.
5. The normal target-bound flow then makes one locked 1200 DPI RGB TIFF capture using that station's fixed 100 × 130 mm hardware acquisition region, then generates a fast JPEG preview from that same TIFF. It does not perform a second low-resolution scan during normal card capture. Card-edge detection must prove visible scanner background around all four sides before Accept is offered.
6. Review the explicitly labelled non-authoritative preview. Before Accept is exposed, both the TIFF and JPEG derivative are already in the device-bound encrypted queue and their plaintext staging files are gone. **ACCEPT FRONT/BACK** uploads that exact TIFF to the session-aware evidence branch; **RESCAN FRONT/BACK** quarantines the encrypted candidate and requires the server to issue a fresh authorisation, operation ID, and later evidence revision for the same pinned card side before another physical scan.
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

For legacy source-development recovery only, never for a production station:

```sh
cd ~/mintvault-platform/scripts/scanner-app
./setup-new-mac.sh
```

The production installer is the signed, notarised and stapled DMG described in
[`PACKAGING.md`](PACKAGING.md). It places the application at
`/Applications/MintVault Scanner.app`; it does not prompt staff for a secret,
station ID or X/Y values. Sign in, wait for station approval, then run
**PREVIEW** with a disposable card. The application ships its precompiled arm64
ImageCaptureCore helper and verifies its sealed digest, architecture, minimum
macOS, signature, signing identifier, and production Team ID before every
spawn. Production stations need no Xcode, command-line tools, source checkout,
Git, npm, or separately installed Node runtime.

## Login startup, update and reinstall

The installed application is off at login until this Mac has completed
device-bound station enrolment. It then enables the modern macOS main-app login
item once by default and never overrides a later user/System Settings choice.
Production does not ship or depend on a service plist, keep-alive helper or
shell repair script; in-app recovery relaunches the same signed application.

Updates are owner-built signed/notarised ZIPs discovered through
`latest-mac.yml`, but that mutable feed is never update authority. Authenticated
station status must supply a short-lived exact release policy matching the
minimum version, Team, source commit, artifact names/sizes/hashes and update or
explicit rollback direction. **UPDATE & RESTART** downloads and verifies that
one ZIP and refuses to restart during any physical/Preview/upload operation.
**DMG REINSTALL** downloads and hashes the exact policy-bound signed DMG before
opening it in macOS; it never falls back to a generic release page.

Update metadata/evidence bodies and ZIP/DMG streams are bounded while they are
read, have timeouts, and must preserve the encrypted-capture disk reserve. Once
installation begins, the app synchronously quiesces scanner IPC, target/health
polling, inbox handling and recovery scratch until native MacUpdater exits or
reports an explicit failure; its delayed macOS quit cannot race a new scan.

Identity/session state remains under Application Support/Keychain and encrypted
evidence under `~/mintvault-scans`, outside the replaceable `.app`. A failed or
interrupted update therefore cannot substitute release authority or erase local
custody; physical signed-update/reinstall persistence is still a clean-Mac
release-acceptance gate.

The source-only `setup-new-mac.sh`/LaunchAgent path is retained temporarily for
development and legacy recovery and is not the production installation path.
Build the helper only on the controlled Apple Silicon build host with
`npm run build:native`; station runtime never invokes a compiler. The current
dependency-backed minimum supported macOS candidate is 12.0 and remains subject
to packaged physical acceptance on the Pilot fleet.

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

`~/mintvault-scans/inbox` is quarantined for forensic recovery only. Any TIFF placed there is encrypted directly into the non-authoritative queue with a reason; it cannot mint a certificate or attach/rewrite evidence. AUTO pairing, one-shot attachment, SilverFast export, synthetic test scans, and unbound TIFF attachment are retired because they cannot establish target binding.

Legacy `processed/`, `failed/`, `discarded/`, and `capture-staging/` capture
plaintext is swept at startup into encrypted quarantine. It is never described
as securely overwritten on SSD storage.

## Encrypted offline custody

Capture evidence uses `capture-queue/index.v1.json` plus `.mvq` containers with
AES-256-GCM, a unique 96-bit nonce and authenticated immutable metadata. The
32-byte queue DEK is wrapped by the station identity helper using this Mac's
Secure Enclave key; copying Application Support and the scans directory to a
different Mac does not make the queue decryptable. Index corruption, missing
artifacts, AEAD failure and unmatched encrypted containers fail closed or enter
`QUARANTINED`; unresolved evidence is never timer-deleted.

Every delivery attempt decrypts into a private scratch file, obtains a fresh
short-lived server grant, streams the exact digest-bound TIFF, and unlinks the
scratch file in `finally`. A startup sweep removes verified scratch duplicates
and encrypts/quarantines any other abandoned TIFF/JPEG. Queue delivery may
continue after Shift Change with station-only signing, but it retains the
original operator from the capture authorisation and cannot claim or physically
scan new work without a current authorised human. Low disk capacity pauses NEW
and target claims while existing encrypted delivery remains available.

The queue index is authenticated in full with a domain-separated HMAC derived
from the wrapped DEK. Artifact AAD also binds the capture session,
authorisation, semantic operation, Card Job, side/revision, profile revision,
tenant/location/station, original operator/role, purpose, server timestamps,
validation results, provenance, app/helper versions, digest, size, and MIME.
Accept and recovery decrypt and reproduce the locked-master and frame checks.
Only an explicit server disposition carrying that exact full binding can move
evidence through `ACCEPTED` to `RESOLVED`; an empty or legacy-success response
remains `NEEDS_RECONCILIATION` with ciphertext intact.

## Legacy source-development operations

```sh
launchctl print gui/$(id -u)/com.mintvault.scanner
tail -f ~/mintvault-scans/scanner-app.log
./uninstall.sh
```

These LaunchAgent commands do not apply to the production DMG application. Do
not load a legacy scanner watcher alongside `com.mintvault.scanner`.

## Tests

```sh
npm test
```

The Scanner tests also prove device-clone resistance, nonce uniqueness,
metadata/ciphertext tamper rejection, corrupt/missing/orphan recovery,
plaintext sweep, exact disposition handling, station-only queued delivery,
original-operator preservation, full grant/finalisation tuples and disk-pressure
gating. Secure Enclave integration is opt-in with
`MINTVAULT_RUN_SECURE_ENCLAVE_TESTS=1 npm test`.
