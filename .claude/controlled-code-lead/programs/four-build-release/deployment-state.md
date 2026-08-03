# Deployment State — Four-Build Integration

- Integration branch PUSHED to origin @ 921fa1dd (owner-authorised). Verified: git ls-remote shows the ref.
- Integration PR: NOT YET CREATED — GitHub's PR-creation endpoint (GraphQL + REST write) returned transient
  "Something went wrong" errors 4x (incident IDs DB8E…, DB91…, DB94…, DBAC…) between 19:41–19:43Z 2026-07-24.
  GitHub-side outage; REST read path works, branch push worked. No duplicate PR was created (verified empty).
  ACTION when GitHub recovers: `gh pr create --base main --head integration/four-build-release-candidate
  --body-file .claude/controlled-code-lead/programs/four-build-release/PR-BODY.md`
- CI: not yet run (needs the PR).
- Staging: NOT deployed (gated on PR+CI+founder merge). Staging still debea36b.
- Prod: UNTOUCHED — d5daecbf.
- CodeQL: HELD per founder; labels.ts NOT changed. Evidence to be presented in the combined review.

## PR retry #5 (founder-instructed single attempt) — 2026-07-24 19:54:15Z
- FAILED. New incident ID: DC74:2367A4:28D684:2F6617:6A63C2E6.
- CONFIRMED GitHub-side: githubstatus.com reports indicator=major, "Partial System Outage",
  component **Pull Requests = major_outage** (Git Operations / API Requests / Actions / Issues = operational).
  That is exactly consistent with: branch push succeeded, PR creation fails.
- No PR was created by the failed attempt (verified `gh pr list --state all` = empty).
- Per founder instruction: STOPPED after one attempt. No further retries.
- origin/main re-verified unchanged at debea36b; branch head on remote = 921fa1dd.
- CI + CodeQL results: NOT AVAILABLE — no PR exists, so no checks have run.

## PR OPENED — #244 (2026-07-24 ~19:57Z)
- URL: https://github.com/mintvaultuk-byte/mintvault-platform/pull/244
- head 921fa1ddd02b6f3882290a7061155a48c447a9e8 · base main debea36bfae7855b4028070b8a6648c95b3c9c11
- MERGEABLE / UNSTABLE. 35 files, +3012/-137 (matches local build exactly).

### CI RESULTS (all checks finished; run 30122159009, re-run once)
| Check | Result |
|---|---|
| CodeQL (SAST) javascript-typescript | PASS (1m40s) |
| PR dependency review | PASS |
| Secret scan (gitleaks) | PASS |
| CodeQL (code-scanning alert) | FAIL — EXPECTED, founder-HELD js/polynomial-redos labels.ts:406 |
| Lint, Type Check, Test & Build | FAIL — 1 test of 2648 |

Test totals: **2227 passed / 1 failed / 420 skipped (2648)**; files 157 passed / 1 failed / 24 skipped (182).
tsc + lint + build steps PASSED (failure is in the Test step only).

### The single failing test — ROOT-CAUSED, NOT caused by this integration
`tests/print-workflow-service.test.ts > "reserves each contended cert to exactly one of two concurrent batches"`
AssertionError: expected false to be true → **line 189 only** (loser must report code `already_reserved`).

PROOF it is pre-existing (PR #240), not ours:
1. The IDENTICAL test + identical assertion FAILED on **main @ 4f6449c9** (the "Merge PR #240: Print Workflow" commit) at 17:15Z — hours before this integration branch existed. Run 30112120950.
2. The integration changes **ZERO** print-workflow files (`git diff --name-only debea36b HEAD | grep print` = empty).
3. In every failure the two CORRECTNESS assertions PASS: exactly one batch wins MVX (L185) and MVX ends `printing` (L186). Only the loser's error-code detail differs.

ROOT CAUSE (server/print-workflow.ts): there are TWO legitimate rejection paths for the losing batch,
selected purely by read timing —
 - loser's pre-flight snapshot read (L389-397 `states.get` + `nextState(from,'create_batch')`) happens AFTER the
   winner commits `print_state='printing'` → MVX rejected in the PRE-CHECK with the state-machine's code; never
   reaches L448, so `already_reserved` is absent → assertion fails;
 - loser's snapshot read happens BEFORE the winner commits → MVX is eligible, hits the state-guarded UPDATE
   (L443-449), gets 0 rows → `already_reserved` → assertion passes.
Both are CORRECT product behaviour. The TEST over-specifies one of two valid race outcomes.
Likely why it reproduces more on this branch: 182 test files vs main's 180 (we add catalogue + variant-line
suites) → more parallel load → the loser's read more often lands after the winner's commit.

VERDICT: test-quality defect owned by PR #240 (already on main). NOT a product regression. NOT introduced here.
RECOMMENDED FIX (NOT APPLIED — no code changes authorised): widen the L189 assertion to accept either
legitimate rejection code for MVX (or assert simply that the loser rejected MVX). One-line test change in
#240's test file; needs founder authorisation since it is outside this integration's scope.

## FOUNDER-APPROVED CI FIXES APPLIED (2026-07-24) — PR #244 now ALL GREEN
Branch updated 921fa1dd → **a90ef0c8** (2 commits; PR #244 updated in place, no new PR).

### Commit a2b85338 — tests/print-workflow-service.test.ts ONLY (no product code)
Assertion widened to the two legitimate loser codes ['already_reserved','invalid_from'] and
STRENGTHENED with DB proof: exactly one create_batch print_event for the contended cert; exactly one
print_batches row containing it; same batch_id; loser.applied excludes it.

### Commit a90ef0c8 — server/labels.ts (1 line + comment) + tests/promo-suffix-redos.test.ts (new)
BEFORE: const PROMO_SUFFIX_RE = /\s+black star promos?$/i;
AFTER:  const PROMO_SUFFIX_RE = /\s{1,64}black star promos?$/i;
Equivalence holds for EVERY input (not just realistic ones) because splitPromoSuffix() .trim()s both
base and suffix — a >64 whitespace run yields byte-identical output; only the match offset differs.
New suite: 43 tests (33-case old-vs-new corpus, singular/plural, ordinary names, near-misses,
tab/newline/multi-space, 64/65/200/300 boundary, 100k+200k pathological <1s, source pinning,
preview/print same renderer, no MVGS/grade/Pristine drift).

### CI ON a90ef0c8 — ALL FIVE GREEN
| Check | Result |
|---|---|
| CodeQL (code-scanning alert) | **PASS** — js/polynomial-redos CLEARED by the hardening |
| CodeQL (SAST) javascript-typescript | PASS (1m43s) |
| Lint, Type Check, Test & Build | **PASS** (3m46s) |
| PR dependency review | PASS |
| Secret scan (gitleaks) | PASS |
Totals: **2271 passed / 0 failed / 420 skipped (2691)**; files 159 passed / 0 failed / 24 skipped (183).
PR mergeStateStatus: UNSTABLE → **CLEAN**. Local: tsc 0, build OK, lint 0 err, MVGS 202/202.

STILL NOT DONE (owner-gated): merge, migrations (0017/0018/0019), seed, staging deploy, prod. Prod = d5daecbf.

## PHASE 1 — comment fix (2026-07-24)
Commit 74acb264 `docs(preview)`: shared/label-preview-fields.ts comment-only (hostile F4).
PROVEN comment-only: stripped comments+blanks and diffed → executable code byte-identical.
Gates: tsc 0; focused preview/label/ReDoS/MVGS suites 351/351 (MVGS 202/202, ReDoS 43/43).
CI on 74acb264: ALL FIVE GREEN (CodeQL pass, SAST pass, Lint/Type/Test/Build pass 3m55s,
dep-review pass, gitleaks pass). Totals 2271 passed / 0 failed / 420 skipped. PR state CLEAN.

## PHASE 2 — MERGED (2026-07-24 20:32:29Z)
- Pre-merge: origin/main re-fetched = debea36b (UNCHANGED from baseline) ✓
- Branch audit: 19 commits, all accounted for; 37 files, all belonging to the 4 workstreams;
  NO lockfile/CI/.env/fly.toml/Dockerfile drift; only protected file = server/labels.ts (approved).
- Merge method: merge commit (repo convention; merge_commit=true).
- **PR #244 state=MERGED · mergeCommit = f0f4d9df9623cc344f4afc9cb79aeef25434074c**
- **origin/main: debea36b → f0f4d9df**
- INTEGRITY: `git diff 74acb264 origin/main` = EMPTY → merge introduced nothing beyond the reviewed branch.
- Migrations on new main: 0001–0019 + 0022 (0020/0021 remain unused gaps).
- Production NOT deployed. Prod remains d5daecbf.

## PHASE 3 — STAGING MIGRATION DRY-RUN (read-only, NO writes) — AWAITING FOUNDER APPROVAL
Worktree moved to detached f0f4d9df (== origin/main, verified) so the plan reflects merged main.

TARGET SAFETY (checked BEFORE any DB call):
- local .env host = ep-purple-voice-abfez796-pooler.eu-west-2.aws.neon.tech → **STAGING** ✓ (NOT prod ep-wispy-morning)
- staging app mintvault-v2 reports the SAME DB host via `fly ssh` → dry-run target == the app's own DB ✓

DRY-RUN RESULT (`npm run db:migrate`, no --apply):
  **Migrations: 20 total, 17 applied, 3 pending, 0 inconsistent, 0 checksum-mismatch.**
  **pending: 0017_partner_credit_reservations.sql, 0018_correction_audit_index.sql, 0019_catalogue_manager.sql**
  → EXACTLY the expected set. Nothing unexpected. Runner default mode = plan + destructive-SQL lint, no writes; no blocking lint findings.

INDEPENDENT JOURNAL VERIFICATION:
- 0022 status=applied; journal checksum == sha256 of the on-disk file → **0022 recorded correctly** ✓
- zero journal rows in a non-`applied` state (no crashed/`applying`/`failed` rows) ✓
- 0017/0018/0019 absent from journal ✓; their target objects absent in DB
  (catalogue_items=null, partner_credit_reservations=null, idx_audit_log_cert_correction_recent=null) ✓

PARTNER FLAGS: `partner_feature_flags` has ZERO rows and `resolveFlag` returns false when no row
(fail-closed, server/partner/flags.ts:47) → **all 9 partner flags OFF before**. Migrations add no flag
rows, so they remain OFF after.

ADDITIVITY / COMPATIBILITY with the currently-deployed staging app (still debea36b until we deploy):
- 0019 = CREATE TABLE/INDEX IF NOT EXISTS (catalogue_items) — new table, invisible to old code.
- 0017 = CREATE TABLE/INDEX IF NOT EXISTS + CREATE OR REPLACE FUNCTION/VIEW + pg_trigger-guarded DO.
  NOTE: adds a BEFORE-INSERT trigger to the EXISTING partner_credit_ledger; dormant because partner
  flags are OFF and there is no partner activity on staging.
- 0018 = CREATE INDEX CONCURRENTLY on audit_log (transparent to the app; no write blocking).
All three idempotent → safe under the migration-before-code ordering.

**STOPPED. NOT APPLIED. No seed. No staging deploy. No prod deploy. Awaiting explicit founder approval of this exact plan.**

## PHASE 3b — MIGRATIONS APPLIED TO STAGING (2026-07-24, founder-approved)
Pre-flight (all 7 re-confirmed immediately before apply): HEAD=f0f4d9df==origin/main ✓ · host
ep-purple-voice ✓ · mintvault-v2 reports the SAME host ✓ · ep-wispy-morning ABSENT ✓ · pending
exactly 0017/0018/0019 ✓ · 0 checksum-mismatch ✓ · flags 0 rows/0 enabled ✓.

APPLY OUTPUT (`npm run db:migrate -- --apply`):
  Migrations: 20 total, 17 applied, 3 pending, 0 inconsistent, 0 checksum-mismatch.
  ✓ Applied 3: 0017_partner_credit_reservations.sql, 0018_correction_audit_index.sql, 0019_catalogue_manager.sql

POST-APPLY VERIFICATION — ALL GREEN
1. Journal: 0017/0018/0019 all status=applied, completed_at set, checksum == sha256 of on-disk file ✓
2. 0022: status=applied, checksum still matches disk → intact & unchanged ✓
3. 20 journal rows; ZERO non-applied or incomplete rows ✓
4. Objects: partner_credit_reservations + partner_credit_reservation_events + uq_partner_locations_identity;
   idx_audit_log_cert_correction_recent **indisvalid=true**; catalogue_items ✓
5. Triggers all tgenabled='O' (enabled): trg_partner_credit_ledger_preserve_active_reservations (the 0017
   ledger trigger), + no_row_mutate/no_truncate on ledger & events, + reservation identity guard ✓
6. Partner flags: 0 rows, 0 enabled → ALL STILL OFF ✓
7. Second dry-run: **20 total, 20 applied, 0 pending, 0 inconsistent, 0 checksum-mismatch** ✓
8. Integrity: reservations/events/ledger all 0 rows (no data touched); RLS enabled+FORCED on both new
   tables with 2 policies; trigger fn present; audit_log 1818 rows untouched and the partial index def
   matches the intended predicate; catalogue_items = 17 columns, PK, 3 indexes incl.
   uq_catalogue_items_category_value; **0 rows (NOT seeded, as instructed)** ✓

STAGING APP HEALTH after migration while still running OLD code (debea36b) — proves additivity:
  /api/version 200 (commit debea36b) · /ready 200 · homepage 200 ✓
PRODUCTION UNTOUCHED: mintvaultuk.com = d5daecbf ✓

**STOPPED. No seed. No staging deploy. No prod deploy. Awaiting founder approval.**

## PHASE 1-3 STAGING RELEASE COMPLETE (2026-07-24) — PROD UNTOUCHED
### Seed
Pre-checks all passed (HEAD=f0f4d9df==origin/main; ep-purple-voice; mintvault-v2 same host; no ep-wispy-morning; catalogue 0 rows; flags OFF).
Command: `npx tsx scripts/db/seed-catalogue.ts` (script's own documented invocation; no package script exists; script UNMODIFIED).
Run 1: "96 seed rows … inserted new: 96, skipped existing: 0".
By category: rarity 35, finish 24, promo 12, language 8, designation 6, era 6, subset 5 = 96 (all active, 0 archived, 0 blank).
NOTE: schema defines EIGHT categories; the 8th, `attribute` ("Optional Card Attributes"), has ZERO seed rows BY DESIGN
(optional, founder-populated via UI). Seed output == the script's intended dataset (96 intended → 96 inserted), so NOT a stop condition.
Run 2 (idempotency): "inserted new: 0, skipped existing: 96"; total still 96; duplicates 0.
Unique index uq_catalogue_items_category_value valid=true unique=true. Unrelated tables unchanged
(certificates 257, audit_log 1818, partner ledger 0, reservations 0). Flags still OFF.

### Deploy
origin/main re-confirmed f0f4d9df immediately before deploy. `bash scripts/safe-deploy.sh staging` (mintvault-v2, fly.v2.toml).
GUARD 1 passed (checkout current with origin/main). Image deployment-01KYAY279WB85AAKAX629TNR8T.
Machine d8d14d0f34d378 rolled, reached started, 1/1 checks passing. Transient fly WARNING during rollout
("not listening on expected address") resolved by itself — machine then passed smoke+health checks.
GUARD 2: "✅ VERIFIED: mintvault-v2 is live on commit f0f4d9df (checked the running server)".
Staging machines: ONE machine configured (not two) — version 426, lhr, started, 1 total/1 passing.

### Phase 3 verification
/api/version = f0f4d9df ✓ · /ready 200 ✓ · homepage 200 ✓ · /api/health 200 ✓
Migration journal: 20 total, 20 applied, 0 pending, 0 inconsistent, 0 checksum-mismatch ✓
Partner flags: 0 rows / 0 enabled ✓ · catalogue_items 96 live ✓ · certificates 257 untouched ✓
PROD: mintvaultuk.com = d5daecbf; 2 machines both v1062, last updated 13:22Z (hours before this work) — UNTOUCHED ✓

### Smoke tests (authenticated, staging only)
D CATALOGUE: list 96 via app (7 categories + attribute 0); CREATE(201)/EDIT(200)/DEACTIVATE/REACTIVATE/SEARCH all pass;
  RBAC: unauthenticated 401 on items GET+POST, import, export, snapshot; cleanup = archived (live back to 96).
  Archiving removed it from /api/catalogue/snapshot → PROVES the picker reads the DB catalogue, not the hard-coded seed.
C PREVIEW: OLD /api/admin/label-preview = 404 (removed) ✓; canonical endpoint 200 image/png ✓.
  **RUNTIME PARITY PROOF:** preview (no structured keys) vs print `?format=png` on cert 364 = BYTE-IDENTICAL sha256
  (79a20764…, 73069 bytes) → same renderer, and the v1 legacy cert renders UNCHANGED.
  Preview WITH structured keys legitimately differs → shows the consolidated line the label gets AFTER save (correct).
  Consolidated line via shared formatter = "SPECIAL ILLUSTRATION RARE · BLACK STAR PROMO · COSMOS HOLO".
  Pristine gate: all-10s vs all-9s render DIFFERENTLY; isPristine(10s)=true / (9s)=false ✓
B PRINT WORKFLOW: /printing/queue 200 (9 rows) · /printing/workflow/queue 200 (0022 tables live) ·
  batches + events ledger 200 · LIFECYCLE GUARD: unapproved cert rejected {code:"not_approved"}, applied=[], batchId null,
  NO state change ✓. Positive path (eligible→printing) NOT exercised: all 9 staging certs are awaiting_approval and
  approving one would mutate PROTECTED grading state / consume a cert number. Covered by CI print-workflow suites (green).
A RARITY-CLEAR: client-side behaviours. Verified the SHIPPED bundle (recursive crawl, 213 chunks, 5.24 MB) CONTAINS
  "No rarity — clear", rarity-clear testid, certificate-preview-panel, canonical preview endpoint, Catalogue Manager,
  printing/workflow — and does NOT contain the removed /api/admin/label-preview (not even as a substring).
  Interactive click-through deferred to founder smoke test (see limitations).

### Limitations / deferred (honest)
1. Workstream A interactive click-through + "one preview panel visible" not driven in a browser (would require typing
   admin credentials into a login form). Covered by: served-bundle proof, CI suites, and the hostile review that
   specifically confirmed #239's emit-guard, single-select and no-cross-cert-bleed survive #243's catalogue repoint.
2. Non-super-admin (staff) denial not exercised empirically — no staff/grader accounts exist on staging. Proven by
   unauthenticated 401s + requireSuperAdmin source + hostile-review confirmation.
3. Print-workflow positive path not exercised on staging (see B).
4. Disposable catalogue row remains as an ARCHIVED soft-delete (id 193) — no hard-delete route exists.
5. Staging runs ONE machine, so the "two machines same version" check is N/A.

**STOPPED. Production NOT deployed and NOT planned without explicit founder approval.**
