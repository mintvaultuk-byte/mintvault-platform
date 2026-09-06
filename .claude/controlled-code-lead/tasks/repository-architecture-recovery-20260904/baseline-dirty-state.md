# Preserved working-tree ownership snapshot

**Committed baseline:** `09beacaa5bc03f8e80e4c7e59232df6fc466b7cb`  
**Purpose:** prevent the architecture program from treating pre-existing White Ace WIP
as a clean baseline or silently overwriting it.

## Modified paths

- `.claude/controlled-code-lead/INDEX.md`
- `engineering/ISSUE_REGISTER.md`
- `engineering/PROOF_LEDGER.md`
- `tests/certificate-update-route.test.ts`
- `tests/customer-facing-route-boundaries.test.ts`
- `tests/estimate-credit-consumption-owner-binding.test.ts`
- `tests/manual-certificate-image-object-write.integration.test.ts`
- `tests/scanner-front-before-back.test.ts`

The five test changes and `.gitleaksignore` originated in the preceding White Ace WIP.
The three governance files are overlapping records: the architecture correction appends
to files already modified by that WIP. They must be reconciled, not reset.

## Untracked paths

- `.gitleaksignore`
- `.claude/controlled-code-lead/tasks/white-ace-assurance-repository-20260904/architecture-after.md`
- `.claude/controlled-code-lead/tasks/white-ace-assurance-repository-20260904/architecture-before.md`
- `.claude/controlled-code-lead/tasks/white-ace-assurance-repository-20260904/change-manifest.md`
- `.claude/controlled-code-lead/tasks/white-ace-assurance-repository-20260904/deployment-state.md`
- `.claude/controlled-code-lead/tasks/white-ace-assurance-repository-20260904/governance-snapshot.json`
- `.claude/controlled-code-lead/tasks/white-ace-assurance-repository-20260904/implementation-budget.md`
- `.claude/controlled-code-lead/tasks/white-ace-assurance-repository-20260904/issue-register.md`
- `.claude/controlled-code-lead/tasks/white-ace-assurance-repository-20260904/phased-repair-plan.md`
- `.claude/controlled-code-lead/tasks/white-ace-assurance-repository-20260904/repair-graph.json`
- `.claude/controlled-code-lead/tasks/white-ace-assurance-repository-20260904/reviewer-status.md`
- `.claude/controlled-code-lead/tasks/white-ace-assurance-repository-20260904/rollback.md`
- `.claude/controlled-code-lead/tasks/white-ace-assurance-repository-20260904/task-ledger.md`
- `.claude/controlled-code-lead/tasks/white-ace-assurance-repository-20260904/white-ace-assessment.md`
- `.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/architecture-damage-assessment.md`
- `.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/architecture-topology.md`
- `.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/baseline-dirty-state.md`
- `.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/change-manifest.md`
- `.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/issue-register.md`
- `.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/phased-repair-plan.md`
- `.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/repair-graph.json`
- `.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/reviewer-status.md`
- `.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/rollback.md`
- `.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/task-ledger.md`
- `.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/test_validate_program.py`
- `.claude/controlled-code-lead/tasks/repository-architecture-recovery-20260904/validate-program.py`

## Ownership rule

No repair wave may start until its exact write scope has been compared with this list.
Any overlap must preserve and reconcile the WIP explicitly. A new path, content change,
branch movement, stash/worktree movement, or ownership change invalidates this snapshot
and `AUTH-BASELINE` returns to OPEN.
