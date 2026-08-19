# Task ledger — partner scanner final programme (2026-08-19)

## Stage 0 baseline

- **Repository:** `/Users/cornelius/mintvault-platform`
- **Branch / HEAD:** `fix/canonical-card-detector-20260817` / `fd89f225105e41e140cee10700907358c59df1ae`
- **Origin main:** `f64e67fbfd9e8b5a5b647dd78265ada4478b485d`
- **Staging / production read-only versions:** `f024f938` / `36699531`
- **Scope:** scanner runtime, capture lifecycle, fixed profile, preview/queue UX, Card Job/evidence binding, partner credits UX, Stripe TEST readiness, recovery, viewer evidence contract, packaging, and staging readiness.
- **Prohibited:** production mutation; live Stripe; secret/auth/payment/protected-MVGS edits without a separate owner approval; destructive data operation; overwrite/reset of pre-existing dirty work.
- **Dirty baseline:** pre-existing scanner/viewer/server/test changes. Preserve and reconcile before editing.

## Current stage

Stage 7 protected repair set complete. Three non-overlapping read-only reviews were received and
personally reconciled by the Lead. The task now has four locally proven repairs, including the two
explicitly owner-approved protected changes. The owner-authorised, additive staging-only migration
has been applied; production remains untouched.

## Evidence

- Focused scanner suite: 71 passed, 0 failed.
- Full scanner suite: 161 passed, 0 failed.
- `npm run check`: passed.
- `git diff --check`: passed.
- Changed-file ESLint: 0 errors, 44 pre-existing warnings.
- Repository-wide ESLint: baseline-red with 1,626 errors / 5,769 warnings across unrelated files and nested `.claude/worktrees`; not a clean release gate.
- Protected repair focused/wider gate: 97 passed, 0 failed across FRONT/BACK full-resolution pixel
  source contract, real-PostgreSQL Price/currency/environment/replay grant authority, concurrent
  NEW boundary, migration parity/migrator proof, Stripe environment isolation, and grading inspection.
- Staging migration proof: the runner dry-ran and then applied **only**
  `0093_partner_credit_pack_currency.sql` in convergence mode. Journal count moved 82 → 83 with
  checksum `3f85bfcd4521482a61e0dfab0c77359e4486c9bbe6c1db36f5d0ae152f9283c2`; the nullable
  `stripe_currency` column now exists. The five active packs retain null Price IDs and currencies,
  so staging grants remain fail-closed. No wallet, ledger, Card Job, Stripe configuration/payment,
  secret, or production database was changed.
- Focused lint over the protected repair files: 0 errors; 24 pre-existing warnings in legacy
  viewer/webhook/Stripe files.
- Targeted hostile-review repairs: 139 focused viewer/payment/migration/station tests passed; the
  production build passed. The viewer now visibly labels a legacy fallback as legacy, and 0093 is
  additive-only (no destructive constraint drop).
- Full-suite baseline provenance: `partner-management-ux` fails because `HEAD f024f938` already
  contains `partner_card_job_voided` without a matching audit-constraint migration. This package
  did not create that condition; it is a separately scoped follow-up, not a reason to weaken tests.

## Next authorised action

Deploy the exact reconciled commit to staging from a clean worktree and verify release health and
version. Do not configure Stripe, make a payment, restart the Scanner, or touch production.
