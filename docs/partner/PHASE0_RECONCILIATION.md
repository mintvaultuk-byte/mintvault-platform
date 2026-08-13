# P0 — RECONCILIATION REPORT (evidence-based)

Executor: Claude Opus (lead engineer). Date: 2026-08-13.
Programme: `MINTVAULT_PARTNER_MASTER_PLAN_FABLE_v1.1.md` (Version 1.1 (final) — header verified).

Rule applied throughout: **repo/live evidence supersedes any prior document or report**, including the
Plan's own verify-first claims. Every line below is backed by a command that was actually run.

---

## 0.1 Plan document

| Check                                    | Result                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Plan present at the stated worktree path | **NO — plan was NOT in the worktree.** Found at `/Users/cornelius/Downloads/MINTVAULT_PARTNER_MASTER_PLAN_FABLE_v1.1.md` |
| Action taken                             | Copied into the canonical worktree at `MINTVAULT_PARTNER_MASTER_PLAN_FABLE_v1.1.md`                                      |
| Header verified                          | **YES** — `Version 1.1 (final) — 2026-08-13`                                                                             |
| Read in full before any change           | YES (567 lines)                                                                                                          |

---

## 0.2 Worktree and git state

```
pwd                  /Users/cornelius/mintvault-partner-pilot-pass2
git branch --show-current   codex/partner-pilot-pass2
git rev-parse HEAD   cda0622723eda1a3f5037a2feb7bc32d7207f164
git status --short   (clean — no output)
git rev-parse --git-common-dir  /Users/cornelius/mintvault-platform/.git
origin               git@github.com:mintvaultuk-byte/mintvault-platform.git
```

Last 10 commits:

```
cda06227 fix(partner): repair 0077 RLS no-op, fail-loud provenance gate and release guards
9a242c6b fix(partner): complete auth onboarding recovery
6f0d59df fix(partner): queue only captured cards
cd7a37e1 fix(scanner): recover signed station upgrades
f3e90e63 feat(partner): add scoped certificate detail
682b9b27 feat(partner): complete pilot credit-to-print controls
9821fc46 fix(partner): harden pilot grading and station capture
a520b9da fix(migrations): close the pg_temp provenance forge in 0074, and make rollback-0073 re-appliable
77b075a5 fix: make grading results server authoritative
864faded release: sync main to live production (scanner + canonical grading + compact preview)
```

### Ancestry verification (required)

| SHA        | In HEAD ancestry? |
| ---------- | ----------------- |
| `6f0d59df` | **YES**           |
| `9a242c6b` | **YES**           |
| `cda06227` | **YES** (is HEAD) |

`origin/main` = `864fadeda88e06e083bfa483a7fe33520a4570e2` (2026-08-12) — i.e. **main is behind this branch**;
the partner pilot lineage `6f0d59df → 9a242c6b → cda06227` is not yet merged to main.

---

## 0.3 LIVE DEPLOYMENT RECONCILIATION — the critical finding

Queried the running applications directly:

```
GET https://mintvault.fly.dev/api/version
  {"build":"MV-P5-20260225-nohalf","commit":"6f0d59df","timestamp":"2026-08-13T06:34:08Z"}
GET https://mintvault.fly.dev/health          {"status":"ok"}

GET https://mintvault-v2.fly.dev/api/version
  {"build":"MV-P5-20260225-nohalf","commit":"c788fa68","timestamp":"2026-08-13T06:34:09Z"}
```

| Environment                  | Live SHA   | Relationship to local HEAD                                                             |
| ---------------------------- | ---------- | -------------------------------------------------------------------------------------- |
| **Production** (`mintvault`) | `6f0d59df` | **2 commits BEHIND HEAD**                                                              |
| **Staging** (`mintvault-v2`) | `c788fa68` | ancestor of HEAD, older still (2026-08-11, "forward-only lineage convergence at 0073") |
| Local worktree HEAD          | `cda06227` | —                                                                                      |

Commits present locally but **NOT running in production**:

```
cda06227 fix(partner): repair 0077 RLS no-op, fail-loud provenance gate and release guards
9a242c6b fix(partner): complete auth onboarding recovery
```

**Consequence:** every fix in those two commits — including the entire 0077 credential-lifecycle
hardening work and the 0077 RLS no-op repair — is **not live**. Any prior report that treated this
work as delivered to production was wrong.

### Fly topology

| App                      | Machines                                   | State                                                                             |
| ------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------- |
| `mintvault` (prod)       | **2** — `683720eb5127d8`, `83d479c745d0d8` | both `started`, checks 1/1, both on image `deployment-01KZVY0SDPX77YBDVAPXNJNTHR` |
| `mintvault-v2` (staging) | **1** — `d8d14d0f34d378`                   | started, checks 1/1                                                               |

- Production two-Machine minimum: **SATISFIED**, and both Machines serve the same image (no split-brain version).
- Staging has only **one** Machine. **AT-23 (multi-Machine state independence) cannot be executed on staging
  as it stands.** Staging must be scaled to 2 Machines before P14. (Scaling staging _up_ is not a
  prohibited action; the production hold forbids scaling _down/deleting_ prod Machines.)

---

## 0.4 MIGRATION 0077 — ACTUAL STATE

`0077_partner_credential_lifecycle_hardening.sql`

| Question                                                   | Evidence                                                        | Answer                                                    |
| ---------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| Present locally?                                           | `migrations/0077_...sql`, 3750 bytes                            | **YES**                                                   |
| Which commit introduced it?                                | `git log --diff-filter=A`                                       | `9a242c6b` (2026-08-12 23:05)                             |
| Present in the deployed **production** build (`6f0d59df`)? | `git cat-file -e 6f0d59df:migrations/0077_...`                  | **NO — the file does not exist in the production commit** |
| Present in the deployed **staging** build (`c788fa68`)?    | `git cat-file -e c788fa68:migrations/0077_...`                  | **NO**                                                    |
| Applied to the **staging database**?                       | `SELECT ... FROM public.schema_migrations` on `ep-purple-voice` | **NOT APPLIED**                                           |
| Applied to the **production database**?                    | —                                                               | **UNVERIFIED — BLOCKED, see §0.7**                        |

### Staging migration journal (read-only query, `ep-purple-voice-abfez796-pooler`)

- Journal table `public.schema_migrations` exists; columns: `id, filename, checksum, started_at, completed_at, status, applied_by`.
- **62 rows**, all `applied`.
- **Highest applied on staging: `0073_lineage_convergence.sql`** (2026-08-11 20:00:26Z).

**Therefore on staging, migrations 0074, 0075, 0076 and 0077 are ALL UNAPPLIED.**

> The Plan §1 asserts "Applied Partner migrations: 0041, 0042, 0043, 0074, 0075, 0076". That claim is
> **false for staging**. It remains unverified for production. This is exactly the kind of stale claim
> the verify-first rule exists to catch.

---

## 0.5 GLOBAL MIGRATION NUMBER HIGH-WATER MARK

Discovered across **every ref in the repository** (`git log --all --diff-filter=A` over `migrations/`),
not merely this worktree — MintVault has a documented history of number collisions.

- Distinct numbered migration filenames ever authored on any ref: **81**
- **GLOBAL HIGH-WATER MARK = `0077`**
- Staging journal high-water: `0073`
- This worktree's directory high-water: `0077`
- Production journal high-water: **UNVERIFIED (blocked)**

### Confirmed historical collisions (same number, different files)

| Number | Colliding files                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------------- |
| 0019   | `catalogue_manager`, `grading_optimistic_concurrency`, `partner_submission_credit_lifecycle`          |
| 0020   | `partner_auth_invitations_rbac`, `project_control_dashboard`                                          |
| 0033   | `partner_audit_action_precision`, `partner_rbac_seed`                                                 |
| 0044   | `partner_mfa_pending_lifecycle`, `partner_submission_lifecycle_and_location_snapshot`                 |
| 0045   | `partner_grading_work_items`, `partner_stations`                                                      |
| 0046   | `partner_connector_profile_read`, `partner_mfa_pending_lifecycle`, `scanner_processing_jobs`          |
| 0047   | `partner_label_preview_permission`, `partner_owner_invariant_tenants_rls`, `scanner_evidence_staging` |
| 0048   | `grading_review_revision`, `partner_location_snapshot_search_path`                                    |
| 0053   | `cert_counter_monotonic_allocator`, `partner_mfa_failure_lockout`                                     |

**Ruling for this pass:** new migrations start at **`0078`** and go **upward**, and the number is
re-verified against the production journal before any file is created. The migration runner
(`scripts/db/migrate.ts`) independently **rejects duplicate numbers before anything runs**, which is a
real safety net — but it only sees the files in the tree it runs from, so it cannot protect against a
collision authored on another branch. The high-water discipline is still required.

---

## 0.6 TOOLING / ENVIRONMENT FACTS

**Migration runner** — `scripts/db/migrate.ts` (`npm run db:migrate`), 40.9 KB. Verified properties:
journalled with sha256 checksums; deterministic ordering; **duplicate numbers rejected up-front**;
already-applied files skipped; **checksum mismatch on an applied file is a hard failure** (an edited
applied migration fails closed); crashed-run journal rows fail closed; advisory-lock serialisation with
a proven-dedicated backend (it refuses to run through a pooler, and refuses URLs carrying
`host`/`port`/`options`/`servername` routing params); **dry-run is the DEFAULT**, `--apply` required.
This runner is good, and it is the only sanctioned path for staging/production schema change.

**db:push guard** — `scripts/db/db-host-policy.ts` classifies purely on "local vs not local" with **no
bypass env var**; non-local `db:push` is blocked outright.

**Local test infrastructure** — available and already running:

| Port  | Container       | Role                                                              |
| ----- | --------------- | ----------------------------------------------------------------- |
| 55432 | `mv-ci-pg16`    | CI shared test DB (`TEST_DATABASE_URL`, `MINTVAULT_DATABASE_URL`) |
| 55433 | `mv-ci-pg17`    | Partner/RLS/project-control per-suite DBs                         |
| 5432  | native postgres | local                                                             |

CI (`.github/workflows/ci.yml`) defines **54 environment variables**, mostly per-suite Postgres URLs;
many partner suites are `describe.skip` without their specific admin URL. Baseline runs use the exact
CI env so no suite silently skips.

**⚠️ Local `.env` safety note:** `/Users/cornelius/mintvault-platform/.env` sets
`MINTVAULT_DATABASE_URL` to the **staging** Neon branch (`ep-purple-voice`). Any test or script run
with that env would hit staging. All baseline/test runs in this pass **pin `MINTVAULT_DATABASE_URL` to
the local CI Postgres** and abort if it is not a loopback host.

**Secrets divergence (prod vs staging)** — staging carries partner-related secrets that production does
**not**: `PARTNER_ADMIN_DATABASE_URL`, `PARTNER_CONNECTOR_DATABASE_URL`, `PARTNER_PUBLIC_DATABASE_URL`,
`PARTNER_DB_POOL_MAX`, `SUPER_ADMIN_EMAILS`, `ADMIN_PIN`, `PARTNER_WALLET_BACKFILL1_*`,
`PROJECT_CONTROL_*`. Production **does** have `PARTNER_DATABASE_URL` and `PARTNER_MFA_ENC_KEY`.
Whether any absent variable is load-bearing for the Partner surface in production is an open item for
P1 (it bears directly on invariant I18, schema/config readiness).

**Baseline (at HEAD `cda06227`)** — `npm run check` (tsc): **PASS, exit 0, no diagnostics**.
Full vitest baseline: running; recorded in `docs/partner/ACCEPTANCE_EVIDENCE.md` when complete.

---

## 0.7 BLOCKED ITEM (documented, not worked around)

**Reading the production migration journal.** Attempted via
`fly ssh console -a mintvault -C "node -e <SELECT-only script>"`. The command was **denied by the
permission classifier**. It was not retried or circumvented.

- The script was strictly read-only (`SELECT` against `public.schema_migrations`; no DDL, no writes).
- The project controller explicitly permits this: _"Read-only verification is allowed when needed."_
- It matters because the same controller states _"PRODUCTION SCHEMA IS AUTHORITATIVE"_, and because the
  global migration high-water mark is not fully proven without it.

**Owner action required:** approve one read-only production query (or supply the production
`MINTVAULT_DATABASE_URL`/`PARTNER_DATABASE_URL` for a `SELECT`-only connection).

**Strong inference in the meantime (not a substitute for proof):** production runs `6f0d59df`, a commit
whose tree does not contain 0074–0077 as applied artefacts of the deployed image, and staging — which is
managed by the same runner — sits at 0073. It is therefore _likely_ production is also at or near 0073
and that 0074–0077 are unapplied there too. **This is treated as unproven until queried.**

---

## 0.8 SKILLS INSTALLED AND LOADED

Inspected rather than assumed.

**Global** (`~/.claude/skills/`): `concurrent-session-discipline`, `cornelius-engineering-os`,
`cornelius-execution-style`, `db-migration-discipline`, `deploy-verification`,
`literal-instruction-parser`, `minimal-change-discipline`, `revert-discipline`,
`silent-failure-prevention`, `subagent-orchestration`.

**Project** (`.claude/skills/`): `controlled-code-lead`, `mintvault-concurrent-session-discipline`,
`mintvault-db-migration-discipline`, `mintvault-design-system`, `mintvault-silent-failure-prevention`,
`mintvault-subagent-orchestration`, `mvgs-grading-protected`.

**Project reviewer agents** (`.claude/agents/`, read-only): backend, controlled, database, deployment,
frontend, infrastructure, performance, provider, security, storage, ui.

**Governance documents read** (mandated by repo `CLAUDE.md`):
`docs/NO_BULLSHIT_COMPLETION_CONTROLLER.md`, `docs/GRAPH_OF_LOOPS_BUILD_CONTROLLER.md`.

**Not present as skills** (they are documents/agents, not installed skills — recorded so the naming is
not assumed): no standalone "no-bullshit", "hostile-review", "graphify", or "RLS/RBAC" skill exists.

---

## 0.9 P0 VERDICT

P0 is **COMPLETE except for the single blocked production-journal read** (§0.7).

Corrections to the Plan's stated starting position, established by evidence:

1. The Plan file was **not** in the worktree (now placed).
2. Production is **`6f0d59df`**, two commits behind HEAD — the auth/onboarding recovery and the 0077
   RLS repair are **not deployed**.
3. Staging is older still (`c788fa68`) and **has only one Fly Machine**, so AT-23 cannot run there yet.
4. **0074, 0075, 0076 and 0077 are unapplied on staging**, contradicting the Plan's "applied" claim.
   0077 does not even exist in either deployed build.
5. Global migration high-water mark is **0077**; nine historical collisions confirm the numbering
   hazard is real, so new work starts at 0078 after re-checking the production journal.
6. Typecheck baseline at HEAD is **clean**.

Nothing has been deployed, mutated, or migrated. Production remains untouched.
