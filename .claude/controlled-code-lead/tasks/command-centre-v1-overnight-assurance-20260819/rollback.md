# Rollback control — staging only

Immediate containment: set the persisted Super Admin Command Centre Pilot Flag OFF and verify navigation hidden plus API/direct routes fail closed.

Pre-v533 staging recovery target captured before this task changes staging:

- image: `registry.fly.io/mintvault-v2:deployment-01M0DTK3VQNA3FESW58R851JGT`
- digest: `sha256:e2524959029d7ceac1cc96c2f104b6bdd001383f5fc8a8f2c50898be2254ed0d`
- embedded source: `60b9e2683c6866a385496d14de1a780615858468`
- Fly release: v532

Executable staging image rollback (never production):

```sh
fly deploy --image registry.fly.io/mintvault-v2:deployment-01M0DTK3VQNA3FESW58R851JGT -c fly.v2.toml --app mintvault-v2
```

Then require both machines healthy, `/health` 200 and `/api/version` exactly `60b9e2683c6866a385496d14de1a780615858468`; keep Command Centre OFF; verify Partner Management. Restore the intended candidate with `scripts/safe-deploy.sh staging --yes --partner-network-consolidation true` and rerun acceptance. No migration/data rollback is required because V1 is read-only and this pass adds none.

## Executed proof — 2026-08-20

The exact image rollback command above was executed against staging. Both LHR machines reached started state with 1/1 checks and `/api/version` returned `60b9e268`. The repaired image `registry.fly.io/mintvault-v2:deployment-01M0E2K5QPTYAYN0N8GJGAJQSX` was then restored by exact image; both machines again passed and `/api/version` returned `3d65b960`. Production was untouched.
