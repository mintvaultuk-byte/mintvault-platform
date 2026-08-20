# Deployment State — Growth Completion Night

## Production

- Live commit: `facfd36f` via `https://mintvault.fly.dev/api/version`
- Fly release at baseline: v1109, complete
- Fly release at final reconciliation: v1110, complete, created 2026-08-19T21:27:48Z by a concurrent actor
- Final image: `deployment-01M0DYQHT8R6V6QV265H918CED`
- Machines: two started version-1110 LHR machines, health passing
- Database: production identity confirmed indirectly through the running app; 63 applied migrations, highest `0100`
- Growth tables: `partner_applications`, `submission_acquisition` present
- Provider workspace/account values: not inspected; secret values will not be read

## Program branch

- Branch: `codex/growth-completion-night-20260819`
- Baseline: exact `origin/main` `facfd36f4ec8f164d017aba7a4386bab04a4aa6d`
- Runtime candidate: `c2d18aea` (control `333fbfd9`, implementation `079d5336`, hostile closure `c2d18aea`)
- Release candidate before addendum: evidence and CI-environment test-isolation closeout (`e877032b`)
- Infrastructure addendum implementation: `fe0588da5b92131998d88b79779e8a9b6b468e96`
- Exact local candidate: final clean branch HEAD after this evidence-only closeout; not published
- Pushed: no
- Remote CI: no branch run exists because the workflows trigger on pull request or `main`
- Migration applied: no; `0101_growth_reviews_and_conversion.sql` is authored only
- Configuration/secrets changed: no
- Deployed: no
- Fly/Neon/billing configuration changed: no
- Infrastructure mutation or spend action: no; runtime is `MANUAL` monitor/detect/recommend only

## Known divergence/concurrency

- Dirty launch and `main` worktrees contain unrelated Scanner/Partner work; this candidate remains isolated.
- Engineering OS is enrolled on the canonical baseline. The graph was rebuilt and checked against the runtime candidate.
- Production advanced from Fly v1109 to v1110 during this task while the served SHA remained `facfd36f`; this branch did not cause that release. Reconcile SHA, Fly release and migration journal again immediately before any protected release action.
