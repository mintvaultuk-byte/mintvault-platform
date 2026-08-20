# Provider Connection Boundaries

## Fly telemetry

Current state: `NOT_CONNECTED`. The production secret inventory contains no least-privilege Fly metrics authority. The application must continue to show CPU, RAM, request rate, p95, 5xx and machine telemetry as unavailable.

Owner connection action: create a read-only token scoped to the `mintvault` app, approve the exact Fly Metrics/GraphQL API contract and add it through the normal server-side secret workflow. The follow-up adapter must use native `fetch`, an abort timeout, a bounded cache and stale/unknown fallback; it must never expose the token or automatically scale.

The current application now has a bounded display DTO for safe per-machine status, region, CPU, RAM, request pressure, p95, 5xx and deployed version/SHA. It deliberately returns no machine rows until that read authority exists. The DTO is not a provider client and contains no write method.

## Neon telemetry

Current state: application database availability is `REAL` from the bounded server readiness query. Neon connection pressure, latency, compute, storage and PITR/history telemetry are `NOT_CONNECTED`. No least-privilege Neon metrics authority is configured, and no Neon mutation exists.

Owner connection action: approve a read-only Neon project telemetry contract and server-side identity. The adapter must be bounded and must keep database availability distinct from provider pressure. Compute/storage changes require an entirely separate privileged, confirmed, audited and rollback-capable package.

## Provider billing

Current state: Fly, Neon, R2 and Resend cost/billing authorities are `NOT_CONNECTED`. The Growth Command therefore shows no provider amount, trend, cost per card/order, or consolidated total.

Owner connection action: approve each provider's least-privilege billing-read contract and the exact account/project boundary. Amounts must remain in authoritative source currency. GBP normalisation is unavailable until the owner approves a traceable FX authority; no conversion is inferred from a spot rate or hard-coded constant.

## Google Search Console

Current state: `NOT_CONNECTED`. No read-only service identity or canonical-property configuration exists.

Owner connection action: grant a service identity read access to the exact `https://mintvaultuk.com/` property and add the credential/property through the normal server-side secret workflow. The follow-up adapter must query Search Analytics server-side on a bounded cadence, cache results, and return stale/not-connected on failure. No SERP scraping is an acceptable substitute.

Neither optional provider blocks review/conversion/authority code or commercial outreach.
