# GB-04E rollout

1. Freeze and push the exact candidate; open a PR against the then-current canonical main.
2. Require terminal exact-SHA CI, governance, CodeQL, Gitleaks, dependency review and independent hostile review with zero actionable in-scope BLOCKER/HIGH.
3. Create one documented Fly organisation read-only token with the shortest practical expiry; configure only `FLY_TELEMETRY_TOKEN` on app `mintvault`.
4. Deploy only the verified candidate through `scripts/safe-deploy.sh`; do not change machine count/shape/region, CPU, RAM, autoscaling or spend.
5. Prove `/api/version`, two healthy LHR machines, authenticated Growth UI/API values, deterministic capacity/readiness, no secret exposure and no dead control.
6. If provider telemetry fails, revoke/unset only the dedicated token. If runtime health fails, execute the frozen v1113 code rollback.

Status: candidate freeze pending. Provider activation/deployment has not started.
