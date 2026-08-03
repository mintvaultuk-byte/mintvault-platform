# FINAL REPORT — Partner Portal expanded build, hostile review

**Date:** 2026-08-03 · **Governance:** controlled-code-lead v1.1, Stages 0–3 complete, Stage 4
proposed, Stage 5 NOT started.

## Source state (frozen, verified)

| Field | Value |
|---|---|
| Worktree | `/Users/cornelius/mintvault-platform` |
| Branch | `psp/partner-rbac-hybrid` |
| HEAD | `fa94e75234c784dad3201b1438ae84e901ea7e73` |
| Pre-Codex base | `e0a2b571` |
| Tracked tree | clean (only untracked governance dirs) |
| Diff | 50 files, +7055 / −798 |
| Commits | 7 (`c1c5dafd`, `157be2f6`, `bb23e96e`, `8034ca54`, `51df18ad`, `babc930b`, `fa94e752`) |
| Branch pushed? | **NO** — `git ls-remote` empty; **zero CI runs, ever** |
| Production | NOT contacted |

## Verdict

**NOT safe to deploy to staging.** Three BLOCKERs, eight HIGHs. Two of the BLOCKERs mean the
shipped feature does not work in the target environment at all, and one is a revenue defect.

---

## BLOCKER 1 — One credit per SUBMISSION, not per CARD (revenue leak)

Found independently by two agents; Lead-verified against four artefacts.
`submission-service.ts:706` reserves once per submission (`cardReference: partner-submission:${id}`,
no loop). `0017:50` `CHECK (reserved_credits = 1)` means one row can never carry N credits.
`connector-import-service.ts:412` prices the same submission `pricePerCardPence × cardCount`.
`0017:71` `uq_partner_credit_reserve_card_live` was designed as the per-card guard and is
neutralised by the synthetic per-submission key. **20 cards invoiced, 1 credit debited.**
Every fixture in the new 1,604-line lifecycle suite is single-card, so the suite is blind to it.

## BLOCKER 2 — Credit settlement is DEAD on staging (migration vs runtime guard contradiction)

`definer-guard.ts:142-157` flags **any** `pg_auth_members` row for
`partner_credit_lifecycle_definer`, with no `admin_option`/`set_option` filter. Staging has
exactly one: `neondb_owner`, grantor `cloud_admin`. Migration `0041:664-672` *deliberately*
tolerates that row (asserting only on `'set'`/`'usage'`). The two disagree; the guard fails
closed → `credit_schema_incomplete` → **HTTP 409 on every partner credit settlement,
cancellation, and Super Admin recovery.**

Why it was never caught: the test cluster runs as `postgres`, a **superuser**
(`postgres17-cluster.ts:111/132`). Under a superuser the migration's `REVOKE ADMIN OPTION`
removes the row entirely, so the test asserts `[]` and passes. On Neon the migration runs as
non-superuser `neondb_owner`, the row survives, and the guard fires. **The test environment
differs from production in exactly the dimension the guard measures.**

Core MintVault is safe: `findPartnerDestinationLink` returns `null` (not `[]`) on zero rows, so
non-partner submissions short-circuit before the guard.

## BLOCKER 3 — Partner dashboard is a red "forbidden" box for 3 of 6 roles

`dashboard.tsx:32` merges two query errors and `:62` gates all content on both succeeding. The
credits query is unconditional, but `partner.credits.view` is not held by `PARTNER_RECEPTION`
(the primary shop-floor persona), `MVGS_ASSESSMENT_TECHNICIAN`, or `PARTNER_TRAINEE`. The shell
already knows this — it hides the Billing nav item on that exact permission. Result: those users
see one red panel containing the raw server string **"forbidden"** and a Try-again button that can
never succeed. The submission counts they ARE entitled to see never render.

---

## THE MIGRATION SITUATION — worse than a collision

**Staging can neither re-apply nor roll back 0041.** Lead-verified directly:

| Fact | Value |
|---|---|
| `neondb_owner` superuser | false |
| `pg_has_role(…,'partner_credit_lifecycle_definer','usage')` | **false** |
| All 5 lifecycle functions owned by | `partner_credit_lifecycle_definer` |

`usage` is exactly the predicate PostgreSQL's ownership check evaluates. So
`CREATE OR REPLACE FUNCTION` fails (blocks re-apply, at 0041 line 166 — long before the GRANT
block at 382) and `DROP FUNCTION` fails (blocks the rollback script at line 62).

The proof is the contrast with the working 0006 pattern:

| Role | `neondb_owner` membership rows |
|---|---|
| `partner_definer` (0006) | cloud_admin row **+ self-grant `inherit=true, set=true`** → re-runnable |
| `partner_credit_lifecycle_definer` (0041) | cloud_admin row only, `inherit=false, set=false` → bricked |

0041 copied 0006's ownership-transfer pattern and added a self-revoke (line 657) that 0006 never
had. **That one line bricks it.**

**Recoverable:** `admin_option = true` survives from `cloud_admin`, so one owner-approved
`GRANT partner_credit_lifecycle_definer TO neondb_owner WITH SET TRUE, INHERIT TRUE;` restores
both paths. That same fact **disproves the migration's own security claim** that "migration users
retain no SET ROLE path" — the claim is false as written (bounded impact: `neondb_owner` is
already BYPASSRLS, so it gains nothing it lacks).

### Collision resolution

`migrate.ts:288` rejects duplicate numbers and **throws before anything runs**. The moment both
0041 files coexist, every migration run in every environment fails closed.

**Never renumber the partner file** — the journal is keyed by filename, so a rename makes it
"pending" → re-apply → fails at line 166 → whole run aborts.

**Renumber CATALOGUE 0041 → 0028 or 0029.** Journal-clean, and uniquely it does NOT trip the
rollback guard's `> 41` predicate, preserving the rollback window. Second choice: 0042 (clean,
but permanently forfeits 0041 rollback). Free across all branches: **0028, 0029, 0042+**.

---

## Answers to the standing questions

**Did G6A–G6D survive?** For wallet/ledger, **yes — verified clean.** No UPDATE/DELETE/TRUNCATE
against `partner_credit_ledger` anywhere in the repo; no stored balance column exists by design;
balances derived from `partner_credit_availability`; negative balance structurally impossible via
three layers; idempotency DB-enforced on every credit write; double-consume refused by the
database, not just the app. **For the release path, no** — it is reimplemented in PL/pgSQL inside
0041 and has already diverged from the TypeScript original (recovery tolerance, `source` value,
idempotency-key shape, fingerprint algorithm). That divergence is the direct cause of H3, where
an authorised Super Admin recovery permanently bricks all four connector terminal transitions.

**Is the scanner genuinely connected?** **No — and it is not faked either.** The Mac watcher and
the partner portal are two disjoint universes: zero `partner|tenant` references in
`scan-ingest-service.ts` or the watcher scripts; zero `scan|upload|image` references in the
wizard. `front_image_key`/`back_image_key` were reserved in migration 0007 and are referenced by
no server or client code. **No process anywhere writes a heartbeat.** The dashboard says so
explicitly and honestly ("No device registry exists"). Credit where due — this is the right
behaviour. Residual: the admin "Devices" tab shows browser sessions with a State column reading
"Live", which can be misread as scanner health.

**Tests.** Full suite is **RED both ways**. Plain: 33 files failed, 1415 skipped. With
`LC_ALL=C LANG=C`: 7 files failed, **852 still skipped**. The DB files don't skip silently — they
error on `pg_ctl`. 72 tests including the *only* Super Admin credit-audit proof are env-gated and
have **never executed anywhere**, because the branch has never been pushed or run in CI. Two
read-only guard tests over the credit ledger were **deleted and inverted**. Three suites were
narrowed by migration filter — the wallet one to `≤16`, which drops 0017's negative-balance
backstop, and is far broader than its own stated rationale (which would need `<41`).

**Tenant isolation.** No cross-tenant exposure is presently reachable. But the brief's premise is
wrong in an important way: the admin pool connects as a **BYPASSRLS** role, so `FORCE ROW LEVEL
SECURITY` is **inert** on those paths — proven read-only by returning all 3 tenants' organisations
under a bogus tenant context. The two most financially significant transitions (`submit`,
`cancel`) run on that pool. Every query there currently carries an explicit `tenant_id` predicate
(Lead spot-checked), but isolation is now a hand-maintained invariant with no test and no CI guard.
`partner_submission_credit_holds` has no RLS and IS read/written directly by application code —
including an `UPDATE` the definer was never granted, confirming the admin pool is the executor.

**Blast radius.** 0041 installed BEFORE triggers on `submissions`, `certificates` and
`label_prints` — two are CLAUDE.md protected systems. The `submissions` guard serialises the whole
row to JSONB **twice on every update** (DECLARE-section initialisers evaluated before the EXISTS
short-circuit), including every ordinary consumer grading change. A single stray hold row freezes
receive/grade/scan/ship/complete plus certificate creation and label printing for that submission,
surfacing to an admin as a 500. The only in-app clear path **mints a replacement credit**; there
is no "this hold was a mistake" admin action. And the expiry job creates holds **unattended**.

---

## Remaining work, in dependency order

1. Owner decides the three questions below.
2. Fix `definer-guard.ts` to match the migration (BLOCKER 2) — smallest, highest-value repair.
3. Fix the test harness executor (`partner-realistic-db.ts:195`) so it stops running 0041 as
   superuser; add apply-twice and rollback-happy-path tests. Without this, nothing else is proven.
4. Renumber catalogue 0041 → 0028/0029.
5. Fix BLOCKER 3 (dashboard capability gate) and BLOCKER 1 (credit unit, if per-card confirmed).
6. Push the branch and get a green CI run. **No claim in this report about test coverage should be
   treated as proven until that happens.**

## Owner decisions required (all three block repair)

1. **Are partner credits sold per CARD or per SUBMISSION?** Everything in the repo says per card.
   Changes reservation cardinality and forces rework of the SQL definer function.
2. **Approve the one-statement staging GRANT** to un-brick 0041's re-apply/rollback paths?
3. **Was enabling manual Super Admin credit adjustment intended?** It was switched on and its
   guard tests were deleted in the same changeset.

## Production

**Entirely unverified — deliberately not contacted.** F1/F2/F3 all hinge on the grantor and
`admin_option` shape of a provider-created membership row, which is a per-project artefact.
Note that the `mintvault` Fly app has no `PARTNER_*` secrets at all (only `mintvault-v2` does).
Re-run the two read-only probes against prod before any release decision there.
