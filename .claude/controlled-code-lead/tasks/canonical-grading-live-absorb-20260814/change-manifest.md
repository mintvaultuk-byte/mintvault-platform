# Change manifest — Canonical grading live absorb

**Date:** 2026-08-14
**Lead session:** `codex/unified-grading-live-absorb-20260814` at `90f906259992de8b326422fdece2f593d3a3b4e0`

## Findings this manifest addresses
- CG-LA-01 — absorb the divergent production lineage — classification G.
- CG-LA-02 — resolve the 38 named file conflicts / 43 conflict blocks semantically — classification B.
- CG-LA-03 — protect against main and production movement — classification G.
- CG-LA-05 — retain, do not run or alter, the established migration identity — classification C.

## Findings explicitly deferred
- CG-LA-04 — pre-existing CodeQL backlog. The final PR must prove no new alert/regression; this manifest neither suppresses nor claims to resolve historical alerts.

## Files to change

| File group | Change | Why | Classification |
|---|---|---|---|
| `.claude/controlled-code-lead/INDEX.md` and historic `partner-pilot-*` task records listed by the merge | Preserve both valid historical records without changing runtime behavior. | CG-LA-02 | A |
| `client/src/components/grading/{centering-input,grade-display,grading-panel}.tsx` | Retain candidate's protected canonical panel integration while incorporating live-only non-maths behavior where the four-way comparison proves it. No scoring constants, formulas, thresholds, centering bands or Pristine rules may change. | CG-LA-02 | B |
| `client/src/pages/{admin-staff,admin/partner-management,cert-detail,partner/certificates,partner/grading}.tsx` and `docs/planning/PARTNER_PILOT_PLAN.md` | Keep every live route/capability while retaining the single `GradingWorkstation` adapters and scanner-control slots. | CG-LA-02 | B |
| `server/{grader.ts,lib/draft-grade-authority.ts,routes.ts,routes/grader.ts,routes/admin/label-preview.ts,scanner-capture-service.ts}` | Union live authority/scanner behavior with candidate revision-bound preview and manual/auto approval CAS; preserve zero-side-effect stale losers. | CG-LA-02 | B |
| `server/partner/{certificate-history-service,grading-routes,print-eligibility,station-routes,station-service}.ts` | Preserve tenant/location/provenance/MFA/rate-limit/signed-station semantics and live Partner functionality. | CG-LA-02 | B |
| `tests/{draft-grade-authority,partner-pilot-certificate-allocation-and-print,partner-schema-parity,partner-station-fleet-control,partner-station-identity,structured-variant-persistence,variant-line-consolidation}.test.ts` | Retain the union of production behavior regression proof and candidate canonical assertions. | CG-LA-02 | B |
| `.claude/controlled-code-lead/tasks/canonical-grading-live-absorb-20260814/*` | Add release ledger, proof, rollback/rollout, snapshots and final evidence. | CG-LA-01..05 | G |

## Files explicitly NOT touched
- `shared/mvgs-scoring.ts`, `shared/centering.ts`, `shared/pristine.ts`, `shared/mvgs-input-builder.ts` — protected MVGS maths and gates are byte-identical across the reviewed lineages.
- `migrations/0073*` through `migrations/0078*`, `scripts/db/migrate.ts`, `shared/schema.ts` — no workstation schema change is required; migration history remains untouched.
- Authentication/login/PIN/session files, Stripe/webhook files, secrets and environment configuration — out of scope.
- `/Users/cornelius/mintvault-platform` and `/Users/cornelius/mintvault-unified-grading-20260814` — preserved worktrees, not merge targets.

## Protected actions required
- [x] Normal merge into the isolated local branch — owner runbook expressly directs Phases 3–6.
- [x] Local final commit and push — owner runbook authorises only after all reconciliation and local gates pass (Phase 24).
- [x] Protected PR and normal merge — owner runbook authorises only with exact-SHA green checks and current main (Phases 25–26).
- [x] Production deploy — owner runbook conditionally authorises `scripts/safe-deploy.sh prod` only after every Phase 27–28 condition is proved.
- [x] MVGS-adjacent conflict resolution — owner runbook expressly authorises preservation of the reviewed canonical workstation, while prohibiting any MVGS maths change.
- [x] Migration application — not authorised and not required.

## Order of operations
1. Merge live `6f0d59df` into this isolated branch with `--no-commit`.
2. Resolve every conflict by comparing merge base, current main, live and candidate. Retain candidate canonical composition and union live-only runtime behavior.
3. Classify every live-only item A–D and add category A behaviors/tests if missing.
4. Re-run moving-target, migration identity, architecture, authority, scanner/station, Partner and quality gates; repair any confirmed in-scope defect.
5. Commit, push and open a protected PR only after local gates pass; merge and deploy only under the recorded conditional authority.

## Regression gates required
- [x] `npm run check`, `npm run lint` (zero errors), `npm run build`, SQL/migration lint; final `git diff --check` remains a pre-commit gate.
- [x] Canonical architecture, five-role browser geometry, compact preview, review no-write, preview runtime/revision barrier, manual and auto CAS, printability, scanner/station, Partner RBAC/MFA/upload, migration and MVGS guards.
- [x] Full suite under isolated sanctioned PostgreSQL infrastructure. The failing no-URL/parallel attempt was remediated by the serial loopback CI run; it is not used as a pass.
- [x] Architecture and MVGS negative mutation proofs, restored byte-identically.
- [ ] Exact final-PR GitHub checks; post-merge natural ancestry guard; post-deploy multi-machine/version/route/browser verification.

---
**Approved to proceed to Stage 5:** Cornelius Oliver — explicit conditional authority in the supplied final canonical live-absorb runbook, 2026-08-14.
