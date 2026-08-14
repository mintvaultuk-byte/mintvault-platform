# Task ledger — Canonical compact grading workstation density

## Stage 0 — Baseline (recorded 2026-08-14 14:52 UTC)

- Governed repository: `/Users/cornelius/mintvault-platform`
- Isolated worktree: `/Users/cornelius/mintvault-compact-workstation-density-20260814`
- Branch / baseline commit: `codex/canonical-compact-workstation-density-20260814` / `839edd9c45215bfba157b930b9ec5690d47ceac0`
- `git status`: clean at creation.
- Production baseline: Fly release v1082, commit `839edd9c`, verified by `https://mintvaultuk.com/api/version` at 2026-08-14 14:52 UTC; `/health` returned HTTP 200.
- Main baseline: `origin/main` is `839edd9c45215bfba157b930b9ec5690d47ceac0` (PR #298 merge).
- Protected systems in play: canonical grading workstation presentation and the MVGS-protected grading surface. No MVGS authority, scoring, centering, labels, printability, approvals, revision/CAS, scanner evidence, migrations, auth, or Partner RBAC code may change.
- Explicit scope: remove the normal filter row; recover inspection space; compact the shared left rail and all right-side Card Details, Grade, and Review stages for Super Admin, Pending Review, Staff, Grader, and Partner; prove geometry and behavioural preservation.
- Owner authorisation: the attached owner acceptance request explicitly permits the listed presentation-only changes, a protected PR/merge, and a controlled production deployment only after all stated gates. It does not authorise any protected grading-behaviour change.
- Explicit prohibited actions: no shared-root edits; no migrations or database writes; no dependency changes; no scoring/threshold/centering/Pristine/label/certificate-number changes; no direct deploy command; no absorbing the protected dirty universal-workstation worktree.

## Stage progress

| Stage | Status | Date | Notes |
|---|---|---|---|
| 0 — Baseline | done | 2026-08-14 | Clean worktree and live/main lineage captured. |
| 1 — Review plan | done | 2026-08-14 | Shared shell, rail, header, display and harness scopes identified. |
| 2 — Investigation | done | 2026-08-14 | 1280×800 and 1024×768 source/browser baseline captured. |
| 3 — Lead verification | done | 2026-08-14 | One canonical role-neutral geometry and protected boundaries confirmed. |
| 4 — Implementation authorisation | done | 2026-08-14 | `change-manifest.md` records the narrow owner-approved scope. |
| 5 — Implementation | done | 2026-08-14 | Shared presentation only: filter UI removal, 35% rail, compact certificate/card/stages/Grade/Review geometry, and dev-harness evidence hooks. |
| 6 — Regression | in progress | 2026-08-14 | Local focused behavioural suite, protected mutation red/green, build/type/lint, source review, and browser measurements completed; exact-PR CI remains. |
| 7 — Final report | pending | | |

## Reviewer assignments (Stage 1)

| Reviewer | Scope | Report |
|---|---|---|
| Lead | Source ownership, baseline geometry, behavioural gates | local evidence captured |
| Fresh read-only UI reviewer | Post-implementation hostile density review across all five roles | `reviewer-report.md` — no source BLOCKER/HIGH; independent browser unavailable in its environment |

## Links

- Issue register: `issue-register.md`
- Change manifest: `change-manifest.md` (to be written after investigation, before source edits)
- Rollout: `rollout.md`
- Rollback: `rollback.md`
- Deployment state: `deployment-state.md`
- Definition of proof: `definition-of-proof.md`
- Governance snapshot: `governance-snapshot.json`
