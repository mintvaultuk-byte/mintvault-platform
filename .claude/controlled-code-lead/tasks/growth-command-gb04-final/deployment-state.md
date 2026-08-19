# Deployment state — GB-04 final production Growth Command

## Production
- Live commit: `cf891246` confirmed by `/api/version` during the canonical release.
- Live Fly release: v1107 on `mintvault`, two `lhr` machines healthy.
- DB host: `ep-wispy-morning-ab6f4o08` / production; the canonical journal has 62 entries through `0098`.
- Neon PITR: owner-confirmed, production history window six hours.
- Rollback artifact: Fly v1106 image `registry.fly.io/mintvault:deployment-01M0D2CNE9PYVZ825RSGDJDRE4`.

## This task branch
- Branch: `codex/growth-command-gb04-final` from exact `cf891246`.
- Pushed: no.
- Deployed: no.
- Intended migration: one additive canonical file, `0099_growth_commercial_attribution.sql`.
- Local production-shaped runner rehearsal: passed against the exact 62-entry canonical journal; `0099` was the sole pending migration and produced a 63-entry clean journal in the disposable rehearsal database.
- Current canonical snapshot: `origin/main` remains `cf891246890fd18bc8dfdca90e5bbf44001b5f5e` after final local verification.
- Release gates still outstanding: exact-SHA remote CI, production migration, deploy, and live Super Admin proof.

## Other in-flight work
- The preserved Partner/Scanner worktree is not the canonical release branch. Its unmerged changes are excluded from this task.
