# Rollout — canonical lineage final freeze

**Classification:** C / E / F / G

## Pre-rollout checklist

- [x] Local and production-shaped regression evidence recorded.
- [ ] Owner authorises the exact production migration/release window.
- [ ] Final `origin/main`, active Partner/Scanner and production version checks remain unchanged.
- [ ] Actual production migration identity proves the `REFERENCES` capability required by `0080`.
- [ ] Stripe mode and all five Pack Price IDs/currency/amounts/tax behaviors match the locked map.
- [ ] A rollback Fly image/SHA is captured by the safe deployment path.

## Steps after separate owner approval

1. Re-fetch refs and production `/api/version`; abort if any reconciled source moved.
2. Run the approved production migration preflight/rehearsal and apply the canonical ordered pending
   set only through the approved runner and destructive guard.
3. Merge/push only the frozen SHA through the owner-approved flow.
4. Use `scripts/safe-deploy.sh` with the required reconciliation acknowledgement for live
   `158dbf53768187bb4176f3de0e9c23a26cff11fd`; never raw `fly deploy`.
5. Confirm exact deployed `/api/version`, migrations, Super Admin Partner controls, Scanner
   zero-credit view, and one human-approved Stripe TEST/live checkout appropriate to the environment.

## Who/what is affected

- Partner Super Admins, Scanner operators, Partner credit purchasers, and the release/migration
  operator. No public consumer or grading-rule change is intended.

## Timing constraints

- Do not run during active Partner checkout, Stripe webhook incident, or unannounced active-line
  development. This candidate is a freeze, not permission to release it.
