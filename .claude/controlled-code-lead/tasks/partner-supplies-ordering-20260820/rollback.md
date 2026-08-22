# Rollback — Partner supplies ordering

## Application rollback

If Partner Supplies routes or UI fail after deployment, redeploy the immediately previous verified staging release only through `scripts/safe-deploy.sh staging --yes` after normal ancestry/live-SHA checks. Do not use a force or unknown-live bypass.

## Data rollback posture

The migration is additive and supply records are operational/audit evidence. Do **not** delete orders, snapshots, events or notification attempts to roll back an application release. The previous app ignores the new tables.

If a schema rollback is ever requested, it must be separately owner-approved, must refuse while supply rows exist, and must be executed only against staging through the numbered migration runner. Forward-fixing is preferred.

## Provider containment

Disable the supplies worker/tick or roll back the application while retaining outbox rows; do not recreate orders. Pending/failed notifications remain durable and may be retried only after the repair is verified.
