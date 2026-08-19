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

## Owner-independent completion pass — physical Canon unavailable

| Task                                                            | Result                 | Evidence                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Re-run protected 0094 safety proof                              | PASS                   | `tests/scanner-physical-release-migration.test.ts` plus `tests/db-migration-safety.test.ts` included in the 207/207 post-commit focused gate; 0094 linter label remains `approved protected index replacement`.                                                                                 |
| Add protected 0096 audit-constraint migration                   | PASS / staged          | `0096_partner_card_job_void_management_audit.sql` widens only `chk_partner_management_audit_action`; local linter/runner proof passed; staging scoped migration applied journal 84→85 with checksum `c9272094…`.                                                                                |
| Deploy owner-independent package to staging                     | DEPLOYED               | `scripts/safe-deploy.sh staging --allow-behind --yes`; live-ancestry guard passed; Fly version 508 healthy; `/api/version` = `87366650`; `/health` = `ok`.                                                                                                                                      |
| Production-shaped Scanner `.app`                                | PASS unsigned          | `npm run package:mac && npm run verify:package` passed; bridge SHA-256 `54f31967…2d2f2d`; manifest says Partner Mac requires no Node/npm/Git/Xcode/clang; Developer ID signing identity unavailable.                                                                                            |
| Background Front→Back state-machine source proof                | PASS                   | Scanner suite 176/176; server scanner/payment/authority slice 311 passed / 2 skipped; simulator proves FRONT release → BACK arm while FRONT pending, reordered finalisation, no READY_TO_GRADE until both sides.                                                                                |
| Durable queue / restart / disk-full / lost-TIFF safety          | PASS source/mocked     | Scanner tests include ENOSPC pre-scan refusal, restart recovery retention, explicit terminal proof before deleting lost-TIFF tasks, and post-evidence reconciliation retry.                                                                                                                     |
| Independent upload progress                                     | PASS source/mocked     | Scanner tests and simulator cover per-side upload state and 0/63/100 progress samples; physical upload timing still requires hardware/staging operator run.                                                                                                                                     |
| Retry/reconnect/idempotency / stale preview / MV-side binding   | PASS source/mocked     | Scanner/server gates cover timeout reconciliation, duplicate callback rejection, stale preview rejection, same Card Job/MV/session/side/station binding, and no extra credit on BACK.                                                                                                           |
| One-card-one-credit / zero-credit UX / packs / Stripe authority | PASS except config     | Server and scanner gates prove consume-once, zero-credit hard block/modal/reconnect, 5/10/25/50/100 pack plumbing, Stripe TEST mode/Price/currency/environment verification, unpaid/wrong/replayed event rejection; staging packs remain fail-closed until owner supplies TEST prices/currency. |
| Auth/MFA/onboarding/station/viewer/downstream                   | PASS source/local      | Auth/onboarding/viewer/downstream slice 144 passed / 65 skipped; viewer pixel source labels remain explicit; grading maths and immutable TIFF master unchanged.                                                                                                                                 |
| 5k / 10k / 20k control-plane load                               | PASS simulated         | 5,000 workflows + 20,000 burst PASS; 10,000 workflows + 20,000 burst PASS; zero cross-MV contamination, duplicate evidence, duplicate reservation, double consume, negative wallet, zero-credit bypass, or stale current Preview in the simulator.                                              |
| Full root gate                                                  | FAIL external-env only | Post-commit `npm test`: 292 files passed / 54 skipped / 5 suites failed because `TEST_DATABASE_URL` or `MINTVAULT_DATABASE_URL` was absent; no actionable scanner/payment/viewer/auth source-contract failure remained.                                                                         |
| Production isolation                                            | PASS read-only         | No production deployment/migration by this pass; read-only prod check found no scanner `0094`/`0096` rows and no `physical_released` column.                                                                                                                                                    |

## Physical Canon acceptance-only checklist

1. Launch packaged staging Scanner.
2. Canon READY.
3. PREVIEW FRONT.
4. SCAN FRONT.
5. Verify FRONT upload runs in background.
6. Immediately PREVIEW BACK while FRONT still uploads.
7. SCAN BACK.
8. Both sides authoritative.
9. Cable disconnect/reconnect recovery.
10. Scanner restart during pending upload.
11. Image-quality visual check.
12. Measured scan timing/countdown accuracy.
