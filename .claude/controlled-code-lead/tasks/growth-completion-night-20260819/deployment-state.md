# Deployment State — Growth Completion Night

## Production

- Live commit: `facfd36f` via `https://mintvault.fly.dev/api/version`
- Fly release: v1109, complete
- Image: `deployment-01M0DSJ9GTNRS0MJ5KAN0NH2JR`
- Machines: two started version-1109 LHR machines, health passing
- Database: production identity confirmed indirectly through the running app; 63 applied migrations, highest `0100`
- Growth tables: `partner_applications`, `submission_acquisition` present
- Provider workspace/account values: not inspected; secret values will not be read

## Program branch

- Branch: `codex/growth-completion-night-20260819`
- Baseline/ahead of main: exact `origin/main`, zero commits at bootstrap
- Pushed: no
- Deployed: no

## Known divergence/concurrency

- Dirty launch and `main` worktrees contain unrelated Scanner/Partner work.
- Local Command Centre reconciliation is three commits ahead of main and overlaps Super Admin shell.
- Engineering OS enrollment is unmerged on older lineage.
- Production had multiple same-day releases; reconcile again before remote/release activity.

