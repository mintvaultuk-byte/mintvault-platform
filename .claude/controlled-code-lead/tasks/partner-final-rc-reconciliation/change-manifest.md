# Change manifest — Terra M-1 reconciliation

Class: A (test/harness only). NO production code, NO migration bytes, NO grading logic touched.
Additive only: 60 insertions, 0 deletions across 2 modified files + 1 new file.

## 1. tests/helpers/partner-realistic-db.ts  (MODIFIED, +24)
Add two entries to `APPLICATION_SCOPE_MIGRATIONS`, each with its reasoning inline in the style of
the existing entries:
- `0088_nfc_binding_integrity` — classified on the migration's OWN declaration
  (`SCOPE: APPLICATION (requires certificates)`, migrations/0088:36). Note recorded that it is
  to_regclass-guarded and so would NOT fail in partner scope; it would NO-OP, and a no-op recorded
  as "applied" is a false claim of coverage. Contrast drawn with 0080, which is genuinely
  partner-scope because the partner table it creates is real.
- `0090_lineage_convergence_scanner` — hard `RAISE EXCEPTION` preconditions on core `certificates`,
  plus `ALTER TABLE certificates` and FKs in its inlined body.

## 2. tests/migration-scope-contract.test.ts  (MODIFIED, +36)
STRENGTHENED, never weakened. The pre-existing generic classification guard is untouched; four new
assertions added:
- 0088 pinned application-scope AND its own source banner pinned, so classification and migration
  cannot drift apart.
- 0090 pinned application-scope AND its `RAISE EXCEPTION` precondition pinned.
- both pinned to make `requiresCoreSchema()` return true (the classification is load-bearing, not
  bookkeeping).
- NEGATIVE test asserting on `partnerScopeOnly()` itself, so a future refactor reading a different
  source cannot pass the list assertions while still feeding 0088/0090 to a partner harness.

## 3. tests/lineage-convergence-0090.test.ts  (NEW)
Real-PostgreSQL proof for 0090. Drives the REAL runner (`applyMigrations`, `listMigrationFiles`,
`loadLineageExclusions` from scripts/db/migrate.ts) over the REAL migration bytes with the REAL
migrations/lineage-exclusions.json, on a disposable PostgreSQL 17 cluster (`startPostgres17`).
No parallel migration engine. Covers every point Terra required:
- pre-0090 staging-lineage state built on disposable PG, with an explicit anti-vacuity assertion
  that every object 0090 delivers is ABSENT beforehand
- 0090 applies successfully through the runner; exactly `["0090_…"]` applied
- the three declared collisions are excluded — not applied, not journalled — and the staging
  occupants stay immutable
- converged state asserted from PostgreSQL's catalogue, plus SEMANTIC assertions (the
  one-live-candidate-per-session unique index and the ingest idempotency key actually enforce)
- undeclared identity conflict still aborts the whole run, journal byte-identical, no half-convergence
- REAL declarations proven void without their supersededBy migration (run aborts)
- rerun safety at BOTH levels: runner re-applies nothing, and the 0090 body replayed directly with
  the journal bypassed is a no-op
- 0090 fails closed with no certificates table (ties the new APPLICATION-scope classification to
  real behaviour) and fails closed when the 0044 content it verifies is absent

## Rollback
`git checkout -- tests/helpers/partner-realistic-db.ts tests/migration-scope-contract.test.ts &&
 rm tests/lineage-convergence-0090.test.ts`
Nothing is deployed, no database is mutated, no migration file is edited. Rollback is total.
