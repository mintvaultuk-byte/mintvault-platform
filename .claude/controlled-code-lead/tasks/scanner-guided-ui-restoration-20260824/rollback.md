# Rollback — Scanner guided UI restoration (2026-08-24)

## Trigger conditions

- The packaged Scanner fails to show the station sign-in/pending/calibration state.
- An ACTIVE station loses its normal capture workflow.
- The package verifier or focused Scanner regression tests fail.

## Rollback steps

### If not yet committed

- Inspect the isolated worktree diff and revert only the listed Scanner files with a targeted patch; never touch the unrelated root worktree.

### If committed but not released

- Revert the single Scanner UI commit in this isolated branch after confirming no later Scanner commit depends on it.

### If the local packaged app is launched

- Quit only the corrected foreground Scanner via its own app control, preserve its runtime manifest/logs, and relaunch the previous verified 1.5.1 package from its recorded isolated path if an owner chooses to roll back.

## What rollback does NOT undo

- No stations, approvals, cards, captures, credits, wallets, database rows, staging services, or production systems are changed by this repair.

## Verification after rollback

- Check the exact executable/version and runtime manifest; verify the existing staging station remains PENDING with no approval event or balance movement.
