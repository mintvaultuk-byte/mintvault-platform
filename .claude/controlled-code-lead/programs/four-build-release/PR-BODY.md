## Four-Build Coordinated Integration Candidate

Reconciles four completed workstreams into one staging candidate. **Staging only — production NOT deployed.**

### Constituents
| PR | What | Migration |
|---|---|---|
| #239 | Explicit "No rarity — clear" (empty rarity persists; no mount-wipe; no cross-cert leak; single-select; finish/promo independent) | none — already on main |
| #240 | Print Workflow (Approval → Printing → Printed) | 0022 — already on main + applied to staging |
| #242 | Review-stage live 1:1 preview + consolidated structured Variant line (`shared/variant-line.ts`, version-gated ≥2; old certs unchanged until edited) | none |
| #243 | Catalogue Manager — DB-backed classification catalogue + admin UI + import/export + catalogue-backed picker | 0019_catalogue_manager (free on main/staging/prod) |

### Integration decisions
- **Base:** origin/main @ debea36b (already contains #239 + #240). Order: main → #242 → #243.
- **Preview consolidation (the one real collision):** #242 and #243 each shipped a live label-preview. Consolidated to ONE canonical endpoint `POST /api/admin/certificates/label/preview` (modular, rate-limited, `adminOrStaffRead`, `buildPreviewFields` 200-char caps). Removed #242's duplicate inline `POST /api/admin/label-preview` + `LabelPreview.tsx`. The canonical route now (a) applies the same server-authoritative structured-variant derivation the save routes use (so the consolidated variant line renders — #242 parity), and (b) loads the saved cert base when editing (so the black-label/Pristine preview matches print — #242 fidelity). Client mounts ONE `CertificatePreviewPanel` for Rarity+Review.
- **Migration numbering:** 0019 = catalogue (unique within this set; free on all three journals). 0022 = print (unchanged). No renumbering. The reported 0019 "collision" is with OTHER non-release branches (G6D, grading-concurrency), not this integration.
- **Semantic-merge catch:** #242's inline route called `applyStructuredVariantFromBody` with the old 2-arg signature; #243 changed it to 3-arg (catalogue snapshot). Removing #242's inline route resolved it; canonical route uses the 3-arg form.

### Verification
- tsc 0 · build OK · lint 0 errors (changed files 0 problems).
- Full vitest 1822 passed / 781 skipped; 17 DB-backed disposable-PG17 suites deferred to this PR's CI (don't run in the local sandbox; passed on #242/#243 CI individually). MVGS 187/187, catalogue, variant-line, grading-stages, structured-variant all green locally.
- Staging migration dry-run: 20 total / 17 applied / 3 pending (0017, 0018, 0019) / 0 checksum-mismatch.
- Secret scan clean. Single canonical preview endpoint confirmed. #239 clear + cross-cert guard preserved.

### Preserved (no behaviour change)
MVGS grading/centering/Pristine gate/approve-lock · certificate numbering · physical label rendering for existing certs · Print Workflow · legacy variant/rarity values (never erased) · single-select rarity · finish/promo independence.

### ⚠️ Founder decisions required before staging apply/deploy
1. **CodeQL** `js/polynomial-redos` @ `server/labels.ts:406` (pre-existing regex, protected file). Founder decision: **HELD** — `labels.ts` is NOT changed in this branch. To be evaluated in this combined review; a one-line semantics-preserving hardening (`\s+`→`\s{1,64}`) will be applied ONLY if proven byte-identical for all rendered labels AND proven to clear CodeQL, with focused regression tests; otherwise evidence is presented for founder approval before any protected-code change. Runtime is already capped (200-char + whitespace-collapse at the only entry). **Not dismissed by Lead.**
2. **Staging migration apply** will apply 0017 + 0018 + 0019 (staging never received 0017/0018; all additive/idempotent).
3. **Deploy to staging** (mintvault-v2) after merge.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
