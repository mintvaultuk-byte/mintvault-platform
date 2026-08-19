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
- Baseline: exact `origin/main` `facfd36f4ec8f164d017aba7a4386bab04a4aa6d`
- Runtime candidate: `c2d18aea` (control `333fbfd9`, implementation `079d5336`, hostile closure `c2d18aea`)
- Release candidate: final branch HEAD after the documentation-only evidence closeout
- Pushed: no
- Remote CI: no branch run exists because the workflows trigger on pull request or `main`
- Migration applied: no; `0101_growth_reviews_and_conversion.sql` is authored only
- Configuration/secrets changed: no
- Deployed: no

## Known divergence/concurrency

- Dirty launch and `main` worktrees contain unrelated Scanner/Partner work; this candidate remains isolated.
- Engineering OS is enrolled on the canonical baseline. The graph was rebuilt and checked against the runtime candidate.
- Production had multiple same-day Fly releases while the served SHA remained `facfd36f`; reconcile SHA, Fly release and migration journal again immediately before any protected release action.
