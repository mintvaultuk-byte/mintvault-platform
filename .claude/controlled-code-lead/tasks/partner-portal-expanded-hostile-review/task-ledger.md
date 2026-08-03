# Task ledger — partner-portal-expanded-hostile-review

Governance: controlled-code-lead v1.1. Lead = main Claude session. Opened 2026-08-03.

## Stage 0 — Baseline (COMPLETE, evidence-backed)

| Field | Value | How verified |
|---|---|---|
| Worktree | `/Users/cornelius/mintvault-platform` | `git` in-repo |
| Branch | `psp/partner-rbac-hybrid` | `git branch --show-current` |
| HEAD | `fa94e75234c784dad3201b1438ae84e901ea7e73` | `git rev-parse HEAD` |
| Pre-portal baseline | `e0a2b571` | owner-supplied, confirmed as merge-base of the 7-commit chain |
| Tracked worktree | CLEAN | `git status --porcelain` shows only untracked `.claude/controlled-code-lead/**` governance dirs |
| Committed diff | 50 files, +7055 / −798 | `git diff --stat e0a2b571..HEAD` |
| Staging DB | `ep-purple-voice-abfez796-pooler.eu-west-2.aws.neon.tech` / `neondb` | parsed from local `.env` |
| Production | NOT contacted this session | no prod credentials used; deliberately unverified |

### Commits created by the Codex pass (7, oldest first)

```
c1c5dafd wip(partner): preserve g6d integration before hostile-review repairs
157be2f6 wip(partner): preserve partial g6d repairs before role redesign
bb23e96e chore(migration): renumber 0019 -> 0027 to clear the collision with 0019_catalogue_manager
8034ca54 feat(partner): complete portal credits and lifecycle
51df18ad fix(migration): grant temporary lifecycle set role
babc930b fix(migration): revoke lifecycle role administration
fa94e752 fix(migration): verify lifecycle runtime capability
```

Note: `bb23e96e` proves the partner migration has ALREADY been renumbered once to dodge a
catalogue collision (0019 → 0027), and later landed on 0041 — where it collides with catalogue
again. The last three commits are post-hoc repairs to the migration's role handling.

## Stage 0b — Read-only staging migration forensics (COMPLETE)

Method: two read-only Node probes (SELECT / `information_schema` / `pg_catalog` only; no `SET`,
no DDL, no DML) against the staging URL in `.env`. Scripts kept in the session scratchpad.

Answers to the owner's ten mandated questions:

1. **schema_migrations row for partner 0041** — `id=32`, `filename='0041_partner_submission_credit_lifecycle.sql'`, `status='applied'`, `applied_by='neondb_owner'`.
2. **Applied checksum vs current file** — stored `dd7e29cf768c9a4746a77e74f25ee640c8d58a3ec9bbfb091dd3dcce16f3e07a`; sha256 of the working-tree file is byte-identical (30,388 bytes). **MATCH.** The file has not been edited since it was applied.
3. **Timestamp / status** — `started_at == completed_at == 2026-08-03T05:47:46.700Z`, status `applied`. Identical timestamps are the runner's transactional signature (single INSERT with `completed_at=now()` inside the migration's own transaction).
4. **Objects created/modified** — tables `partner_credit_accounting_exceptions` (RLS enabled + FORCED, tenant-isolation policy present, 0 rows) and `partner_submission_credit_holds` (**RLS NOT enabled**, 0 rows); column `partner_connector_imports.deleted_at timestamptz NULL`; 6 functions (5 owned by `partner_credit_lifecycle_definer`, SECURITY DEFINER, pinned search_path); triggers `trg_partner_destination_credit_hold_guard` on `submissions`, `trg_partner_certificate_credit_hold_guard` on `certificates`, `trg_partner_label_print_credit_hold_guard` on `label_prints`, plus 2 append-only triggers on the exceptions table; roles `partner_connector_runtime` (NOLOGIN, no BYPASSRLS) and `partner_credit_lifecycle_definer` (NOLOGIN, BYPASSRLS).
5. **Completed fully?** — YES. Every declared object is present, and the journal row is `applied` with a completion timestamp.
6. **Partial objects from a failed apply?** — NO. Zero rows in `schema_migrations` with `status <> 'applied'`. The runner applies transactional files inside `BEGIN/COMMIT` and inserts the journal row in the same transaction, so a failure leaves neither objects nor a row.
7. **Rollback safe and journal-correct?** — Journal-correct YES: `rollback-partner-submission-credit-lifecycle.sql:118` deletes the 0041 journal row as its final act. It also guards against rolling back beneath a later applied migration and against dropping the hold trigger while an active hold exists. It is deliberately PARTIAL: it does not drop the two new tables, the `deleted_at` column, or the `partner_connector_runtime` role. Because every create in 0041 is `IF NOT EXISTS` / `CREATE OR REPLACE`, a clean re-apply after rollback is expected to succeed. **Delegated to Agent 5 for statement-by-statement proof.**
8. **Catalogue 0041 applied anywhere?** — NOT on staging, proven two independent ways: no journal row matching it (only `0019_catalogue_manager` and `0026_catalogue_abbreviation_unique` are journalled), and `catalogue_items` still carries the plain `uq_catalogue_items_category_value` btree`(category, value)` rather than the functional `(category, lower(btrim(value)))` index that migration would create. Production: **UNVERIFIED — not contacted.**
9. **Current watermark** — 32 journal rows, highest number 0041.
10. **Revert/renumber trap?** — **YES, two distinct traps. See below.**

### The two migration traps (Lead's own analysis, evidence cited)

**TRAP 1 — total migration outage on merge (CRITICAL).**
`scripts/db/migrate.ts:288-300` rejects duplicate migration NUMBERS by numeric value and
**throws before any migration runs**, including on the dry-run planning path. The instant
`0041_catalogue_case_insensitive_value_unique.sql` and
`0041_partner_submission_credit_lifecycle.sql` coexist in `migrations/` — which is exactly
what a merge to main produces — **every migration run in every environment fails closed.**
This is not a soft conflict; it is a complete migration-system outage until one file is
renumbered.

**TRAP 2 — renumbering the APPLIED migration re-runs it (HIGH).**
The journal is keyed by FILENAME (`schema_migrations.filename UNIQUE`, read at
`migrate.ts:343`), not by number. Renaming the applied partner `0041_…sql` to `0042_…sql`
leaves the `0041_…` row orphaned in staging's journal forever and makes `0042_…` look
**pending**, so the runner would **re-apply the whole migration** — a migration that installs
triggers on `certificates` and `label_prints`. It would also permanently desynchronise the
journal from the file set, and once any 0042+ row exists the rollback script's own guard
(`… ::integer > 41`) refuses to roll 0041 back.

**Consequence: the partner migration is the one that must NOT move. Catalogue 0041 is
unapplied everywhere reachable and is therefore the cheap one to renumber.** Free numbers
must be chosen against ALL branches and against staging's journal, which contains applied
`0035`, `0039`, `0040` whose files do not exist on this branch.

### Branch/environment divergence (HIGH, pre-existing, not caused by Codex)

Staging's journal contains `0035_partner_certificate_origin.sql`,
`0039_project_control_live_evidence.sql` and `0040_project_control_seed_reconciliation.sql`.
**None of those three files exist on `psp/partner-rbac-hybrid`.** This branch's numbered file
set is 0001–0019, 0022, 0023, 0024, 0026, 0030–0034, 0041 (29 files). Staging is therefore
ahead of this branch in applied migrations, and any numbering decision made from this branch
alone will be wrong.

### Blast-radius flag raised to the panel (Lead)

Partner 0041 installs BEFORE triggers on `public.submissions`, `public.certificates` and
`public.label_prints`. `certificates` and `label_prints` are CLAUDE.md protected systems
(certificate lookup, label generation). Every certificate insert/update and every label print
on staging now executes a SECURITY DEFINER plpgsql function. A partner-scoped migration has
taken a dependency on the core grading/label pipeline. Agent 5 owns quantifying this.

## Stage 1 — Review plan (COMPLETE)

Seven read-only agents, non-overlapping scopes, all launched 2026-08-03:

| # | Scope | Agent type |
|---|---|---|
| 1 | UI/UX, brand, responsive, placeholders | ui-reviewer |
| 2 | Wallet & ledger integrity | backend-reviewer |
| 3 | Reservation lifecycle (reserve/consume/release/expire) | backend-reviewer |
| 4 | Tenant isolation & RBAC | security-reviewer |
| 5 | Migration necessity, safety, collision | database-reviewer |
| 6 | Submission workflow & scanner/watcher honesty | backend-reviewer |
| 7 | Test vacuity & mutation proof | controlled-reviewer |

## Stage 2 — Reviewer investigation: IN PROGRESS

## Authorised next action

Await all seven reports, then Stage 3 Lead verification (personally reproduce every
BLOCKER/HIGH). No implementation before that.

## NOT authorised (owner gate required, every one)

deploy · apply or roll back any migration · edit either 0041 file · add credits · create
submissions · push · merge · any production contact.
