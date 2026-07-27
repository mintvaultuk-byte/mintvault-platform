# Production designation-catalogue reconciliation (PR #259)

**Status: PREPARATION ONLY — nothing in this package has been executed against production.**

## Why

PR #259 switches the Card Details designation picker from the hard-coded
`DESIGNATION_OPTIONS` array to the DB-backed catalogue. Production's catalogue was
seeded with lowercase internal values and **no abbreviations**, so after #259 ships
the picker would present the wrong option set and persist codes that
`DESIGNATION_LABELS` (`server/routes.ts`) cannot resolve.

This package makes production's catalogue match the canonical contract. The same
reconciliation has already been applied to staging and verified end to end.

## Two facts that bound the risk

1. **No certificate stores a designation.** Production: 700 certificates, **0** with
   a non-empty `designations` array. Staging: 259, also 0. There is no historical
   data to orphan and no certificate rewrite is required.
2. **The change is inert until #259 deploys.** Pre-#259 `buildSnapshotFromRows`
   emits no `designations` key and there is no `mapDesignationRow`, so the running
   production app does not read designation rows at all. The reconciliation can be
   run safely in advance of the deploy.

## Canonical contract

Ten codes, verified against **both** pre-#259 sources (a test asserts this):

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

`error` and `misprint` are **absorbed** by `ERROR_MISCUT` (they appear in its alias
list). `test_print` is **excluded** — it was never a historical persisted code.
All three are **archived, never deleted**, so they remain readable and are exempt
from migration 0026's uniqueness rule.

## What the script does

3 updates (add abbreviations) · 7 creates · 3 archives = **13 actions in one
transaction**. Rows are resolved by `(category, value)` — **never** by hard-coded id.

## Safety guards (all fail closed, before any write)

| Guard | Behaviour |
|---|---|
| `--environment` | must be exactly `staging` or `production` |
| default mode | **dry run** — `--apply` is required to write |
| `--confirm-production` | required for `--apply` against production |
| `--expected-app-sha` | compared to the live `/api/version`; mismatch refuses |
| `--expected-db-host` | must be a substring of the connection host; mismatch refuses |
| certificate check | refuses if **any** certificate stores a designation |
| baseline check | refuses unless the inventory is the approved 6-row baseline (or already reconciled → no-op) |
| cross-category check | uses the shared `catalogueConflict` validator |
| duplicate-code check | pre-flight **and** again inside the transaction before COMMIT |
| transaction | single `BEGIN`/`COMMIT`; any error triggers `ROLLBACK` |
| credentials | only the DB **host** is ever printed |

The script never touches certificates, grading, MVGS, Pristine/P10, centering,
labels, `cert_counter`, the schema, or the migration journal.

## Production change window — exact sequence

> Each step is gated on the previous one succeeding. Do not batch.

```bash
# 0. environment (set MINTVAULT_DATABASE_URL to the PRODUCTION connection string)
export MINTVAULT_DATABASE_URL='<production connection string>'
export PROD_SHA=e6c7c1394b2cedee9033be76df3b2a93d788b2b3
```

**1 — verify version and DB identity (read-only)**
```bash
curl -s https://mintvault.fly.dev/api/version
```

**2 — export a catalogue backup (read-only)**
```bash
curl -s -H "Cookie: <super-admin session>" \
  https://mintvault.fly.dev/api/admin/catalogue/export \
  > catalogue-backup-prod-$(date +%Y%m%dT%H%M%S).json
```
Or straight from the DB:
```bash
psql "$MINTVAULT_DATABASE_URL" -Atc \
  "SELECT json_agg(t) FROM (SELECT * FROM catalogue_items ORDER BY id) t" \
  > catalogue-backup-prod.json
```

**3 — dry run**
```bash
npx tsx scripts/db/reconcile-designation-catalogue.ts --environment production
```

**4 — apply (the approved change)**
```bash
npx tsx scripts/db/reconcile-designation-catalogue.ts \
  --environment production --apply --confirm-production \
  --expected-app-sha "$PROD_SHA" --expected-db-host ep-wispy-morning
```

**5 — migration 0026 precondition (read-only, must return zero rows)**
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

**6 — apply migration 0026** (approved runner; dry run first)
```bash
npx tsx scripts/db/migrate.ts            # plan only
npx tsx scripts/db/migrate.ts --apply    # applies 0026
```

**7 — verify the unique index**
```sql
SELECT indexname FROM pg_indexes
 WHERE tablename = 'catalogue_items'
   AND indexname = 'uq_catalogue_items_live_effective_code';
```

**8 — deploy PR #259**
```bash
scripts/safe-deploy.sh prod
```

**9 — production verification checklist**
- `/api/version` reports the #259 commit
- `/api/catalogue/snapshot` → `snapshot.designations` has the 10 canonical codes
- the Card Details picker renders 10 options, no `test_print`
- a disposable save stores e.g. `["FIRST_EDITION"]`, and Review renders "1st Edition"
- `certificates` count unchanged

**10 — land and deploy PR #260** once separately approved (it fixes the
pre-existing hidden-autosave / Authentic-Only issues, which are **not** in scope here).

## Rollback

```bash
# dry run
npx tsx scripts/db/rollback-designation-catalogue.ts --environment production

# apply
npx tsx scripts/db/rollback-designation-catalogue.ts \
  --environment production --apply --confirm-production \
  --expected-app-sha "$PROD_SHA" --expected-db-host ep-wispy-morning
```

Restores `abbreviation = NULL` on the three pre-existing rows, **deletes only the
seven rows the reconciliation created**, and un-archives `error` / `misprint` /
`test_print`. Same guard surface; single transaction; refuses if any certificate
has since stored a designation (which would make deletion unsafe). Unrelated
catalogue rows are never touched.

Migration 0026 is **not** reverted by this rollback — it is additive and harmless
on the restored baseline (the baseline has no duplicate effective codes). If it
must be removed, use `migrations/rollback-0026-catalogue-abbreviation-unique.sql`.

## Verification evidence (disposable PostgreSQL 17, never staging or production)

`tests/designation-catalogue-reconciliation.test.ts` — 25 tests covering the
contract-vs-application match, the `effectiveCatalogueCode` ⇄ SQL equivalence,
planning, apply, idempotent rerun, rollback, and every fail-closed inventory.

The CLI itself was additionally exercised end-to-end against a throwaway cluster:
dry run wrote nothing; all six guards refused; apply produced exactly the ten
canonical rows with 7 create + 6 update audit rows; rerun was a no-op; rollback
restored the exact six-row baseline; certificates and unrelated rows unchanged.
