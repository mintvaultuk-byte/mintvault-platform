# Rollout — governance-phase-9

**Classification:** governance / local-only. No deploy, no push, no migration.

## Pre-rollout checklist (9A)
- [x] All 9A regression gates pass (tsc, vitest, diff review, changed-file allowlist, secret scan)
- [x] Change manifest implemented, no partial edits
- [x] No protected action (push/deploy/migrate/rotate) taken

## Steps
1. One LOCAL commit on `governance-phase-9`: "Phase 9A — Governance stabilisation and version control". NOT pushed.
2. STOP at the mandatory restart checkpoint (agent/hook registration is startup-gated).
3. Owner restarts Claude Code.
4. New session resumes THIS task from `task-ledger.md`; recompute snapshot; prove reviewer isolation; then 9B.

## Who/what is affected
- Only the governance framework's git-tracked state on a local dedicated branch. No customer/prod impact.

## NOT in this rollout (deferred, owner-gated)
- Pushing the branch; the hook rewrite (9B); permission-rule remediation (9B); credential rotation (separate plan); program layer + scale (9C).
