# Rollback — Partner Pilot Pass 2

> ## 🚨 CORRECTED 2026-08-14 by task `partner-final-rc-reconciliation` — DO NOT follow the `b0de0880` target below
>
> This document names `b0de0880` as the known-good lineage and says to "deploy the exact previous
> verified release". **`b0de0880` is now 22 commits behind live production.** Deploying it would
> REMOVE from production:
>
> - `77b075a5` — server-authoritative grading results
> - `bffed7a2` — high-severity rate-limit hardening
> - `9cd9804d` — the production migration 0074 reconciliation
> - `662d9511` — the canonical-grading absorb of v1078
>
> **The correct rollback target is now `067ed0c6` / v1083** — or, more safely, whatever
> `/api/version` reports at the moment you begin, captured verbatim into this file first.
>
> `scripts/safe-deploy.sh` GUARD 1L will correctly BLOCK a deploy that does not contain what is
> live. **If that guard fires during a rollback, it is right and you are wrong — do not reach for
> `--allow-behind` to force it through.** That flag is how a good guard becomes a clobber.
>
> **Schema is NOT reverted by a code rollback.** Migrations 0079–0090 are additive and six of them
> (0080–0083, 0088, 0089) have no rollback script; 0090 is deliberately forward-only. So any code
> rollback lands an OLDER release against a NEWER schema, and that tolerance is the thing that
> actually needs proving before you rely on this plan.

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
