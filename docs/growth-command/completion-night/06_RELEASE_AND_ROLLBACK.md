# Release and Rollback

## Current release state

No Growth Completion Night code, migration, push or deployment has occurred. Production remains `facfd36f`, Fly v1109.

## Intended release order

1. Clean local candidate from canonical main; no protected-system edit.
2. Focused behavioural proof per package.
3. Integrated full gates, Graphify and rendered desktop/mobile acceptance.
4. Independent hostile review; repair only reproduced BLOCKER/HIGH; targeted re-review changed surfaces.
5. Freeze exact SHA and obtain terminal remote CI proof.
6. If a migration is required: separately authorized staging rehearsal, journal/schema verification and rollback/containment proof.
7. Serialized safe-deploy path only after approval record validation.
8. Verify `/api/version`, served bundle marker, real API contracts and public routes.

## Migration gates

- Highest production identity is `0100`; next free is `0101` until allocated here and in `01_CURRENT_CANONICAL_STATE.md`.
- Prefer additive, resume-safe SQL. Never infer schema from fixtures.
- Inventory target DB columns before authoring and after applying.
- No production or staging migration is authorized by creation of a SQL file.

## Rollback principles

- Application: revert the exact Growth commits and deploy the last known-good SHA through `scripts/safe-deploy.sh`.
- Database: retain harmless additive structures when old code ignores them; never delete review/customer records as an application rollback.
- Providers: fail closed to `NOT CONNECTED`/`UNKNOWN`; disable adapter via existing safe configuration only after authorization.
- Email/reviews: suppress future scheduling before rollback; sent email cannot be recalled.
- Public authority pages: remove routes/sitemap entries together; cached third-party search copies may persist.
- MCP: revoke dedicated credential/identity; no database credential is shared with the connection.

## Release vetoes

Security/privacy, payment integrity, protected grading, migration proof, rollback/containment, exact-SHA CI, dead UI, fake data and owner approval can veto release. Unproven speculation and unrelated MEDIUM/LOW findings cannot.

