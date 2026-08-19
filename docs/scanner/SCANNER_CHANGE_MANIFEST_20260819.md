# Scanner change manifest — SFAP-015 — 2026-08-19

## Included code surfaces

- `server/scanner-capture-service.ts`
- `server/scanner-evidence-staging-service.ts`
- `server/scanner-evidence-finalisation.ts`
- `server/routes.ts`
- `server/partner/capture-authority.ts`
- `server/partner/card-job-cancellation.ts`
- `server/partner/station-routes.ts`
- `scripts/scanner-app/lib/server-client.js`
- `scripts/scanner-app/lib/state.js`
- `scripts/scanner-app/lib/watcher.js`
- `scripts/scanner-app/main.js`
- `scripts/scanner-app/renderer/app.js`
- `scripts/scanner-app/renderer/index.html`
- `scripts/scanner-app/renderer/styles.css`
- `migrations/0094_scanner_capture_physical_release.sql`
- `scripts/db/lint-destructive-sql.ts`
- `scripts/db/migrate.ts`
- `migrations/0096_partner_card_job_void_management_audit.sql`
- `migrations/rollback-0096-partner-card-job-void-management-audit.sql`
- `scripts/scanner-app/lib/lide400-controller.js`
- `scripts/scanner-app/package.json`
- `scripts/scanner-app/scripts/package-macos.js`
- `scripts/scanner-app/scripts/verify-package.js`
- `scripts/scanner-app/scripts/control-plane-load-sim.js`

## Included tests

- `scripts/scanner-app/test/server-client-tiff-upload.test.js`
- `scripts/scanner-app/test/station-active-card.test.js`
- `tests/partner-card-job-grading-bridge.test.ts`
- `tests/partner-card-job-cancellation.test.ts`
- `tests/scanner-front-before-back.test.ts`
- `tests/scanner-station-capture-boundary.test.ts`
- `tests/scanner-evidence-staging-service.integration.test.ts`
- `tests/partner-schema-parity.test.ts`
- `tests/db-migration-safety.test.ts`
- `tests/scanner-physical-release-migration.test.ts`
- `tests/partner-core-release-blockers.test.ts`
- `tests/partner-management-ux.test.ts`
- `scripts/scanner-app/test/scanner-packaging.test.js`
- `scripts/scanner-app/test/control-plane-load-sim.test.js`
- Fixture updates in partner Card Job/output/reconciliation/pilot helper tests for `physical_released`.

## Behavioural changes

1. A station may release the physical Canon target after a safe TIFF has been durably queued and the server has minted a direct staging upload task.
2. Released upload/finalisation work remains bound to the same station/Card Job/MV/certificate/side and cannot unlock another card.
3. BACK may be armed while FRONT uploads, but READY_TO_GRADE still requires immutable FRONT and BACK evidence.
4. Upload/finalisation retries are idempotent and must reconcile post-evidence side effects before the Scanner deletes local work.
5. Lost-local-TIFF recovery is fail-closed unless the server proves terminal failure or accepted evidence.
6. Cancellation and arming share a per-certificate transaction advisory lock.
7. Generic Partner browser station arming cannot request recapture; repair must use the exact-side invalidation/FIX authority.
8. The destructive-SQL linter and migration runner allow `0094` only when the exact protected
   create-before-drop index replacement is present; the generic `DROP INDEX` rule remains blocked.
9. The Scanner package path builds an unsigned production-shaped `.app` with the native bridge
   compiled at package time and verified as a nested executable, so Partner Macs do not need Node,
   npm, Git, Xcode, clang, Command Line Tools, or a source checkout for the packaged runtime.
10. The destructive-SQL linter and migration runner allow `0096` only when the exact protected
    `partner_management_audit` CHECK replacement preserves the prior 0084 vocabulary and adds
    `partner_card_job_voided`; generic `DROP CONSTRAINT` remains blocked.
11. The owner-independent control-plane simulator covers 5k/10k workflow runs, 20k event bursts,
    reordered side finalisation, network retries, stale preview, cross-MV/cross-side/cross-tenant/
    cross-station attacks, zero-credit attempts, and independent upload progress samples.

## Staging status

- `0094_scanner_capture_physical_release.sql` has been applied to staging only through scoped
  migration mode; post-apply index/data checks were clean.
- The SFAP-015 successor has been deployed to `mintvault-v2`; Fly health checks and `/health` passed.
- Commit `87366650` has been deployed to `mintvault-v2` as Fly version 508; `/api/version` reports
  `87366650`; `/health` passed.
- `0096_partner_card_job_void_management_audit.sql` has been applied to staging only through scoped
  migration mode; journal 84→85, checksum `c927209413365215222a7b1093d9a647fb3855fec0bfb416a3d80b861d7ccf46`.
- Production was not targeted by this scanner pass. Read-only reconciliation observed a separate
  production release; production has no scanner `0094` or `0096` journal row and no
  `scanner_capture_sessions.physical_released` column.

## Exclusions

- No grading maths change.
- No immutable TIFF master mutation.
- No live Stripe payment.
- No production mutation.
- No physical Canon run.
- No signed/notarised Scanner build. An unsigned local production-shaped `.app` exists and passed
  package verification; Developer ID/notary credentials were unavailable (`0 valid identities found`).
- Staging physical acceptance is not complete until the owner runs the Canon Scanner script against
  the staging deployment.
