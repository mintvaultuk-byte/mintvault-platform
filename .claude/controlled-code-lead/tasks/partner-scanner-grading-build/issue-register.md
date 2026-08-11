# Issue Register - Partner / Scanner / Grading Current Build

Baseline: `c782a613e9d97f1943ecafff95a7506d29d14267`
Branch: `psp/partner-rbac-hybrid`
Owner decision: current Partner / scanner / grading integration bundle approved with narrow non-maths protected grading authorisation.

## Dirty File Inventory

| File                                                                                | Classification  | Reason                                                                   |
| ----------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------ |
| `.claude/controlled-code-lead/INDEX.md`                                             | COMPLETE        | Current build index entry replaces stale unrelated task entry.           |
| `.claude/controlled-code-lead/programs/four-build-release/**`                       | STALE/EXCLUDE   | Historical four-build release artefacts, not this build.                 |
| `.claude/controlled-code-lead/programs/partner-shop-pilot/**`                       | STALE/EXCLUDE   | Historical partner-shop planning artefacts; useful context only.         |
| `.claude/controlled-code-lead/tasks/catalogue-manager-hardening/**`                 | STALE/EXCLUDE   | Catalogue task artefacts, not this build.                                |
| `.claude/controlled-code-lead/tasks/catalogue-manager/**`                           | STALE/EXCLUDE   | Catalogue task artefacts, not this build.                                |
| `.claude/controlled-code-lead/tasks/owner-authorisation-prepilot-hostile-review/**` | STALE/EXCLUDE   | Old authorisation review note, not this build.                           |
| `.claude/controlled-code-lead/tasks/partner-final-approval-concurrency/**`          | STALE/EXCLUDE   | Separate concurrency proof task, not this build.                         |
| `.claude/controlled-code-lead/tasks/partner-portal-expanded-hostile-review/**`      | STALE/EXCLUDE   | Historical review artefacts, not this build.                             |
| `.claude/controlled-code-lead/tasks/partner-prod-demo-shop/**`                      | STALE/EXCLUDE   | Demo-shop staging/prod artefacts, not this build.                        |
| `.claude/controlled-code-lead/tasks/partner-staging-demo/**`                        | STALE/EXCLUDE   | Demo staging artefacts, not this build.                                  |
| `.claude/controlled-code-lead/tasks/partner-user-management-hostile-review/**`      | STALE/EXCLUDE   | Historical user-management review artefacts, not this build.             |
| `client/src/components/grading/card-tool-geometry.ts`                               | OWNER-PROTECTED | Non-maths workstation coordinate adapter; requires protected MVGS proof. |
| `client/src/components/grading/grading-panel.tsx`                                   | OWNER-PROTECTED | Non-maths evidence URL wiring into manual workstation.                   |
| `client/src/components/grading/manual-card-tool.tsx`                                | OWNER-PROTECTED | Non-maths scanner working-image binding and coordinate adapter use.      |
| `client/src/components/partner/partner-mfa-enrolment.tsx`                           | KEEP            | Partner onboarding/MFA lifecycle UX.                                     |
| `client/src/components/partner/partner-route-guard.tsx`                             | KEEP            | Partner permission routing.                                              |
| `client/src/lib/partner-api.ts`                                                     | KEEP            | Partner API client for MFA, customers, catalogue, card images.           |
| `client/src/pages/partner/dashboard.tsx`                                            | KEEP            | Partner workstation dashboard integration.                               |
| `client/src/pages/partner/login.tsx`                                                | KEEP            | Partner MFA login input hardening.                                       |
| `client/src/pages/partner/submission-detail.tsx`                                    | KEEP            | Partner card evidence visibility.                                        |
| `client/src/pages/partner/customers.tsx`                                            | KEEP            | Partner customer workflow page.                                          |
| `client/src/pages/partner/grading.tsx`                                              | KEEP            | Partner grading workstation page.                                        |
| `migrations/0046_partner_mfa_pending_lifecycle.sql`                                 | REPAIR          | Superseded filename; content belongs at registered slot `0044`.          |
| `scripts/scanner-app/README.md`                                                     | KEEP            | Scanner evidence invariant documentation.                                |
| `scripts/scanner-app/lib/server-client.js`                                          | KEEP            | TIFF master upload preservation.                                         |
| `scripts/scanner-app/lib/watcher.js`                                                | KEEP            | TIFF-only production watcher queue.                                      |
| `scripts/scanner-app/package.json`                                                  | KEEP            | Scanner app test script.                                                 |
| `scripts/scanner-app/test/server-client-tiff-upload.test.js`                        | KEEP            | Scanner client TIFF regression.                                          |
| `server/grader.ts`                                                                  | OWNER-PROTECTED | Non-maths partner adapter/evidence URL support; MVGS proof required.     |
| `server/lib/multer-configs.ts`                                                      | KEEP            | V850/SilverFast upload size contract.                                    |
| `server/lib/image-evidence.ts`                                                      | KEEP            | Scanner evidence inspection boundary.                                    |
| `server/partner/auth.ts`                                                            | KEEP            | Partner MFA login/session hardening.                                     |
| `server/partner/catalogue-routes.ts`                                                | KEEP            | Partner read-only catalogue dependency.                                  |
| `server/partner/customer-routes.ts`                                                 | KEEP            | Partner customer edit API.                                               |
| `server/partner/customer-service.ts`                                                | KEEP            | Partner customer edit/duplicate guard.                                   |
| `server/partner/grading-routes.ts`                                                  | OWNER-PROTECTED | Partner-scoped non-maths MVGS handoff adapter.                           |
| `server/partner/mfa-service.ts`                                                     | KEEP            | Partner MFA pending lifecycle.                                           |
| `server/partner/mount.ts`                                                           | KEEP            | Partner router mounting.                                                 |
| `server/partner/routes.ts`                                                          | KEEP            | Partner MFA API lifecycle.                                               |
| `server/partner/submission-routes.ts`                                               | KEEP            | Partner card image upload route.                                         |
| `server/partner/submission-service.ts`                                              | KEEP            | Partner card images, totals, handoff snapshot.                           |
| `server/r2.ts`                                                                      | OWNER-PROTECTED | Immutable evidence upload helper under protected image-storage area.     |
| `server/routes.ts`                                                                  | OWNER-PROTECTED | Non-maths scanner evidence and legacy TIFF rejection wiring.             |
| `server/scan-ingest-service.ts`                                                     | OWNER-PROTECTED | Scanner evidence ledger and working derivative binding.                  |
| `shared/schema.ts`                                                                  | KEEP            | Additive scanner evidence schema definition.                             |
| `tests/card-tool-geometry.test.ts`                                                  | OWNER-PROTECTED | Non-maths workstation coordinate regression.                             |
| `tests/helpers/partner-realistic-db.ts`                                             | REPAIR          | Migration list must match repaired filename.                             |
| `tests/image-evidence.test.ts`                                                      | KEEP            | Scanner evidence boundary proof.                                         |
| `tests/partner-onboarding-ux.test.ts`                                               | KEEP            | Partner MFA/onboarding UX regression.                                    |
| `tests/partner-runtime-integration.test.ts`                                         | KEEP            | Partner real HTTP/MFA runtime regression.                                |
| `tests/partner-schema-parity.test.ts`                                               | REPAIR          | Migration parity must match repaired filename.                           |
| `tests/partner-shop-workflow-source.test.ts`                                        | KEEP            | Partner shop workflow source regression.                                 |
| `tests/partner-workflow-apis.test.ts`                                               | KEEP            | Partner customer/card workflow API regression.                           |

## Issues

### MV-PGS-001 - Migration slot mismatch

Severity: HIGH
Source: dirty inventory
Reproduction: untracked file is `migrations/0046_partner_mfa_pending_lifecycle.sql` while test registry expects `0044_partner_mfa_pending_lifecycle.sql`.
Reachability: migration parity and realistic DB helpers consume numbered migration filenames.
Impact: checkpoint would be internally inconsistent and migration ordering could drift.
Repair: rename file to `0044_partner_mfa_pending_lifecycle.sql`.
Test: `npx vitest run tests/partner-schema-parity.test.ts` passed as part of the focused suite; `npm run check` passed.
Status: PROVEN

### MV-PGS-002 - Stale governance artefacts in dirty tree

Severity: HIGH
Source: dirty inventory
Reproduction: untracked historical programme/task folders appear in `git status`.
Reachability: accidental `git add .` would carry unrelated old governance state into the build.
Impact: checkpoint would not represent the approved current build.
Repair: exclude stale artefacts from this local checkpoint without deleting them.
Test: `git status --short` after exclusion.
Status: PROVEN

### MV-PGS-003 - Protected MVGS behaviour proof

Severity: HIGH
Source: owner-protected files touched by current build.
Reproduction: protected grading files are modified.
Reachability: partner grading and scanner evidence paths call existing MVGS draft/workstation components.
Impact: unauthorised grading math drift would be release-blocking.
Repair: keep changes non-maths/evidence-adapter-only; run protected MVGS regression and source proof.
Test: MVGS scoring/pristine/centering/input-builder regression passed; protected scoring source files have no direct diff; changed protected files are evidence/adapter/write-guard surfaces only.
Status: PROVEN

## Proof Log

- `npm run check`: pass.
- `npm run build`: pass; existing PostCSS `from` warning only.
- `npm test --prefix scripts/scanner-app`: 2 passed, 0 failed.
- `npx vitest run tests/card-tool-geometry.test.ts tests/image-evidence.test.ts tests/partner-onboarding-ux.test.ts tests/partner-shop-workflow-source.test.ts tests/partner-schema-parity.test.ts`: 73 passed, 0 failed.
- `npx vitest run tests/mvgs-scoring.test.ts tests/pristine.test.ts tests/centering.test.ts tests/mvgs-input-builder.test.ts tests/grading-draft-validation.test.ts tests/partner-workflow-apis.test.ts`: 187 passed, 44 skipped; skip is DB-backed partner API without local DB env.
- `npx vitest run tests/partner-runtime-integration.test.ts tests/partner-workflow-apis.test.ts`: 85 skipped; both suites require disposable Postgres env.
- `npx vitest run tests/partner-submission-wizard-ui.test.ts tests/card-preview-and-ready-to-print.test.ts tests/grading-workstation-layout-fix.test.ts tests/grading-final-polish.test.ts`: 111 passed, 0 failed.
- `npx vitest run tests/partner-dashboard-integration.test.ts tests/partner-definer-transitive-reachability.test.ts`: 24 passed, 36 skipped.
- `.claude/governance-tests/run-all.sh`: 4 governance suites passed, 0 failed.
- `git diff --check`: pass.
