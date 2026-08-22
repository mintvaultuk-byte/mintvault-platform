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

The 2026-08-19 final acceptance continuation accepted three verified, owner-specified auth/station
security repairs (`SFAP-020` through `022`) for implementation. Stripe TEST acceptance remains
fail-closed pending owner commercial/environment configuration (`SFAP-023`).

The same pass repaired the local physical-scan durability barrier (`SFAP-024`): an fsync-confirmed
journal now precedes ICA acquisition, and an interrupted journal can retain exactly one discovered
TIFF only as an upload-refused recovery candidate.

The current pass removed the normal post-scan `ACCEPT`/`RESCAN` branch for locally safe captures:
a GREEN placement plus explicit `SCAN` is now the operator acceptance, the TIFF auto-enters upload
after local frame safety, the preview remains visible during upload, byte-level upload progress is
propagated from the direct staging stream, and a scan countdown is shown only from this station's
measured rolling timings. The remaining `SFAP-015` blocker is narrower and still real: BACK is not
armed/preparable while FRONT upload/finalisation is unresolved, because the server currently holds
one live station session and finalisation requires immutable FRONT evidence before BACK.

## Evidence

- Focused scanner suite: 71 passed, 0 failed.
- Focused Scanner workflow gate for this pass: 84 passed, 0 failed.
- Full scanner suite: 164 passed, 0 failed.
- `npm run check`: passed.
- `git diff --check`: passed.
- Changed-file ESLint for this pass: 0 errors, 116 pre-existing warnings.
- Repository-wide ESLint: baseline-red with 1,626 errors / 5,773 warnings across unrelated files and nested `.claude/worktrees`; not a clean release gate.
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
- Staging deployment proof: release **504** deployed commit `78d5bb34` from a detached clean
  worktree. Both `lhr` machines have passing health checks; `/api/version` reports `78d5bb34` and
  `/health` reports `ok`. An initial release 503 lacked the documented `GIT_SHA` build argument and
  therefore reported `unknown`; it was immediately replaced and is not accepted as evidence.
  Production remains on `36699531` and was only read.
- Read-only staging wallet aggregate: 4 wallets, 1 at zero availability, 3 positive, aggregate
  availability 601. This proves a zero-credit staging state but not the running Scanner modal,
  because no authorised station session is available in this browser.
- The anonymous zero row is ledger/reserved/available 0/0/0. Staging has 18 active reservations
  (18 credits), 3 consumed reservations (3 credits), and Card Jobs: 1 `CAPTURING`, 12
  `NEEDS_SCAN`, 1 `QA_REVIEW`, 5 `READY_TO_GRADE`; all are read-only aggregates.
- Full-suite baseline provenance: `partner-management-ux` fails because `HEAD f024f938` already
  contains `partner_card_job_voided` without a matching audit-constraint migration. This package
  did not create that condition; it is a separately scoped follow-up, not a reason to weaken tests.

## Next authorised action

Use an authorised staging grader session to inspect an existing Scanner capture at 12× on FRONT and
BACK, recording the visible source identity and image dimensions. Do not configure Stripe, make a
payment, restart the Scanner, or touch production.

# 2026-08-19 — final credit UX acceptance repair pass

- Review gate completed with three independent read-only audits (Scanner UX, wallet/reservation,
  Stripe Checkout). They found SFAP-021 through SFAP-024; staging deployment is held until each has
  a local regression and hostile review pass.
- Staging schema inventory was read-only against `ep-purple-voice-abfez796`: the existing
  `partner_credit_checkout_sessions` table has the 0097 columns exactly (no operation/snapshot
  fields yet). No wallet, Partner, Stripe, card-job, Oliver, Pilot, or MV280 data was read or
  changed.
- Current staging was independently reconciled as release v519, serving `e5ca7b4b`; no production
  action is authorised by this pass.
