# Rollback — Canonical grading live absorb

## Trigger conditions
- The absorb merge changes protected grading, scanner, Partner, or migration semantics contrary to the accepted evidence.
- A required local or GitHub gate fails for the final SHA.
- Production health, exact SHA verification, or safe route smoke checks fail after deployment.

## Rollback steps

### Before push
- Stop with the isolated worktree intact. Inspect `git status` and use a targeted revert of only the merge resolution if necessary; do not touch the shared root or the reviewed candidate branch.

### After push / PR, before merge
- Close the PR or add a normal follow-up commit. Never force-push or rewrite shared history.

### After main merge or deployment
- Revert the exact merge commit on `main`, then use `scripts/safe-deploy.sh prod` only with the reverted, verified main SHA and the same natural-ancestry guard. Verify both machines, `/health`, `/ready`, `/api/version`, and safe unauthenticated route gates.

## What rollback does NOT undo
- No migration or production data change is planned. This release must not issue certificates, approve/reject customer records, send mail, or alter payments during verification.

## Verification after rollback
- `git merge-base --is-ancestor <prior-live-sha> origin/main`.
- Fly machines healthy; `/api/version` reports the intended rollback SHA; protected endpoints remain non-404 safe refusals.
