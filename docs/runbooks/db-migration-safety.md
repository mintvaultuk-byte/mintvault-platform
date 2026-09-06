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
| `npm run db:migrate`             | Dry-run through `MINTVAULT_MIGRATION_DATABASE_URL`: shows the pending plan, lints, applies nothing.                                                                                      |
| `npm run db:migrate -- --apply`  | Applies pending migrations through the separately held migration credential under an advisory lock, recording each in the `schema_migrations` journal.                                   |
| `npm run db:push`                | Local-only schema prototyping. Guarded — blocked against non-local hosts.                                                                                                                |

Config: `drizzle.config.ts` scopes Drizzle to a **fail-closed allowlist** derived from
`shared/schema.ts` (only managed tables are ever in scope). Vault Quest stays isolated via
`drizzle-vq.config.ts`.

## Production image one-off runner

The production Docker image includes the numbered migration runner as:

```sh
node /app/dist/migrate.cjs
```

The image also includes the numbered SQL inventory at `/app/migrations`. Only
`migrations/<four-or-more-digits>_*.sql` files are copied into that image path; rollback scripts and legacy
unnumbered SQL files are intentionally excluded because the runner never executes them and rollback
remains an explicit owner-approved operation.

Vault Quest has a separate numbered inventory at `/app/migrations-vq` and the
closed `--estate vault-quest` runner profile. Main remains the default. VQ uses
`drizzle.vq_schema_migrations` and a separate advisory lock; a main journal row
never satisfies a VQ requirement. Run main migrations first so `mintvault_app`
exists before VQ's additive role/grant authority. Image CI applies and replays
the bundled VQ runner and compares its own SQL checksums to completed journal rows.
Shipping source inventory alone is not runtime-readiness or deployment proof.

For a fresh, separately owner-approved VQ target, retain a dry-run before apply:

```sh
node /app/dist/migrate.cjs --estate vault-quest
node /app/dist/migrate.cjs --estate vault-quest --apply
```

An existing unjournalled VQ schema must **not** replay old SQL. The explicit
`--estate vault-quest --historical-baseline-v1 --apply` admission mode requires the
exact immutable0000–0015 source digest and structural fingerprint, no existing VQ
control metadata, and the restricted main-owned role. It executes only0016 and
records one observed-schema receipt; the old16 files are attested, never reported
as executed. Review the exact catalog/lineage/role checks and target evidence first.
Quiesce application writers and competing operator DDL through admission. Refusal
requires investigation/forward repair, not deleting metadata, editing old SQL or
hand-inserting journal rows. This documentation grants no target execution approval.

Normal application startup is unchanged:

```sh
node dist/index.cjs
```

There is no `release_command`, and migrations do not run when the web server starts.

`MINTVAULT_DATABASE_URL` is the restricted web LOGIN and is never accepted as production migration
authority. The migration runner requires a distinct `MINTVAULT_MIGRATION_DATABASE_URL`. That secret
must not be installed on the public web app: release readiness rejects a production web process
that can see it.

Run production/staging migrations only from an owner-approved, separately scoped execution
environment using an exact reviewed image ref. A protected GitHub Environment or dedicated
migration app are acceptable patterns, provided the environment holds only its target's migration
secret, requires an independent reviewer before apply, locks concurrent runs, verifies the exact
default-branch SHA, and retains the dry-run/apply evidence. These controls and secrets are external
release gates until their configuration is independently evidenced; this repository does not claim
they exist and no autonomous agent may create or invoke them.

First production execution must be a dry-run, reviewed by the operator, and only then applied.

Illustrative dry-run shape, not to be run until the protected execution environment is independently
reviewed (the privileged URL is injected there, never copied from the web app):

```sh
MINTVAULT_MIGRATION_DATABASE_URL=<protected-environment-injection> \
  node /app/dist/migrate.cjs
```

After the retained dry-run is reviewed and the protected apply environment is approved:

```sh
MINTVAULT_MIGRATION_DATABASE_URL=<protected-environment-injection> \
  node /app/dist/migrate.cjs --apply
```

Pre-run evidence to capture without secret values:

```sh
exact default-branch commit SHA
exact reviewed image digest / embedded commit
protected environment name and approval record
dry-run artifact and migration checksums
```

Post-run evidence to capture:

```sh
journal rows/checksums/status/completed_at/applied_by
runner exit status and redacted output
post-migration readiness result from the restricted web LOGIN
```

The migration execution must exit after the runner completes, must never replace or scale web
Machines, and must not be used as a deploy command.

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
   - Point `MINTVAULT_MIGRATION_DATABASE_URL` at it (`127.0.0.1`). Exact-loopback
     `MINTVAULT_DATABASE_URL` fallback exists only under `NODE_ENV=test|development`.
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
