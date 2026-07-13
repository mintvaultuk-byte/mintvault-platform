# Runbook — Vault Quest artwork backup, versioning & recovery (R4-OPS-02)

> **Scope:** Vault Quest approved artwork only. Never touches grading / certificate
> backups. VQ shares the grading R2 bucket today; isolation is prefix-only.

## Problem

Approved VQ art uses **deterministic, overwrite-in-place** keys
(`vq/characters/{id}/approved/{type}.png`, `vq/art/{cardId}/{slot}.png`) with **no
R2 versioning, no B2 copy, no stored hash**. Re-approving a slot silently destroys
the prior image, unrecoverably. The R2→B2 archival worker backs up only cert
prefixes — **zero `vq/`**.

## Target design (this phase lands the safe core; the rest is C/D)

### 1. Immutable versioned keys + revision ledger  — *pure core implemented (7D)*

- Every approve/upload writes a **new immutable key**:
  `vq/characters/{id}/approved/{slot}/{revisionId}.png` · `vq/art/{id}/{slot}/{revisionId}.png`
  (built by `buildApprovedRevisionKey`, guarded by `assertVqBackupKey`).
- A row lands in **`vq_artwork_revisions`** (migration `0010`, authored, unapplied):
  `sha256`, `byteSize`, `mime`, w/h, `sourceCandidateId`, `createdBy`, `isActive`,
  `backupState`. A **partial-unique index** enforces at most one active revision per
  `(entity, slot)` — a botched swap can't split-brain.
- The entity's **existing** pointer column (`approvedArtworkR2Key` /
  `referencePack[type].r2Key` / `vqCards.artR2Key`) points at the active revision's
  immutable key. **Readers are unchanged** — they just dereference a versioned key.
- **Integrity** is computed on the exact bytes at approve time (`sha256Hex`) and
  verified with `verifyIntegrity` (constant-time) before any restore activates.

**Status:** pure key/guard/hash/pointer logic implemented + unit-tested
(`server/vault-quest/lib/vq-artwork-versioning.ts`). Schema + migration authored,
**not applied**. Rewiring the ~5 approve/upload sites to write versioned keys +
insert revisions = **Category C** (needs the migration on staging). A one-time
backfill of existing approved pointers into revision rows (hashing legacy objects)
= **Category G**.

### 2. B2 sibling backup worker  — *Category A code / C run / D provisioning*

- A **separate** worker `vq-artwork-b2-archival.ts` with its **own cron guard** —
  never bolted onto the cert worker (a VQ failure must not regress cert backup).
- Driver: `vq_artwork_revisions WHERE backup_state IN ('pending','failed')`.
  Because keys are immutable, the B2 destination key = the same key; `existsInB2`
  gives free idempotency.
- Per object: `existsInB2` → `getR2Buffer` → `uploadToB2(key, buf, mime, 90)` →
  **verify** re-hash vs `revision.sha256` (never mark archived on mismatch) →
  `backup_state='archived'`. Only **approved/active + superseded** revisions are
  archived — candidates are excluded (`assertVqBackupKey`).
- Failure isolation: own try/catch + `audit_log`; one bad row never aborts the
  sweep, and cannot reach the cert sweep. B2 COMPLIANCE lock (90d) = no-delete.
- **Do not run** until owner provisions/confirms the B2 path (reuse the existing
  cold-archive bucket = no new secret; needs write/read/list/head, no delete).

### 3. Restore  — *pure planner/guards implemented / execution C*

Because approved keys are immutable, **restore = a pointer flip to an existing
revision**, not a byte overwrite — safe by construction:

1. Operator picks a target `revisionId` for `(entityType, entityId, slot)`.
2. `assertVqRestoreTarget` — key must belong to that entity, be a valid backup key,
   and **never** be a grading/cert object (both-way guard).
3. Verify the object still exists + `verifyIntegrity` (sha256). **Refuse on
   mismatch/missing.** Cold path: if R2 is gone but B2 has it, download from B2,
   verify, re-materialise under the **same immutable key** (content-identical), then
   continue.
4. `planPointerSwap` in one transaction: deactivate the prior active, activate the
   target, repoint the pointer column. **The previous active revision row is kept**
   (history) — never deleted.
5. Record restorer + `audit_log`.

### 4. R2 versioning / dedicated VQ bucket  — *Category D, not primary*

- R2 object versioning is **bucket-level**, so it can't be scoped to `vq/` on the
  shared bucket without versioning cert overwrites too. Immutable app keys + the
  ledger are the PRIMARY control; R2 versioning is only worthwhile as
  defence-in-depth **on a dedicated VQ bucket**.
- A dedicated VQ bucket (the `vq-infrastructure-separation` branch already scaffolds
  it) gives true blast-radius isolation + per-bucket versioning + scoped creds, at
  the cost of provisioning (D) + a one-time object copy (G). Do the immutable
  keys/ledger + B2 extension first; land the bucket move as the follow-up.

## Disaster-recovery summary

| Failure | Recovery |
|---|---|
| Re-approval overwrote a master | Restore the prior `vq_artwork_revisions` row (pointer flip) — the old immutable key still exists |
| R2 object evicted/corrupt | Cold path: pull from B2, verify sha256, re-materialise under the same key |
| Bucket loss | Restore approved art from B2 (once the B2 vq worker is live) |
| Bad bytes uploaded | Integrity verify refuses activation; roll back to the last good revision |

**Guarantees:** a restore never overwrites the only good copy (pointer flip / same
immutable key); verifies hash before activation; keeps the previous active revision;
records who restored; and cannot cross the VQ↔grading boundary.
