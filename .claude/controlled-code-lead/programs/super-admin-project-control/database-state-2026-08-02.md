# Project Control — verified database state, 2026-08-02

Recorded by direct read-only query against each environment. **This supersedes every earlier
statement in this repository about where migration 0030 is applied.** Two prior documents
contradicted each other and both were wrong in part; the contradiction (audit finding D-3) is
closed by this record.

## Method

- **Staging** — read-only `SELECT` over `schema_migrations` and `information_schema` via the
  local `.env` connection (`ep-purple-voice…`, the staging endpoint).
- **Production** — read-only `SELECT` executed *inside* the `mintvault` Fly container via
  `flyctl ssh console -C`, so the connection string never left the machine and was never printed.
- No write, DDL, migration, or seed was executed against either environment.
- Repository checksum computed with `shasum -a 256 migrations/0030_project_control.sql`.

## Environment matrix

| Environment | Fly app | 0030 journal row | Recorded checksum | pc_* tables | FKs | Triggers | Seed rows | Verdict |
|---|---|---|---|---|---|---|---|---|
| **Staging** | `mintvault-v2` | **APPLIED** — `completed_at` 2026-07-29T16:38:38.636Z, status `applied` | `7d19c87a…d316d4` | **9 / 9** | **9** | 3 | **0 in every table** | **Applied, checksum MATCHES** |
| **Production** | `mintvault` | **ABSENT** (journal holds 23 rows) | — | **0** | — | — | — | **Not applied** |

Repository file checksum: `7d19c87a7bd28d749856f43cccb879f232152a5e1dc4a3076c3195a309d316d4`
(identical in the working tree and at `origin/main`).

Staging journal depth is **29** rows, not the 23 or 24 quoted in earlier documents — 0031–0035
have landed since those were written.

## Consequences — binding

1. **Migration 0030 MUST NOT be edited, ever.** It is applied to staging under a checksum that
   matches the current file. `scripts/db/migrate.ts` treats a checksum mismatch on an
   already-applied file as a hard error and refuses to proceed — which would block *every* future
   migration on staging, not only this one. All further schema change ships as a new numbered
   migration.
2. **The seed has never run anywhere.** All nine tables are empty on staging and absent on
   production. A seed-model change is therefore still fully effective on first application; this
   is the cheapest moment to get the truth model right, and it will not stay cheap.
3. **Production carries no Project Control schema.** Any production activation must apply 0030
   (and anything after it) *before* the application deploys, or Project Control reads will 500.
4. **`rollback-0030-project-control.sql` is safe to correct.** Rollback scripts do not match the
   runner's `^(\d{4,})_.+\.sql$` pattern, are never journalled, and carry no checksum — so
   repairing one cannot disturb the ratchet. This was verified before the repair was made.

## Corrections to earlier records

| Document | Claim | Reality |
|---|---|---|
| `program-ledger.md:213` | "0030 authored, **not applied** to staging or production (both journals hold 23 rows)" | Wrong for staging — applied 2026-07-29, journal now 29 rows. Correct for production. |
| `tasks/partner-user-management-hostile-review/deployment-state.md:30` | "24 journalled, latest `0030_project_control.sql`" | Directionally correct (0030 *is* applied); the count is now 29. |
| `programs/partner-shop-pilot/programme-plan.md:33` | "prod journal lacks 0026/0030/0031/0032" | Confirmed for production. |

## Unrelated finding surfaced during this check

`SUPER_ADMIN_EMAILS` is **absent from both Fly apps** (verified by secret *name* listing only; no
value was read). `superAdminEmails()` therefore falls back to `ADMIN_EMAIL`, and every
authenticated admin session satisfies `requireSuperAdmin`. The Super Admin gate is real protection
against staff, grader, partner and anonymous callers, but it is **not** a second privilege tier
above the admin panel. This is an activation blocker to be decided by the owner, not a code
defect, and it is recorded here so it is not rediscovered a third time.
