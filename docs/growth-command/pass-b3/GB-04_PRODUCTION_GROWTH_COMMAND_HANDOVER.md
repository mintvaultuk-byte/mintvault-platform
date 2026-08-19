# GB-04 — Production Commercial Growth Command

## Scope and canonical lineage

GB-04 is a semantic reconciliation of the earlier Growth Command work onto canonical release `cf891246890fd18bc8dfdca90e5bbf44001b5f5e`. It keeps the Partner, Scanner, B1, GB-03 and current Partner credit authority untouched. The former conflicting Growth migration identity is not retained: the additive canonical migration is `0099_growth_commercial_attribution.sql`.

The scope is deliberately limited to a first-party commercial control surface:

- server-authoritative paid grading aggregates;
- minimal, controlled acquisition attribution;
- Super Admin-only Growth Command and Partner lead work queue;
- deterministic campaign-link generation;
- a reusable internal service boundary for a future, separately authorised GB-04B MCP.

It does not introduce a tracker, advertising pixel, cookie, browser storage, new Partner tenant model, campaign database, outreach sender, price change, Stripe configuration change, refund behaviour, or credit behaviour.

## Architecture and authority

`server/commercial-growth-service.ts` is the single read/write business boundary used by the Super Admin API. Its internal capabilities are `getGrowthSummary`, `getAcquisitionPerformance`, `getCampaignPerformance`, `listPartnerApplications`, `getPartnerApplication`, `updatePartnerLeadStatus`, and deterministic `generateTrackedCampaignLink`.

`/api/super-admin/growth` is only a thin HTTP adapter. It is router-wide `requireSuperAdmin`, rate limited, emits `private, no-store`, and is covered by request-body log suppression. Aggregate queries do not return customer/order data. Partner-application detail is visible only through the existing Super Admin gate and only with the minimum applicant fields required for review.

Revenue is counted only where a submission has `payment_status = 'paid'`, no deletion marker, a PaymentIntent binding, and a verified payment timestamp/currency. The existing atomic paid transition remains the idempotency winner. The confirmed PaymentIntent and signed webhook pass the actual Stripe amount, currency, and observed verified-paid time into that one transition; duplicate confirmations/webhooks cannot create a second paid row or overwrite the winner. Historical rows without those verified facts remain explicitly not instrumented rather than estimated.

`submission_acquisition` stores only a controlled category and approved campaign tokens. No cookie, browser identifier, IP, referrer, email, phone, arbitrary UTM text, or customer PII is allowed. Capture is fail-open: an unavailable/invalid attribution write cannot prevent submission creation or payment. Absence of an approved token does **not** become a manufactured Direct classification; it remains `UNATTRIBUTED`.

## Acquisition and campaign policy

The available categories are `DIRECT`, `ORGANIC`, `PARTNER_OUTREACH`, `CREATOR`, `REFERRAL`, `SOCIAL`, `EMAIL`, `OTHER`, and honest `UNATTRIBUTED` output.

The supported fields are `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, and `utm_term`. Each is a MintVault-owned allowlisted token. The client mirrors the server filter for clean URL continuity, but the server is authoritative. Email-shaped strings, phone-shaped strings, URL values, markup, free text and unregistered personal-name-like tokens are discarded before persistence.

The controlled generator permits only MintVault-owned `/partners` and `/submit` targets. It does not persist campaign objects. The accepted Partner campaign example is:

`https://mintvaultuk.com/partners?utm_source=outreach&utm_medium=email&utm_campaign=medway_cataclysm`

The URL is generated deterministically by the server, has no PII, and can be copied from Growth Command. It is a technical readiness example only; it does not send outreach or publish a campaign.

## Super Admin Growth Command

`/admin/growth` stays inside the existing `AdminShell`; its sidebar entry is visible only after `/api/admin/session` confirms Super Admin status. The route self-gates unauthenticated visitors to the existing admin login and redirects authenticated non-Super-Admins to `/admin`. The API remains the enforcement point for direct/deep-link attempts.

The responsive page provides:

- Today, 7-day, 30-day, 90-day, and all instrumented-time periods in Europe/London;
- paid cards, actual GBP revenue, paid submissions, average cards per paid order, and unattributed paid orders;
- source and campaign tables with paid submissions, paid cards, revenue, and Partner applications;
- Partner-application pipeline counts and explicit `Not instrumented` states for unsupported Partner revenue/cards/repeat customer measurements;
- list/detail review of existing `partner_applications` records;
- validated business/profile opening, pre-operational state changes, and an opaque-ID handoff to canonical Partner Management only after `ONBOARDING`;
- the controlled campaign-link generator and working Copy Link action.

Growth owns only `NEW`, `CONTACTED`, `QUALIFIED`, `NOT_A_FIT`, and `ONBOARDING`. A state change is server-validated and transactionally audited. It cannot create a Partner organisation, user, location, station, credit, or operational approval; the onboarding handoff is an owner-directed navigation to the existing Partner Management surface.

## Privacy and security

No browser analytics, tracking SDK, local/session storage, fingerprinting, pixel, or cross-site data source is introduced. The public GB-03 application remains isolated from Partner tenants. Existing external applicant URLs are displayed as text and opened only after a client-side `http(s)` parse rejects credential-bearing and unsafe schemes. React renders all external data as text; no HTML injection path is introduced.

The future MCP boundary is intentionally documentation only:

- read-safe later: summary, controlled performance aggregates, Partner lead list/detail, deterministic tracked-link generation;
- owner-confirm/write later: lead-state changes, campaign publication, outreach sending;
- never autonomous: grading decisions/rules, refunds, Stripe pricing, Partner credits, deploys, migrations, Scanner authority, RBAC/security changes.

No external MCP endpoint, credentials, authentication, or transport is present in GB-04.

## Migration and release checks

`0099_growth_commercial_attribution.sql` is additive. It adds `submission_acquisition` and paid-query indexes only. It has no destructive statement and does not alter `0094` through `0098`. It is classified as application-scope because it references core `submissions` payment fields.

The production-shaped rehearsal uses the real migration runner with the exact canonical `62 applied` journal state. It proves `0099` is the only pending migration, applies only `0099`, and leaves `63 applied`, zero pending, zero inconsistencies, and zero checksum mismatches. Production migration and deployment evidence are recorded only after the authorised release stage completes.

## Rollback

GB-04 has no destructive migration. Application rollback is a single release-image/SHA rollback. The new migration is intentionally retained on rollback because it is additive and old code does not depend on it. Do not delete attribution rows or edit the migration journal as part of rollback.
