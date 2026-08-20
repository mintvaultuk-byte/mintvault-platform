# Deployment state — GB-04D Growth Command — 2026-08-20

## Production

- Live commit: `ee7fbe43` confirmed by `/api/version`.
- Live Fly release: `v1112`, app `mintvault`.
- Live image: `mintvault:deployment-01M0EW6KY7JGV6M851K600EY37`.
- Fleet: two LHR machines (`683720eb5127d8`, `83d479c745d0d8`), version 1112, started, 1/1 checks passing.
- Production pooler identity was observed from authenticated operational evidence. Its hostname, connection string and credentials are not recorded here.
- Fresh production-image dry-run: 64 applied through canonical `0101`, zero pending, zero inconsistent and zero checksum mismatch.
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
- Local implementation: committed. Initial implementation candidate `f64dcbf8f0bb1c62912d37479d0f4d7f0ba60a0e` received hostile review; that review's evidence-only corrections are applied in the following candidate. `git rev-parse HEAD` is the exact current authority.
- Local verification: focused 60/60; full disposable matrix exited red with 6,369 passed/2 skipped and one unchanged baseline-reproduced failure; check/lint/build/graph/diff/changed-file formatting passed. No green full-suite claim is made.
- Initial hostile result: zero product BLOCKER/HIGH; one release-evidence HIGH accepted and corrected; resulting-SHA re-review pending.
- Pushed: no.
- Deployed anywhere: no.

## Known divergence and in-flight sessions

- The launch workspace is dirty with unrelated Partner/Scanner work and remains untouched.
- Multiple active worktrees exist; this branch has a dedicated coordination lock.
- Production contains current main plus additional unmerged Command Centre lineage. Any future publication/release must preserve that ancestry and reconcile main immediately before push/deploy.
