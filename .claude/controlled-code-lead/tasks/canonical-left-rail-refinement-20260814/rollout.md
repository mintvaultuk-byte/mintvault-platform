# Rollout — Canonical grading left-rail refinement

**Classification:** A (presentation-only code change with controlled production release)

## Pre-rollout checklist

- [x] Exact source/tests/browser evidence pass locally.
- [ ] The final PR SHA has all required checks green and introduces no new high/critical alert.
- [ ] `origin/main` has not moved incompatibly and the final live SHA is an ancestor of the merged SHA.
- [ ] Owner's conditional push/merge/deploy authority from the supplied brief is still satisfied.

## Steps

1. Push the isolated branch and open a normal protected PR.
2. Merge only the exact green head after refreshing `origin/main`.
3. Reconcile Fly release, live version and ancestry; deploy the merged main SHA only through `scripts/safe-deploy.sh prod`.
4. Verify both machines, `/health`, `/ready`, `/api/version`, and the deployed static artifact for absence of the removed preview chrome.

## Affect

All five canonical grading roles receive the same visual density change. No database, scanner, label renderer or customer record changes occur.
