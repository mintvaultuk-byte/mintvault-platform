# Rollback control — staging only

Immediate containment: set the persisted Super Admin Command Centre Pilot Flag OFF and verify navigation hidden plus API/direct routes fail closed.

Immediate pre-two-gate staging recovery target:

- image: `registry.fly.io/mintvault-v2:deployment-01M0ERFXFDRYJ2EP44HWAKRHQ9`
- digest: `sha256:d018716271b2ccb1681d44bbdc41c0e99e44c233dfd2b76c6367591a194a9b03`
- embedded source: `a449169374bd5c38c33d9e92e10e3e8c3058f9df`
- Fly release: v543
- captured health: 2/2 LHR machines started, 1/1 checks passing

Executable immediate staging image rollback (never production):

```sh
fly deploy --image registry.fly.io/mintvault-v2:deployment-01M0ERFXFDRYJ2EP44HWAKRHQ9 -c fly.v2.toml --app mintvault-v2
```

Then require both machines healthy and `/api/version` exactly `a4491693`; keep Command Centre OFF; verify Partner Management. Restore the intended candidate with `scripts/safe-deploy.sh staging --yes --partner-network-consolidation true` and rerun acceptance. No migration/data rollback is required because the two-gate pass adds none.

## Earlier executed rollback proof

The pre-v533 staging recovery target remains recorded as executed evidence:

- image: `registry.fly.io/mintvault-v2:deployment-01M0DTK3VQNA3FESW58R851JGT`
- digest: `sha256:e2524959029d7ceac1cc96c2f104b6bdd001383f5fc8a8f2c50898be2254ed0d`
- embedded source: `60b9e2683c6866a385496d14de1a780615858468`
- Fly release: v532

Executable historical staging image rollback (never production):

```sh
fly deploy --image registry.fly.io/mintvault-v2:deployment-01M0DTK3VQNA3FESW58R851JGT -c fly.v2.toml --app mintvault-v2
```

The command was executed against staging; both machines returned healthy on `60b9e268`, and the repaired image was then restored and verified healthy. This proves the direct-image procedure rather than merely documenting it.

### Executed proof — 2026-08-20

The exact image rollback command above was executed against staging. Both LHR machines reached started state with 1/1 checks and `/api/version` returned `60b9e268`. The repaired image `registry.fly.io/mintvault-v2:deployment-01M0E2K5QPTYAYN0N8GJGAJQSX` was then restored by exact image; both machines again passed and `/api/version` returned `3d65b960`. Production was untouched.
