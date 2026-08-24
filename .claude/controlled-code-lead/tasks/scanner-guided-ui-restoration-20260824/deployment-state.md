# Deployment state — Scanner guided UI restoration (2026-08-24)

## Production

- Live commit: `01d5e4da` (preceding read-only acceptance audit)
- Live Fly release: `1123`
- Mutation authorised in this task: no

## Staging

- Live commit: `8b117946` (release `589`, preceding read-only acceptance audit)
- Database/station mutation authorised in this task: no

## This task's branch

- Branch: `codex/partner-scanner-onboarding-20260824`
- Baseline: `8b117946c411a544f38cf551a091bfb949cb8f43`
- Pushed: `f7d281b73084b21e641b22d76dc4b209b9f20cc1` is published to `origin/codex/partner-scanner-onboarding-20260824`; this evidence follow-up is pending publication.
- Deployed to Fly: no
- Local packaged Scanner: 1.5.4 arm64 package built, verified and foreground-observed; its isolated runtime manifest declared the exact executable, profile/scans dir and STAGING API, then the package and helpers exited cleanly.

## Known divergence between environments

- This repair changes only the packaged local Scanner presentation. The staging API remains `8b117946` / release `589`; no Fly deploy, staging database mutation or station action was performed or is required for this release.

## Other in-flight sessions

- Root worktree `fix/claim-ownership-collection-boundary` is dirty and unrelated. It is excluded from this task.
