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

## Included tests

- `scripts/scanner-app/test/server-client-tiff-upload.test.js`
- `scripts/scanner-app/test/station-active-card.test.js`
- `tests/partner-card-job-grading-bridge.test.ts`
- `tests/partner-card-job-cancellation.test.ts`
- `tests/scanner-front-before-back.test.ts`
- `tests/scanner-station-capture-boundary.test.ts`
- `tests/scanner-evidence-staging-service.integration.test.ts`
- `tests/partner-schema-parity.test.ts`
- Fixture updates in partner Card Job/output/reconciliation/pilot helper tests for `physical_released`.

## Behavioural changes

1. A station may release the physical Canon target after a safe TIFF has been durably queued and the server has minted a direct staging upload task.
2. Released upload/finalisation work remains bound to the same station/Card Job/MV/certificate/side and cannot unlock another card.
3. BACK may be armed while FRONT uploads, but READY_TO_GRADE still requires immutable FRONT and BACK evidence.
4. Upload/finalisation retries are idempotent and must reconcile post-evidence side effects before the Scanner deletes local work.
5. Lost-local-TIFF recovery is fail-closed unless the server proves terminal failure or accepted evidence.
6. Cancellation and arming share a per-certificate transaction advisory lock.
7. Generic Partner browser station arming cannot request recapture; repair must use the exact-side invalidation/FIX authority.

## Exclusions

- No grading maths change.
- No immutable TIFF master mutation.
- No live Stripe payment.
- No production mutation.
- No physical Canon run.
- No packaged/notarised Scanner build.
- No staging deploy in this pass because `0094` is intentionally blocked by migration safety until protected index replacement is approved.
