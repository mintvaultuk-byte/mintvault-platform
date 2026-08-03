# Program Ledger — Four-Build Coordinated Integration & Staging Release

**Governance:** controlled-code-lead v1.1 · **Started:** 2026-07-24 · **Lead session** (this Claude)
**Goal:** Reconcile 4 workstreams → one integration candidate → staging → STOP before prod.
**Hard prohibitions (owner):** No prod deploy. No prod migration. No CodeQL dismissal w/o founder. No touching another session's worktree/branch/stash.

## Stage 0 — Baseline (VERIFIED DIRECTLY 2026-07-24)

| Fact | Value |
|---|---|
| origin/main SHA | debea36bfae7855b4028070b8a6648c95b3c9c11 (contains #239 + #240) |
| Staging (mintvault-v2) /api/version | debea36b (= main tip) |
| Prod (mintvault / mintvaultuk.com) /api/version | d5daecbf (PR #236 merge — BEHIND main; no #238/#239/#240) |
| PR #242 head (review-polish-clean) | fa5be2fd — CI CLEAN (CodeQL pass) |
| PR #243 head (feat/catalogue-manager) | f97fbd03 — CI UNSTABLE (CodeQL RED: js/polynomial-redos labels.ts:384) |
| PR #239 (rarity-clear) | MERGED to main (b69e353e / merge debea36b) |
| PR #240 (print workflow, mig 0022) | MERGED to main (merge 4f6449c9) |

### Migration journals (READ DIRECTLY — staging via local .env, prod via `fly ssh`)
| Migration | main repo | staging journal | prod journal |
|---|---|---|---|
| 0001–0016 | ✓ | applied | applied |
| 0017 partner_credit_reservations | ✓ | **MISSING (obj absent)** | applied |
| 0018 correction_audit_index | ✓ | **MISSING (obj absent)** | applied |
| 0019 catalogue_manager (#243 only) | #243 | free (catalogue_items absent) | free (catalogue_items absent) |
| 0022 print_workflow_lifecycle (#240) | ✓ | applied | **MISSING** |

**Migration numbering decision:** 0019=catalogue (KEEP, free within four-build set + all envs), 0022=print (KEEP, already merged). NO renumbering needed. Reported 0019 "collision" is with OTHER non-release branches (G6D, grading-concurrency) — NOT in this integration.

**Staging apply reality:** runner applies pending in numeric order → applying catalogue 0019 will ALSO apply 0017+0018 (staging never received them; partner flags OFF so staging runs fine without). All three additive/idempotent (0017 IF NOT EXISTS; 0018 concurrent-index via runner directive; 0019 authored additive). OWNER MUST APPROVE this 3-migration staging apply.

**Prod (future, NOT this task):** prod lacks 0019 AND 0022; a prod deploy would need 0022 applied BEFORE print code + 0019 for catalogue. Documented only.

### Preview endpoint collision
- #242: inline `server/routes.ts` `POST /api/admin/label-preview` (requireAdmin). Client LabelPreview.tsx/CardPreviewPanel.tsx.
- #243: modular `server/routes/admin/label-preview.ts` `POST /api/admin/certificates/label/preview` (previewLimit rate-limit + adminOrStaffRead + shared buildPreviewFields). Client CertificatePreviewPanel.tsx.
- Both mount in WorkstationPreviewAside.tsx. Both call generateLabelPNG. → Consolidate to ONE (leaning #243's hardened modular endpoint) on merged tree.

### CodeQL
- js/polynomial-redos, server/labels.ts ~384, regex `/\s+black star promos?$/i`. Pre-existing regex; #243 preview route adds a taint path. Source controls: trim/collapse whitespace + 200-char cap. Owner decision required (A regex-harden / B restructure taint / C justified dismissal). labels.ts is PROTECTED.

## Integration order (confirmed by dependency): main(#239+#240) → #242 → #243(after preview consolidation + CodeQL decision).

## Stage 4/5 — Integration built (2026-07-24)
- Integration worktree: /Users/cornelius/mintvault-four-build-integration (branch integration/four-build-release-candidate, from debea36b).
- Checkpoint 1: merge #242 (review-polish-clean fa5be2fd). tsc 0, 71 focused + MVGS 187 pass.
- Checkpoint 2 (00bd55ec): merge #243 (feat/catalogue-manager f97fbd03, --no-commit) + preview consolidation.
- Preview consolidation applied per change-manifest: canonical = #243 modular endpoint; #242 inline route + LabelPreview.tsx removed; canonical route now applies structured variant (3-arg catalogue snapshot) + loads saved cert base (Pristine fidelity); client mounts ONE CertificatePreviewPanel with structured keys + certificateId.
- Semantic-merge catch (auto-merge missed): #242 inline route called applyStructuredVariantFromBody with the OLD 2-arg signature; #243 changed it to 3-arg (catalogue). Removing #242's inline route resolved it; canonical route uses correct 3-arg form.

## Stage 6 — Regression (integration candidate)
- tsc: 0 errors. build: OK. lint: 0 errors (2356 pre-existing warnings; my changed files 0 problems).
- Full vitest: 1822 passed / 781 skipped / 17 FILES failed — ALL 17 are DB-backed disposable-PG17/DATABASE_URL suites (postgres17-cluster pg_ctl won't start in this local sandbox; need TEST_DATABASE_URL). NONE reference consolidation surfaces. Same class the #243 session documented. Authoritative gate = PR CI (Postgres service), which passed on #242 and #243 individually.
- Hermetic/logic suites pass locally: catalogue 33+, variant-line-consolidation (repointed), grading-stages (repointed), structured-variant, rarity-structured-compat, MVGS 187, pristine.
- Single canonical preview endpoint confirmed (1 route, 1 registration). LabelPreview import 0.
- Secret scan on diff: clean. #239 clear-rarity + cross-cert guard: preserved (Lead-verified).
- Staging migration DRY-RUN (read-only): 20 total, 17 applied, 3 pending (0017,0018,0019), 0 checksum-mismatch → catalogue 0019 applies cleanly; 0022 checksum matches staging journal.
- CodeQL js/polynomial-redos labels.ts:406 → HELD for founder (see codeql-decision.md). labels.ts NOT edited.
