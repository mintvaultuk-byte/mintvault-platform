# Task ledger — White Ace repository assurance and remediation intake

## UTC-credit continuation — 2026-09-05

Pre-wave15101b2844187aa184198d5116e2898463dfae61, preserved unrelated
docs/planning/vault-worlds, owner-CREDIT approved from existing explicit record.
Root sole writer, Terra bounded reproduction, Sol independent verification. Read the
approved packet in change-manifest.md and rollback.md; historical exclusions below
are not current credit authority. Other protected or external gates remain intact.
Old service: independent22/24; augmented root suite22pass/5fail after permitting only
the owned PG17 loopback fixture (first sandbox attempt had EPERM/27skipped, not red proof).
WIP: UTC timestamp writes and refund RETURNING status; three real credit/idempotency/
recovery suites43/43, zero skips. Independent boundary/mutation work remains in progress;
not exact-candidate certification. Parent program valid:true/ready:false,101+34 nodes.
No migration, deploy, provider call, new dependency or live credential use.

Changed-surface proof: Sol held-out PG17 reproduces trusted request day preceding SQL
UTC day (repeat admitted; refund reported true while count remained1). Root adds
lagged-day and late-old-window regressions: intermediate source27pass/2fail. Final
admission uses input.today::date::timestamp for both writes and monotonic newer-or-same
day admission; direct/stale compensation retains recorded-day guards and UTC writes.
Final three-suite matrix45/45 on root Vitest4.1.11 and exact-lock Vitest4.1.7 copy
/private/tmp/mintvault-h1ef-clean.x3NRtE; no skips. Two initial UTC regressions unchanged;
five added cases cover stale recovery, old-day direct/stale compensation, midnight
request lag and old-day rewind. Existing concurrency/idempotency tests remain intact.

Commands: pinned Node20.20.2 runs vitest for estimate-credit-consumption-owner-binding,
estimate-credit-idempotency, estimate-credit-recovery-lifecycle with --pool=forks
--maxWorkers=1 --no-file-parallelism. env -i supplies only locale/PATH/POSTGRES17_BIN.
The existing fixture creates mkdtemp/initdb PG17.10 on a random127.0.0.1 port, assigns
only that generated cluster URL to its process-local MINTVAULT_DATABASE_URL alias before
service import, and stops/removes only its owned cluster. No inherited URL or .env read.
An execution-guard rejection on alias ambiguity was resolved by these read-only source
checks and an approved retry of the SAME command; no indirect execution or config bypass.

Final npm run check, check:tests (unchanged345), architecture:check (unchanged8455),
and local production build PASS. Scoped lint0errors,40existing warnings; new tests
add no explicit-any warnings. git diff --check PASS. No generated snapshot change.
Governance-only postflight remains fail-closed on managed CLAUDE drift/npm egress/
preserved dirty tree/branch protected paths; Graphify REBUILD_REQUIRED. No --run or
--accept-protected used, no hostile/exact-candidate gate waived.
SHA256 service4bdc8a315a834354151aec0ccf802ad8bccadbc5d7e70aed7ae4544d2caa6e46;
test099be91c983f1cee6bf26e192c51d36d62857e6fbfb295e8be0efc7ace150087.

Independent Sol final review CLEAN: real45/45, zero skips. Isolated mutations all bite:
removing trusted-day/UTC writes fails2/3 focused assertions (direct/stale counts);
weakening monotonic < to <> fails delayed-old admission1/1; reverting refund CTE
RETURNING result fails1/1. Restore7/7 UTC cluster passes and both hashes match root.
Completed detached evidence worktree was safely moved with git worktree move from
.engineering/tmp/waa-credit-proof-15101b28 to
/private/tmp/mintvault-waa-credit-proof-15101b28, retaining both dirty overlay files,
Git registration and exact hashes; no files deleted or shared checkout absorbed.
REPAIR-CREDIT-UTC FIXED; independent local proof clean, PROOF-CREDIT still IN_PROGRESS
for immutable-candidate binding. No restricted security or final hostile gate closed.


## Stage 0 — Baseline (recorded 2026-09-04 Europe/London)

- Repository: `/Users/cornelius/mintvault-platform`.
- Branch: `fix/resource-hardening-staging-20260827`.
- Commit: `09beacaa5bc03f8e80e4c7e59232df6fc466b7cb`.
- Upstream: `origin/fix/resource-hardening-staging-20260827`; ahead/behind `0/0`.
- Relative to `origin/main`: 47 commits ahead, 0 behind; merge base `01d5e4daab30d58ad53943585ebecc972befaa8a`.
- `git status`: clean at baseline. Ten existing stashes and many separate worktrees were observed and will not be modified.
- White Ace package: `/Users/cornelius/Downloads/white-ace-assurance-v0.2.0-install-ready.zip`; SHA-256 `e8f549d3d7f5d15e1d2098ec119c7ef7dc21649a7942cebf85058b2142060a21`; package tests 6/6 passed.
- White Ace preflight: `NOT_ESTABLISHED`; deterministic local static scope; `WAA-SEC-022` and `WAA-SEC-022B` reported `FAIL`; all other unproved controls remain `UNKNOWN`, not implied failures.
- Engineering preflight: risk `CRITICAL`; required mode `HOSTILE`; protected branch surfaces listed by the command evidence.
- Graphify: reviewed local version `0.9.39`; code-only graph rebuilt after initial cache-permission failure; graph freshness check passes.
- Governance: version `1.2`; baseline input hash `6982453027781d27438d578c7d6ca22016fd9c8f4a076db26c920d78fe7ed22e` over the declared governance inputs in `governance-snapshot.json`.
- Production/staging identity: not queried; this assessment is not deploy-adjacent and has no provider or production-access authority.
- Protected systems in play: identity/tenancy, payments/entitlements, object storage and evidence, migrations, release/CI, protected grading boundaries, customer data and legal/provenance claims.
- Explicit scope: evidence-backed whole-repository assessment, reconciliation of the prior senior assessment with current source, and the smallest safe local remediation package for proven actionable BLOCKER/HIGH defects.
- Explicit prohibited actions: deployment, push, production/staging mutation, migration application or authoring without approval, dependency changes, secret/env changes, paid-provider calls, storage deletion, destructive operations, and edits to auth/payment/MVGS/protected systems without the required owner approval.

## Stage progress

| Stage | Status | Date | Notes |
|---|---|---|---|
| 0 — Baseline | complete | 2026-09-04 | Exact Git/governance/tool state recorded. |
| 1 — Review plan | complete | 2026-09-04 | Lead-only evidence lanes; no subagents requested. |
| 2 — Investigation | complete | 2026-09-04 | Graph/source/test/CI/migration/history reconciliation complete for the current local repository. |
| 3 — Lead verification | complete | 2026-09-04 | Four product HIGH findings and one local credential-permission HIGH accepted after deterministic reproduction/source/metadata verification; prior release findings reconciled. |
| 4 — Implementation authorisation | partial / owner pending | 2026-09-04 | Manifest admits safe proof/scanner repairs. Protected credit, certificate/storage, auth and migration repairs require explicit owner approval. |
| 5 — Implementation | partial | 2026-09-04 | Safe test/scanner/evidence repairs complete. No product, migration, dependency, environment or external-system change made. |
| 6 — Regression | in progress | 2026-09-04 | Focused/object-write/database/history proofs recorded; final safe static/build/postflight gates pending. Protected failing tests intentionally remain red. |
| 7 — Final report | drafted | 2026-09-04 | `white-ace-assessment.md` records current verdict `NOT_ESTABLISHED` / `NOT READY`. |
| 8 — Graph-loop repair plan | complete | 2026-09-04 | A 34-node/7-phase repair graph and phased multi-agent plan now map accepted findings to owner gates, sequential Lead repairs, independent proof, rollback, integration, external evidence, and release boundary. Structural validation passes; readiness fails by design. |
| 9 — Architecture scope correction | complete | 2026-09-04 | Owner challenge was valid. Three independent architecture lanes found systemic client/server/data/runtime wiring and authority defects outside this slice. This graph is now explicitly nested under `../repository-architecture-recovery-20260904/`; earlier bounded/concentrated wording is withdrawn. |

## Review lanes

| Reviewer | Scope | State |
|---|---|---|
| Lead | Authority graph, Git/CI/runtime reproducibility, supply chain | complete for local source; external CI/runtime remains unknown |
| Lead | Identity, tenancy, privileged services, tokens | complete for current source; protected token repair pending |
| Lead | Payments, entitlements, provider boundaries | complete for current source; protected credit repair pending |
| Lead | Evidence, object storage, provenance and recovery | complete for current source; protected image repair and live restore evidence pending |
| Lead | Tests, migrations, staging/release/observability evidence | complete locally; external evidence remains unknown |

Independent hostile review remains required before any release claim. No subagent was dispatched because this task did not include an explicit multi-agent request.

The subsequent owner request for a multi-agent graph-loop repair plan explicitly
authorised orchestration. Three read-only planning/skill-validation agents were then
used: one MintVault forward-plan test, one skill-behaviour reviewer, and one validator
adversary. They made no repository edits and did not review product repairs that have
not yet been authorised.

## Next authorised action

Obtain the five decisions in `repair-graph.json`: target/WIP disposition, local secret
permissions, credit behavior, image/storage behavior, and token/migration-0123
authoring. Until then, the graph is executable as a plan but protected repair nodes do
not have implementation authority.

## Graph-loop skill delivery

- Personal skill: `/Users/cornelius/.codex/skills/graph-loop-repair`.
- Skill manifest validation: pass.
- Validator behavioral/adversarial suite: 22/22 pass.
- Independent skill-behavior review: pass; no actionable HIGH remains.
- Independent validator QA: pass; valid controls pass and malformed/false-ready
  inputs fail closed with parseable JSON.
- MintVault graph: structurally valid, 34 nodes, 7 phases, 26 current release
  vetoes; `--ready` fails as required while owner/external/proof gates remain open.

## Links

- Canonical repository issue authority: `../../../../engineering/ISSUE_REGISTER.md`
- Canonical repository proof ledger: `../../../../engineering/PROOF_LEDGER.md`
- White Ace crosswalk: `issue-register.md`
- Deployment boundary: `deployment-state.md`
- Governance snapshot: `governance-snapshot.json`
- Architecture baseline: `architecture-before.md`
- Architecture after safe proof repairs: `architecture-after.md`
- White Ace assessment: `white-ace-assessment.md`
- Phased multi-agent repair plan: `phased-repair-plan.md`
- Machine-validated repair graph: `repair-graph.json`
- Authoritative parent architecture program: `../repository-architecture-recovery-20260904/`
