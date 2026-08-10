# Deployment state — mintvault-final-integration-local-proofs

## Production and staging

- Not queried, contacted, or mutated. They are explicitly outside this task.
- No production or staging commit, release, database host, bucket, provider account, or migration state is asserted by this ledger.

## This task's branch

- Branch: `codex/mintvault-final-product-integration`
- Baseline: `cb70672181909bf90a3ceece3d329a9191727bd1`
- Pushed: no
- Deployed anywhere: no

## Local proof environment

- Target: new Docker PostgreSQL and MinIO containers bound only to `127.0.0.1` on unique unused ports.
- Credentials: generated synthetic values passed to child processes only; never written to an environment file or committed.
- Cleanup: remove only containers labeled `mintvault.local-proof=mintvault-final-integration` and their anonymous data volumes after the proof.
