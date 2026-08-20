# Deployment State — Growth Completion Night

## Production

- Live commit: `f4285b71` via `https://mintvaultuk.com/api/version`
- Fly release: v1111, complete
- Live image: `deployment-01M0ES4KPD6QC64WSVP2SXMR28`
- Machines: `683720eb5127d8` and `83d479c745d0d8`, both started version 1111 in LHR with 1/1 checks passing
- Rollback image: `registry.fly.io/mintvault:deployment-01M0DYQHT8R6V6QV265H918CED` (v1110)
- Database: production Neon host identity confirmed; 64 applied migrations through `0101`, zero pending/inconsistent/checksum mismatch
- Growth schema: commercial target, conversion, review request/attempt/suppression relations and required indexes/constraints present
- Provider workspace/account values: not inspected; no secret value read or committed

## Program branch and release authority

- Branch: `codex/growth-completion-night-20260819`
- Baseline: exact `origin/main` `facfd36f4ec8f164d017aba7a4386bab04a4aa6d`
- Exact published candidate: `d7dddadd504eddd6a976bc5c29a0949cbc5220f5`
- Pull request: #320, normally merged with no force push or history rewrite
- Canonical/deployed application SHA: `f4285b71a5fd0cad578e845d9aaed43768309541`
- Remote CI: terminal pull-request checks plus terminal `main` CI and Engineering OS green on the release authority
- Migration applied: yes, once through `scripts/db/migrate.ts --apply`; checksum `e91a62b6352c69945a9824a41a07a0c78e36d4914509464a88290e3737ecbe9a`
- Configuration/secrets changed: no
- Deployed: yes, only through `scripts/safe-deploy.sh prod --yes`
- Fly/Neon/billing configuration changed: no
- Infrastructure mutation or spend action: no; runtime remains `MANUAL` monitor/detect/recommend only

## Reconciliation and observation

- Dirty launch and local `main` worktrees containing unrelated Scanner/Partner work were preserved and never used for release.
- Fetched canonical `origin/main` had not advanced beyond the candidate baseline and no migration-number collision existed.
- Graphify was CURRENT and the hostile release bar had zero actionable in-scope BLOCKER/HIGH before publication.
- Bounded post-release logs showed authenticated Growth intelligence/leads/reviews/link-options responses at 200 and no post-startup Growth, Partner, Scanner, payment, review or migration regression.
