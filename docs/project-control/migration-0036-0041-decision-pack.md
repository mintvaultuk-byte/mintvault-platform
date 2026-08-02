# Migration ownership decision pack — 0036 to 0041

**Prepared:** 2026-08-02 · **Status:** DECISION REQUIRED — nothing has been renumbered.

This document exists because migration 0039/0040 introduced a **monotonic migration-order guard**
(`scripts/db/migrate.ts`, commit `5fefee78`) that throws — with **no override flag** — when a
pending migration is numbered below the highest already-applied number. That guard is correct and
deliberate. It also means the order these branches land in is now a decision with consequences,
rather than an accident.

No migration file has been renamed. Renumbering is the owner's call, and for 0039/0040 it is
**not available** — see the staging constraint below.

---

## The constraint that removes most of the options

**Migrations 0039 and 0040 are already applied on STAGING** (`mintvault-v2`), which is running
`c70daae6`, seed version 1, 22 nodes / 35 packages.

The runner stores a **checksum per applied migration** and hard-fails the entire run on a mismatch
(`migrate.ts` — checksum ratchet). So:

- **0039 and 0040 cannot be renumbered or edited.** Renaming the file changes the journal key;
  editing the contents changes the checksum. Either one breaks staging's ledger and requires
  hand-written recovery SQL against a live host.
- The applied watermark on staging is therefore **40**, permanently.
- **0036, 0037 and 0038 are consequently below the watermark on staging already.** This is not a
  future risk to avoid; it is the current state of that estate.

Everything below follows from that.

---

## Decision table

| # | Migration | Owning branch | Merged? | Ahead of main | Depends on | Collision risk | Proposed final number |
|---|---|---|---|---|---|---|---|
| 0036 | `0036_partner_device_registry.sql` | `psp/w2-a-device-registry` | No | 1 | 0001 partner foundation (on main) | **None** — sole owner of 0036, no other branch uses the number | **0042** |
| 0037 | `0037_grading_axis_inspection_completion.sql` | `psp/w2-mvgs-server-authority-integration` **and** `psp/w2-mvgs-server-authority-reconciled` | No | 27 / 85 | grading tables (on main) | **Two branches carry the same file.** `…-reconciled` is a superset (85 commits, also carries 0038). Landing both is a duplicate-number failure | **0043** — and only from `…-reconciled` |
| 0038 | `0038_nfc_uid_live_uniqueness.sql` | `psp/w2-mvgs-server-authority-reconciled` | No | 85 | certificates (on main) | **None** — sole owner | **0044** |
| 0039 | `0039_project_control_live_evidence.sql` | `integration/project-control-landing-20260802` | No | 66 | 0030 | **Applied on staging — immovable** | **0039 (unchanged)** |
| 0040 | `0040_project_control_seed_reconciliation.sql` | `integration/project-control-landing-20260802` | No | 66 | 0030, 0039 | **Applied on staging — immovable** | **0040 (unchanged)** |
| 0041 | `0041_catalogue_case_insensitive_value_unique.sql` | `fix/catalogue-manager-hardening` | No | 4 | 0019 + 0026 (both on main) | Number is free, but sits **below** 0042-0044 above; it is above the watermark so the guard permits it | **0041 (unchanged)** |

### Why 0037 is the one to watch

`psp/w2-mvgs-server-authority-integration` (27 commits) and `psp/w2-mvgs-server-authority-reconciled`
(85 commits) **both carry `0037_grading_axis_inspection_completion.sql`**, authored twice
(`f7ff2d67`, then ported in `faf131e0`). Landing both branches produces a **duplicate migration
number**, which `listMigrationFiles` rejects outright — a different and louder failure than the
ordering guard. Only one of these branches may land, and `…-reconciled` is the superset.

⚠️ Neither MVGS branch has been reviewed as part of this landing. Both touch the **protected**
grading system, which under `CLAUDE.md` and the MVGS protection rule requires explicit per-change
founder approval. Nothing here recommends landing them; this pack only records what their numbers
would collide with.

---

## Recommended landing order

1. **`integration/project-control-landing-20260802`** (0039, 0040) — already applied on staging;
   landing it changes no estate's ledger.
2. **`fix/catalogue-manager-hardening`** (0041) — above the watermark, no renumbering needed, and
   its prerequisites 0019 and 0026 are already on main.
3. **`psp/w2-a-device-registry`** — renumber 0036 → **0042** before merge.
4. **`psp/w2-mvgs-server-authority-reconciled`** — renumber 0037 → **0043**, 0038 → **0044**, before
   merge, and only under the MVGS protected-system approval.
5. **Abandon or rebase `psp/w2-mvgs-server-authority-integration`** — its 0037 is superseded by the
   reconciled branch's copy.

Landing Project Control first does **not** make the other branches worse off: staging's watermark is
already 40, so 0036-0038 need renumbering whether or not this branch merges. The only thing that
would change that is rolling 0039/0040 back off staging, which the rollback-order guard now makes
safe but which is a deliberate destructive action requiring owner approval.

---

## Branches requiring renumbering, exactly

| Branch | Rename | To |
|---|---|---|
| `psp/w2-a-device-registry` | `migrations/0036_partner_device_registry.sql` | `migrations/0042_partner_device_registry.sql` |
| `psp/w2-mvgs-server-authority-reconciled` | `migrations/0037_grading_axis_inspection_completion.sql` | `migrations/0043_grading_axis_inspection_completion.sql` |
| `psp/w2-mvgs-server-authority-reconciled` | `migrations/0038_nfc_uid_live_uniqueness.sql` | `migrations/0044_nfc_uid_live_uniqueness.sql` |

Each rename must carry its rollback file and any test that names the filename. **None of these are
applied on any estate**, so renaming disturbs no checksum and needs no forward reconciliation.

Verify before renaming, per branch:

```bash
psql "$URL" -c "SELECT filename, status FROM schema_migrations WHERE filename LIKE '003%' OR filename LIKE '004%';"
```

Expect **zero rows** for 0036, 0037, 0038 and 0041 on both estates. Any row means that file is
applied somewhere and this plan does not apply to it.

---

## Forward reconciliation — not required, and why

A renumbering plan only needs a forward reconciliation step when a file that is **already applied**
changes identity. That is not the case for any file in this pack:

- 0036/0037/0038/0041 — unapplied everywhere, so a rename is a pure repository change.
- 0039/0040 — applied on staging, and therefore **not being renamed**.

The staging journal is left exactly as it is. No `UPDATE schema_migrations`, no re-checksum, no
hand-written SQL.

---

## Outstanding read-only checks the owner must run

These need database credentials this session does not have. Both are read-only.

1. **Confirm 0039's checksum premise.** Commit `5fefee78` edited 0039 after it was authored,
   justified by "0039 is unapplied on every environment". Staging has since had it applied — so
   confirm the applied checksum matches the file **currently in the branch**:

   ```bash
   psql "$STAGING_URL" -c "SELECT filename, status, checksum FROM schema_migrations WHERE filename LIKE '00%project_control%';"
   ```

   A mismatch on 0039 stops this branch until reconciled.

2. **Confirm production's Project Control baseline.** If `0030_project_control.sql` is **not**
   applied on production, `0040` will fail there on `ALTER TABLE pc_work_packages` — cleanly rolled
   back by the runner, but the deploy exits non-zero. Production is at `6f182624`, 102 commits
   behind main, so this is likely.
