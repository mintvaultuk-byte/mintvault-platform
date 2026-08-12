# Task ledger — Partner Pilot Pass 2

## Stage 0 — Baseline (recorded 2026-08-12 13:42 BST)

- Branch: `codex/partner-pilot-pass2`
- Commit: `864fadeda88e06e083bfa483a7fe33520a4570e2`
- `git status`: clean before the governance records created for this task.
- Production: `b0de0880` from `https://mintvaultuk.com/api/version` at
  2026-08-12 12:40:53 UTC; `/health` was `200`; the two Partner probes were
  both `503`.
- Pass 1: `7368b07e695b64ceaa9e7c449ce844c2ef00afc3`, one commit ahead of
  this baseline. It must be semantically integrated, not deployed wholesale.
- Build/test status: unmeasured on this new candidate at Stage 0. Pass 1 local
  proof is historical only and is invalidated by integration.
- Protected systems in play: MVGS authority/labels, Partner auth/runtime/RLS,
  partner credits, certificate allocator, scanner evidence/R2, migrations,
  production deployment and physical printing.
- Explicit scope: Pass 2 must complete the code and local/integration proof
  needed for one Partner card from controlled credit through capture, MVGS, 100%
  QA, server-gated print and history, using the canonical product surfaces.
- Explicit prohibited actions: do not deploy, push, change secrets or runtime
  configuration, create DB roles, apply any migration, mutate Stripe/live data,
  or perform physical capture/print without a narrow owner approval/interaction.

## Stage progress

| Stage | Status | Date | Notes |
|---|---|---|---|
| 0 — Baseline | complete | 2026-08-12 | Clean candidate created from current `origin/main`; live and Pass 1 ancestry captured. |
| 1 — Review plan | complete | 2026-08-12 | Three non-overlapping, read-only reviewer scopes completed. |
| 2 — Investigation | complete | 2026-08-12 | Reports recorded as `reviewer-*.md`; no reviewer made a change. |
| 3 — Lead verification | complete | 2026-08-12 | Findings PP2-F1 through PP2-F13 consolidated; source and live evidence rechecked. |
| 4 — Implementation authorisation | complete for packages A–C | 2026-08-12 | `change-manifest.md` records bounded local-source authority, QA/flag and station packages. |
| 5 — Implementation | complete for packages A–C | 2026-08-12 | All changes are local source/tests; 0074 and new 0075 are unapplied migration files. |
| 6 — Regression | in progress | 2026-08-12 | Focused authority, QA and scanner suites, typecheck, lint and build pass; full suite has known environment/native-render limits recorded in definition of proof. |
| 7 — Final report | pending | | External production/runtime/physical acceptance gates remain. |

## Reviewer assignments

| Reviewer | Scope | Status |
|---|---|---|
| `runtime_reconciliation` | live/lineage, Partner mount/runtime, role/RLS/config and migrations | in progress; read-only |
| `credits_qa_audit` | credit lifecycle, QA, print gates, tenancy/security proofs | in progress; read-only |
| `scanner_product_audit` | native scanner/product flow and canonical workstation surfaces | in progress; read-only |

## Links

- Program: `../../programs/partner-pilot/program-ledger.md`
- Issue register: `issue-register.md`
- Reviewer status: `reviewer-status.md`
- Architecture before: `architecture-before.md`
- Change manifest: `change-manifest.md`
- Rollout: `rollout.md`
- Rollback: `rollback.md`
- Deployment state: `deployment-state.md`
