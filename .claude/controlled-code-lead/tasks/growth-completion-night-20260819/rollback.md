# Rollback — Growth Completion Night

## Recorded recovery authority

- Live application: `f4285b71`, Fly v1111, image `deployment-01M0ES4KPD6QC64WSVP2SXMR28`
- Last known-good rollback image: `registry.fly.io/mintvault:deployment-01M0DYQHT8R6V6QV265H918CED` (v1110, served `facfd36f`)
- Neon recovery/history window confirmed under established release governance: 6 hours at release time
- Production journal after release: 64 applied migrations through `0101`, zero pending/inconsistent/checksum mismatch

## Application containment

If a genuine regression is confirmed, deploy the recorded v1110 image through the repository safe-deploy path under release authority. Do not reset/rewrite canonical history or use the dirty launch/local-main worktrees. Verify served SHA, both machines, health and public/protected boundaries after containment.

## Database

Migration `0101_growth_reviews_and_conversion.sql` is additive. Retain its tables, indexes, constraints and journal row when rolling the application back; the older application ignores them. Never drop review, suppression, delivery-attempt, conversion-event or commercial-target revision data as an emergency action. Never edit the migration journal. Any later removal requires a separately reviewed forward migration.

The commercial target store is append-only metadata. An application rollback must retain every target/null-clear revision and audit row.

## Email and reviews

The review destination/sender is currently not configured, so no connection containment is required. If configured later, removing/disabling the approved destination, hostname allowlist or sender should return scheduling to `NOT_CONFIGURED`. Token rotation can invalidate outstanding preference/click links and requires separate consideration.

## MCP and providers

Growth MCP auth/client and optional provider reads are currently not connected. If configured later, revoke the dedicated credential/client connection separately. No MCP database credential or write authority exists. The application has no provider mutation, autoscaling or spending authority to undo.

## Public authority and cache

Application rollback removes the Completion Night public presentation while preserving underlying data. In-process public cache entries expire within 60 seconds; downstream search caches may persist and must not be represented as immediately recallable.
