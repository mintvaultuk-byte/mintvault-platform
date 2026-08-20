# GB-04B — Growth Intelligence / Business Command Centre

## Scope and boundary

GB-04B extends the existing Super Admin Growth Command. It does not alter grading, Stripe pricing or fulfilment, Partner provisioning, Scanner authority, or production infrastructure. It contains no analytics cookie, browser storage, pixel, visitor identifier, or external MCP endpoint.

Growth remains one Super Admin module at `/admin/growth`, with deep-linkable internal tabs: Overview, Acquisition, Partners, SEO & Traffic, Conversion, Site Health, and Campaigns. The existing Partner-lead detail/actions and controlled campaign link generator are preserved.

## Metric authority matrix

| Visible metric                                 | Authority                                                                 | Refresh/cache                            | Failure state                                    | Privacy                   |
| ---------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------ | ------------------------- |
| Revenue, paid submissions/cards, average cards | `submissions` with verified Stripe paid predicate and `payment_timestamp` | 30s server snapshot / bounded UI refresh | API error or stale valid snapshot                | Aggregate only            |
| Source/campaign performance                    | `submission_acquisition` plus approved Partner attribution                | Same commercial snapshot                 | Empty measured results, never fabricated         | Controlled tokens only    |
| Partner pipeline                               | `partner_applications` status counts                                      | Same commercial snapshot                 | API error/stale                                  | Aggregate only            |
| Recent paid cards/submissions/revenue/apps     | Verified GBP paid timestamps plus timestamped application records         | Rolling 60-minute DB window              | API error/stale or tiny-sample velocity withheld | Aggregate only            |
| Submission/checkout conversion                 | No stable canonical event cohort                                          | N/A                                      | `NOT_INSTRUMENTED`                               | No tracking added         |
| Site/database availability                     | Server-side `SELECT 1` + certificate schema readiness                     | 30s snapshot                             | `RED` readiness failure                          | Aggregate status only     |
| Fly CPU/RAM/RPM/p95/5xx/machines               | No safe runtime provider adapter configured                               | N/A                                      | `NOT_CONNECTED` / `UNKNOWN`                      | No machine IDs/tokens     |
| Neon pressure/latency/compute/storage/PITR     | No provider signal                                                        | N/A                                      | `NOT_CONNECTED` / `UNKNOWN`                      | No host/credentials       |
| Fly/Neon/R2/Resend cost                        | No approved provider billing-read authority                               | N/A                                      | `NOT_CONNECTED` / `UNKNOWN`                      | No billing credential     |
| Search Console metrics                         | No Search Console connection                                              | N/A                                      | `NOT_CONNECTED`                                  | No provider secret        |
| Technical SEO configuration                    | MintVault sitemap, robots and SSR route policy                            | In-process source config                 | `ERROR` only for inconsistent configured policy  | Public configuration only |

`/api/health` is now a generic, rate-limited public readiness response. It no longer emits database status, uptime, timestamps, or raw database errors. Detailed health is only available through the existing Super Admin Growth boundary.

## Health and capacity model

`deriveCapacityStatus` accepts only fleet-wide provider inputs and server-configured sustained-window thresholds. It does not have production defaults, because the current runtime does not own a Fly metrics adapter.

- Request rate is contextual and can never independently make capacity amber or red.
- `GREEN` requires all configured fleet signals within thresholds.
- `AMBER` requires a correlated warning signal such as CPU/memory/latency/5xx.
- `RED` requires a customer-impacting signal, degraded machine count, or correlated resource and latency pressure.
- Missing data is `UNKNOWN — INSUFFICIENT_TELEMETRY` and recommends only `TELEMETRY_INCOMPLETE`.

The only action model is monitor → detect → recommend in `MANUAL` mode. There is no scale, deploy, payment, Partner, Scanner, budget, automatic-spend, or database mutation control. `GUARDED AUTO` is a documented future design that is unavailable without a separately approved privileged package. See `completion-night/INFRASTRUCTURE_CONTROL_DESIGN.md`.

## Campaign readiness, incidents and velocity

Campaign Readiness is a pure deterministic rule over site readiness, payment health, database availability, 5xx, Fly machine health and correlated capacity. Any red input returns red; missing required authority returns unknown; fully connected amber/green inputs return amber/green. It is advisory and never changes campaign state.

Incident Mode checks red revenue-path authorities in a fixed order: payments, submission/checkout service, database, application errors, correlated capacity, Fly machines, then Partner applications. An active incident is rendered before ordinary insights. The clear state explicitly does not claim that unknown providers are healthy.

Revenue velocity is the exact rolling 60-minute count of verified GBP paid submissions/cards/revenue. It is not forecasted; all three values are withheld as `INSUFFICIENT_DATA` below three verified paid submissions. A previous-window comparison remains `NOT_INSTRUMENTED` until a like-for-like baseline is implemented.

## Insights

Insights are deterministic and include a rule id, period/window, bounded input metrics and result. Current rules cover service readiness, incomplete capacity telemetry, missing Search Console, uninstrumented conversion and actionable Partner pipeline counts. They never use an LLM or claim an explanation absent the measured input.

## SEO and provider connection

Search Console is explicitly `NOT_CONNECTED`; impressions, clicks, CTR, position, queries and pages are not rendered as zero. A future connection must use a dedicated server-side service identity with verified property access, bounded cache/timeout, no browser credential, and aggregate-only response.

## Growth MCP contract

The aggregate-only service contracts include `getGrowthSummary`, `getAcquisitionPerformance`, `getCampaignPerformance`, `getPartnerPipeline`, `getLivePulse`, `getSiteHealth`, `getCapacityStatus`, `getInfrastructureStatus`, `getCampaignReadinessStatus`, `getRevenueVelocity`, `getSeoSummary`, `getConversionSummary`, and `getGrowthInsights`. The infrastructure/readiness/velocity MCP tools are reads over these same server contracts; they never enable scaling.

The dedicated `/mcp/growth` JSON-RPC transport is fail-closed behind its own bearer-hash identity, rate limit and aggregate audit. Every tool is annotated read-only/non-destructive. `listPartnerApplications` and `getPartnerApplication` remain outside the MCP contract because they contain lead business/contact data.

External state: **B — READ-ONLY MCP TRANSPORT READY — CREDENTIAL/DEPLOYMENT CONNECTION REQUIRES OWNER ACTION.** It must not reuse a browser session, Super Admin password, Partner identity, database credential, or future infrastructure write identity.

## Refresh and zero-dead-UI sweep

Overview/Site Health request a bounded refresh every 30 seconds; other tabs use 120 seconds. The server snapshot has a 30-second TTL and can return a visibly `STALE` last-known-good snapshot for at most five minutes when refresh fails. The manual Refresh button bypasses only this server snapshot and is disabled while its request is pending.

| Control                                | Result                                          |
| -------------------------------------- | ----------------------------------------------- |
| Internal tab buttons                   | Navigate to the matching Growth tab/deep link   |
| Period selector                        | Reloads bounded authoritative commercial period |
| Manual Refresh                         | Refetches the intelligence snapshot             |
| Partner Review/status/handoff          | Existing Super Admin actions/destination        |
| Safe web presence link                 | Only HTTP(S), no credentials                    |
| Campaign selects/Generate/Copy         | Controlled registry/server link/copy result     |
| Provider connection/scale/MCP controls | Not rendered — no authorised action             |

Broken active controls: **0**.

## Tests and rollback

Focused GB-04B tests cover capacity green/amber/red/unknown behaviour, the request-rate non-trigger invariant, live-pulse aggregate/PII boundary, health unavailability, Search Console not-connected, conversion no-fake-rate, traceable insights and public-health redaction. The existing Growth RBAC test also covers the new intelligence endpoint.

No migration is required. Rollback is a normal application deploy rollback; the intelligence route is read-only and failure-isolated from public site, payments, Partner applications, Partner portal and Scanner boundaries.
