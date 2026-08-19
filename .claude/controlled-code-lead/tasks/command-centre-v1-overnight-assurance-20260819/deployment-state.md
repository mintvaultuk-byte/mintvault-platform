# Deployment state — Command Centre V1 overnight release assurance

## Production

- Prohibited. This pass will not query, inspect, deploy, configure, toggle or mutate production.

## Staging starting authority

- Prior reconciled evidence identifies app `mintvault-v2`, URL `https://mintvault-v2.fly.dev`, Fly version `532`, two healthy LHR machines and runtime artifact `60b9e2683c6866a385496d14de1a780615858468`.
- Fresh read-only staging identity/health/status inspection is pending in this pass.
- The persisted flag authority is `super_admin_command_centre_enabled`; prior state was ON after an ON → OFF → ON proof.
- This pass may repeat staging ON → OFF → ON and may safe-redeploy staging only if application code changes. It may not perform any business-data mutation.

## Candidate

- Evidence HEAD: `c485a7f839fd6614948740eca3972e3f8a081f68`
- Deployed source ancestor: `60b9e2683c6866a385496d14de1a780615858468`
- Candidate code is unchanged after the staged artifact; intervening commits are evidence/governance only.
- Pushed: no. Production: untouched and unqueried.
