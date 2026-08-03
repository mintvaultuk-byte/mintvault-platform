# Issue Register — Catalogue Manager Hardening

Lead-verified findings (read personally, line-by-line, at HEAD 7f4f12e7).
Reviewer IDs are cross-referenced where they corroborate.

| ID | Sev | Fix | File:line | Verified mechanism |
|---|---|---|---|---|
| L-1 | BLOCKER | 1 | shared/structured-variant-validate.ts:173,176,179,183 + server/lib/catalogue-provider.ts:33 + server/routes.ts:1805-1812 | Snapshot is built from ACTIVE, non-archived rows only (`allRows.filter(r => r.active && !r.archived)`). Archiving a rarity/finish/promo/subset makes `rarityByValue()` return undefined → `errors.push("Unknown rarity …")` → `ok:false` → PUT /api/certificates/:id returns 400 "Invalid rarity selection." **An existing certificate using that value can no longer be saved at all.** Both the force-refresh retry (1808) and the first attempt use the same archived-excluding snapshot, so the retry cannot help. |
| L-2 | BLOCKER | 2 | shared/pokemon-rarity-catalogue.ts:30-44 + shared/structured-variant-validate.ts:186-187 | Language catalogue contains `zh-cn` "Simplified Chinese" and `zh-tw` "Traditional Chinese". There is **no** `value`, `label`, or alias equal to plain "Chinese". A stored certificate language of "Chinese" → `languageByValueOrLabel` returns undefined → `Unknown language "Chinese"` → 400. Certificate is uneditable. Same class of failure for any legacy language string not in the alias lists. |
| L-3 | HIGH | 3 | server/services/catalogueService.ts:270-323; client/src/pages/admin-catalogue.tsx:210-224 | Import writes row-by-row with **no transaction** (each `createCatalogueItem`/`updateCatalogueItem` auto-commits). A failure at row N leaves rows 1..N-1 permanently written. No preview, no dry-run, no confirmation. `ImportResult.errors` is a flat `string[]` with **no row index or identity**, and the client destructures only `{created, updated, skipped}` — so `errors` is discarded entirely and failed rows are invisible. Silent partial writes confirmed. |
| L-4 | BLOCKER | 4 | server/routes/admin/catalogue.ts:120 + server/services/catalogueService.ts:164,181 | PUT passes `req.body` straight through. `updateCatalogueItem` does `const {reason, ...fields} = patch` then `.set({...fields, …})` with **no Zod schema and no strict()**. `category`, `value`, `createdBy`, `createdAt` are real columns and are therefore writable by any super-admin request body. Worse: the uniqueness check at :165-177 builds its candidate from `before.category`/`before.value`, so a **renamed `value` is validated against the OLD value** — the duplicate check is bypassed entirely, and `value` is the code persisted onto certificates. |
| L-5 | HIGH | 5 | client/src/pages/admin-catalogue.tsx:287-291 + server/services/catalogueService.ts:36-39,70 | UI renders exactly three states: loading / `items.length === 0` → "No entries yet. Add one to get started." / table. `itemsQuery.isError` is **never rendered**. 403, 404, 500 and missing-migration all fall into the `length === 0` branch and display the same "empty catalogue" copy. Server-side, `isMissingTable()` swallows the missing table and returns `[]`, so a missing migration is indistinguishable from an empty catalogue at the API layer too. |
| L-6 | HIGH | 6 | server/routes/admin/catalogue.ts:95-97 + server/services/catalogueService.ts:241 | When `search` is non-empty the route calls `searchCatalogueItems()`, which hard-codes `includeInactive:true, includeArchived:true`. The **"Show archived" checkbox is silently ignored whenever a search term is present.** Separately, `parseCategory()` (:74-76) returns `undefined` for an unknown category and the list route then silently lists **all** categories instead of returning a validation error. (Note: the reorder route at :157-158 *does* validate category — the list route is inconsistent with it.) Line 98 also contains a dead ternary `search ? rows : rows`. |
| L-7 | HIGH | 7 | server/services/catalogueService.ts:230-235 | Reorder issues N separate `db.update()` calls in a bare `for` loop with **no transaction**. A failure partway leaves the category's `sort_order` half-renumbered and unrecoverable without a manual fix. The audit event (:236) is already correctly single — that part needs no change. Route :160 also silently drops non-integer ids via `.filter(Number.isInteger)` rather than rejecting the request. |
| L-8 | MEDIUM | 8 | server/services/catalogueService.ts:169 | `abbreviation: fields.abbreviation ?? before.abbreviation` — `??` treats an explicit `null` (the "clear this abbreviation" signal the client sends at admin-catalogue.tsx:148) as "absent", so **validation runs against the OLD abbreviation while `.set({...fields})` writes `null`**. Validated state ≠ written state. Clearing an abbreviation can therefore pass a check it should have failed (or vice versa) and can reach the DB unique index in 0026 unvalidated. |
| L-9 | MEDIUM | 9 | migrations/0019_catalogue_manager.sql:50-51 | `uq_catalogue_items_category_value ON catalogue_items (category, value)` is **case-sensitive**. The app-level check (`catalogueConflict` → `norm()`, shared/catalogue-validate.ts:132-136) *is* case-insensitive, so the API blocks Holo/HOLO/holo — but the database does not. Two concurrent creates can both pass the app check (TOCTOU), and any path that bypasses the service (seed, direct SQL, restore) can create case-variant duplicates. 0026's `lower()` index covers only `designation`+`attribute` effective codes, not `(category, value)` generally. |
| L-10 | MEDIUM | 10 | client/src/lib/queryClient.ts:54-55 | Global React Query defaults are `staleTime: Infinity` + `refetchOnWindowFocus: false`. The catalogue queries (admin-catalogue.tsx:93-112) and `useCatalogue` inherit them, so a catalogue edited in one tab is never refreshed in another until a manual invalidate. **Scope note:** this default is GLOBAL and shared with Project Control, Partner Network and every other surface — changing it globally is out of scope and forbidden by the owner's directive, so the fix is applied per-query on the catalogue queries only. |

## Rejected / not-a-defect (checked, found correct)
- Reorder audit emits ONE event per operation (catalogueService.ts:236) — already correct, no change needed.
- `catalogueConflict` value-uniqueness IS case-insensitive at the application layer — the gap is DB-only (see L-9).
- `useCatalogue` sets its own `staleTime: 5 * 60 * 1000` (useCatalogue.ts:25), so it does not inherit Infinity; only `refetchOnWindowFocus` is inherited.
- Reorder renumbers the WHOLE category (:212-229), correctly avoiding collisions from a partial/filtered id list.
- Snapshot mapping never uses `label` as the persisted code (catalogue-snapshot.ts:92), so relabelling is genuinely safe for stored certificates.

## Lead's own live evidence (STAGING, read-only, 2026-08-02)

Query run inside `BEGIN TRANSACTION READ ONLY` against ep-purple-voice (staging). Production NOT queried.

### catalogue_items WHERE category='language' (15 rows)
Four Chinese rows exist; TWO share the identical label "Chinese":

| value | label | region | source |
|---|---|---|---|
| zh-Hans | **Chinese** | china | NOT from seed — hand-added |
| zh-Hant | **Chinese** | china | NOT from seed — hand-added |
| zh-cn | Simplified Chinese | china | seed (POKEMON_LANGUAGES:39) |
| zh-tw | Traditional Chinese | china | seed (POKEMON_LANGUAGES:40) |

Verified `zh-Hans`/`zh-Hant` appear in NO seed file, NO migration, and NO commit touching
shared/pokemon-rarity-catalogue.ts. They were inserted directly into the staging catalogue.

Consequence: `languageByValueOrLabel("Chinese")` matches `norm(l.label)` and returns the FIRST
`.find()` hit — so on staging "Chinese" resolves AMBIGUOUSLY and order-dependently, rather than
failing. On a database carrying only the seeded rows it resolves to NOTHING and hard-fails 400.
Whether FIX 2's symptom is a 400 or a silent wrong-dialect therefore depends on which rows the
environment has. Alias lists also overlap ("simplified chinese", "zh-hans", "cn" each appear on
two rows), so alias lookup is ambiguous too.

Mitigating fact that makes the fix safe: ALL FOUR rows are region "china", so region derivation
for a legacy "Chinese" is unambiguous even when the dialect is not.

### certificates.language distinct (staging)
"English" -> 259, "Spanish" -> 3. ZERO Chinese certificates on staging.
The owner's report of Chinese certificates concerns PRODUCTION, which was deliberately not queried.
The compatibility fix is a no-op where no such rows exist, so it is safe regardless.

## Deferred — NOT implemented this pass (logged, needs owner decision)
- R4-F3: `GET /api/catalogue/snapshot` uses a bespoke `isAdmin || isGrader` boolean gate that skips
  the revocation/freshness checks `requireAdmin`/`requireGrader` perform. AUTH LOGIC — CLAUDE.md
  rule 3 forbids changing it without owner approval, and it is outside the ten fixes.
- R1-F2: catalogue PUT has no optimistic lock; a stale editor modal can silently un-archive a row
  (the `stale-form-clobber` incident class). FIX 4 removes the category/value half of this, but the
  active/archived clobber remains. Adding a version/compare-and-swap is a new feature, not hardening.
- R3-F3: rows can be simultaneously active=TRUE and archived=TRUE (4 such rows on staging, incl.
  `attribute/zz_smoke_test_tmp`, a smoke-test artefact). Benign today — every read path filters both
  flags. Changing archive semantics to also clear `active` alters restore behaviour; owner's call.
- STAGING DATA: duplicate/overlapping Chinese catalogue rows (above). A data question, not a code
  question. No catalogue data changed in any environment by this task.
