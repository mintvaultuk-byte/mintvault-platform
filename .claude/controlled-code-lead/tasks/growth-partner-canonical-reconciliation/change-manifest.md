# Change manifest — Growth / Partner canonical reconciliation

## Approved purpose

Create one candidate from canonical `718f60e7` and live `337776e6` using a normal merge commit. The candidate must retain the approved Growth visual release and the live Partner public-presence release, including original migrations `0102` and `0103`.

## Expected paths

| Path group | Intended change | Classification |
| --- | --- | --- |
| Live-only Partner public-presence source, routes, public pages, tests and docs | Preserve exact live lineage through the merge; alter only a proven conflict resolution. | Protected / semantic merge |
| `migrations/0102_*`, `migrations/0103_*`, their rollback material and migration tests | Preserve existing bytes and identity; do not create, apply, renumber or edit a migration. | Protected / immutable lineage |
| Growth visual source and F3 test/docs from `718f60e7` | Preserve exact approved behavior and visual composition. | Protected visual contract |
| `server/partner/routes.ts`, `server/static.ts`, and their narrow regressions | Repair two confirmed CodeQL high findings without altering Partner authority, public data policy, or visual composition. | A / security repair |
| This task directory and controlled-code-lead index | Record decisions, proof and boundaries. | Governance only |

## Explicitly prohibited

- No deployment, staging rollout, migration application, database mutation, secret/configuration change, provider connection, infrastructure scaling/spend, or Fly/Neon mutation.
- No Partner, Scanner, payment, grading, or auth-authority redesign.
- No history rewrite, force push, blind `ours`/`theirs` resolution, test deletion, skipped checks, or allowed failures.

## Order and gates

1. Inspect both lineages and migration identities; start from clean canonical main.
2. Use `git merge --no-ff --no-commit 337776e6`; resolve only verified semantic conflicts.
3. Establish that both required commits are ancestors, migrations are intact, and no unapproved runtime surface was dropped.
4. Run focused Growth, Partner/public, portal/application/management/SEO/discovery/maps, Scanner, payment and migration proof; then typecheck, lint, production build, Graphify, governance and independent hostile review.
5. Commit, re-fetch canonical main, push and open a PR only if the base is still reconcilable. Run exact-SHA CI/security checks. No merge or deploy.
