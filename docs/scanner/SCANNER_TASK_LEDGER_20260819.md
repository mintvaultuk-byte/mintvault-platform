# Scanner task ledger — 2026-08-19

## SFAP-015 background Front→Back pass

| Task                                                                                            | Result               | Evidence                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate physical Canon ownership from network upload/finalisation                              | Done in source       | `scanner_capture_sessions.physical_released`; migration `0094`; server staging grant marks released only after accepted hash/bytes/provenance candidate. |
| Allow BACK after durable/server-authorised FRONT upload task, not after mere preview/scan-start | Done in source/tests | Capture authority counts same-station released FRONT as present for arming BACK; scanner tests prove FRONT background upload does not block BACK claim.  |
| Keep READY_TO_GRADE behind immutable FRONT + BACK only                                          | Preserved            | Staged finalise reconciliation still advances from immutable evidence only; local released state is not grading evidence.                                |
| Preserve same partner/location/station/Card Job/MV/reservation/geometry                         | Done in source/tests | Authority and service enforce station affinity both directions, fixed geometry pairing, and no credit path on BACK.                                      |
| Remove generic recapture bypass                                                                 | Done                 | Partner station generic route hardcodes `recapture:false`; recapture same-side owner must match.                                                         |
| Make lost-local-TIFF recovery safe                                                              | Done                 | `/failed` returns explicit terminal/non-terminal result; Scanner queue deletion requires terminal proof.                                                 |
| Close cancellation/refund race                                                                  | Done locally         | Shared per-certificate advisory transaction lock in cancellation and session creation.                                                                   |
| Preserve Preview=Acceptance                                                                     | Preserved            | Normal post-scan Accept path remains absent; unsafe frames are Rescan-only.                                                                              |
| Preserve independent upload progress                                                            | Preserved            | Per-side `captureUploads` state and renderer upload panel.                                                                                               |
| Hostile specialist review                                                                       | Done                 | Native/Electron PASS; capture/session PASS; auth/payment PASS after fixes.                                                                               |
| Focused/wider gates                                                                             | Done locally         | Scanner 166/166; wider server 194 passed / 2 skipped; typecheck/build/diff passed.                                                                       |
| Protected 0094 migration path                                                                   | Done                 | Linter/runner approval is exact-file/exact-index-replacement only; disposable PostgreSQL 0093→0094/idempotency/invariant proof passed.                   |
| Staging 0094 migration                                                                          | Done on staging      | Scoped migration applied only `0094_scanner_capture_physical_release.sql`; checksum `4918f58e72da…`; journal 83→84; post-checks clean.                   |
| Staging deploy                                                                                  | Done                 | Deployed to `mintvault-v2` only after 0094; Fly machines healthy; `/health` OK; `/api/version` reports the SFAP-015 successor.                           |
| Production isolation reconciliation                                                             | Read-only checked    | Scanner pass did not target production; production separately moved to `c6ae706f`/`0095_growth_partner_applications.sql`; no scanner `0094` present.     |
| Physical Canon acceptance                                                                       | Not done             | Requires owner to operate staging Scanner after migration/deploy.                                                                                        |
| 5,000 scanner-overlap scale run                                                                 | Not done             | Existing 5,000 one-credit NEW storm is credit/idempotency proof only, not scanner-overlap load proof.                                                    |

## Next owner-controlled task

Perform the physical Canon acceptance script on staging:

`Preview FRONT → GREEN → Scan FRONT → wait only for physical capture + upload-task acceptance → Preview BACK while FRONT still uploads`.
