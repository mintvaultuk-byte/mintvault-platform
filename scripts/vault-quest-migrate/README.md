# Vault Quest data-separation migration scripts (Phase 2)

Rehearse — and later execute — moving Vault Quest's data onto its own dedicated
Neon database and R2 bucket. **These scripts never write to the current shared
(source) database or grading bucket, are dry-run by default, and refuse the
grading production host.** They target the *new* dedicated Vault Quest resources.

> Phase 2 is **staging only**. Do not point these at any production resource.

## SOURCE vs DEST

| Role | Database | R2 |
|---|---|---|
| **SOURCE** (read-only) | `MINTVAULT_DATABASE_URL` (current shared staging) | `R2_*` + `R2_BUCKET_NAME` (grading bucket) |
| **DEST** (write) | `VAULT_QUEST_DATABASE_URL` (new dedicated staging DB) | `VAULT_QUEST_R2_*` + `VAULT_QUEST_R2_BUCKET` (new bucket) |

## Owner must create first (not yet available)

The dedicated Vault Quest staging resources do **not** exist yet. Before these
scripts can run, create:

1. **Neon** — a separate Neon *project* for Vault Quest with a **`vaultquest-staging`**
   database/branch. You need its connection string. Scripts use the **unpooled/direct**
   host (pooler rejects `search_path`); the app can use either.
   *(The `vaultquest-prod` DB is Phase 3 — not needed for Phase 2.)*
2. **Cloudflare R2** — a Vault Quest staging bucket (e.g. `vaultquest-assets-staging`)
   and an API token scoped to it (endpoint + access key id + secret).
3. *(Optional, Phase 5)* **Backblaze B2** — `vaultquest-cold-archive` with Object
   Lock Compliance + a bucket-scoped app key. Not required for Phase 2.

## Secrets the scripts need (staging)

```
# SOURCE (already exist locally — read-only):
MINTVAULT_DATABASE_URL=...        # shared staging DB
R2_ENDPOINT= / R2_ACCESS_KEY_ID= / R2_SECRET_ACCESS_KEY= / R2_BUCKET_NAME=   # grading bucket

# DEST (owner creates these):
VAULT_QUEST_DATABASE_URL=...      # vaultquest-staging (direct/unpooled host)
VAULT_QUEST_R2_ENDPOINT=...
VAULT_QUEST_R2_ACCESS_KEY_ID=...
VAULT_QUEST_R2_SECRET_ACCESS_KEY=...
VAULT_QUEST_R2_BUCKET=...         # e.g. vaultquest-assets-staging

# For the staging TEST app (AI features), optional for the copy scripts:
VAULT_QUEST_ANTHROPIC_API_KEY=...
VAULT_QUEST_HIGGSFIELD_TOKEN=...  # (+ _MODEL / _API_URL / _WORKSPACE_ID if overriding)
```

## Run order

```bash
# 1. Create the 12 vq_ tables on the new staging DB (dry-run first, then --commit)
node scripts/vault-quest-migrate/apply-migrations.mjs            # validate (rolls back)
node scripts/vault-quest-migrate/apply-migrations.mjs --commit   # apply

# 2. Populate — choose ONE:
#    (a) mirror current shared staging data:
node scripts/vault-quest-migrate/copy-vq-tables.mjs              # dry-run (counts)
node scripts/vault-quest-migrate/copy-vq-tables.mjs --commit     # copy all 12 tables
#    (b) OR build canonical from scratch (empty DB): seed 36 characters + 12 rules
ALLOW_PROD=0 node scripts/seed-vq-character-bible.mjs --commit   # reads VAULT_QUEST_DATABASE_URL

# 3. Verify DB copy (row counts + checksums must all PASS)
node scripts/vault-quest-migrate/verify-db.mjs

# 4. Copy R2 objects (keys preserved) then verify
node scripts/vault-quest-migrate/copy-vq-r2-objects.mjs          # dry-run (list)
node scripts/vault-quest-migrate/copy-vq-r2-objects.mjs --commit # copy + inline md5 check
node scripts/vault-quest-migrate/verify-r2.mjs                   # independent count/size/hash

# 5. Deploy a STAGING app instance pointed at the VAULT_QUEST_* staging resources
#    and run the test checklist (Character Bible, descriptions, references,
#    candidates, Full Card, exports/renders, AI routes admin-gated, cert lookup).
```

## Rollback (staging)

The shared source DB/bucket are **never modified**, so rollback is trivial: stop
pointing Vault Quest at the new staging resources. To redo a rehearsal from
scratch, reset the new staging DB (source untouched):

```bash
node scripts/vault-quest-migrate/reset-staging.mjs                                   # dry-run (lists drops)
node scripts/vault-quest-migrate/reset-staging.mjs --commit --yes-drop-staging       # drop 12 vq_ tables on DEST
```

## Also here

- `smoke-fail-closed.ts` — `npx tsx scripts/vault-quest-migrate/smoke-fail-closed.ts`
  proves the Phase-1 clients fail closed and never fall back to grading (no DB/network needed).

All scripts: dry-run by default · never write SOURCE · refuse SOURCE===DEST · refuse grading prod host.
