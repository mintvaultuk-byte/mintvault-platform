# Database Migration Safety (Phase 0.5)

Operational guide for changing the MintVault database schema safely. This exists because
a routine `drizzle-kit push` against a real database can drop unmanaged live tables
(payments, credits, sessions, subscriptions). These guards make that impossible through
official workflows.

## Golden rules

1. **`db:push` is for a LOCAL/DISPOSABLE database only.** It is blocked against any
   non-local host. There is **no override**.
2. **Production and staging schema changes use numbered migrations only** — never `push`.
3. **Never edit a migration after it has been applied.** The journal stores a checksum; an
   edited applied migration is a hard error.

## The tools

| Command | What it does |
|---|---|
| `npm run db:preflight` | Read-only. Lists every live object (tables, views, matviews, schemas, orphan sequences, enums) and **fails closed** if any is unknown (not managed and not in the classified inventory). |
| `npm run db:lint-sql <file.sql>` | Scans a migration for destructive statements (DROP/TRUNCATE/rename/unqualified DELETE/…). Exits non-zero on a blocking finding. Regex heuristic, not a full parser. |
| `npm run db:migrate` | Dry-run: shows the pending plan, lints, applies nothing. |
| `npm run db:migrate -- --apply` | Applies pending migrations under an advisory lock, recording each in the `schema_migrations` journal. |
| `npm run db:push` | Local-only schema prototyping. Guarded — blocked against non-local hosts. |

Config: `drizzle.config.ts` scopes Drizzle to a **fail-closed allowlist** derived from
`shared/schema.ts` (only managed tables are ever in scope). Vault Quest stays isolated via
`drizzle-vq.config.ts`.

## Creating and shipping a migration

1. **Write** `migrations/NNNN_description.sql` (zero-padded number, unique, ordered). Prefer
   additive, idempotent statements (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).
   For a non-transactional statement (e.g. `CREATE INDEX CONCURRENTLY`), put
   `-- migrate:no-transaction` at the top of the file; it runs outside a transaction and must
   be individually idempotent.
2. **Lint**: `npm run db:lint-sql migrations/NNNN_description.sql`. Resolve any 🚫. A genuinely
   destructive, owner-approved change is applied with `db:migrate -- --apply --allow-destructive`.
3. **Test on a disposable database** (never staging/prod):
   - Stand up a throwaway local Postgres.
   - Point `MINTVAULT_DATABASE_URL` at it (`127.0.0.1`).
   - `npm run db:preflight` (should pass), `npm run db:migrate` (plan), then `-- --apply`.
   - Verify the schema and re-run `-- --apply` to confirm idempotency (applies 0).
4. **Inspect the plan** on the target: `npm run db:migrate` (dry-run) shows exactly what is
   pending. Review it.
5. **Get owner approval** — applying to staging/production is a protected action.
6. **Apply**: with approval, run `npm run db:migrate -- --apply` against the target. The
   advisory lock prevents two concurrent runners from double-applying.
7. **Verify**: re-run `npm run db:preflight` and confirm the change is present and the journal
   row shows `status = applied` with a `completed_at`.

## After a failed migration (roll forward)

Transaction-safe migrations roll back automatically on error (nothing is journaled). For a
non-transactional migration that failed mid-way, the journal row is left `status = failed` and
the runner refuses to proceed until it is resolved:

1. Inspect what actually landed (`db:preflight`, manual `\d`).
2. Make the migration idempotent so re-running is safe, or write a follow-up migration that
   completes the change.
3. Delete or fix the `failed` journal row only after the database is in a known-good state.
4. Re-run `npm run db:migrate -- --apply`.

Application/deploy rollback is unchanged (image-pin redeploy via `scripts/safe-deploy.sh`).
For a data-destructive forward change, rely on Neon point-in-time recovery — **confirm PITR is
enabled first**.

## Why editing an applied migration is prohibited

The journal stores each migration's SHA-256 checksum. If a file's content changes after it was
applied, the checksum no longer matches and the runner stops with a hard error. This prevents a
silent divergence where two environments ran different SQL under the same filename. To change
something already shipped, write a **new** migration.

## `schema_migrations` journal

Columns: `filename` (unique), `checksum` (sha256), `started_at`, `completed_at`, `status`
(`applied` / `applying` / `failed`), `applied_by`. The runner bootstraps the table itself
(`CREATE TABLE IF NOT EXISTS` + additive `ALTER`s) — there is no chicken-and-egg migration for
the journal.

## Emergency procedure

If a schema change is causing an incident:

1. **Do not** attempt `db:push` against prod — it is blocked and would be the wrong tool anyway.
2. Roll the application back (image-pin redeploy) if the app is the problem.
3. If the schema itself is wrong, write and apply a corrective **numbered migration**
   (additive/reversing), or use Neon point-in-time recovery for data loss.
4. Record the incident per the controlled-code-lead governance.

## Honest limitations

- The destructive-SQL linter is a **regex heuristic**, not a PostgreSQL parser. It catches the
  common destructive statements and ignores keywords inside comments/strings/dollar-quoted
  bodies, but it is a safety net, not a proof of safety.
- The host guard classifies "local vs not local"; it does not distinguish staging from
  production (both are non-local and both are blocked for `push`, which is the intended
  behaviour).
- No production hostname, credential, or connection string appears in any of these tools or in
  this document.
