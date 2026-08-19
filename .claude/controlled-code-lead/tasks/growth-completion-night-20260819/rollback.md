# Rollback — Growth Completion Night

## Before activation

The branch is isolated and production remains `facfd36f`. If the candidate is rejected before activation, do not apply `0101`, do not create configuration/secrets, and do not deploy. Preserve the branch and evidence; no production rollback is necessary.

## Application

After an authorized release, contain new review scheduling by removing/disabling its approved configuration, then non-destructively revert runtime commits `c2d18aea` and `079d5336` on a clean release branch. Deploy the last known-good application SHA through the repository safe-deploy path only after approval validation. Never reset or clean the dirty launch/main worktrees.

## Database

Migration `0101_growth_reviews_and_conversion.sql` is additive. On application rollback, retain its tables, indexes and data so the old application ignores them. Never drop review, suppression, delivery-attempt or conversion-event data as an emergency rollback. Verify the journal and schema inventory after containment; any later removal requires a separately reviewed forward migration.

## Email and reviews

Remove/disable `REVIEW_DESTINATION_URL`, its hostname allowlist or `RESEND_DOMAIN_VERIFIED` through the authorized configuration path so the scheduler returns `NOT_CONFIGURED`. Revoke/rotate `REVIEW_TOKEN_SECRET` only with awareness that outstanding preference/click links will stop resolving. Already delivered email cannot be recalled; suppressions and attempts remain auditable.

## MCP and providers

Remove or rotate `GROWTH_MCP_TOKEN_SHA256` to fail the endpoint closed. Disconnect any custom app at the client/workspace side. No database credential is shared with MCP. Optional provider adapters remain `NOT CONNECTED`; if later configured, revoke their dedicated credentials separately.

The Infrastructure/GBP addendum creates no provider configuration, mutation authority, autoscaling action or spend. Before activation, rejection needs no provider rollback. After an authorized application release, revert only the addendum application commit to restore the previous Growth UI/contracts; no Fly/Neon/billing side effect exists to undo.

## Public authority and cache

Reverting the application removes the new population presentation and initial-HTML structured data. In-process public cache entries expire within 60 seconds; downstream search-engine caches may persist and must not be represented as immediately recallable.
