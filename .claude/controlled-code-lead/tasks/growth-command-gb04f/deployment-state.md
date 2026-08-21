# Deployment state — GB-04F baseline

## Production

- Live application version: `1e868cc7` from `/api/version` at 2026-08-20 19:48 UTC; it is the previously deployed GB-04E candidate whose tree is now canonical through merge `d67e3472ef43a5e1bc27e6bab778dc613f495f7e`.
- Fly: app `mintvault`, release v1114, image `registry.fly.io/mintvault:deployment-01M0G52W5NQV0XWV0ECK5BP8AN`.
- Fleet: `683720eb5127d8` and `83d479c745d0d8`; LHR, started, 1/1 health check passing.
- Production database: protected Neon authority; read-only health only in scope. No database mutation is authorised.

## This task's branch

- Branch: `codex/growth-command-gb04f` from canonical `d67e3472`.
- Pushed: no. Deployed: no.
- Planned deployment: only the exact verified candidate through `scripts/safe-deploy.sh`; no raw Fly deploy, scaling or provider configuration.

## GB-04F live diagnostic baseline

- At 2026-08-20 20:53 UTC, authenticated Growth showed machine `683720eb5127d8` p95 850ms / 1.2 rpm and `83d479c745d0d8` p95 10,000ms / 2 rpm. Both were healthy; max CPU 0.514%, max RAM 17.642%, observed 5xx 0%, database pool 4/8 active with 0 waiters, and database readiness 4ms.
- This is provider maximum-per-machine p95 with a sparse five-minute sample. It has no route, request-sample or dependency attribution. GB-04F records the limitation rather than calling it a capacity condition.
- Separate Fly app `mintvault-v2` exists with two healthy LHR machines at a different commit. It is outside this repository's production `fly.toml`, unmodified and not attributed to the canonical `mintvault` app.

## Known concurrency

- The original `/Users/cornelius/mintvault-platform` worktree is dirty on a separate branch and is not touched.
- Multiple unrelated worktrees exist. GB-04F owns only the isolated path and lock above.
