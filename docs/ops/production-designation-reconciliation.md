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

**Known concurrency limitation (stated honestly):** `SELECT … FOR UPDATE`
cannot lock rows that do not yet exist, so a *phantom* insert of a designation
row concurrent with the run is prevented by `SERIALIZABLE` isolation plus the
`(category, value)` unique index rather than by row locks. Under Neon's pooler a
serialization failure surfaces as an aborted transaction — the run fails closed
with no partial write, and is safe to re-run.

## 5. Scope

Writes `catalogue_items` only. Never touches certificates, grading, MVGS,
Pristine/P10, centering, image analysis, labels, certificate rendering,
`cert_counter`, the schema, or the migration journal.

---

## 6. Production change window — exact sequence

> Execute from the **reviewed commit** in a dedicated worktree — do **not** merge
> PR #261 first (see §9). Each step is gated on the previous one. Do not batch.
>
> **FREEZE:** from step 2 (backup) through step 10 (verification), no one may
> edit the Catalogue Manager. Announce the freeze before starting. The
> reconciliation aborts if the catalogue changes mid-run, but the freeze avoids
> a wasted window.
>
> **Approval boundary:** steps 1–3 are read-only and need no further approval.
> **Steps 4, 7 and 9 are protected actions requiring the owner's explicit
> go-ahead at the moment of execution.**

```bash
cd /Users/cornelius/mintvault-ops-designation-reconciliation
git rev-parse HEAD          # must equal the reviewed PR #261 commit
export MINTVAULT_DATABASE_URL='<production connection string>'
export PROD_SHA=e6c7c1394b2cedee9033be76df3b2a93d788b2b3
export PROD_DB=ep-wispy-morning-ab6f4o08-pooler.eu-west-2.aws.neon.tech
```

### Step 1 — confirm app version and database identity (read-only)
```bash
curl -s https://mintvault.fly.dev/api/version
```
**Expect:** `"commit":"e6c7c139"`.
**STOP if:** the commit differs — production has moved; re-review before continuing.

### Step 2 — export the catalogue backup (read-only) 🔒 FREEZE STARTS
```bash
npx tsx scripts/db/export-catalogue-backup.ts \
  --environment production --expected-db-host "$PROD_DB"
```
**Expect:** `catalogue rows : 96`, a `sha256`, and a file under
`~/Downloads/mintvault-production-backups/`.
**STOP if:** the row count is not 96, or the command refuses.
Record the sha256 in the change log.

### Step 3 — reconciliation dry run
```bash
npx tsx scripts/db/reconcile-designation-catalogue.ts \
  --environment production --expected-db-host "$PROD_DB"
```
**Expect:** `certificates: 700 total, 0 with designations`, six BEFORE rows, and
`PLAN (13 actions)` — 3 UPDATE, 7 CREATE, 3 ARCHIVE.
**STOP if:** the action count is not 13, any certificate carries a designation,
or the script refuses. **Review the printed plan line by line before step 4.**

### Step 4 — execute the reconciliation 🔴 OWNER APPROVAL REQUIRED
```bash
npx tsx scripts/db/reconcile-designation-catalogue.ts \
  --environment production --apply --confirm-production \
  --expected-app-sha "$PROD_SHA" --expected-db-host "$PROD_DB"
```
**Expect:** `✔ committed 13 actions in one SERIALIZABLE transaction.` and ten
AFTER rows with the canonical abbreviations.
**STOP if:** anything other than a clean commit — the transaction rolls back
whole, so a failure means **nothing was written**; diagnose before retrying.

### Step 5 — migration 0026 precondition (read-only, must return **zero rows**)
```sql
SELECT lower(coalesce(nullif(btrim(abbreviation), ''), btrim(value))) AS code,
       count(*) AS n
  FROM catalogue_items
 WHERE active = TRUE AND archived = FALSE
   AND category IN ('designation', 'attribute')
   AND btrim(coalesce(nullif(btrim(abbreviation), ''), btrim(value))) <> ''
 GROUP BY 1 HAVING count(*) > 1;
```
**STOP if:** any row is returned — 0026 would abort. Do not proceed.

### Step 6 — migration 0026 plan (read-only)
```bash
npx tsx scripts/db/migrate.ts
```
**Expect:** `pending: 0026_catalogue_abbreviation_unique.sql`, 0 inconsistent,
0 checksum-mismatch.

### Step 7 — apply migration 0026 🔴 OWNER APPROVAL REQUIRED
```bash
npx tsx scripts/db/migrate.ts --apply
```
**Never** use `db:push`. **Never** run without the plan from step 6.

### Step 8 — verify the unique index
```sql
SELECT indexname FROM pg_indexes
 WHERE tablename = 'catalogue_items'
   AND indexname = 'uq_catalogue_items_live_effective_code';
```
**Expect:** one row.

### Step 9 — deploy PR #259 🔴 OWNER APPROVAL REQUIRED
```bash
scripts/safe-deploy.sh prod
```

### Step 10 — production verification 🔓 FREEZE ENDS after this passes
```bash
curl -s https://mintvault.fly.dev/api/version      # expect the #259 commit
curl -s https://mintvault.fly.dev/api/health       # expect status ok, db ok
```
```sql
-- catalogue after
SELECT value, abbreviation, archived FROM catalogue_items
 WHERE category='designation' ORDER BY archived, sort_order, id;   -- 10 live + 3 archived
-- certificate designation count MUST still be zero
SELECT count(*) FROM certificates
 WHERE jsonb_array_length(COALESCE(designations,'[]'::jsonb)) > 0; -- expect 0
-- certificate count unchanged
SELECT count(*) FROM certificates;                                  -- expect 700
```
Then in the UI: `/api/catalogue/snapshot` → `snapshot.designations` has the ten
canonical codes; the Card Details picker shows ten options with no `test_print`.

### Step 11 — PR #260
Land and deploy PR #260 promptly after its own final verification and separate
approval. It fixes the pre-existing hidden-autosave / Authentic-Only issues,
which are **not** in scope here.

---

## 7. Rollback decision point

**Decide at the end of step 4.** If the reconciliation committed but the plan
was wrong, or step 5/8 fails in a way that implicates the catalogue, roll back
**before** deploying #259 (step 9). After #259 is live, rolling the catalogue
back without also reverting the deploy would leave the picker broken — revert
the deploy first.

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
harmless on the restored baseline. To remove it, use
`migrations/rollback-0026-catalogue-abbreviation-unique.sql`.

## 8. Backups

Written **outside the repository**, default
`~/Downloads/mintvault-production-backups/`, filename
`catalogue-backup-<environment>-<timestamp>.json`, mode `0600`, with a printed
SHA-256. The exporter refuses an inside-repo destination, symlink redirection,
and silent overwrite. `.gitignore` carries `catalogue-backup-*.json` and
`mintvault-production-backups/` as a second line of defence. The backup contains
catalogue rows and the DB **hostname** only — never a connection string.

## 9. Merge or execute from the reviewed commit?

**Execute from the reviewed commit in this worktree. Do not merge PR #261
first.**

Merging would put an operational script that mutates production onto `main`,
where it becomes part of every future deploy artifact and can be run by anyone
with a checkout. The package's value is that it is reviewed, pinned and executed
once under supervision. Verify with `git rev-parse HEAD` immediately before
step 4. Merge (or close) PR #261 only **after** the change window, as a record.

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
