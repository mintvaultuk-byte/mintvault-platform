# GB-04E deployment state

- Baseline production SHA: `da9c4406e4249c35dcb54fd3f3f3171d1f7e9a9d`.
- Baseline Fly release: v1113.
- Baseline image: `registry.fly.io/mintvault:deployment-01M0FVMKY1KSZMWDN6WHDD3185`.
- Baseline machines: `683720eb5127d8`, `83d479c745d0d8`; both LHR/started/healthy.
- Candidate: implementation complete; exact SHA pending commit freeze.
- Production configuration changes: none in GB-04E yet.
- Deployment: not started; no token has been created or configured.
- Rollback authority: baseline image/release retained; exact post-change rollback will be frozen before any activation.
