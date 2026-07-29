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

| Command                          | What it does                                                                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run db:preflight`           | Read-only. Lists every live object (tables, views, matviews, schemas, orphan sequences, enums) and **fails closed** if any is unknown (not managed and not in the classified inventory). |
| `npm run db:lint-sql <file.sql>` | Scans a migration for destructive statements (DROP/TRUNCATE/rename/unqualified DELETE/…). Exits non-zero on a blocking finding. Regex heuristic, not a full parser.                      |
| `npm run db:migrate`             | Dry-run: shows the pending plan, lints, applies nothing.                                                                                                                                 |
| `npm run db:migrate -- --apply`  | Applies pending migrations under an advisory lock, recording each in the `schema_migrations` journal.                                                                                    |
| `npm run db:push`                | Local-only schema prototyping. Guarded — blocked against non-local hosts.                                                                                                                |

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

## Partner Network — SECURITY DEFINER definer role (migration 0006, DB-F1)

The Partner Portal pre-auth lookups (`partner_auth_lookup`, `partner_session_lookup`,
`partner_reset_token_tenant`) run **before** any tenant context exists, under `FORCE ROW LEVEL
SECURITY`. They only return rows because they are `SECURITY DEFINER` **owned by a dedicated
BYPASSRLS role, `partner_definer`** — never by the runtime role and never by a superuser. If that
ownership model is broken, partner login silently fails closed (returns nothing).

**Provisioning requirement (one-time, elevated).** Creating a `BYPASSRLS` role requires the applying
role to be a superuser, or to hold `CREATEROLE` + `BYPASSRLS`. On managed Postgres (Neon) the
standard migration role may not have this. In that case, provision `partner_definer` **once** with an
elevated role before applying `0006`, and grant the migration role membership so it can reassign
function ownership:

```sql
CREATE ROLE partner_definer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;
GRANT partner_definer TO <migration_role>;
```

Migration `0006` then reconciles the role, transfers ownership of exactly the three functions, and
**fails closed** (aborts) if `partner_definer` is missing or misconfigured. The running Partner
Portal needs **no** elevated privilege — `partner_runtime` stays `NOSUPERUSER`/`NOBYPASSRLS` with
EXECUTE-only. `npm run db:preflight` and the Partner Portal startup check both re-assert the model
and refuse a broken configuration.

## Partner Network — G6D deployment-owner migration (0019)

`0027_partner_submission_credit_lifecycle.sql` has a stricter, intentional migration-time
requirement than ordinary Partner migrations. It provisions and transfers ownership of five
`SECURITY DEFINER` functions to the no-login `partner_credit_lifecycle_definer` role, which has
`BYPASSRLS` only because the narrow connector release path must cross `FORCE ROW LEVEL SECURITY`
after it validates its tenant and linkage inputs.

The numbered migration runner uses the identity in `MINTVAULT_DATABASE_URL`; therefore the
controlled deployment that applies 0019 must use the database/deployment owner (or an equivalently
authorised owner identity) that can create and revoke the temporary membership in that definer role.
An ordinary application connection, `partner_runtime`, `partner_connector_runtime`, or a restricted
migration login must never be elevated to make this work. PostgreSQL 16+ records role-membership
grantors, so a login that merely received the membership from another operator cannot necessarily
revoke it atomically; 0019 fails closed rather than leaving a `SET ROLE` path behind.

The required operational sequence is:

1. An approved elevated operator pre-provisions `partner_credit_lifecycle_definer` as `NOLOGIN`,
   `NOSUPERUSER`, `NOCREATEROLE`, `NOCREATEDB`, `NOREPLICATION`, `BYPASSRLS` if the managed service
   prevents its creation by the deployment owner.
2. The deployment owner runs the numbered migration runner in a controlled maintenance window.
   Migration 0019 is transactional; its temporary membership and `CREATE` privilege are revoked
   before commit.
3. Verify the journal records 0019 as `applied`, the release function is owned by the no-login
   definer, the deployment/migration login has no membership in that definer, and the connector
   role has only the narrow function `EXECUTE` grant.
4. Before a staging or production run, prove the actual configured runner identity can complete this
   sequence in a disposable service-equivalent database. Do not discover a permission mismatch on a
   shared or live database.

The realistic test helper mirrors this split: ordinary migrations run as the non-superuser
`pn_migrator`; 0019 runs only in its disposable deployment-owner phase; restricted runtime roles
remain unable to create schema objects or directly mutate accounting tables.

## Partner Network — choosing the rollback script (DB-F2)

- **Full Phase-1 rollback (0001–0006):** use `migrations/rollback-partner-network-phase1.sql`. It
  drops all `partner_*` tables + functions, both roles (`partner_definer`, `partner_runtime`) and all
  Phase-1 journal rows, and preserves existing MintVault data. This is the ONLY full-phase rollback.
- **`migrations/rollback-0001-partner-foundation.sql` is a 0001-ONLY rollback.** It now **refuses to
  run** (raises) if any later Partner migration (0002–0006) is applied, so it can no longer be
  mistaken for a full-phase rollback.
- Both rollback scripts have no numeric prefix, so the migration runner never executes them as
  forward migrations, and the destructive-SQL linter blocks them if pointed at them directly. Run a
  rollback only as an explicit, owner-approved action, rehearsed on a disposable DB first.
- Both scripts are wrapped in a single `BEGIN … COMMIT` transaction, so the 0001-only refuse-guard
  aborts the whole script even under `psql -f` with its default `ON_ERROR_STOP=off` (every statement
  after the raise then errors and COMMIT rolls back). Still, run rollbacks with
  `psql -v ON_ERROR_STOP=1 -f <script>` so any unexpected error also stops immediately.

## Partner Network — known operational prerequisites (documented, not defects)

- **Rate limiting** (`server/partner/rate-limit.ts`) uses an in-process store by default. Before
  enabling the portal on more than one machine, inject a shared (Postgres/Redis) store via
  `setPartnerRateLimitStore`, or per-instance limits multiply. Tracked as a launch precondition.
- **Password-reset request latency** is dominated by the awaited delivery call on the positive path;
  a future hardening should move delivery off the request path to fully remove the timing signal.
