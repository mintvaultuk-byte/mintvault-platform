# Morning Handover — Growth Completion Night Live

**Last updated:** 2026-08-20 06:16 BST
**State:** Growth core released to production; optional owner connections and owner-entered commercial targets remain.

## Release result

Pull request [#320](https://github.com/mintvaultuk-byte/mintvault-platform/pull/320) merged the exact candidate `d7dddadd504eddd6a976bc5c29a0949cbc5220f5` normally into canonical `main` at `f4285b71a5fd0cad578e845d9aaed43768309541`. There was no force push, history rewrite, governance bypass or semantic conflict. The exact deployable SHA passed terminal pull-request CI, terminal `main` CI and the Engineering OS workflow before release.

Production now serves application commit `f4285b71` on Fly release **v1111**, image `deployment-01M0ES4KPD6QC64WSVP2SXMR28`. Both LHR machines (`683720eb5127d8` and `83d479c745d0d8`) are started and passing 1/1 health checks. The recorded rollback image is `registry.fly.io/mintvault:deployment-01M0DYQHT8R6V6QV265H918CED` from v1110.

## Migration 0101

The production journal was clean before mutation: 63 applied migrations, no non-applied entries, no checksum mismatch and only canonical `0101_growth_reviews_and_conversion.sql` pending. Its checksum is `e91a62b6352c69945a9824a41a07a0c78e36d4914509464a88290e3737ecbe9a`.

The production-shaped PostgreSQL rehearsal passed 4/4. Migration `0101` was then applied once through `scripts/db/migrate.ts --apply`; no `db:push`, journal edit, skip mode or destructive flag was used. The production journal now has 64 applied migrations, zero pending, zero inconsistent and zero checksum-mismatched entries. Expected Growth target, conversion, review-request, delivery-attempt and suppression relations, indexes and constraints are present. All new tables were empty immediately after application; no targets, reviews, conversion activity or customer data were seeded.

## Commercial Scoreboard

The existing `/admin/growth` Command Centre now shows the owner-authoritative August 2026 scoreboard for:

- Paid cards
- Revenue in GBP
- Partner applications
- Qualified Partners
- Genuine reviews

All five targets initially show `NO TARGET SET`; this is intentional and truthful. The live actuals at acceptance were 0 paid cards, £0.00 revenue, 1 Partner application, 0 qualified applications and genuine reviews `NOT INSTRUMENTED`. Target pace uses the elapsed `Europe/London` calendar month: green at/on pace, amber from 70% to under 100% of pace, red below 70%, and neutral when target or actual authority is absent. Target mutations remain Super Admin-only append-only revisions with audit rows; clearing a target creates a null revision instead of deleting history. Growth MCP has no target write tool.

The owner target-entry path is **Super Admin → Growth Command → Overview → Edit targets**. No business goal was invented or entered during release acceptance.

## Live Growth acceptance

Authenticated read-only production acceptance proved all eight Command Centre sections and their live authority:

- **Overview:** live Commercial Growth Targets; five neutral `NO TARGET SET` cards.
- **Acquisition:** authoritative source and campaign tables; the current application is truthfully `UNATTRIBUTED`.
- **Partners:** 1 new application, 2 active operational Partners, and no inferred Partner-card or Partner-revenue linkage.
- **SEO & Traffic:** Search Console `NOT CONNECTED`; no request count presented as traffic/search authority.
- **Conversion:** persisted server events and Stripe-authoritative paid stages; unavailable comparisons remain `NOT INSTRUMENTED` or `INSUFFICIENT DATA`.
- **Reviews:** neutral eligibility/outbox/sent/clicked/failed/uncertain/suppressed lifecycle, all zero at release.
- **Site Health:** database/schema ready; absent Fly telemetry remains `UNKNOWN / NOT CONNECTED`.
- **Campaigns:** controlled attribution and link generation; default Medway Cataclysm Partner outreach configuration is present, but sending remains a separate owner action.

The Command Centre also loaded current rule-based intelligence through the authenticated Growth intelligence endpoint. Desktop 1440×900 and mobile 390×844 both had no document-level horizontal overflow; all eight section controls remained present on mobile and the browser console contained no errors. No target editor mutation, campaign send or provider configuration occurred.

## Public/core acceptance

Live HTTP acceptance passed for `/health`, `/api/health`, `/api/healthz`, `/`, `/submit`, `/partners`, `/verify`, `/population`, `/sitemap.xml` and `/robots.txt`. A synthetic missing route returned a real 404 with `X-Robots-Tag: noindex,nofollow` and HTML `noindex,nofollow`. The sitemap includes the population, Partner, submission and verification routes; the population page ships server-visible structured data in initial HTML.

Unauthenticated checks confirmed Super Admin Growth, Partner session and Scanner capture-session boundaries return 401. The dedicated Growth MCP route returns 503 `Growth MCP is not configured` when its optional credential is absent. An invalid review token returns 503 without redirect while the optional destination is absent. No charge or customer mutation was created for testing.

## Package completion

| Package                                      | Final state                                                         | Evidence-based conclusion                                                                                                                  | Remaining dependency                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| GB-01 checkout/payment conversion protection | **LIVE**                                                            | Paid and revenue actuals remain canonical Stripe-verified GBP records; conversion observation is fail-open.                                | None.                                                                                                       |
| GB-02 SEO/canonicals/sitemap/404             | **LIVE**                                                            | Canonicals, public discovery, sitemap/robots and real noindex 404 behavior passed live.                                                    | Optional Search Console measurement.                                                                        |
| GB-03 public Partner acquisition             | **LIVE**                                                            | Public application intake and protected pipeline are live; one new application is visible.                                                 | Owner reviews lead and sends approved outreach.                                                             |
| GB-04 / GB-04B Command Centre                | **LIVE**                                                            | Authoritative actuals, scoreboard, attribution, pipeline, controlled links and truthful provider gaps passed authenticated acceptance.     | Optional provider read connections.                                                                         |
| GB-04C MCP                                   | **INTERNAL/PRODUCTION INTERFACE READY — OWNER CONNECTION REQUIRED** | Aggregate-only, authenticated, audited, rate-limited read tools are deployed; absent auth fails closed.                                    | Owner creates a dedicated credential and connects an approved client if desired.                            |
| GB-05 genuine reviews                        | **LIVE, DESTINATION NOT CONFIGURED**                                | Neutral eligibility, idempotency, suppression and bounded failure handling are deployed; request/click is never called a published review. | Owner approves/configures destination and sender; provider authority is needed for published-review counts. |
| GB-06 authority MVP                          | **LIVE**                                                            | Real privacy-thresholded aggregates, initial-HTML structured data and useful indexable public pages passed live.                           | Optional Search Console measurement.                                                                        |

## Provider and owner actions

Required now:

1. Enter the real August targets at `/admin/growth` only when the business has approved them.
2. Review the one new Partner application and begin approved Medway/Cataclysm outreach through the existing commercial process.

Optional connections:

1. Configure the approved review destination, allowlist and verified sender; separately connect a published-review count authority if genuine-review actuals are required.
2. Create a dedicated Growth MCP bearer and connect an approved read-only client.
3. Connect least-privilege Search Console and, if desired, Fly/Neon/billing read telemetry. These connections grant no deployment, migration, autoscaling, spending or target-mutation authority.

No secret value was requested, displayed or committed.

## Observation and rollback

Bounded post-release observation confirmed both machines healthy, served SHA `f4285b71`, authenticated Growth intelligence/leads/reviews/link-options responses at 200, normal database health and no post-startup Growth, Partner, Scanner, payment, review or migration error. A replacement machine briefly failed its health check before the service started, then passed; this was deployment readiness, not an ongoing regression.

If an application regression is later confirmed, roll back through the repository safe-deploy path to image `registry.fly.io/mintvault:deployment-01M0DYQHT8R6V6QV265H918CED`. Migration `0101` is additive and its append-only data must remain; do not drop tables or edit the journal.

## Scope boundary

GB-07, GB-08 and Market Intelligence were not started. No autonomous outreach, infrastructure mutation, autoscaling or spend authority was added.
