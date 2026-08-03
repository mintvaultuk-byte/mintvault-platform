# Change Manifest — Catalogue Manager Hardening

Branch `fix/catalogue-manager-hardening`, worktree `/Users/cornelius/mintvault-catalogue-hardening`, base `7f4f12e7`.
No deploy, no push, no merge, no reseed, no DB mutation in ANY environment.

## Guiding constraint
Every change is confined to the Catalogue Manager and the certificate *validation* seam it
owns. Project Control, Partner Network, the grading engine, scanner, Stripe, auth and label
rendering are NOT touched.

---

## FIX 1 + FIX 2 — one grandfathering mechanism (BLOCKER)

Rule: a catalogue code or language that is absent from the LIVE catalogue is an error,
UNLESS it is byte-identical to the value already stored on the certificate being updated —
then it resolves from the archived/inactive set and downgrades to a warning.
Create has no `existing`, so new certificates can never use archived values.

| File | Change |
|---|---|
| `server/lib/catalogue-provider.ts` | Return archived/inactive rows alongside live ones (already loads `allRows` — no extra query). New `getCatalogueSnapshotWithHistory()`. |
| `shared/structured-variant-validate.ts` | `validateStructuredVariant` gains an optional `grandfathered` set (stored codes + stored language). Unknown code present in the historical set AND equal to the stored value → warning, not error. |
| `shared/pokemon-rarity-catalogue.ts` | `LEGACY_LANGUAGE_COMPAT` map: `"chinese" → region "china"` (all four Chinese rows are region `china`, so region is unambiguous even when dialect is not). Resolution only, never a rewrite. |
| `server/lib/structured-variant.ts` | `applyStructuredVariantFromBody` accepts the grandfather set and threads it through. |
| `server/routes.ts` | UPDATE path (~1805) passes `existing`'s stored codes + language. CREATE path (~2144) passes nothing. |
| `client/src/components/rarity-picker/RarityVariantPicker.tsx` | Mirror the existing designation orphan-guard (`certificate-form.tsx:2033-2041`): union the stored-but-archived value into the chip list, marked "existing value on this certificate". |

Stored certificate data is NEVER altered. `certificates.language` is written by `putGuarded`
(routes.ts:1741), not by the structured columns, so legacy "Chinese" stays exactly as stored.

## FIX 4 — strict PUT (BLOCKER) — also closes R2-F4 / R6-F14
| File | Change |
|---|---|
| `shared/schema.ts` | New `updateCatalogueItemSchema` = `insertCatalogueItemSchema.partial().pick({label,abbreviation,aliases,description,metadata,sortOrder,active,archived,allowCrossCategory,notes}).extend({reason}).strict()`. Trim transforms on `value`/`abbreviation`/`label` (R2-F11). |
| `server/services/catalogueService.ts` | `updateCatalogueItem` parses the patch before use; `.set()` built from the PARSED object, never a spread. Rejects `id`,`category`,`value`,`createdBy`,`createdAt`,`updatedBy`,`updatedAt` and unknown keys. |
| `client/src/pages/admin-catalogue.tsx` | Stop sending `category`/`value` on the update path (they're immutable; the field is already disabled at :372). |
| `shared/catalogue-snapshot.ts` | Defensive `Array.isArray(row.aliases) ? … : []` in all four mappers, so a malformed row degrades instead of throwing on the certificate save path. |

## FIX 3 — import safety (BLOCKER)
| File | Change |
|---|---|
| `shared/catalogue-import.ts` (NEW, pure) | Row-plan builder: given existing rows + payload rows, return per-row `{index, category, value, action: create|update|unchanged|error, changedFields, error}`. Pure → unit-testable without a DB. |
| `server/services/catalogueService.ts` | `importCatalogue(payload, actor, {dryRun})`. Dry-run returns the plan and writes NOTHING. Apply wraps the whole thing in ONE `db.transaction` (all-or-nothing). Existing rows loaded ONCE (kills the per-row full-table scan). Unchanged rows skipped — no write, no audit. Per-row results carry index + category + value. Errors classified: validation messages pass through, driver errors replaced with a generic string + `console.error` (no Postgres text to the client). Errors capped at 50 + `truncated` count. |
| `server/routes/admin/catalogue.ts` | `POST /import?dryRun=1` (or `{dryRun:true}`) → preview. Apply requires explicit confirm. |
| `client/src/pages/admin-catalogue.tsx` | Two-step: file → dry-run → confirmation modal showing per-row plan (highlighting `active`/`archived` flips) → apply. Render errors. |

## FIX 5 — state differentiation (HIGH)
| File | Change |
|---|---|
| `server/services/catalogueService.ts` | `isMissingTable` matches SQLSTATE `42P01`, not the loose `/relation/i` regex. Missing table surfaces explicitly instead of `[]`. New `CatalogueNotFoundError` → 404. |
| `server/routes/admin/catalogue.ts` | List response carries `catalogueAvailable`. Missing migration → 503 with a distinct code. `fail()` maps not-found → 404. |
| `client/src/pages/admin-catalogue.tsx` | Attach `err.status`/`err.body` at the fetch boundary (currently discarded at :99). Render five distinct states: empty / 401 / 403 / 404 / 500 / migration-missing. Same for the audit panel (:343). |

## FIX 6 — search correctness (HIGH)
| File | Change |
|---|---|
| `server/services/catalogueService.ts` | `searchCatalogueItems` accepts and applies `includeInactive`/`includeArchived` instead of hard-coding `true`. |
| `server/routes/admin/catalogue.ts` | Thread the flags into the search branch. Unknown/present-but-invalid `category` → 400 (matching the reorder route). Strict boolean parsing (reject `1`/`TRUE`/arrays). Delete the dead `search ? rows : rows` ternary. |

## FIX 7 — transactional reorder (HIGH)
| File | Change |
|---|---|
| `server/services/catalogueService.ts` | Wrap the renumber in ONE `db.transaction`. Only write rows whose `sortOrder` actually changed (stops the reorder stamping `updatedBy` on the whole category — R6-F4). Audit inside the transaction, single event, now carrying prior order as `oldValue`. |
| `server/routes/admin/catalogue.ts` | Reject non-integer / unknown ids with 400 instead of silently dropping them. |
| `client/src/pages/admin-catalogue.tsx` | Move `invalidate()` into `finally` so a failed mutation resyncs (R1-F9). |

DB-safe: `sort_order` has NO unique index (verified on staging), so intermediate states cannot collide.

## FIX 8 — abbreviation clearing (MEDIUM)
`server/services/catalogueService.ts:169` → `"abbreviation" in fields ? (fields.abbreviation ?? null) : before.abbreviation`.
Normalise `""` → `null` on write. Align the three length limits (Zod 24 / validator 64 / DB unbounded) on one number.
Map SQLSTATE `23505` to a 400 with the friendly message instead of a raw 500.

## FIX 9 — case-insensitive uniqueness (MEDIUM)
| File | Change |
|---|---|
| `migrations/0031_catalogue_value_ci_unique.sql` (NEW) | `CREATE UNIQUE INDEX … (lower(btrim(category)), lower(btrim(value)))`, guarded by a `to_regclass` check and a pre-flight duplicate scan that RAISEs with the offending rows (same shape as 0026). **AUTHORED ONLY — NOT APPLIED ANYWHERE.** |
| `migrations/rollback-0031-…sql` (NEW) | Inverse + journal deletion. |
| `server/services/catalogueService.ts` | Wrap validate+insert so a `23505` becomes a clean 400. |

⚠️ Applying this migration is a PROTECTED ACTION requiring owner approval, and requires the
duplicate scan to be run against PRODUCTION first (staging returned zero violations; prod unknown).

## FIX 10 — cache (MEDIUM)
Per-query overrides ONLY — the global `staleTime: Infinity` in `client/src/lib/queryClient.ts:54-55`
is shared with Project Control and Partner Network and is NOT touched.
- `admin-catalogue.tsx` itemsQuery/auditQuery: `staleTime: 0`, `refetchOnWindowFocus: true`.
- `useCatalogue.ts`: `refetchOnWindowFocus: true`; expose `isFallback` so pickers can show a degraded banner.
- Debounce the search term (~250ms) so typing doesn't create one permanent cache entry per keystroke.

## Additional (zero-risk, in-scope)
- `migrations/rollback-0019-…sql`, `rollback-0026-…sql`: add `DELETE FROM schema_migrations WHERE filename = …` so a rollback is a true inverse (R3-F2). File authoring only — not executed.
- `scripts/db/seed-catalogue.ts`: dry-run default, `--apply` required, production-host guard via `classifyDbHost`. Makes the owner's "DO NOT reseed" a code-level guarantee (R6-F9).
- `server/routes/admin/catalogue.ts`: audit the export operation (R6-F6).

## NOT doing (deferred — owner decision required)
- R4-F3 snapshot auth gate (AUTH LOGIC — CLAUDE.md rule 3)
- R1-F2 optimistic lock on catalogue PUT (new feature)
- R3-F3 archive-also-clears-active (changes restore semantics)
- Any catalogue DATA change in any environment (the duplicate Chinese rows on staging)
