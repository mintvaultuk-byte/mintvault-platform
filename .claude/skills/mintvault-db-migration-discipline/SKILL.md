---
name: mintvault-db-migration-discipline
description: Use this skill BEFORE writing or dispatching any MintVault database work — a migration, schema change, column add/rename/drop, index, backfill, or anything that reads or allocates cert numbers. Fires whenever a Claude Code prompt will touch shared/schema.ts, a migrate function, ADD COLUMN / CREATE INDEX, a backfill UPDATE, or the cert_counter / certificate_number columns. Also fires before ANY prod deploy that carries a migration. The skill enforces: inventory the live DB columns first, validate the actual SQL against the live DB (not just tsc), check cert_counter before cert work, and never assume staging and prod schemas match. Without this skill, MintVault has repeatedly shipped migrations that silently collided with existing columns, SQL that type-checked but referenced non-existent columns and 500'd at runtime, and a desynced cert_counter that would 500 the next allocation. Fire on every DB-touching task — over-firing costs one psql query; under-firing costs a prod incident.
---

# MintVault DB migration discipline

This skill exists because every database bug this session came from the same gap: trusting that a migration ran, that a column exists, or that staging and prod match — without checking the live database. The failures were:

- **Silent column collision.** `ADD COLUMN IF NOT EXISTS grader_status` is a **no-op** if the column already exists — it does NOT error, does NOT update the type/default, and the migration audit row still gets written. Prod was already on grader-v2 with `grader_status` present; only a live `information_schema` check revealed it.
- **SQL that type-checks but 500s.** A query referencing `cert.cert_id` compiled clean under `tsc` and then threw at runtime because the real column is `certificate_number`. TypeScript does not know your Postgres schema. This bug appeared **four times** in different functions before it was swept.
- **cert_counter desync.** Staging's `cert_counter.last_issued` was 203 while the max issued cert was MV206 — the next allocation would have collided/500'd. Prod was healthy (165 == 165) but only because it was checked.

The locked rule behind this skill: **web-search UK regulatory questions rather than guessing, and validate every schema assumption against the live DB rather than assuming.**

## When this skill fires

Fire automatically when ANY of these is true:

- A prompt will edit `shared/schema.ts`, any `migrate*()` function, or run raw DDL
- The work contains `ADD COLUMN`, `DROP COLUMN`, `ALTER`, `CREATE INDEX`, `RENAME`
- A backfill `UPDATE` over a business table is involved
- Anything touches `certificate_number`, `cert_counter`, or allocates a new cert
- A prod deploy is being prepared that carries any migration
- A new endpoint runs SQL against a table whose columns you have not personally confirmed exist

If in doubt, fire. The cost is one read-only `psql` query.

## The protocol — five checks, in order

### Check 1 — Inventory the live DB columns FIRST (the target DB, not your memory)

Before writing the migration, query the actual target database:

    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = '<table>'
    ORDER BY ordinal_position;

If a column you intend to add already exists, the migration is a no-op for it — confirm its **type and default already match** what the code expects, or you ship a column that's silently wrong. Report the actual column list before proceeding.

### Check 2 — ADD COLUMN IF NOT EXISTS is SILENT on collision

Never read "migration ran, audit row written" as "the column is correct." A collision writes the audit row and changes nothing. After any additive migration, **verify the column exists with the expected type/default** via Check 1 — do not infer it from the migration returning success.

### Check 3 — Validate the actual SQL against the live DB (tsc is not enough)

`npm run check` passing means the TypeScript compiles. It says **nothing** about whether the columns the query references exist. Before shipping any new query:

- Grep the query's column names against the real schema (Check 1 output), OR
- Run the query (or an `EXPLAIN`) against staging read-only and confirm it does not throw

The canonical trap: `cert.cert_id` (does not exist) vs `certificate_number` (real). Sweep ALL occurrences with a word-boundary grep, including dead/unrouted functions, because the next refactor may route them:

    grep -rnE "\bcert_id\b|\.cert_id\b" server/ --include="*.ts"

### Check 4 — cert_counter before any cert-allocating work

Before shipping anything that issues a cert number:

    SELECT last_issued FROM cert_counter WHERE id = 1;
    SELECT MAX((regexp_replace(certificate_number,'\D','','g'))::int)
    FROM certificates WHERE certificate_number ~ '^MV[0-9]+$';

If `last_issued < max_mv`, the counter is desynced and the next allocation will collide/500. Fix it atomically BEFORE the deploy:

    UPDATE cert_counter
    SET last_issued = (SELECT MAX((regexp_replace(certificate_number,'\D','','g'))::int)
                       FROM certificates WHERE certificate_number ~ '^MV[0-9]+$') + 1
    WHERE id = 1;

### Check 5 — Prod and staging are different databases; check the target

Prod Neon is `ep-wispy-morning-ab6f4o08`; staging is `ep-purple-voice-abfez796`. They diverge — a concurrent session can migrate one and not the other. **Run Checks 1–4 against the database you are about to deploy to**, never against staging as a proxy for prod. Confirm the host in the connection string before running prod checks, and refuse to run prod mutations if the host is not `ep-wispy-morning`.

## Migration construction rules (locked MintVault standard)

- Idempotent + resume-safe: `IF NOT EXISTS` / `IF EXISTS`, safe to run twice
- Additive-then-cutover for renames; keep a compat view for the 7-day window
- Every backfill: dry-run `SELECT` showing affected rows FIRST, then the `UPDATE`
- Every schema change writes an `audit_log` row (entity_type/entity_id/action/admin_user/details jsonb/created_at)
- Indexes before the writes that need them scale
- Soft-delete only on business tables (`deleted_at`), never hard delete

## What to say to Cornelius when this skill fires

Terse. Report the live-DB findings, not the protocol. Format:

    Live schema (<table>, <db>) — [columns that matter, or collision found]
    SQL validated — [columns exist / mismatch found]
    cert_counter — [N == max MV N, healthy / desync found, fix applied]
    Target DB — [confirmed prod ep-wispy-morning / staging ep-purple-voice]
    Status — [SAFE TO MIGRATE / BLOCKED ON X]

## Anti-patterns — do NOT do these

- **Don't assume a migration ran correctly because it returned success.** `IF NOT EXISTS` collisions are silent.
- **Don't trust `tsc` to catch a wrong column name.** It can't see the DB.
- **Don't run cert work without the cert_counter check.**
- **Don't check staging and deploy to prod.** Different DBs. Check the target.
- **Don't skip dead/unrouted functions in a column-name sweep.** They get routed later.
- **Don't run a prod mutation without confirming the host is `ep-wispy-morning`.**
