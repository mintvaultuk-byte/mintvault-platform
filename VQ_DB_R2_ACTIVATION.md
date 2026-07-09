# Vault Quest — DB / R2 Activation Checklist (Phase 1b)

**Plan only. Nothing in this document has been run.** It activates the `vq_` tables on **staging** and exercises save/list/upload/preview/export. Production schema push and the Fly code deploy remain **blocked** (Section 6).

> ⚠️ **Where to run this:** on a machine whose `MINTVAULT_DATABASE_URL` resolves to the **staging** Neon branch. In the current sandbox the DB host is unreachable ("unable to parse host"), so the push must run on the real dev environment, not here.

---

## 1. Exact command to push `vq_*` tables to staging only

```bash
# from repo root, with .env pointing at STAGING
npx drizzle-kit push --config drizzle-vq.config.ts
```

- **Do NOT run `npm run db:push`** — that uses the default `drizzle.config.ts` (the grading schema). The VQ push must always pass `--config drizzle-vq.config.ts`.
- `push` prints the statements and asks to confirm. **Read the diff first:** it must show only `CREATE TABLE "vq_…"`. If anything mentions a non-`vq_` table, answer **no** and stop.
- Pre-flight guard (run before pushing — confirm it prints the staging host, `ep-purple-voice-abfez796`, not prod):

```bash
node -e "console.log(new URL(process.env.MINTVAULT_DATABASE_URL).host)"
```

---

## 2. Confirmation: `drizzle-vq.config.ts` only touches `vq_*`

Two independent guarantees:

1. **`tablesFilter: ["vq_*"]`** in `drizzle-vq.config.ts` — drizzle-kit only introspects/diffs `vq_`-prefixed tables. It **cannot** emit a statement against a grading table, even though the DB has drifted from `shared/schema.ts`.
2. **The already-generated migration proves it.** `migrations-vq/0000_next_mister_fear.sql` contains exactly seven statements, all `vq_`:

```
CREATE TABLE "vq_card_revisions"
CREATE TABLE "vq_cards"
CREATE TABLE "vq_elements"
CREATE TABLE "vq_families"
CREATE TABLE "vq_game_config"
CREATE TABLE "vq_releases"
CREATE TABLE "vq_sets"
```

Verified: **zero** `ALTER` / `DROP` / `TRUNCATE`, and **zero** statements against any non-`vq_` table.

*(Optional, offline, no DB touched — regenerate and re-inspect any time:)*
```bash
npx drizzle-kit generate --config drizzle-vq.config.ts   # writes SQL to migrations-vq/, connects to nothing
```

---

## 3. Exact environment variables needed

**Database** (read by `server/config.ts` → `getDatabaseUrl()`):

| Var | Purpose |
|---|---|
| `MINTVAULT_DATABASE_URL` | Postgres connection string — **must point at staging** for this activation |

**R2** (read by `server/r2.ts`, for artwork upload/serve):

| Var | Purpose |
|---|---|
| `R2_ENDPOINT` | Cloudflare R2 S3 endpoint |
| `R2_ACCESS_KEY_ID` | R2 access key |
| `R2_SECRET_ACCESS_KEY` | R2 secret key |
| `R2_BUCKET_NAME` | R2 bucket (same bucket as grading — VQ writes only under the `vq/` prefix) |

No new secrets are introduced. Admin auth (`ADMIN_PASSWORD`, `ADMIN_PIN`, `SESSION_SECRET`) is unchanged and already required to reach any `/api/admin/*` route.

---

## 4. Test checklist

Run the dev server (`npm run dev`) against staging, then **log in at `/admin`** (email + password → PIN) so the browser holds the `mv.sid` admin cookie. Then open **`/admin/vault-quest`**. Each row is pass/fail.

### 4a. Preview card (DB-free — should already work)
- [ ] Enter Card ID `GNV-001`, Name `Flammi`, Type Creature, Element Flame, Stage 1, Health 5, Attack 1 `Ember Tap`/2, Vulnerability `Water`.
- [ ] Live preview panel renders the card within ~1s; QA shows a warning about missing artwork (expected), no rejects.
- [ ] Type `HP` into an effect field → QA shows a **red reject** `[attack1_effect] banned term(s) [HP]`, and **Approve** is disabled.

### 4b. Upload artwork (R2)
- [ ] Click **Upload artwork**, choose a PNG/JPG ≥64×64.
- [ ] Toast shows "Artwork uploaded (main)" with dimensions; the `✓ vq/art/GNV-001/main.png` key appears.
- [ ] Preview refreshes with the real art in the fixed window (placeholder gone).
- [ ] Try a non-image (e.g. a `.txt` renamed `.png`) → rejected with "file is not a decodable image".
- [ ] Confirm in R2: object exists at `vq/art/GNV-001/main.png`; **no** object was written outside the `vq/` prefix.

### 4c. Save card (DB — needs the push from Section 1)
- [ ] Click **Save draft** → toast "Saved GNV-001 (draft)".
- [ ] Row appears in the Cards list with a `draft` badge.
- [ ] Edit Health to 6, Save draft again → succeeds; a revision row is written (verify: `SELECT count(*) FROM vq_card_revisions WHERE card_id='GNV-001';` returns ≥1).
- [ ] With a clean card (no QA rejects), click **Approve** → saves as `approved`.
- [ ] With a QA-failing card, **Approve** returns 422 "cannot approve a card that fails QA" (draft still allowed).

### 4d. List cards (DB)
- [ ] The Cards panel shows all saved cards ordered by collector number, each with its status badge.
- [ ] `curl` (with admin cookie): `GET /api/admin/vault-quest/cards?status=draft` returns only drafts.

### 4e. Export SVG / PNG / PDF (DB-free)
- [ ] Click **SVG** → downloads `GNV-001.svg` (opens as a vector card).
- [ ] Click **PNG** → downloads `GNV-001.png` (300-DPI card).
- [ ] Click **PDF** → downloads `GNV-001.pdf`; verify it is a **69×94 mm** page with 3 mm bleed + crop marks (matches the CLI output).
- [ ] Export a QA-failing card → blocked with 422, no file.

### 4f. Isolation smoke (grading unaffected)
- [ ] Load a normal cert page / admin certificates list → still works.
- [ ] Confirm no new tables outside `vq_`: `SELECT tablename FROM pg_tables WHERE tablename LIKE 'vq/_%' ESCAPE '/';` lists exactly the 7 `vq_` tables and nothing else changed.

---

## 5. Rollback plan

The activation is **additive and isolated** — it only creates 7 new `vq_` tables and writes objects under the `vq/` R2 prefix. Nothing grading-side is modified, so there is nothing grading to roll back.

**Undo the schema** (staging):
```sql
DROP TABLE IF EXISTS
  vq_card_revisions, vq_cards, vq_families, vq_sets,
  vq_elements, vq_game_config, vq_releases CASCADE;
```
- Safe because no grading table references a `vq_` table (zero cross-schema FKs). `CASCADE` only touches the `vq_` set.
- To re-push cleanly afterwards, also clear the local journal: `rm -rf migrations-vq/` then regenerate (Section 2).

**Undo R2 artwork** (optional — isolated prefix):
```bash
# delete only the vq/ prefix; never touches images/{certId}/ customer photos
aws s3 rm "s3://$R2_BUCKET_NAME/vq/" --recursive --endpoint-url "$R2_ENDPOINT"
```

**Undo the code** (only if fully reverting the feature — not needed for a DB-only rollback): the integration is the 3 additive wiring lines (`App.tsx`, `admin-shell.tsx`, `routes.ts`) plus the new `vq_`/`server/vault-quest/` files — remove per the extraction manifest in `VQ_PHASE1_ADMIN_INTEGRATION_PLAN.md §9`.

**Blast radius if the push goes wrong:** none to grading — `tablesFilter` makes a grading-table change impossible, and the worst case (a half-created `vq_` table) is fixed by the DROP above and a re-push.

---

## 6. Deploy still blocked — confirmed

- `scripts/safe-deploy.sh` is **ABSENT** on this branch (verified). Until it is merged/cherry-picked from `routes-split` (commits `94e9938`, `9fc70a1`), **no Fly deploy happens** — no raw `fly deploy`.
- Scope of this activation: **staging DB push + local/staging testing only.** It is *not* a deploy.
- Still gated behind the deploy hold (do later, founder-watched, one at a time):
  1. **Production** schema push — same command with `MINTVAULT_DATABASE_URL` set to the **prod** URL (from Fly secrets), run deliberately with you watching the diff, **before** any code deploy that needs the tables.
  2. The **Fly code deploy** of the VQ routes/page — only once `safe-deploy.sh` is present, staging is green, and you say deploy.

---

## One-line summary

Point `.env` at staging → `npx drizzle-kit push --config drizzle-vq.config.ts` (confirm the diff is 7 `vq_` CREATEs) → log into `/admin/vault-quest` → walk Section 4 → rollback is a one-line `DROP` of the 7 `vq_` tables. Production and Fly deploy stay blocked until `safe-deploy.sh` is in.
