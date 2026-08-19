# Acceptance Contract

## Product and truth

- [ ] Existing GB-04B capability is preserved; no needless dashboard rebuild.
- [ ] Production contains zero fake Growth/review/SEO/telemetry/conversion data.
- [ ] Missing authority renders `NOT CONNECTED`, `UNKNOWN`, `NOT INSTRUMENTED` or `INSUFFICIENT DATA`.
- [ ] Paid state and revenue remain server-authoritative and are never double-counted.
- [ ] Review requests are neutral, genuine, idempotent, suppression-aware and never gated by sentiment.
- [ ] Public authority output uses approved/public, privacy-safe facts and minimum sample rules.

## Security and privacy

- [ ] Super Admin RBAC remains the server enforcement point for internal Growth data.
- [ ] MCP identity is dedicated, revocable, rate-limited, audited and Growth-read-only; no arbitrary query/write.
- [ ] No customer enumeration, email leakage, PII logs, recipient injection, open redirect or arbitrary review URL.
- [ ] No provider token or credential reaches the browser, logs, docs or handover.
- [ ] Partner tenant, Scanner, grading, payment and auth boundaries are unchanged.

## UI and search

- [ ] One existing `/admin/growth` product; no decorative duplicate dashboard.
- [ ] Every active control has a real authority/action/result; `BROKEN = 0` on desktop and mobile.
- [ ] Admin UI preserves the existing black/gold dense command-centre language and canonical tokens/patterns.
- [ ] Public pages have self-canonical metadata, truthful structured data, search-visible output, correct sitemap policy and real 404 behaviour.
- [ ] No thin doorway pages, keyword stuffing, fake citations or mass content.

## Performance and reliability

- [ ] Aggregate queries are bounded/index-supported; provider calls are cached and timed out.
- [ ] Instrumentation and provider failure fail open for the commercial path.
- [ ] No request-log firehose, browser-refresh provider call, per-second telemetry query or unbounded public aggregate.
- [ ] Retry/idempotency and rollback/containment are explicit.

## Proof and release

- [ ] Focused behavioural tests execute non-vacuously.
- [ ] Critical negative/mutation checks bite.
- [ ] `npm run check`, `npm test`, `npm run lint`, `npm run build`, `git diff --check` pass.
- [ ] Graphify check passes; Engineering OS gap is truthfully recorded unless enrollment lands.
- [ ] Partner/Admin, Scanner shared-boundary, payment authority, migration inventory/scope and schema-parity regressions pass.
- [ ] Rendered desktop 1440px and mobile 390px acceptance passes.
- [ ] One independent hostile review is reconciled; all proven in-scope BLOCKER/HIGH are fixed and proven.
- [ ] Exact candidate SHA remote CI is terminal green before production.
- [ ] Rollback is recorded; deployment and any migration are separately authorized and serialized.
- [ ] Production proof verifies the exact served artifact and real responses, not HTTP 200 alone.

