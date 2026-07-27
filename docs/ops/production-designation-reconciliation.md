# Production designation-catalogue reconciliation (PR #259)

**Status: PREPARATION ONLY — no production execution has occurred.**
Nothing in this package has been run against the production database. The
identical reconciliation has been applied to **staging only**, and verified.

---

## 1. Why

PR #259 switches the Card Details designation picker from the hard-coded
`DESIGNATION_OPTIONS` array to the DB-backed catalogue. Production's catalogue
was seeded with lowercase internal values and **no abbreviations**, so after
#259 ships the picker would present the wrong option set and persist codes that
`DESIGNATION_LABELS` (`server/routes.ts`) cannot resolve.

## 2. Two facts that bound the risk

1. **No certificate stores a designation.** Production: 700 certificates, **0**
   with a non-empty `designations` array. Staging: 259, also 0. There is no
   historical data to orphan and no certificate rewrite is required.
2. **The change is inert until #259 deploys.** Pre-#259 `buildSnapshotFromRows`
   emits no `designations` key and there is no `mapDesignationRow`, so the
   running production app does not read designation rows at all.

## 3. Canonical contract

Ten codes, verified by test against **both** pre-#259 sources
(`client/src/lib/designationOptions.ts` and `DESIGNATION_LABELS`):

| value | abbreviation (persisted code) | label |
|---|---|---|
| `unlimited` | `UNLIMITED` | Unlimited |
| `first_edition` | `FIRST_EDITION` | 1st Edition |
| `shadowless` | `SHADOWLESS` | Shadowless |
| `promo` | `PROMO` | Promo |
| `tournament_stamp` | `TOURNAMENT_STAMP` | Tournament / Event Stamp |
| `prerelease` | `PRERELEASE` | Prerelease |
| `staff` | `STAFF` | Staff |
| `error_miscut` | `ERROR_MISCUT` | Error / Miscut / Misprint |
| `japanese_print` | `JAPANESE_PRINT` | Japanese Print |
| `other_language` | `OTHER_LANGUAGE` | Other Language |

`error` and `misprint` are **absorbed** by `ERROR_MISCUT` (both appear in its
alias list). `test_print` is **excluded**. All three are **archived, never
deleted**, so they remain readable and are exempt from migration 0026.

The reconciliation validates the **full** row contract — value, label,
abbreviation, aliases, description, `allow_cross_category`, active, archived —
not just the abbreviation.

## 4. Safety guards (all fail closed, before any write)

| Guard | Behaviour |
|---|---|
| **environment ↔ database binding** | the hostname from `MINTVAULT_DATABASE_URL` must **exactly equal** the host the script has configured for `--environment`. No substring/prefix/suffix matching. A production URL labelled `--environment staging` is refused. |
| `--expected-db-host` | second operator confirmation; must exactly equal **both** the configured host and the actual hostname |
| default mode | **dry run** — `--apply` required to write |
| `--confirm-production` | required for `--apply` against production; refused if paired with another `--environment` |
| `--expected-app-sha` | hex-validated, min 7 chars; compared to live `/api/version`; a full 40-char SHA is additionally confirmed against git; refuses a SHA shorter than the live commit rather than truncating |
| certificate check | refuses if **any** certificate stores a designation — re-checked inside the transaction |
| baseline check | refuses unless the inventory is the approved 6-row baseline (or already reconciled → no-op) |
| archived canonical row | detected in **preflight** and refused (resurrecting one is not an approved rule) |
| pre-set abbreviation | refused — the persisted code is never silently overwritten |
| cross-category / duplicate code | shared `catalogueConflict` + duplicate-effective-code check, re-run **inside** the transaction before COMMIT |
| concurrency | `BEGIN ISOLATION LEVEL SERIALIZABLE`, `SELECT … FOR UPDATE` on existing designation rows, and an inventory-fingerprint comparison that aborts on any drift between preflight and transaction |
| rollback ownership | only rows with `created_by = 'ops:reconcile-designation-catalogue'` may be deleted; a single unowned row aborts the whole rollback |
| credentials | only the DB **host** is ever printed; a malformed URL yields "(value withheld)" |
| backup path | refuses inside-repo destinations, symlink redirection, and overwrite without `--force-overwrite` |
| **pooler endpoint only** | the configured hostnames are the Neon **`-pooler`** endpoints. The **direct** (non-pooler) endpoint is refused by design — see §4.1 |

**Known concurrency limitation (stated honestly):** `SELECT … FOR UPDATE`
cannot lock rows that do not yet exist, so a *phantom* insert of a designation
row concurrent with the run is prevented by `SERIALIZABLE` isolation plus the
`(category, value)` unique index rather than by row locks. Under Neon's pooler a
serialization failure surfaces as an aborted transaction — the run fails closed
with no partial write, and is safe to re-run.

### 4.1 Connection string requirement — pooler endpoint ONLY

The environment↔database binding accepts **exactly** these hostnames and nothing
else:

| environment | the ONLY accepted hostname |
|---|---|
| `production` | `ep-wispy-morning-ab6f4o08-pooler.eu-west-2.aws.neon.tech` |
| `staging` | `ep-purple-voice-abfez796-pooler.eu-west-2.aws.neon.tech` |
| `local-test` | `127.0.0.1` |

This is deliberate. Comparison is exact string equality — no substring, prefix,
suffix or alias matching — which is what makes "production URL, `--environment
staging`" impossible.

**STOP condition — direct endpoint.** If `MINTVAULT_DATABASE_URL` points at the
**direct / non-pooler** Neon endpoint (for production that is
`ep-wispy-morning-ab6f4o08.eu-west-2.aws.neon.tech`, i.e. the same name *without*
`-pooler`), every script in this package will **refuse** with
`database host does not belong to "production"`. That is correct behaviour, not
a bug.

- **Do not** edit `ENVIRONMENTS` in `scripts/db/designation-catalogue-contract.ts`
  to admit the direct endpoint. Do not pass a different `--environment`. Do not
  weaken or bypass the guard in any way.
- **Do** obtain the approved **pooler** connection string and export it as
  `MINTVAULT_DATABASE_URL` for the window.
- **Never** paste, echo, log or commit the connection string. Do not put it in
  this runbook, in the change log, or in a chat message.
- Verify the endpoint **only** via the `db host :` line the scripts print — they
  print the hostname alone and never the credentials.

Note that `migrate.ts` (Phase B) has no such host guard; the branch/commit checks
in Phase B step B1 are what bind it to the right target.

## 5. Scope

Writes `catalogue_items` only. Never touches certificates, grading, MVGS,
Pristine/P10, centering, image analysis, labels, certificate rendering,
`cert_counter`, the schema, or the migration journal.

---

## 6. Production change window

### 6.0 The window runs in TWO phases, in TWO DIFFERENT WORKTREES

This is the single most important operational fact in this document, and the
one that the final hostile review found wrong in the previous version.

| | Phase A — reconciliation | Phase B — migration + deploy |
|---|---|---|
| **PR** | #261 (this one) | #259 |
| **Branch** | `ops/production-designation-reconciliation` | `integration/grading-workspace-consolidation` |
| **Worktree** | `/Users/cornelius/mintvault-ops-designation-reconciliation` | `/Users/cornelius/mintvault-grading-workspace-consolidation` |
| **Commit** | `869e5ea38f39625b356ec90bf1bc49db48ad21f1` (pinned, reviewed) | the separately approved #259 head — **re-verify at execution time** |
| **Contains migration 0026?** | ❌ **NO** | ✅ yes (`migrations/0026_catalogue_abbreviation_unique.sql`) |
| **Is an application release branch?** | ❌ **NO — tooling only** | ✅ yes |

**PR #261 contains operational tooling only. It is NOT the application release
branch.** Migration 0026 does not exist in the PR #261 tree, and neither does
`migrations/rollback-0026-catalogue-abbreviation-unique.sql`. Therefore:

- 🚫 **Never run `scripts/db/migrate.ts` (with or without `--apply`) from the
  PR #261 worktree.** From there `0026` is simply not on disk, so the runner
  prints the *success-shaped* lines `(dry-run) pending: none.` and
  `✓ Applied 0: none` while applying nothing. A zero exit code from that
  worktree is **not** proof that 0026 was applied.
- 🚫 **Never run `scripts/safe-deploy.sh` from the PR #261 worktree.** It
  deploys whatever is checked out. Its GUARD 1 only refuses a checkout that is
  *behind* `origin/main`; `ops/production-designation-reconciliation` is
  *ahead* of `origin/main`, so **GUARD 1 will not stop you** — it would happily
  ship the ops branch to production as the application.

**Approval boundaries.** Read-only steps need no further approval. Three
protected actions each require the owner's explicit go-ahead **at the moment of
execution**, separately:
`A6` (execute reconciliation) · `B4` (apply migration 0026) · `B7` (deploy).

**FREEZE.** From `A3` (backup) until `B8` (post-deploy verification passes) no
one may edit the Catalogue Manager. Announce the freeze before starting. The
reconciliation aborts if the catalogue changes mid-run, but the freeze avoids a
wasted window.

**Never batch steps. Never improvise a branch or worktree change during the
window. Stop on the first unexpected output.**

### 6.1 Master sequence (the map — details in §6.A and §6.B)

1. Obtain separate production authorisation for this window.
2. Freeze Catalogue Manager edits (announce it).
3. Enter the **PR #261** operations worktree.
4. Verify the exact PR #261 commit `869e5ea3…`.
5. Verify the pooler hostname and the production confirmation flags.
6. Create the backup **outside** the repository.
7. Verify and record the backup SHA-256.
8. Run the reconciliation **dry run**.
9. Execute the reconciliation 🔴.
10. Verify the reconciled catalogue state (10 live + 3 archived).
11. Verify zero certificates carry designations.
12. Record the rollback decision point (§7) — decide before leaving Phase A.
13. **Leave the PR #261 worktree.**
14. Enter the separately approved **PR #259** integration/release worktree.
15. Verify branch, exact commit, clean worktree, and 0026 present on disk.
16. Run the migration inventory (read-only).
17. Run the exact migration 0026 duplicate precondition (read-only).
18. Apply migration 0026 through the numbered migration runner 🔴.
19. Verify the journal record **and** the exact index name
    `uq_catalogue_items_live_effective_code` (re-confirm it from the 0026 file
    in the PR #259 worktree — never from this document alone).
20. Run post-migration catalogue and certificate checks.
21. Deploy the approved PR #259 / release commit — **only** after separate
    deployment authorisation 🔴.
22. Verify health, version, machines and production behaviour.
23. Release the Catalogue Manager freeze.
24. Merge or close PR #261 only after the completed window and evidence capture.

**Explicitly prohibited throughout:** `npm run db:push` / `drizzle-kit push`;
running migration 0026 from PR #261; deploying PR #261 as the application
release; continuing after any unexpected output; improvising a branch or
worktree change mid-window.

---

## 6.A PHASE A — PR #261 operations worktree (reconciliation only)

**Everything in Phase A runs from the pinned, reviewed PR #261 commit.**
Nothing in Phase A applies a migration or deploys anything.

### Step A1 — enter the worktree and pin the commit
```bash
cd /Users/cornelius/mintvault-ops-designation-reconciliation
git branch --show-current
git rev-parse HEAD
git status --short
```
- **Expected branch:** `ops/production-designation-reconciliation`
- **Expected commit:** `869e5ea38f39625b356ec90bf1bc49db48ad21f1`
- **Expected status:** empty (clean worktree)
- **PASS:** all three match exactly.
- **STOP if:** the branch differs · the commit is not `869e5ea3…` · the worktree
  is dirty · `git fetch origin && git status -sb` shows unexpected remote
  movement on this branch. Re-review before continuing.

### Step A2 — set the window variables (read-only)
```bash
export MINTVAULT_DATABASE_URL='<approved production POOLER connection string>'
export PROD_SHA=e6c7c1394b2cedee9033be76df3b2a93d788b2b3
export PROD_DB=ep-wispy-morning-ab6f4o08-pooler.eu-west-2.aws.neon.tech
curl -s https://mintvault.fly.dev/api/version
```
- **Expected hostname:** `ep-wispy-morning-ab6f4o08-pooler.eu-west-2.aws.neon.tech`
  (pooler — see §4.1; the direct endpoint is refused by design)
- **Expected application SHA:** `"commit":"e6c7c139"` (short form of `$PROD_SHA`)
- **PASS:** the live commit is `e6c7c139`.
- **STOP if:** the live commit differs — production has moved since review;
  re-review the whole package before continuing.
- **Never** echo, log or paste `MINTVAULT_DATABASE_URL`. Confirm the endpoint
  only from the `db host :` line the scripts print.

### Step A3 — export the catalogue backup (read-only) 🔒 FREEZE STARTS
```bash
npx tsx scripts/db/export-catalogue-backup.ts \
  --environment production --expected-db-host "$PROD_DB"
```
- **Expected:** `db host : ep-wispy-morning-ab6f4o08-pooler.eu-west-2.aws.neon.tech (exact match for production)`;
  `catalogue rows : 96`; `certificates : 700 (with designations: 0)`; a printed
  `sha256`; a `0600` file under `~/Downloads/mintvault-production-backups/`.
- **PASS:** the file exists, the counts match, and the SHA-256 is recorded in the
  change log.
- **STOP if:** the catalogue row count is not 96 · any certificate carries a
  designation · the command refuses for any reason · no file was written.

### Step A4 — verify the backup checksum (read-only)
```bash
shasum -a 256 ~/Downloads/mintvault-production-backups/catalogue-backup-production-*.json
```
- **PASS:** the digest equals the `sha256` printed in step A3. Record both.
- **STOP if:** they differ, or more than one unexpected file matches.

### Step A5 — reconciliation dry run (read-only, writes nothing)
```bash
npx tsx scripts/db/reconcile-designation-catalogue.ts \
  --environment production --expected-db-host "$PROD_DB"
```
- **Expected:** `mode : DRY RUN (no writes)`;
  `certificates: 700 total, 0 with designations`; six BEFORE rows all with
  `abbr=null`; `PLAN (13 actions)` = **3 UPDATE, 7 CREATE, 3 ARCHIVE**;
  `DRY RUN — nothing was written.`
- **PASS:** exactly 13 actions, and the printed plan reviewed **line by line**
  against the §3 contract table.
- **STOP if:** the action count is not 13 · any certificate carries a
  designation · the script refuses (unknown catalogue state, pre-set
  abbreviation, archived canonical row, duplicate effective code,
  cross-category conflict). Do not "fix it up" by hand — re-review.

### Step A6 — execute the reconciliation 🔴 OWNER APPROVAL REQUIRED
```bash
npx tsx scripts/db/reconcile-designation-catalogue.ts \
  --environment production --apply --confirm-production \
  --expected-app-sha "$PROD_SHA" --expected-db-host "$PROD_DB"
```
- **Expected:** `mode : APPLY`;
  `app commit : e6c7c139 (full SHA confirmed against git)`;
  ten AFTER rows carrying the canonical abbreviations; and
  `✔ committed 13 actions in one SERIALIZABLE transaction.`
- **PASS:** the exact `✔ committed 13 actions` line, and ten AFTER rows.
- **STOP if:** anything else. The whole run is one SERIALIZABLE transaction, so
  a failure means **nothing was written** — diagnose before any retry. Do not
  retry blind; re-run step A5 first and confirm the plan is still 13 actions.

### Step A7 — verify the reconciled catalogue (read-only)
```sql
SELECT value, abbreviation, label, active, archived
  FROM catalogue_items
 WHERE category = 'designation'
 ORDER BY archived, sort_order, id;
```
- **Expected:** **10 live rows** (`active = true`, `archived = false`) whose
  `value`/`abbreviation`/`label` match the §3 table exactly, plus **3 archived
  rows** (`error`, `misprint`, `test_print`). 13 designation rows in total.
- **PASS:** 10 + 3, all fields matching §3.
- **STOP / ROLLBACK if:** any count or field differs — go to §7.

### Step A8 — verify zero certificates carry designations (read-only)
```sql
SELECT count(*) AS with_designations
  FROM certificates
 WHERE jsonb_array_length(COALESCE(designations, '[]'::jsonb)) > 0;   -- expect 0
SELECT count(*) AS total_certificates FROM certificates;              -- expect 700
```
- **PASS:** `with_designations = 0` and `total_certificates = 700`.
- **STOP / ROLLBACK if:** either differs — the estate is no longer the one this
  package was approved for. Go to §7.

### Step A9 — rollback decision point (mandatory, recorded)
Decide **now**, before leaving this worktree, whether Phase A stands or is
rolled back. See §7. Record the decision, the timestamp and the backup SHA-256
in the change log. Do not proceed to Phase B on an unresolved doubt.

---

## 6.B PHASE B — PR #259 integration/release worktree (migration + deploy)

> 🚪 **Leave the PR #261 worktree now.** Nothing below runs from
> `ops/production-designation-reconciliation`.

### Step B1 — enter the PR #259 worktree and verify it 🚦 HARD GATE
```bash
cd /Users/cornelius/mintvault-grading-workspace-consolidation
git fetch origin
git branch --show-current
git rev-parse HEAD
git status --short
ls -1 migrations/0026_catalogue_abbreviation_unique.sql
ls -1 migrations/rollback-0026-catalogue-abbreviation-unique.sql
```
- **Expected branch:** `integration/grading-workspace-consolidation`
- **Expected commit:** the **separately approved PR #259 head**. At the time this
  runbook was written that was
  `d59311b9feb20342d9bd9938d743e7777eba6315` — this value is **informational
  only**. The operator MUST confirm the currently approved exact commit with the
  owner immediately before execution and use that.
- **Expected status:** empty (clean worktree)
- **Expected files:** both `ls` commands print a path (0026 and its rollback are
  present on disk).
- **PASS:** branch matches · commit equals the *currently approved* #259 SHA ·
  worktree clean · both migration files present.
- **STOP if:** the wrong branch is checked out · the exact approved commit does
  not match · `migrations/0026_catalogue_abbreviation_unique.sql` is absent ·
  the worktree is dirty · `git status -sb` shows unexpected remote movement.
  **Do not improvise** a checkout, cherry-pick or rebase to make it match.

### Step B2 — migration inventory (read-only)
```bash
npx tsx scripts/db/migrate.ts
```
- **Expected:**
  `Migrations: <N> total, <N-1> applied, 1 pending, 0 inconsistent, 0 checksum-mismatch.`
  followed by
  `(dry-run) pending: 0026_catalogue_abbreviation_unique.sql. Re-run with --apply to execute.`
- **PASS:** `0026_catalogue_abbreviation_unique.sql` is named as pending, with
  **0 inconsistent** and **0 checksum-mismatch**.
- **STOP if:** the output says `pending: none` — that means you are in the wrong
  worktree (0026 is not on disk), **not** that the migration is already applied.
  Also STOP on any inconsistent journal entry or checksum mismatch.

### Step B3 — migration 0026 duplicate precondition (read-only, must return **zero rows**)

This query is copied from migration 0026's own guarded `DO` block at the
approved PR #259 head — **same expression, same filter, same grouping**. Run it
against the *authoritative* file in this worktree, not from memory:

```bash
sed -n '/SELECT string_agg/,/) dupes;/p' migrations/0026_catalogue_abbreviation_unique.sql
```

```sql
SELECT lower(coalesce(nullif(btrim(abbreviation), ''), btrim(value))) AS code,
       count(*) AS n
  FROM catalogue_items
 WHERE active = TRUE
   AND archived = FALSE
   AND category IN ('designation', 'attribute')
   AND btrim(coalesce(nullif(btrim(abbreviation), ''), btrim(value))) <> ''
 GROUP BY 1
HAVING count(*) > 1;
```

**Why only `designation` and `attribute`, and why one shared namespace.**
`CATALOGUE_CATEGORIES` is `rarity`, `finish`, `promo`, `designation`,
`language`, `era`, `subset`, `attribute`. Of those, only `designation` and
`attribute` persist `abbreviation || value` (`mapDesignationRow` in
`shared/catalogue-snapshot.ts`), and both write into the *same*
`certificates.designations` array — so they share ONE persisted-code namespace
and are grouped by code alone, not by `(category, code)`. Every other category
persists its `value` and is already covered by 0019's per-category `value`
uniqueness. This scope is deliberate: an earlier revision of 0026 applied the
rule to every category and aborted against real staging data, flagging 7
legitimate live `rarity` collisions (EN/JP pairs that intentionally share a
printed abbreviation, e.g. `hyper_rare`/`jp_hyper_rare` = "HR"). **Do not
broaden this query** — a broadened version will report false duplicates and stop
the window for no reason.

- **PASS:** **zero rows returned** — the duplicate precondition passes.
- **STOP if:** **any** row is returned. 0026 will abort with
  `0026 BLOCKED: catalogue_items already contains live rows that persist the
  same code: …`. Reconcile the offending rows (change an abbreviation, or
  archive/deactivate the duplicate) under separate approval and re-run this
  check. Do not proceed.
- **Migration 0026's own `DO` block remains authoritative.** This query is a
  pre-check for the operator's benefit only. **If this precheck and the
  migration disagree in either direction — precheck clean but 0026 blocks, or
  precheck dirty but 0026 succeeds — STOP immediately** and escalate; a
  disagreement means the runbook and the migration have drifted apart and
  neither result can be trusted.

### Step B4 — apply migration 0026 🔴 OWNER APPROVAL REQUIRED
```bash
npx tsx scripts/db/migrate.ts --apply
```
- **Expected:** `✓ Applied 1: 0026_catalogue_abbreviation_unique.sql`
- **PASS:** exactly that line, naming 0026.
- **STOP if:** the output is `✓ Applied 0: none` — nothing was applied (almost
  certainly the wrong worktree; return to B1). A zero exit code alone is **not**
  proof. Also STOP on any `🚫 BLOCKED` / `0026 BLOCKED` message.
- 🚫 **Never** use `npm run db:push` / `drizzle-kit push` — it does not honour
  the journal and can drift or drop.
- 🚫 **Never** run this step without the inventory from B2 and the precondition
  from B3 both passing in this same worktree, in this order.

### Step B5 — verify the migration record AND the exact index name (read-only)
```sql
-- 1) journal record
SELECT filename, status
  FROM schema_migrations
 WHERE filename = '0026_catalogue_abbreviation_unique.sql';

-- 2) the index 0026 actually creates
SELECT indexname
  FROM pg_indexes
 WHERE tablename = 'catalogue_items'
   AND indexname = 'uq_catalogue_items_live_effective_code';
```
- **Expected result of (1):** exactly **one row** —
  `0026_catalogue_abbreviation_unique.sql | applied`.
- **Expected result of (2):** exactly **one row** —
  `uq_catalogue_items_live_effective_code`.
- **Exact index name:** `uq_catalogue_items_live_effective_code`. Confirm it
  against the authoritative file in *this* worktree rather than trusting this
  document:
  ```bash
  grep -n 'CREATE UNIQUE INDEX' migrations/0026_catalogue_abbreviation_unique.sql
  ```
  0026 issues `DROP INDEX IF EXISTS` before `CREATE UNIQUE INDEX` on that name,
  so re-running it converges on the current scope rather than leaving a stale,
  over-broad index of the same name behind.
- **PASS:** both queries return exactly one row, and the index name matches the
  `CREATE UNIQUE INDEX` line printed by the `grep` above.
- **STOP if:** either returns zero rows. Note the failure mode this guards
  against: `migrate.ts` can exit zero having applied nothing. **Neither a zero
  exit code nor an absent error is proof — the two rows above are the proof.**

### Step B6 — post-migration catalogue and certificate checks (read-only)
```sql
SELECT value, abbreviation, archived FROM catalogue_items
 WHERE category = 'designation' ORDER BY archived, sort_order, id;  -- 10 live + 3 archived
SELECT count(*) FROM certificates
 WHERE jsonb_array_length(COALESCE(designations,'[]'::jsonb)) > 0;  -- expect 0
SELECT count(*) FROM certificates;                                  -- expect 700
```
- **PASS:** 10 live + 3 archived designation rows; `0` certificates with
  designations; `700` certificates total.
- **STOP / ROLLBACK if:** any value differs — go to §7 (and note 0026 itself is
  additive and harmless on the restored baseline).

### Step B7 — deploy the approved release 🔴 SEPARATE DEPLOYMENT AUTHORISATION REQUIRED

> **This runbook does not authorise a deploy.** Deployment is a separate
> protected action requiring the owner's explicit go-ahead at the moment of
> execution, on top of the approval for the reconciliation window.

Immediately before deploying, re-verify **in the deploy worktree**:
```bash
git branch --show-current   # expected: integration/grading-workspace-consolidation
git rev-parse HEAD          # expected: the approved PR #259 / release commit
git status --short          # expected: empty
```
- 🚫 **STOP IMMEDIATELY if `git branch --show-current` prints
  `ops/production-designation-reconciliation`.** PR #261 is operational tooling,
  **not** the application release branch. Deploying it would ship the ops branch
  as the application. `safe-deploy.sh` will **not** catch this: its GUARD 1 only
  refuses a checkout that is *behind* `origin/main`, and the ops branch is
  *ahead* of it.
- **STOP if:** the branch is anything other than the approved release branch ·
  the commit is not the approved release commit · the worktree is dirty.

```bash
scripts/safe-deploy.sh prod
```
- **Deployment target:** Fly app `mintvault` (config `fly.toml`, host
  `https://mintvault.fly.dev`).
- **Approved SHA:** `<APPROVED_RELEASE_SHA — confirm with the owner immediately
  before running; must equal the `git rev-parse HEAD` printed above>`.
- All existing `safe-deploy.sh` requirements still apply: GUARD 1 (not behind
  `origin/main`) and GUARD 2 (poll `/api/version` until the live server reports
  the exact commit just built).
- **PASS:** `safe-deploy.sh` exits zero **and** GUARD 2 confirms the live commit.
- **STOP if:** GUARD 2 never confirms — use the rollback command the script
  prints. Do not re-run the deploy blind.

### Step B8 — production verification 🔓 FREEZE ENDS after this passes
```bash
curl -s https://mintvault.fly.dev/api/version   # expect the approved release commit
curl -s https://mintvault.fly.dev/api/health    # expect status ok, db ok
fly status -a mintvault                         # expect all machines on the new release
```
- **Expected application SHA:** the short form of the approved release commit
  verified in B7 — **not** `e6c7c139`, and **never** the PR #261 commit
  `869e5ea3`. Seeing `869e5ea3` here means the wrong branch was deployed:
  **STOP and roll the deploy back immediately.**
- Then in the UI: `/api/catalogue/snapshot` → `snapshot.designations` contains
  the ten canonical codes; the Card Details picker shows ten options with no
  `test_print`.
- **PASS:** version matches, health ok, machines all on the new release, picker
  shows the ten canonical options.
- **STOP if:** any check fails — roll the deploy back before touching the
  catalogue (see §7 ordering).

### Step B9 — release the freeze, then close out
Announce that Catalogue Manager editing is unfrozen. Capture the evidence
(command output, backup SHA-256, timestamps) in the change log. Only then §9.

### Step B10 — PR #260
Land and deploy PR #260 promptly after its own final verification and separate
approval. It fixes the pre-existing hidden-autosave / Authentic-Only issues,
which are **not** in scope here.

---

## 7. Rollback decision point

**Decide at the end of Phase A (step A9)** — before entering the PR #259
worktree. If the reconciliation committed but the plan was wrong, or A7/A8 fail
in a way that implicates the catalogue, roll back **while still in Phase A**,
before migration 0026 (B4) and before any deploy (B7). After the release is
live, rolling the catalogue back without also reverting the deploy would leave
the picker broken — **revert the deploy first**, then roll the catalogue back.

Run the rollback **from the PR #261 worktree** (`git rev-parse HEAD` must still
be `869e5ea38f39625b356ec90bf1bc49db48ad21f1`):

```bash
# dry run
npx tsx scripts/db/rollback-designation-catalogue.ts \
  --environment production --expected-db-host "$PROD_DB"

# apply  🔴 OWNER APPROVAL REQUIRED
npx tsx scripts/db/rollback-designation-catalogue.ts \
  --environment production --apply --confirm-production \
  --expected-app-sha "$PROD_SHA" --expected-db-host "$PROD_DB"
```

Restores `abbreviation = NULL` on the three pre-existing rows, deletes **only**
rows carrying `created_by = 'ops:reconcile-designation-catalogue'`, and
un-archives `error` / `misprint` / `test_print`. Refuses if any canonical row
was created by someone else, or if any certificate has since stored a
designation. Single SERIALIZABLE transaction; per-row audit records.

Migration 0026 is **not** reverted by this rollback — it is additive and
harmless on the restored baseline. If it must be removed, that is a separate
protected action run from the **PR #259 worktree** using
`migrations/rollback-0026-catalogue-abbreviation-unique.sql`, which — like 0026
itself — does **not** exist in the PR #261 tree.

**Known incompleteness (harmless, stated for the record):** the rollback
restores `abbreviation = NULL` but leaves the canonical `description` text on
`unlimited` / `first_edition` / `shadowless` (the seeder left those blank). This
is cosmetic, the rows still classify as the approved baseline, and a subsequent
re-run of the reconciliation is unaffected.

## 8. Backups

Written **outside the repository**, default
`~/Downloads/mintvault-production-backups/`, filename
`catalogue-backup-<environment>-<timestamp>.json`, mode `0600`, with a printed
SHA-256. The exporter refuses an inside-repo destination, symlink redirection,
and silent overwrite. `.gitignore` carries `catalogue-backup-*.json` and
`mintvault-production-backups/` as a second line of defence. The backup contains
catalogue rows and the DB **hostname** only — never a connection string.

## 9. Merge or execute from the reviewed commit?

**Execute Phase A from the reviewed commit in the PR #261 worktree. Do not merge
PR #261 first.**

Merging would put an operational script that mutates production onto `main`,
where it becomes part of every future deploy artifact and can be run by anyone
with a checkout. The package's value is that it is reviewed, pinned and executed
once under supervision. Verify with `git rev-parse HEAD` immediately before step
A6. Merge (or close) PR #261 only **after** the completed change window and
evidence capture, as a record — never as a way to get the scripts onto a release
branch.

**PR #261 is never deployed.** It carries no application change (see §5 and the
tree-hash evidence in the review record): `client/`, `server/`, `shared/`,
`migrations/`, `package.json` and `.github/` are byte-identical to
`origin/main@e6c7c139`. It is operational tooling plus this document. The
application release is PR #259 (and later PR #260), deployed from their own
worktrees in Phase B under separate authorisation.

## 10. Verification evidence (disposable PostgreSQL 17 + temp dirs only)

`tests/designation-catalogue-reconciliation.test.ts` — behavioural tests covering
the environment↔database binding, CLI/SHA hardening, contract fidelity against
both application sources, the `effectiveCatalogueCode` ⇄ 0026 SQL equivalence,
full-contract reconciliation, idempotency, rollback ownership, concurrency
fingerprinting, transaction rollback, and backup path safety.

The CLI itself was additionally exercised end-to-end against a throwaway
cluster: a local DB claimed as production was refused; a production-shaped host
labelled staging was refused; `--expected-db-host ep-` was refused; dry run
wrote nothing; apply produced exactly the ten canonical rows (7 create + 6
update audits); rerun was a no-op; rollback refused a human-created `promo` row
and, once ownership was correct, restored the exact six-row baseline with 13
audit rows; the backup refused an inside-repo path and wrote a clean file
outside it. **No staging or production database was involved in any of this.**

**Coverage boundary (stated honestly).** The automated tests exercise the shared
contract module (`scripts/db/designation-catalogue-contract.ts`) and a
transaction re-implementation inside the test file. They do **not** invoke
`main()` of the three executables. The executables' end-to-end behaviour is
evidenced by the manual throwaway-cluster run described above, not by CI. That
is why every protected step in §6 specifies an **observable database or HTTP
result** as its PASS criterion rather than a zero exit code.

---

## 11. Document revision record

| Date | Change | Trigger |
|---|---|---|
| — | Initial runbook | PR #261 `4c792e49` |
| — | Guard hardening described | PR #261 `869e5ea3` |
| 2026-07-27 | **Documentation-only remediation** — no code, script, test or migration change. Split the window into Phase A (PR #261 worktree) and Phase B (PR #259 worktree) with hard branch/commit/clean-tree/0026-present gates; forbade running `migrate.ts` or `safe-deploy.sh` from PR #261, and documented why `safe-deploy.sh` GUARD 1 does **not** protect against it (the ops branch is *ahead* of `origin/main`, not behind); documented that `migrate.ts` in the PR #261 worktree prints the success-shaped `pending: none` / `✓ Applied 0: none` while applying nothing; added §4.1 pooler-endpoint-only requirement and its STOP condition; added explicit expected-output / PASS / STOP / ROLLBACK criteria to every protected step; pinned the 0026 precondition and index name to the authoritative file in the PR #259 worktree with `grep`/`sed` re-verification. | Final independent hostile re-review of `869e5ea3` (findings H2, H3, M4) |

**Correction recorded (2026-07-27).** The re-review initially raised two further
findings — a wrong index name (`uq_catalogue_items_live_effective_code`) and an
over-narrow duplicate precondition — after reading migration 0026 at the
superseded commit `b6c02af2`. The authoritative 0026 at PR #259's head revises
both: the index **is** `uq_catalogue_items_live_effective_code`, and the
precondition **is** correctly scoped to `('designation','attribute')` grouped by
code alone. **The runbook was already right on both points and has not been
changed.** Acting on those two findings would have made step B5 look for an
index that is never created and made step B3 halt the window on 7 legitimate
`rarity` collisions. Verify both against the file in the PR #259 worktree at
execution time (steps B3 and B5 tell you how).

**No production or staging database was contacted while preparing this
revision, and no production execution has occurred.**
