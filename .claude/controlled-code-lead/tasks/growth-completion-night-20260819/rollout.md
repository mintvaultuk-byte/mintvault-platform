# Rollout — Growth Completion Night

## Completed production rollout

1. Re-fetched canonical `origin/main`, production `/api/version`, Fly machines/image and the production migration journal. Main had not moved beyond the candidate baseline; no migration `0101` collision existed.
2. Published exact candidate `d7dddadd504eddd6a976bc5c29a0949cbc5220f5` without force or rewrite and opened PR #320.
3. Waited for terminal pull-request checks. Lint/type/test/build, PostgreSQL/migration coverage, dependency review, gitleaks, CodeQL, Engineering OS/governance and amd64 image boot passed.
4. Merged normally to canonical `main` at `f4285b71a5fd0cad578e845d9aaed43768309541`; terminal `main` CI and Engineering OS passed on that exact authority.
5. Revalidated production-shaped migration lineage (4/4), applied `0101_growth_reviews_and_conversion.sql` once through `scripts/db/migrate.ts --apply`, and verified 64 applied / 0 pending / 0 inconsistent / 0 checksum mismatch plus expected schema objects and zero seeded rows.
6. Deployed only through `scripts/safe-deploy.sh prod --yes`. The guarded path verified live ancestry, moving-target safety, rollback image and the exact served SHA.
7. Verified Fly v1111, two passing LHR machines, public/core routes, protected Partner/Scanner boundaries, authenticated Growth Command, 1440×900 and 390×844 layouts, optional absent-safe interfaces and bounded post-release logs.

## Current operating state

- Application: `f4285b71` live.
- Commercial targets: none seeded; owner entry only through `/admin/growth`.
- Review engine: live and neutral; destination/sender not configured.
- Growth MCP: production interface ready; external auth/client not connected.
- Search Console and Fly/Neon/billing reads: not connected and truthfully unknown.
- Infrastructure: `MANUAL` monitor/detect/recommend only; no provider mutation, autoscaling or spend path.
- Outreach: no message sent by engineering; Medway/Cataclysm remains an owner commercial action.

GB-07, GB-08 and Market Intelligence are outside this rollout and were not started.
