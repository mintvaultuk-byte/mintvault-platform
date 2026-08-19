# Rollback — canonical lineage final freeze

## Trigger conditions

- Candidate fails a release gate or final reference movement check.
- Production migration preflight cannot prove the actual migration identity’s required privileges.
- A configured Stripe Price does not have the locked amount, GBP currency, live/test mode, or
  explicit VAT-inclusive behavior.
- Post-release smoke finds Partner checkout, Scanner credit view, or location management regression.

## Rollback steps

### Before an owner-authorised release

- Do not deploy. Keep `12c9a641` and the final freeze record as local commits; the candidate can
  be abandoned or a later safe, reviewed commit can revert the contained logical repair.

### After an owner-authorised release

- Use `git revert <affected-final-candidate-commit>`; never rewrite shared history.
- Redeploy the captured prior Fly image only through the approved `scripts/safe-deploy.sh` path,
  with owner approval. Do not use a raw deploy.
- The `0098` role-grant migration is additive. Revoking the added permission is possible only with
  a separately approved forward migration; do not attempt journal rewriting or destructive rollback
  during incident response.

## What rollback does NOT undo

- Completed Stripe Checkout payments, ledger credits, refund/dispute audit records, and existing
  production schema/journal entries are durable operational facts. Reverting code does not erase
  them and must never silently debit a Partner wallet.

## Verification after rollback

- Confirm `/api/version` is the expected SHA, read-only migration journal matches the owner-approved
  plan, and protected Partner checkout/credit-view/location smoke paths behave as the prior release.
