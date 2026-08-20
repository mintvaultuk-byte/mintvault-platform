# Release and Rollback

## Current release state

Growth Completion Night is implemented locally through runtime candidate `c2d18aea`; evidence and CI-environment test-isolation closeout follow it through `e877032b`. No migration, push, pull request, configuration write or deployment has occurred. Production still serves `facfd36f`; a concurrent actor advanced Fly from v1109 to v1110 during this task.

## Intended release order

1. Completed: clean local candidate from canonical main with no protected-system write.
2. Completed in Growth scope: focused and split-full executable proof, Engineering OS graph, rendered desktop/mobile acceptance and independent hostile review/repair. Local monolithic postflight still reports excluded Partner/Scanner suite failures and is not represented as green.
3. Owner authorizes push/PR of the exact clean branch; freeze the resulting SHA and obtain terminal remote CI proof.
4. Reconcile production SHA/release/machines and migration identity immediately before release.
5. Separately authorize and apply additive migration `0101`, then verify journal and schema.
6. Separately authorize any review/MCP/provider configuration writes; unavailable connections remain safely disabled.
7. Use the serialized safe-deploy path only after prerequisite gates and approval records validate.
8. Verify `/api/version`, served bundle marker, real API contracts, scheduler state, public routes, Fly machines and database identity.

## Migration gates

- Highest verified production identity is `0100`; candidate `0101_growth_reviews_and_conversion.sql` is allocated but not applied.
- Prefer additive, resume-safe SQL. Never infer schema from fixtures.
- Inventory target DB columns before authoring and after applying.
- No production or staging migration is authorized by creation of a SQL file.

## Rollback principles

- Application: disable review scheduling, revert runtime commits `c2d18aea` and `079d5336`, and deploy the last known-good SHA through `scripts/safe-deploy.sh` after approval validation.
- Database: retain harmless additive structures when old code ignores them; never delete review/customer records as an application rollback.
- Providers: fail closed to `NOT CONNECTED`/`UNKNOWN`; disable adapter via existing safe configuration only after authorization.
- Email/reviews: remove/disable approved destination verification before rollback; sent email cannot be recalled and suppression/audit records remain.
- Public authority pages: remove routes/sitemap entries together; cached third-party search copies may persist.
- MCP: revoke dedicated credential/identity; no database credential is shared with the connection.

## Release vetoes

Security/privacy, payment integrity, protected grading, migration proof, rollback/containment, exact-SHA CI, dead UI, fake data and owner approval can veto release. Unproven speculation and unrelated MEDIUM/LOW findings cannot.
