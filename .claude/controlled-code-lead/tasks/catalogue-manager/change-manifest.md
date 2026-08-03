# Change Manifest — Catalogue Manager

Governance v1.1 · Lead session · Worktree `/Users/cornelius/mintvault-catalogue-wt` · branch `feat/catalogue-manager` off `origin/main@0194cbff`

## Architecture (one canonical system, data-driven)

`shared/pokemon-rarity-catalogue.ts` stays the CANONICAL contract (types + pure helpers).
Its hard-coded arrays become the **SEED + offline fallback**. A new DB table `catalogue_items`
holds the live, admin-editable data. Pure helpers gain an OPTIONAL snapshot param (default =
seed arrays → zero behaviour change for existing callers). Server + client pass a DB-loaded
snapshot. `validateStructuredVariant` remains the single authority (no second validation path).

- **1 table** `catalogue_items` (category discriminator + `metadata jsonb` for per-category
  structure) + reuse existing `audit_log` (NO new audit table).
- **Reads** open to admin+staff (`adminOrStaffRead` precedent). **Writes** `requireSuperAdmin`.
- **Migration `0019_catalogue_manager.sql`** = additive, numbered, gated. Authored + shown to
  owner; NOT applied (owner chose "show me first"). Service tolerates missing table → falls
  back to seed arrays, so the app never breaks pre-apply.
- **Live cert preview** = new read-only `POST /api/admin/certificates/label/preview` calling the
  UNMODIFIED `generateLabelPNG(cert,"front")`. No render-pipeline edit. Debounced client panel.

## Files — NEW
| File | Purpose | Class |
|---|---|---|
| `shared/schema.ts` (edit) | `catalogueItems` table + Zod + types | E |
| `migrations/0019_catalogue_manager.sql` + rollback | additive DDL (authored, not applied) | E |
| `scripts/db/seed-catalogue.ts` | idempotent upsert of seed arrays + spec examples (gated) | G |
| `server/services/catalogueService.ts` | CRUD/reorder/archive/enable/search/import-export/validation/audit; missing-table tolerant | A/B |
| `server/lib/catalogue-provider.ts` | DB→canonical snapshot, TTL cache + invalidate; seed fallback | A |
| `server/routes/admin/catalogue.ts` | read (adminOrStaffRead) + write (requireSuperAdmin) + import/export routes | B |
| `server/routes/admin/label-preview.ts` | read-only front-label preview from unsaved values | A |
| `client/src/hooks/useCatalogue.ts` | TanStack Query loader; seed arrays as placeholder | B |
| `client/src/pages/admin-catalogue.tsx` | Catalogue Manager (8 sections, full CRUD/reorder/archive/notes/audit/import-export) | B |
| `client/src/components/grading-workflow/CertificatePreviewPanel.tsx` | live front preview panel | B |
| `tests/catalogue-*.test.ts` | CRUD, dup/one-category validation, search, aliases, preview object, import/export, roles | C |

## Files — EDIT (repoint, additive/back-compat)
| File | Change |
|---|---|
| `shared/pokemon-rarity-catalogue.ts` | optional snapshot param on helpers (default seed); export SEED_* |
| `shared/structured-variant-validate.ts` | optional snapshot param threaded to helpers (default seed) |
| `server/lib/structured-variant.ts` | pass DB snapshot into validate |
| `server/routes.ts` | register catalogue + label-preview route modules |
| `client/.../RarityVariantPicker.tsx` | consume `useCatalogue` (fallback seed) |
| `client/src/pages/admin-pokemon-knowledge.tsx` | consume `useCatalogue` (fallback seed) |
| `client/src/App.tsx` + admin nav | route + "System → Catalogue Manager" link |
| `WorkstationPreviewAside.tsx` | mount CertificatePreviewPanel (Rarity/Review stages) |

## Explicitly OUT of scope (deferred — protected/legacy)
- Legacy `RARITY_OPTIONS`/`VARIANT_OPTIONS`/`UNIFIED_OPTIONS`/`COLLECTION_OPTIONS` comboboxes
  (`client/src/lib/*Options.ts`): these write the LEGACY `variant`/`rarity` columns guarded by
  the protected "variant XOR rarity" grading save rule. Repointing them changes the protected
  grading save path → needs separate explicit owner approval (mvgs-grading-protected). Flagged, not done.
- NO changes to MVGS scoring, centering, Pristine gate, approve-lock, label rendering.
- Ride-along: applying 0019 via the runner will also pend 0017/0018 (partner/correction, other
  sessions). Owner decides at the gate whether they ride along or reconcile first.

## Rollback
- Code: `git worktree remove`; branch unpushed. Migration authored-only → nothing applied.
  Rollback SQL authored alongside 0019. Pickers fall back to seed arrays if table absent.
