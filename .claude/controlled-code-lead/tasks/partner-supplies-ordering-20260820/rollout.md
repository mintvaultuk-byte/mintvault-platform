# Rollout — Partner supplies ordering

1. Complete local real-Postgres and source/UI gates; inspect changed files and hostile re-review.
2. Commit the exact candidate and verify it descends from current `origin/main` after a fresh fetch/rebase if necessary.
3. Create a local, time-bounded staging approval record for the exact SHA. The owner has authorised staging only; production is excluded.
4. Run the numbered migration runner in dry-run mode against staging; do not use `db:push`.
5. Reconfirm the guarded deploy can resolve staging `/api/version`, then use only `scripts/safe-deploy.sh staging --yes`. No bypass flags.
6. Apply only the additive staging migration with the guarded migration runner if preflight is clean.
7. Carry out exactly one clearly marked staging test order containing all three products, inspect one order/outbox/provider result, then use Super Admin to transition Processing and Dispatched. Do not dispatch stock or create any payment.
8. Perform real-browser Partner/Admin acceptance. If browser authentication is required, stop and request one owner action only; do not guess credentials.

## Go/no-go gates

- `git diff --check`, changed-file lint, TypeScript check, production build, migration SQL lint and migration-scope contract are clean.
- Dedicated supplies real-Postgres tests prove tenant isolation, idempotency, immutable snapshots, transitions, notification failure/retry and no duplicate order.
- No unresolved BLOCKER/HIGH hostile-review finding.
- Staging live SHA and schema readiness prove the deployed artifact is the candidate.
