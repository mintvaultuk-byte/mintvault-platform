# Provider Connection Boundaries

## Fly telemetry

Current state: `NOT_CONNECTED`. The production secret inventory contains no least-privilege Fly metrics authority. The application must continue to show CPU, RAM, request rate, p95, 5xx and machine telemetry as unavailable.

Owner connection action: create a read-only token scoped to the `mintvault` app, approve the exact Fly Metrics/GraphQL API contract and add it through the normal server-side secret workflow. The follow-up adapter must use native `fetch`, an abort timeout, a bounded cache and stale/unknown fallback; it must never expose the token or automatically scale.

## Google Search Console

Current state: `NOT_CONNECTED`. No read-only service identity or canonical-property configuration exists.

Owner connection action: grant a service identity read access to the exact `https://mintvaultuk.com/` property and add the credential/property through the normal server-side secret workflow. The follow-up adapter must query Search Analytics server-side on a bounded cadence, cache results, and return stale/not-connected on failure. No SERP scraping is an acceptable substitute.

Neither optional provider blocks review/conversion/authority code or commercial outreach.
