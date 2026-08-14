# Task ledger — Canonical grading left-rail refinement (2026-08-14)

## Stage 0 — Baseline (recorded 2026-08-14)
- Branch: `codex/canonical-left-rail-refinement-20260814` from clean `470699f47b2ae6e2f908367a84f2f91da630c1ef`.
- `git status`: clean in this isolated worktree. The shared root is dirty on `psp/partner-rbac-hybrid` and remains untouched.
- Production: `v1081`, commit `470699f4`, verified by `https://mintvaultuk.com/api/version`; both Fly machines are `started`, `1/1`.
- Protected systems in play: canonical grading workstation presentation only. MVGS maths, the review authority state machine, label renderer, scanner/station controls, migrations, authentication, payments and secrets are excluded.
- Explicit scope: remove only the visible label-preview chrome from the one shared left-rail component so recovered vertical space expands the existing card viewer for all five role modes.
- Explicit prohibited actions: no grading semantics, server route/renderer, scanner/station, schema, migration, authentication, payment or environment change; no edits in another worktree; no force push.

## Stage progress

| Stage | Status | Date | Notes |
|---|---|---|---|
| 0 — Baseline | done | 2026-08-14 | Main/live SHA and isolated clean worktree reconciled. |
| 1 — Review plan | done | 2026-08-14 | Direct Lead review only: one deterministic shared presentation component and existing five-role harness; no parallel reviewer is needed. |
| 2 — Investigation | done | 2026-08-14 | Reproduced F1 in the shared preview source and traced its single mount and rail flex contract. |
| 3 — Lead verification | done | 2026-08-14 | F1 accepted; no logic/state/API contract changes are required. |
| 4 — Implementation authorisation | done | 2026-08-14 | Owner's supplied micro-repair brief explicitly authorises the exact presentation-only change; manifest and rollback recorded. |
| 5 — Implementation | done | 2026-08-14 | The one shared component now renders a direct 266px maximum certificate image and compact state text only; its request, revision, acknowledgement and abort flow remains intact. |
| 6 — Regression | done locally | 2026-08-14 | 141 scoped assertions and a serial 4,554-assertion full run are green; mutation proof, five-role browser geometry, typecheck, lint, build and diffcheck are green. Exact-PR CI remains the protected release gate. |
| 7 — Final report | pending | | |

## Reviewer assignments (Stage 1)

| Reviewer | Scope | Report |
|---|---|---|
| Lead direct review | Shared preview component, rail flex contract, mounted regression suite and real dev harness | F1 verified; no external reviewer required for this small, single-component repair. |

## Links

- Issue register: `issue-register.md`
- Change manifest: `change-manifest.md`
- Rollout: `rollout.md`
- Rollback: `rollback.md`
- Deployment state: `deployment-state.md`
- Definition of proof: `definition-of-proof.md`
