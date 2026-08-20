# Rollout — GB-04D Growth Command

**Classification:** C / D / F (final classification pending verified design)

## Gate order

1. Reconcile current `origin/main`, production SHA/release, active worktrees and migration journal again.
2. Complete local behavioral/mutation/full regression, graph update/check, secret scan and independent hostile review with zero open in-scope BLOCKER/HIGH.
3. Publish only after separate Git-push authority, then require terminal exact-SHA remote CI.
4. Deploy exact candidate to staging through the repository safe-deploy path; prove authenticated desktop/mobile UI, provider fallbacks, route latency and rollback.
5. Reconfirm the owner's recorded production-deploy grant is still applicable and no concurrent release has moved production.
6. Deploy the exact candidate to production through `scripts/safe-deploy.sh`; perform served-artifact, API, browser, multi-machine and bounded-log proof.

## Hard exclusions

- No migration, secret change, capacity mutation, provider spend or guarded-auto activation without a new owner gate.
- No raw provider control in the browser or MCP.
