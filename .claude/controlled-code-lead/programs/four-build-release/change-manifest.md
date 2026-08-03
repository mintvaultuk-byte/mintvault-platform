# Change Manifest — Preview Consolidation (#242 ⊕ #243)

**Decision:** Canonical preview = #243's modular endpoint `POST /api/admin/certificates/label/preview`
(rate-limited, adminOrStaffRead, buildPreviewFields 200-char caps = ReDoS mitigation) + client
`CertificatePreviewPanel` (debounced, correct object-URL lifecycle, apiRequest). #242's inline
`/api/admin/label-preview` + `LabelPreview.tsx` REMOVED. #242's feature value (consolidated
structured variant line + preview↔print parity) lives in `labels.ts consolidatedVariantForLabel`
+ `shared/variant-line.ts` — SHARED by the canonical endpoint, so it is preserved. To keep parity
the canonical endpoint must APPLY structured variant and the client must SEND structured keys.

| # | File | Change | Class |
|---|---|---|---|
| 1 | server/routes/admin/label-preview.ts | After buildPreviewFields, call `applyStructuredVariantFromBody(req.body, cert, await getCatalogueSnapshot())` (best-effort) so the consolidated structured line renders in preview = #242 parity. | B |
| 2 | server/routes.ts | REMOVE inline `/api/admin/label-preview` route (~4347–4431) — duplicate. | B |
| 3 | client/.../CertificatePreviewPanel.tsx | Extend `CertificatePreviewFields` with rarityCode/finishVariant/promoType/subsetName/era (structured) — subgrades already declared. | B |
| 4 | client/certificate-form.tsx | Remove `import LabelPreview` + `<LabelPreview>` mount + now-unused `labelPreviewDirty()`. Extend CertificatePreviewPanel `fields` with structured keys (rarityCode/finishVariant/promoType/subsetName/era) + subgrades (gradeCentering/corners/edges/surface) for black-label fidelity. | B |
| 5 | client/.../LabelPreview.tsx | DELETE (unused after consolidation; only importer was certificate-form). | B |
| 6 | tests/variant-line-consolidation.test.ts | Repoint the "same generateLabelPNG, no second renderer" assertion from routes.ts inline route to the canonical module server/routes/admin/label-preview.ts. | C |

**Preserved:** consolidated variant line · preview↔print parity · black-label(Pristine) fidelity ·
legacy compat (old certs unchanged) · single canonical variant-line formatter · catalogue DB options.
**Security:** the ONLY preview taint into PROMO_SUFFIX_RE (labels.ts) is now the capped canonical
endpoint (setName ≤200 + whitespace-collapsed). #242's uncapped inline path is removed → net improvement.
**Protected files:** labels.ts NOT modified by this consolidation (only #242's already-approved variant-line
change from the merge remains). No MVGS/grade/centering/Pristine-gate logic touched.
**CodeQL:** held for founder decision (separate report) — NOT dismissed by Lead.
