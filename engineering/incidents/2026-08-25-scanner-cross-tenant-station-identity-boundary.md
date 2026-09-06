# Scanner cross-tenant station identity runtime boundary

- **Date:** 2026-08-25
- **Severity:** HIGH
- **Issue:** SCN-IDENTITY-001
- **Detected in:** Scanner v1.6.1, candidate `0bce7fe1c59374a45470d1c0d39e4541fe0c77ad`
- **Repaired in:** Scanner v1.6.2, code commit `5d776380b478b1cee919d3381635822937982ce8`
- **Deployment:** None; staging was not deployed and production was untouched

## Observed failure

The isolated Shop Games runtime record identified PID 91849, the v1.6.1 candidate executable,
`MINTVAULT_SCANS_DIR=/Users/cornelius/mintvault-shopgames`, Electron userData
`/Users/cornelius/mintvault-shopgames/electron-profile`, and station
`MV-STN-N5YE3IBUGVMMQDIV`. That process had exited before inspection.

The subsequently visible Scanner was the default/shared profile, launched without
`MINTVAULT_SCANS_DIR`. It loaded
`/Users/cornelius/Library/Application Support/MintVaultScanner/station-identity.enc.json`, whose
station code is Shop 0's `MV-STN-6DIISWMIEU2IKRG4`.

Shop Games' independent identity remained at
`/Users/cornelius/mintvault-shopgames/app-state/station-identity.enc.json` and still contained
`MV-STN-N5YE3IBUGVMMQDIV`.

## Identity sources

| Profile | Station | Identity file | Install fingerprint | Public-key fingerprint |
| --- | --- | --- | --- | --- |
| Shop Games | `MV-STN-N5YE3IBUGVMMQDIV` | `/Users/cornelius/mintvault-shopgames/app-state/station-identity.enc.json` | `1e9c6e8fdcf653511e803cc604fec433e58cc761fae02f1a40e2d4564c311149` | `a6d17a0faeb89d22b2ff1691503d306991b9632734f849e5c9089f901306f2ae` |
| Shop 0 / Pokémon Kings | `MV-STN-6DIISWMIEU2IKRG4` | `/Users/cornelius/Library/Application Support/MintVaultScanner/station-identity.enc.json` | `bf95785ce049e4436e357591b6f2731726a2e46c749194dab6d206f36ec2bd6e` | `e8b90a6ea20e77c7336ec8bc144f1ec0ed595ba2cf4e7f4a97c8feb6b29520fb` |

Electron uses the global macOS Keychain service `mintvault-scanner-app Safe Storage` and account
`mintvault-scanner-app Key`. This is a shared encryption-wrapping root, not a station selector. The
station codes, private keys, operator sessions and nonces reside in the distinct encrypted files
above. No Keychain collision, global station record or cross-profile file fallback was found.

## Root cause

Persistence-path isolation was intact, but runtime-authority isolation was incomplete. A locally
ACTIVE station identity plus any stored authenticated operator token made signed station paths
available before `/api/partner/stations/:stationCode/enrolment-status` proved that exact station
under that exact operator session. Setup also reconciled tenant state and read credits before that
proof. Concurrent token replacement could make an otherwise successful response stale, and
enrolment persistence did not independently reject re-homing or a token change at the final write.

## Repair

- Use one immutable operator-session scope for the complete setup transaction.
- Verify the token before dispatch and after every response.
- Validate exact station code/status before tenant reconciliation, credit commit, geometry adoption,
  heartbeat or any other signed station request.
- Keep the validated operator/station pairing process-local so every restart revalidates.
- Invalidate the pairing on sign-out, sign-in/MFA token replacement or station-status change.
- Reject inconsistent 200 responses, stale in-flight responses and stale enrolment writes.
- Refuse to overwrite an existing profile with a different station code.
- Preserve both encrypted identities and all existing calibration data.

## Regression proof

| Proof | Result |
| --- | --- |
| Focused identity/auth/MFA/runtime suite | 24/24 PASS, 0 skipped |
| Shared Keychain wrapping root with two profile files | PASS |
| Restart, sign-out/sign-in and MFA preserve each identity independently | PASS |
| Wrong-tenant and inconsistent station responses fail before heartbeat/credits/state/geometry | PASS |
| Mid-request and final-write token replacement | PASS; no stale authority or enrolment save |
| Existing station cannot be automatically re-homed | PASS |
| Full Scanner suite | 175/175 PASS, 0 skipped |
| Clean full repository suite | 6,950 PASS, 0 failed, 2 platform skips |
| Protected Partner/onboarding/auth/migration matrix | 70/70 suites; 1,320 assertions; 0 failed/skipped |
| Typecheck, lint and provenance-required build | PASS; lint has 0 errors |
| Targeted hostile review | Two independent reviews CLEAR; no actionable BLOCKER/HIGH |

The two repository skips are the protected label pixel-hash cases that are deliberately Linux/x64
only. Portable label metrics ran on this macOS arm64 host. They are unrelated to Scanner identity.

## Preserved authorities

- Shop 0 remains `MV-STN-6DIISWMIEU2IKRG4`.
- Shop 0 calibration `f7b7fe4f-aefb-423c-a4a5-dc9cec8fabcf` remains locally bound only to Shop 0,
  records `pilot_qualified`, and retains its 1.70 mm policy without globalisation.
- Shop Games remains `MV-STN-N5YE3IBUGVMMQDIV`, balance 5, with no local active capture, open card
  or pending start.
- No station was released, revoked, deleted, reset, copied or re-enrolled.
- No card was started, no reservation was created and no credit was consumed.
- The locked FRONT/BACK workflow and fixed Canon geometry authority were not changed.

## Lesson and proof expiry

Per-profile encrypted persistence prevents file collision, but it does not itself prove that the
current human session belongs to the persisted station. Every process restart and operator-session
generation must revalidate the exact operator/station pairing before any signed station request or
local tenant-scoped state change.

Re-open this proof if the identity-file path, Electron application/Keychain namespace,
operator-session persistence, enrolment-status route or middleware, signed-request gate, setup/auth
IPC flow, or station-enrolment write semantics change.
