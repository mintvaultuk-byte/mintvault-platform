# Deployment state — GB-04D Growth Command — 2026-08-20

## Production

- Live commit: `ee7fbe43` confirmed by `/api/version`.
- Live Fly release: `v1112`, app `mintvault`.
- Live image: `mintvault:deployment-01M0EW6KY7JGV6M851K600EY37`.
- Fleet: two LHR machines (`683720eb5127d8`, `83d479c745d0d8`), version 1112, started, 1/1 checks passing.
- Database host identity observed from authenticated production operational logs: `ep-wispy-morning-ab6f4o08` production pooler. No connection string or credential was read.
- Prior Growth migration state: 64 applied through canonical `0101`, zero pending/inconsistent/checksum mismatch as recorded by the released Growth handover; fresh read-only journal proof is pending.
- Provider secret names present in Fly: Stripe, Resend, R2, production database and Scanner authority. No Fly API token, Neon API token, Google Search Console credential, Growth MCP bearer, review destination/secret, or billing credential name is presently listed.
- Configuration/secrets changed by this task: no.

## Canonical source

- `origin/main`: `e057a67d`.
- Production SHA `ee7fbe43` descends from `origin/main` and includes 19 additional Command Centre/security/grading reconciliation commits.
- This task is based on production rather than main so a later deployment cannot silently roll back live lineage.

## Staging

- Not yet reconciled for this task.

## This task's branch

- Branch: `codex/growth-command-gb04d`.
- Baseline: `ee7fbe43`.
- Local implementation: complete in the committed branch tip; exact SHA is reported from Git after each amend.
- Local verification: focused 60/60; no-env broad regression 334 files passed / 54 skipped / 6 failed files, with database-environment suites requiring local disposable URLs and one unchanged baseline canonical-density assertion; check/lint/build/graph/diff/changed-file formatting passed.
- Pushed: no.
- Deployed anywhere: no.

## Known divergence and in-flight sessions

- The launch workspace is dirty with unrelated Partner/Scanner work and remains untouched.
- Multiple active worktrees exist; this branch has a dedicated coordination lock.
- Production contains current main plus additional unmerged Command Centre lineage. Any future publication/release must preserve that ancestry and reconcile main immediately before push/deploy.
