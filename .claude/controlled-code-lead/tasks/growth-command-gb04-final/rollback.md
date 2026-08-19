# Rollback — GB-04 final production Growth Command

## Trigger conditions
- Growth API returns an unexpected 5xx, exposes PII, or reports incorrect paid totals.
- Super Admin RBAC boundary fails.
- The deployed artifact does not match the approved SHA.

## Rollback

- Before commit: inspect exact files and reverse only task-owned changes.
- After deploy: revert the GB-04 application commit and deploy the preceding Fly artifact through `scripts/safe-deploy.sh`; never rewrite history.
- `0099` is additive only. Do not drop the table/indexes in production as part of an application rollback; restored application code simply ignores them.

## What rollback does not undo

It does not reverse Stripe-confirmed submission payment facts or lead-status audit records already written. Those remain durable and correct.

## Verification

Check `/api/version`, both Fly machines, the journal, `/health`, `/submit`, `/partners`, and unauthorised Growth API denial.
