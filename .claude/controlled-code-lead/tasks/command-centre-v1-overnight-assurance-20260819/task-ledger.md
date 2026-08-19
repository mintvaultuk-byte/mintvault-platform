# Task ledger — Command Centre V1 overnight release assurance

## Stage 0 — Baseline (recorded 2026-08-19 20:57 UTC)

- Governed repository/worktree: `/Users/cornelius/mintvault-command-centre-reconciled`
- Branch: `codex/command-centre-v1-reconciliation-20260819`
- Authoritative starting HEAD: `c485a7f839fd6614948740eca3972e3f8a081f68`
- Freshly fetched `origin/main`: `facfd36f4ec8f164d017aba7a4386bab04a4aa6d`; no drift from the prior reconciliation parent.
- `git status`: clean; the dirty primary workspace `/Users/cornelius/mintvault-platform` remains untouched.
- Prior task/program state: `command-centre-v1-reconciliation-20260819`, Stage 7 complete; exact staged source artifact `60b9e2683c6866a385496d14de1a780615858468`, Fly staging version `532`.
- Governance: version 1.2; baseline combined governance snapshot hash `de71677d7151e9372c8465794e504b2aded531b4c2469a7b6ba685e96964afd1`; all five governance self-test suites passed at task start.
- Engineering OS preflight: `CRITICAL` / `HOSTILE`, protected Partner paths detected, Graph status `REBUILD_REQUIRED` because graph metadata is absent. The locked V1 contract excludes Graphify; source, behavioural, adversarial, drift, staging and rollback loops are the applicable evidence loops.
- Reviewer isolation: the reviewer allowlist self-test passed; all delegated reviewers are explicitly read-only and may not edit, mutate Git, access production, change staging state, or deploy.
- Protected systems in play: Super Admin authorisation boundary, Partner RLS/read visibility and persisted global Pilot Flag, grading/certificate immutability, finance/credits/payment read safety, Scanner/station boundaries, staging deployment/rollback.
- Explicit scope: final no-new-feature assurance across workstreams A–O, repair every reproduced in-scope BLOCKER/HIGH defect, re-run affected proofs, verify the exact staging candidate and prepare the final assurance/evidence package.
- Authorised protected staging actions: read-only staging inspection and logs; persisted staging Pilot Flag ON → OFF → ON acceptance; staging safe redeploy only if candidate application code changes and only after local gates. These permissions expire with this task.
- Explicit prohibited actions: any production access, query, deploy, flag/config/data mutation; migration; dependency or environment/secret change; payment/webhook write; protected grading change; business-data mutation; `git push`; destructive database/storage action; unsafe load or chaos against staging.
- Single authorised next action: independent read-only specialist reviews plus Lead-owned local/runtime and read-only staging verification. No implementation change is authorised until a finding is reproduced and a bounded change manifest is written.

## Stage progress

| Stage | Status | Date | Notes |
|---|---|---|---|
| 0 — Baseline | complete | 2026-08-19 | Clean exact baseline, current main, governance integrity and task lock recorded. |
| 1 — Review plan | complete | 2026-08-19 | Three isolated reviewers cover A–G/J/K initially; follow-on passes cover I/L/M/N/O. Lead owns live UI, toggle, staging load/log/soak and final reconciliation. |
| 2 — Investigation | complete | 2026-08-19 | All independent A–O reports received; reviewers remained read-only and HEAD unchanged. |
| 3 — Lead verification | complete | 2026-08-19 | Twenty-two findings reconciled through iterative hostile retest. Parser-only auth approval received, then stopped because the mandated trust-proxy authority precondition failed. |
| 4 — Implementation authorisation | complete | 2026-08-19 | Bounded non-auth manifest/budget/architecture/rollout/rollback written. Local repair and staging-if-changed are explicitly authorised by the owner. |
| 5 — Implementation | complete | 2026-08-19 | Every non-auth HIGH/release-MED root cause repaired within the locked read-only V1 surface; no migrations, dependencies, grading, Scanner feature, payment/ledger writes or protected auth changes. |
| 6 — Regression | in progress | 2026-08-19 | Focused 129/129, full canonical Partner 70/70 suites, runtime signal/failure cleanup, real PostgreSQL finance, check/lint/build and independent retest green. Exact staging deployment/acceptance remains. |
| 7 — Final report | pending | | Overnight assurance plus reconciled evidence package. |

## Reviewer assignments (Stage 1)

| Reviewer | Workstreams | Boundary | Report state |
|---|---|---|---|
| Auth/security reviewer | A auth/session/flag; C grading/certificate authority; L/O retest | Read-only source/tests; no staging or production state | complete — only owner-blocked `CC-OA-001` remains |
| Partner/domain reviewer | B Partner/RLS/privacy; D/E/I/M/H | Read-only source/tests; protected code inspection only | complete — no open source finding; live viewport/control proof pending |
| Data/resilience reviewer | F/G/J/K/D | Read-only source/tests; safe local commands only | complete — no open BLOCKER/HIGH/release-MED |
| Lead | H live controls; feature flag runtime; I/M live deep-link/accessibility; L harness; N drift; O release/rollback; final issue register | Sole editor and sole staging-state operator | in progress |

## Links

- Issue register: `issue-register.md`
- Reviewer status: `reviewer-status.md`
- Deployment state: `deployment-state.md`
- Governance snapshot: `governance-snapshot.json`
- Change manifest / implementation budget / rollout / rollback / definition of proof: created or finalised by the Lead at the applicable stage.
