# Rollback — Canonical grading left-rail refinement

## Trigger conditions

- The preview no longer acknowledges a required revision, Review becomes fail-open, or a role loses its shared rail.
- Browser proof shows a box/chrome remains, the card fails to gain height, or the viewport overflows.
- Final CI or production health/artifact verification fails.

## Rollback

- Before push: retain the isolated worktree and use a targeted patch reversal only after reviewing `git status`; never modify the dirty shared root.
- After push but before merge: close the PR or add a normal corrective commit; never force-push.
- After deployment: revert the exact PR merge commit, then deploy the reverted, verified main SHA with `scripts/safe-deploy.sh prod`.

## What rollback does not undo

No data, migration, certificate, scanner, payment or provider mutation is planned; rollback changes only the SPA artifact.

## Verification

`/health`, `/ready`, `/api/version` and both Fly machines must return to v1081 or the known-good revert SHA; the shared preview behaviour is covered by the unchanged revision suite.
