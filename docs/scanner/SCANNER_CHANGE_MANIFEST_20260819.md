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
- `scripts/scanner-app/scripts/payment-credit-load-sim.js`
- `scripts/payment-control-plane-load-sim.mjs`
- `package.json`
- `server/partner/credit-purchase-service.ts`
- `server/partner/permissions.ts`
- `server/partner/routes.ts`
- `client/src/lib/partner-api.ts`
- `client/src/pages/partner/billing.tsx`
- `migrations/0097_partner_credit_checkout_sessions.sql`
- `migrations/rollback-0097-partner-credit-checkout-sessions.sql`
- `migrations/0098_scanner_operator_credit_view.sql`
- `migrations/rollback-0098-scanner-operator-credit-view.sql`

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
- `scripts/scanner-app/test/payment-credit-load-sim.test.js`
- `tests/payment-control-plane-load-sim.test.ts`
- `tests/partner-credit-purchase.test.ts`
- `tests/partner-credit-presentation.test.ts`
- `tests/partner-at21-grant-boundary.test.ts`
- `tests/partner-rbac-parity.test.ts`
- `tests/partner-scanner-operator-role.test.ts`
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
12. Partner credit Checkout now requires declared deployment Stripe mode before a Session can be
    created; staging refuses LIVE mode and production refuses TEST mode.
13. Checkout validates the configured Stripe Price ID, currency, active state and livemode before a
    buyer can reach Stripe.
14. The verified webhook must match a locally recorded server-created Checkout intent
    (`0097_partner_credit_checkout_sessions.sql`) for the same tenant, pack, Price, currency and
    Stripe mode before the append-only ledger can grant purchase credits.
15. The purchase ledger append and Checkout-intent `created -> granted` transition share one
    partner-admin transaction, so transaction failure remains safely retryable and same-session
    distinct-event replay grants zero.
16. The payment/top-up load simulators cover 5k/10k/20k workflows, 20k hostile/replay bursts,
    zero-credit lock/unlock, browser redirect no-grant, wrong Price/currency/environment, incomplete
    payment, unverified Checkout, missing intent, wrong tenant, duplicate event and retryable
    transaction failure.
17. The owner-locked commercial model is now explicit in source: £10/credit, GBP, VAT included,
    and packs 5/10/25/50/100 at £50/£100/£250/£500/£1,000.
18. Noncanonical active pack rows are not silently priced; they are ignored/refused rather than used
    as a fallback authority.
19. Checkout and webhook fulfilment validate Stripe amount and reject `tax_behavior='exclusive'` so
    a misconfigured Price cannot double-charge VAT.
20. `SCANNER_OPERATOR` can read credit/packs through additive `partner.credits.view` only; purchase
    and admin rights remain absent.
21. `MVGS_ASSESSMENT_TECHNICIAN` is explicitly refused credit purchase even if a purchase permission
    is accidentally present.

## Staging status

- `0094_scanner_capture_physical_release.sql` has been applied to staging only through scoped
  migration mode; post-apply index/data checks were clean.
- The SFAP-015 successor has been deployed to `mintvault-v2`; Fly health checks and `/health` passed.
- Final commit `c3e1c295` has been deployed to `mintvault-v2` as Fly version 509; `/api/version`
  reports `c3e1c295`; `/health` passed.
- `0096_partner_card_job_void_management_audit.sql` has been applied to staging only through scoped
  migration mode; journal 84→85, checksum `c927209413365215222a7b1093d9a647fb3855fec0bfb416a3d80b861d7ccf46`.
- Commit `e6b82b2d` was deployed to `mintvault-v2` from a detached clean worktree; `/api/version`
  reports `e6b82b2d`; `/health` passed.
- Staging Fly version 514 is healthy on both `lhr` machines after setting `STRIPE_ENV=test`.
- `0097_partner_credit_checkout_sessions.sql` was applied in scoped convergence mode; checksum
  `c1039b6fbe3bf9d58ba52f3dc9a34cc2d294fe620918cf881a700561ba87644a`; journal 85→86.
- `0098_scanner_operator_credit_view.sql` was applied in scoped convergence mode; checksum
  `55e27da14c2343a7eae3a73f39836e5bcd20676122f71b4166a7f2721258d313`; journal 86→87.
- Current staging payment config remains fail-closed: `STRIPE_ENV=test` is declared and TEST-shaped
  Stripe keys are present, but the TEST secret returns `api_key_expired`, so the five credit packs
  still have no canonical TEST Price IDs/currency and no real TEST Checkout/webhook proof exists.
- Production was not targeted by this scanner pass. Read-only reconciliation observed a separate
  production release; production has no scanner `0094` or `0096` journal row and no
  `scanner_capture_sessions.physical_released` column.

## Exclusions

- No grading maths change.
- No immutable TIFF master mutation.
- No live Stripe payment.
- No invented Stripe prices, VAT treatment, or manual wallet-balance edit.
- No production mutation.
- No physical Canon run.
- No signed/notarised Scanner build. An unsigned local production-shaped `.app` exists and passed
  package verification; Developer ID/notary credentials were unavailable (`0 valid identities found`).
- Staging physical acceptance is not complete until the owner runs the Canon Scanner script against
  the staging deployment.
