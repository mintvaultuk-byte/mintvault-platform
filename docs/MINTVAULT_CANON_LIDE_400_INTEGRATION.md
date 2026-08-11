# Canon CanoScan LiDE 400 — integration and acceptance record

## Release boundary

This record describes the target-bound scanner path in the existing MintVault
workstation. The coordinated signed-station release supplies its additive
server schema through migrations `0045`–`0047`; it still does not install a
LaunchAgent or alter physical hardware configuration by itself.

```mermaid
sequenceDiagram
  participant O as Setup operator
  participant W as Existing Card Details UI
  participant S as MintVault server
  participant A as Existing scanner-app
  participant C as Canon LiDE 400
  participant E as Immutable evidence ledger/R2
  O->>A: PREVIEW (no target required)
  A->>C: Full-platen 300 DPI JPEG setup capture
  C-->>A: Local JPEG
  A->>A: Detect card bounds, orientation, margins
  Note over A: Show actual Preview; save only a safe measured X/Y
  W->>S: Arm certificate + card/submission + side + station
  A->>S: Claim matching short-lived session
  Note over A: Show exact target; wait for operator Scan
  A->>C: Operator Scan: ImageCaptureCore locked 1200 DPI RGB TIFF request
  C-->>A: Original TIFF
  A->>A: Make non-authoritative preview from that TIFF
  Note over A: Operator Accept or Rescan
  A->>S: Accept only: TIFF + LiDE provenance + session ID
  S->>S: Verify session, profile, TIFF, DPI and geometry
  S->>E: Append immutable evidence revision; select current master
  S-->>W: Captured / processing
```

There is no browser-to-filesystem bridge, GUI automation, filename target, or
free-form certificate/side upload in this path.

## Locked profile

| Setting         | Required value                                               |
| --------------- | ------------------------------------------------------------ |
| Scanner         | Canon CanoScan LiDE 400                                      |
| Source          | Flatbed                                                      |
| Colour          | RGB, 8-bit                                                   |
| Master          | Original TIFF                                                |
| Resolution      | 1200 DPI requested, driver-reported and decoded TIFF density |
| Hardware region | 100 × 130 mm generous station acquisition region             |
| Geometry        | 4550–4900 × 5950–6350 px                                     |
| Profile ID      | `mintvault-canon-lide-400-v3`                                |

The fixed 100 × 130 mm hardware region deliberately tolerates normal placement
variation around a standard 63 × 88 mm TCG card: it provides 4 mm evidence
margin plus at least 9 mm ordinary placement tolerance on every side when the
placement Preview has selected a safe zone. It is not the working crop: the
full TIFF remains the master and a separate card-boundary check must find all
four edges with at least 4 mm of scanner background before the candidate can
be accepted. The station-specific origin is saved only through the explicit
station configuration path after a visible safe Preview.
ImageCaptureCore provides the scanner request, functional-unit resolution,
scan area and destination-file controls used by the bridge; its operation must
still be validated with the actual connected device.

## Jig calibration and ordinary placement

The station fixture defines one fixed **hardware acquisition region**. Staff do
not position cards by X/Y: the intended normal workflow is simply **place card
in the MintVault bottom-left jig/placement zone → SCAN**. The calibrated origin
is station configuration, not an operator control.

Before a station is enabled, use a disposable card and the Scanner app's
**PREVIEW** control. It makes an ImageCaptureCore full-platen, 300-DPI JPEG
setup capture, displays a compact card-centred view with visible surrounding
scanner background, and calculates card X/Y, orientation, and surrounding
margin. The full platen, exact dimensions, and acquisition boundary are
secondary **Service & diagnostics** material. Preview is deliberately separate from final capture: it has no server
target, certificate mutation, TIFF output, upload, or evidence capability.
`scripts/scanner-app/calibrate-lide.js` remains a diagnostic-only tool; it is
not the primary placement workflow and its bounded TIFF output cannot establish
an origin without a corresponding visible safe Preview.

Save a proposal only when the visible Preview gives the card at least 13 mm of
clearance from each chosen final-region edge (4 mm immutable-evidence margin +
9 mm normal placement tolerance). Then test nominal, realistic left/right,
up/down, and small-rotation placements. Record detected card frame, final
hardware margins, TIFF geometry/size, and scan timing. Every final TIFF still
requires at least 4 mm visible scanner background on all four sides. Increase
the hardware region or offset the simple jig away from the glass edge if any
test loses focus, clips an edge, or leaves insufficient background. Never
reduce the region merely to save time.

The local Scanner and server independently refuse a candidate whose detected
card boundary is too close to the acquired TIFF edge. A working crop derives
card geometry only after this test; it cannot repair a clipped master.

### Coordinate contract

The station uses one explicit `imagecapturecore-scan-area-upright-raster-v1`
contract: ImageCaptureCore physical millimetres map to the upright Preview
raster, and then to the actual `object-fit: contain` image-content rectangle
inside the Scanner viewport. It rejects a rotated or mirrored source Preview
instead of silently applying an offset. Consequently, the detected-card frame
and final-region boundary describe the same physical coordinates used for the
hardware request; UI letterboxing cannot shift an overlay beside the card.

On an earlier retained visible local Preview, the card was fully visible at X 5.9422
mm, Y 6.2702 mm, 63.8787 × 88.9382 mm within the full 215.9 × 297.0107 mm
platen. A full-width dark platen reflection required a bounded
connected-component detector fallback; the rerendered card frame confirms that
this is a detection repair, not a software coordinate offset. The position has
enough observed evidence margin for the Preview itself. The current station
calibration requires 13 mm at each final-region edge: 4 mm immutable-evidence
margin plus 9 mm ordinary placement latitude. A later complete Preview at X
7.2627 mm/Y 7.9203 mm remains unsaved because it needs about 6 mm of inward
movement in each direction to meet that operating envelope. Staff never enter
coordinates.

## Evidence and recapture

`certificate_image_evidence` is an append-only revision ledger. A recapture:

1. requires an explicit `recapture: true` server session;
2. uploads a new content-addressed, no-overwrite TIFF object;
3. marks the prior evidence row non-current with `superseded_at` and
   `superseded_by_id`;
4. selects exactly one current master per certificate side; and
5. regenerates grading derivatives only from the selected master.

No master object or evidence row is deleted or overwritten. Replaying the same
bytes is idempotent and does not manufacture a revision.

## Required physical acceptance (hardware acceptance pending)

This workspace's development station has a physically attached Canon LiDE 400.
The following local-development acceptance remains required before any pilot
declaration:

1. With a disposable card in the intended bottom-left placement zone, press
   **PREVIEW** and confirm the compact card-centred image is visible in the
   Scanner app. Record station ID, macOS version, ImageCaptureCore device
   ID/serial, Preview area/dimensions/time, detected card X/Y/size/orientation,
   and all four available margins. Do not save an origin based on a guessed or
   bounded scan. Save only a visibly safe proposal, then record the final
   100 × 130 mm X/Y, physical region, 1200-DPI pixels, TIFF size, and scan
   time. Daily staff never enter X/Y.
2. Confirm popover state `ready`; unplug/replug and confirm `disconnected` then
   `ready` transitions. Confirm `profile_unprovisioned` blocks capture.
3. Select a known certificate linked to a card/submission item, arm front, and
   verify that only its configured station claims it. Try a stale session and a
   different station ID; both must fail closed.
4. Arm front and verify the scanner only displays the target until the operator
   presses **SCAN FRONT**. Verify the single 1200-DPI TIFF creates a fast
   non-authoritative preview with no evidence upload; double-click Scan and
   verify only one physical capture starts. Verify **RESCAN FRONT** archives
   the candidate and retains the exact front target. Verify **ACCEPT FRONT**
   uploads only the reviewed TIFF, then repeat for back and inspect accepted
   evidence rows/object metadata, SHA-256, profile provenance, audit logs, and
   correct certificate/card/side. Deliberately place a card against each
   plausible acquisition edge: its preview must be labelled rescan-only and
   Accept must not be available or upload evidence.
5. Attempt 72/900 DPI, wrong model/profile, JPEG/PNG renamed `.tif`, wrong
   geometry, replay, stale session, and unbound inbox file. Each must be
   rejected without creating a certificate or replacing current evidence.
6. Request an explicit controlled recapture, verify the revision chain and
   current pointer, then verify grading preview/working assets derive from the
   new current master while the old TIFF remains retrievable by object key.
7. Verify Super Admin Card Details and the assigned `can_scan` Staff queue arm
   the same capture-session lifecycle. Verify Grader/Admin Review retain their
   existing grade-only permissions: no scan endpoint is exposed unless a role
   is explicitly granted `can_scan`.
8. Hostile-test duplicate Accept, stale preview Accept, Rescan during upload,
   an expired session, and a newly armed card while a preview is open. Each
   must fail closed; an accepted front must remain untouched while back fails
   or is rescanned.
9. Hostile-test Preview independently: double-click Preview, attempt to save a
   stale Preview ID, arm/change a card while a Preview is visible, and attempt
   Preview while a target TIFF awaits Accept/Rescan. Each must fail closed with
   no target mutation, TIFF, upload, or evidence row.

## Issue register resolved by this change

| Severity | Previous failure                                                                         | Resolution                                                                                                                |
| -------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| High     | Hot-folder AUTO minted a new certificate with no selected card/side                      | Server-owned session binds certificate/card/submission/side before scanner claim                                          |
| High     | Manual TIFF attachment hit an endpoint that rejected TIFF                                | Scanner app now sends TIFF only to session evidence endpoint; unbound attach is disabled                                  |
| High     | 72/900 DPI TIFF could become an immutable master                                         | Locked driver + decoded DPI + region geometry profile checks                                                              |
| High     | One evidence row per side made recapture impossible                                      | Append-only revisions with partial unique current-side index                                                              |
| High     | Stale inbox files could be ingested after restart                                        | Hot-folder TIFFs are quarantined, never ingested                                                                          |
| High     | Uninstall used the wrong LaunchAgent label                                               | Uses canonical `com.mintvault.scanner`                                                                                    |
| High     | A claimed target could scan/upload without physical confirmation                         | Scanner app waits for explicit Scan, creates a local preview, and uploads only on Accept                                  |
| High     | A guessed bounded calibration could miss a card and silently create an unsafe jig origin | Full-platen local 300-DPI Preview visibly detects the card and permits only an exact safe result to persist the final X/Y |

## Test evidence in this repository

- `tests/lide400-profile.test.ts`: valid 1200 DPI profile, wrong DPI and
  metadata-only geometry spoof rejection.
- `tests/image-evidence.test.ts`: generic evidence decoder limits.
- `scripts/scanner-app/test/server-client-tiff-upload.test.js`: original TIFF
  multipart bytes and session endpoint selection.
- Scanner setup Preview tests: no target/session/evidence capability, one
  in-flight Preview, stale-save rejection, and safe-result-only persistence.
- TypeScript compilation: `npm run check`.

Route-to-database/R2 integration needs a disposable Postgres and object-storage
environment; do not execute it against production merely to validate this
release.
