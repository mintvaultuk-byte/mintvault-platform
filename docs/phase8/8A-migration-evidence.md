# Phase 8A — Migration preflight & controlled staging application (evidence)

**Branch:** `vq-phase8-staging-integration` (pushed to `origin`, from Phase-7 HEAD `6439350`).
**Target DB:** STAGING only — `ep-purple-voice-abfez796-pooler.eu-west-2.aws.neon.tech` (neondb), PostgreSQL **17.10**. Prod branch (`ep-wispy-morning`) was **never** touched; both apply and verify scripts hard-abort on a non-staging host.
**Applied at:** 2026-07-11T06:55:49Z.

## Migrations applied (staging only, idempotent)

`0008_export_jobs.sql`, `0009_generation_requests.sql`, `0010_artwork_revisions.sql`, `0011_feature_flags.sql` — all additive `CREATE TABLE/INDEX IF NOT EXISTS`. VQ-only; no grading/cert/payment/auth reference; no destructive or lock-heavy (no `CONCURRENTLY`) statement.

## Exact commands

```
npx tsx --env-file=.env scripts/phase8/preflight.ts        # read-only, all green
npx tsx --env-file=.env scripts/phase8/apply-migrations.ts # staging apply (17 statements)
npx tsx --env-file=.env scripts/phase8/verify-schema.ts    # 14/14 pass, test rows cleaned up
```

## Preflight (read-only) — all green

- STAGING identity confirmed (`ep-purple-voice`); prod fragment absent.
- PostgreSQL 17.10; `gen_random_uuid()` available (0008 default); `has_schema_privilege(public, CREATE)` = true (neondb_owner).
- All 4 target tables absent pre-apply.
- No index-name collisions with the 13 new index names.
- 12 pre-existing vq_ tables (Character Bible + core) — none conflicting; the 0007 production tables are not on this staging branch (independent of 0008–0011).

## Post-apply schema verification — 14/14 pass

- 4 tables created; index counts correct (export=6, generation=5, revisions=6 incl. the implicit `r2_key` UNIQUE, flags=1); 5 CHECK constraints present.
- **Durable invariants proven on real Postgres:** `job_id` auto-uuid + `expires_at` default; the **partial-unique idempotency index rejects a 2nd active job for the same key (SQLSTATE 23505)**; the **state CHECK rejects an invalid value (SQLSTATE 23514)**; a re-export IS allowed once the prior job is terminal (partial-unique is active-only). All test rows were deleted by marker.

## Rollback (staging)

Each table is FK-free and isolated; the app degrades gracefully if absent. To roll back staging:

```sql
DROP TABLE IF EXISTS vq_export_jobs;
DROP TABLE IF EXISTS vq_generation_requests;
DROP TABLE IF EXISTS vq_artwork_revisions;
DROP TABLE IF EXISTS vq_feature_flags;
```

## Not done (out of this session's capability)

Production migrations were **not** applied. The live-route wiring (Stages 2–7) and the deployed **multi-machine** acceptance (Stage 8) require a human-operated 2-machine staging **deploy**, which this headless session cannot create or drive — see the Phase 8 report. The substrate is now live on staging, unblocking that wiring when the environment is available.
