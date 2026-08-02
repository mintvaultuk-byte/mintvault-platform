# Project Control — staging preparation runbook

**Branch:** `opus/project-control-final-integration`
**Prepared:** 2026-08-02 · **Status:** NOT STARTED — every gate below is owner-approved, one at a time.

Nothing in this runbook has been executed. No migration applied, no seed run, no flag
enabled, no secret set, no deploy. This document contains no secrets and no credentials.

> **Do not start at GATE 3.** GATE 0 exists because the hostile review found defects that
> make a staging activation misleading rather than merely incomplete. Read it first.

---

## GATE 0 — blocking defects (owner decision required before anything else)

These were found by the six-reviewer hostile panel and personally reproduced. They are
**not** merge problems; they are defects in the source branches that integration exposed.

| ID | Severity | What is wrong | Fix type |
|---|---|---|---|
| PC-F1 | BLOCKER | The dashboard never calls `/composed-overview`. It calls `/overview`, `/views/shop-launch` and `/live-evidence` instead. The whole gates/contradiction/readiness authority has no UI consumer. | UI work |
| PC-F2 | BLOCKER | The dashboard polls `/live-evidence` every 120s. That route calls the GitHub API and probes both `/api/version` endpoints on every request. Opening the dashboard spends GitHub quota and wakes machines — the exact thing `/composed-overview` was built to prevent. | UI work |
| PC-F3 | BLOCKER | `PROJECT_CONTROL_ENV` is set nowhere — not in `fly.toml`, not in `fly.v2.toml`, not as a secret on either app. Both configs set `NODE_ENV="production"`, so **the staging machine labels its evidence `production`**. Staging's migration ledger renders in the production row; the staging row stays permanently empty. | Config |
| PC-F4 | HIGH | Same root cause, opposite direction: the seed production blockade is driven by the same variable. On staging it will refuse the first seed (fail-safe but blocks GATE 7). A local process pointed at the production database resolves `"local"` and the blockade does **not** fire (fail-open). | Config + code |
| PC-F5 | HIGH | Seed apply's confirmation binds only `{manifestDigest, seedVersionBefore}`. The manifest digest is constant, so unrelated database drift passes the guard and apply executes actions the operator never previewed. | Code |
| PC-F6 | HIGH | No manifest package declares `dependsOn`, so every reseed emits `REMOVE_DEPENDENCY` for every operator-created dependency and hard-`DELETE`s it. | Code |
| PC-F7 | HIGH | `MERGED` and `MIGRATION_AUTHORED` are tautologies — one repo snapshot satisfies both; `MIGRATION_AUTHORED` uses `>= 0`, which is unfalsifiable. 30 readiness points are free. | Code |
| PC-F8 | HIGH | Flag evidence bypasses the freshness window and ignores `environment`, so expired and/or production flag rows can satisfy `FEATURE_ENABLED_STAGING`. | Code |
| PC-F9 | HIGH | A rate-limited GitHub sync writes a `STALE` null-head row that wins the last-known-good read, blanking `mainSha`. | Code |
| PC-F10 | HIGH | `CONTRADICTORY` gate state has no branch in the readiness cap, so a contradictory database observation does not cap readiness. | Code |

**PC-F3 is the cheapest and highest-value fix: one environment variable on staging.**
Until it is set, every environment label the dashboard shows is wrong.

**Owner decision:** approve a remediation pass for these before staging, or accept a
staging run that knowingly mislabels environments and overstates readiness.

---

## GATE 1 — integration approval

- **Branch:** `opus/project-control-final-integration`
- **Commit:** `33738291`
- **Worktree:** `/Users/cornelius/mintvault-project-control-final-integration` (clean)
- **Merges:** truth-reconciliation `8608fe59` → integrated-candidate `e7abc650` → live-UI `d02d31f8`, on `origin/main` `372a98f3`
- **Gates:** `tsc` 0 errors · ESLint 0 errors (2503 pre-existing warnings) · `npm run build` succeeds · Project Control suites 37 files / 821 tests / 0 failed / 0 skipped on real PostgreSQL 17.10
- **Reviewer verdict:** integration is sound; the source branches carry the ten defects in GATE 0.

☐ Owner approves the integration commit.

---

## GATE 2 — secrets and configuration

All four required names are **ABSENT** on both `mintvault-v2` (staging) and `mintvault`
(production) — verified read-only, values never displayed.

| Name | Staging | Production |
|---|---|---|
| `SUPER_ADMIN_EMAILS` | absent | absent |
| `SUPER_ADMIN_PROJECT_CONTROL_ENABLED` | absent | absent |
| `PROJECT_CONTROL_GITHUB_TOKEN` | absent | absent |
| `PROJECT_CONTROL_GITHUB_REPO` | absent | absent |

With `SUPER_ADMIN_EMAILS` absent the code falls back to the single `ADMIN_EMAIL`
(fail-safe, not fail-open) — but Super Admin separation is therefore **not proven**.

☐ Owner sets, on **staging only**: `SUPER_ADMIN_EMAILS`, `PROJECT_CONTROL_GITHUB_TOKEN`
(read-only, repo-scoped), `PROJECT_CONTROL_GITHUB_REPO`, and `PROJECT_CONTROL_ENV=staging`
(closes PC-F3).
☐ `SUPER_ADMIN_PROJECT_CONTROL_ENABLED` stays **unset/off** until GATE 8.
☐ Production untouched.

Secret changes are a protected action — the owner performs them.

---

## GATE 3 — migration dry run (read-only)

Current staging ledger (verified read-only 2026-08-02): latest applied
`0035_partner_certificate_origin.sql`; `0030_project_control.sql` applied; **0039 and 0040
not applied**; 9 `pc_*` tables present, all empty (`nodes=0 packages=0 events=0`).

⚠️ **Numbering gap.** `0036`, `0037`, `0038` exist on unmerged branches
(`psp/w2-a-device-registry`, `psp/w2-mvgs-server-authority-*`). Applying 0039/0040 first
means those three would later apply *after* higher numbers. The runner orders by numeric
prefix and skips already-applied files, so it will not refuse — but the applied order will
not match the file order. Decide the merge sequence before applying.

```bash
npm run db:migrate -- --dry-run
```

☐ Output lists exactly `0039_project_control_live_evidence.sql` and
`0040_project_control_seed_reconciliation.sql` as pending.
☐ No checksum mismatch, no inconsistent row, no destructive finding.
☐ Rollback scripts present for both, each retracting its own journal row (0039 fixed in `33738291`).

---

## GATE 4 — apply migrations to staging

**NOT PERFORMED.** Command and verification documented only.

```bash
npm run db:migrate
```

Verification (read-only):
```sql
SELECT filename, status FROM schema_migrations
 WHERE filename LIKE '0039%' OR filename LIKE '0040%';
SELECT table_name FROM information_schema.tables
 WHERE table_schema='public' AND table_name LIKE 'pc_%' ORDER BY 1;
```
☐ Both rows `applied`. ☐ `pc_evidence_snapshots`, `pc_sync_runs`, `pc_sync_leases`,
`pc_sync_checkpoints`, `pc_seed_state`, `pc_seed_runs` present.

**Rollback:** `psql -f migrations/rollback-0040-...sql` then `rollback-0039-...sql`. Both are
transactional and both retract their journal row.

⚠️ Untested path: no test applies 0039/0040 through the real runner, and rollback-0040 has
no test at all (R3-02, R3-03). Treat the first staging apply as the first real exercise.

---

## GATE 5 — seed dry run

**NOT PERFORMED.**

```
POST /api/admin/project-control/seed/dry-run
```
(Super Admin session required; the flag must be on, so this follows GATE 8 — or the flag is
turned on briefly for GATE 5/6 and off again. Owner's call.)

The dry-run path is proven write-free: it runs `to_regclass` plus three `SELECT`s, opens no
transaction, and advances no sequence.

---

## GATE 6 — owner reviews the dry-run output

☐ counts ☐ inserts ☐ updates ☐ supersedes ☐ preserves ☐ rejects ☐ plan digest

⚠️ Read this against **PC-F5**: the confirmation does not bind the plan, only the manifest
digest and seed version. Reviewing the preview does not currently guarantee that apply
executes that preview.
⚠️ And **PC-F6**: any dependency an operator created will appear as `REMOVE_DEPENDENCY` and
will be deleted.

---

## GATE 7 — first seed apply

**NOT PERFORMED. Requires explicit owner approval at the moment of execution.**

```
POST /api/admin/project-control/seed/apply   { "confirmationToken": "<from GATE 5>" }
```

⚠️ Will be **refused** on staging until `PROJECT_CONTROL_ENV=staging` is set (GATE 2) —
staging currently resolves to `production` and the blockade fires.

Proven: single transaction, advisory lock, plan recomputed under the lock, concurrent apply
refused, seed version does not advance on failure, machine fields not seeded, absent
packages superseded rather than deleted, re-run is a genuine no-op.

---

## GATE 8 — enable the flag on staging

**NOT PERFORMED.** Separate approval, after seed verification.

Set `SUPER_ADMIN_PROJECT_CONTROL_ENABLED` on `mintvault-v2` only.
Rollback: unset it — the surface returns 404 again (flag is checked before auth).

---

## GATE 9 — visual and functional verification

☐ Overview ☐ ten launch gates ☐ workflow tree ☐ live evidence ☐ package detail
☐ GitHub refresh ☐ seed status ☐ audit ☐ mobile 390px ☐ tablet 768px

⚠️ **PC-F1/PC-F2 apply here.** The evidence panel is fed by the expensive live route, not the
composed overview, so what you verify is not the composed-authority behaviour.
⚠️ Three checked-in screenshots (`1024x768-integrity-orphan-warning`,
`1024x768-integrity-cycle-warning`, `1440x900-package-evidence-history-package-history`)
depict fixture-only markup that production never renders (PC6-02). Do not treat them as
acceptance criteria.
⚠️ The 390px "no horizontal overflow" assertion is vacuous — happy-dom computes no layout, so
`scrollWidth` is always 0 (PC6-01). Mobile overflow must be checked by eye.

---

## GATE 10 — production planning

Deliberately out of scope. A separate pass, after staging is verified and GATE 0 is closed.
Production is currently at `6f182624`, has none of the four secrets, and returns 404 on the
Project Control surface.

---

## Rollback summary

| Step | Undo |
|---|---|
| Secrets | unset the names added in GATE 2 |
| Migrations | `rollback-0040-...sql` then `rollback-0039-...sql` (both transactional, both retract their journal row) |
| Seed | supersede-only by design; nothing is deleted except dependencies (PC-F6) |
| Flag | unset `SUPER_ADMIN_PROJECT_CONTROL_ENABLED` → surface 404s |
| Branch | never merged to main, never pushed; delete the worktree |
