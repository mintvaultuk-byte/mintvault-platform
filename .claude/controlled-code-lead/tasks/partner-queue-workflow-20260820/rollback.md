# Rollback — Partner queue evidence and shop-floor workflow

## Trigger conditions

- A queue row reports a side as admitted but the same side is unavailable in the workstation.
- A thumbnail binds to another certificate or the opposite side.
- Any Partner route/CTA becomes inaccessible for an authorised role.
- Any protected MVGS, payment, auth, scanner or evidence-storage behaviour changes outside the manifest.

## Rollback steps

### Local candidate

- Inspect `git status` and revert only this task's commit(s); never reset or clean the shared checkout.

### If later deployed to staging

- Revert the specific candidate commit from the then-current canonical branch and use `scripts/safe-deploy.sh staging`; never force deploy or roll back unrelated work.

## What rollback does not undo

- No records, evidence objects, credits, reservations, payments or customer data are changed by this task.

## Verification after rollback

- Confirm the staging `/api/version` commit and open the Partner grading queue in an authenticated staging browser session.
