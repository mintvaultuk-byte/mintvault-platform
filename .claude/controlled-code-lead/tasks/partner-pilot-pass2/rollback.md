# Rollback — Partner Pilot Pass 2

## Before a commit

Check this task worktree's `git status` and revert only named Pass 2 files if
needed. Never operate on the unrelated dirty root worktree.

## After a local commit

Use a reviewed `git revert <commit>` or create a new corrective commit; never
rewrite shared/pushed history. Keep `origin/main` and the live `b0de0880`
lineage available as known-good comparison points.

## If an owner-approved deployment later occurs

Revert the final integration commit, deploy the exact previous verified release
only through `scripts/safe-deploy.sh`, then re-check `/api/version`, `/health`,
Admin, Staff and Partner safe-refusal/health routes. The detailed rollout is
not authorised or written until the candidate, migration inventory and owner
approval are present.

## What rollback cannot undo

Issued certificate identities, accepted physical evidence, printed labels and
any credit/Stripe data mutation require their own audited remediation record.
