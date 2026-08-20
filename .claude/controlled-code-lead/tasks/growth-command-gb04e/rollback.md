# GB-04E rollback

- Code rollback baseline: SHA `da9c4406e4249c35dcb54fd3f3f3171d1f7e9a9d`.
- Fly rollback baseline: v1113 image `registry.fly.io/mintvault:deployment-01M0FVMKY1KSZMWDN6WHDD3185`.
- Provider configuration rollback must be provider-scoped and frozen before activation; do not remove unrelated secrets/configuration.
- Fly activation rollback: revoke the dedicated GB-04E read-only token, unset only `FLY_TELEMETRY_TOKEN`, and roll back to v1113 only if the candidate code itself is unhealthy. Missing token safely returns telemetry to `NOT_CONNECTED`.
- No database or infrastructure rollback is expected because migrations/scaling are prohibited.
