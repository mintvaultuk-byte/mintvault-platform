# Acceptance Contract

## Product and truth

- [x] Existing GB-04B capability is preserved; no needless dashboard rebuild.
- [x] MintVault Growth monetary presentation is canonical GBP/`£`; no USD/AUD commercial formatter exists.
- [x] Candidate contains zero fake Growth/review/SEO/telemetry/conversion data.
- [x] Missing authority renders `NOT CONNECTED`, `UNKNOWN`, `NOT INSTRUMENTED` or `INSUFFICIENT DATA`.
- [x] Paid state and revenue remain server-authoritative and are never double-counted.
- [x] Review requests are neutral, genuine, idempotent, suppression-aware and never gated by sentiment.
- [x] Public authority output uses approved/public, privacy-safe facts and minimum sample rules.
- [x] Commercial targets are explicitly owner/Super Admin-set monthly values; no example, forecast, AI or MCP target is seeded or inferred.
- [x] Scoreboard status compares actual progress with elapsed `Europe/London` calendar-month progress and renders no-target/unavailable authority grey.
- [x] Genuine published-review actuals remain unavailable until an approved provider proves them; sent/clicked requests are not substituted.

## Security and privacy

- [x] Super Admin RBAC remains the server enforcement point for internal Growth data.
- [x] MCP identity is dedicated, revocable, rate-limited, audited and Growth-read-only; no arbitrary query/write.
- [x] No customer enumeration, email leakage, PII logs, recipient injection, open redirect or arbitrary review URL.
- [x] No provider token or credential reaches the browser, logs, docs or handover.
- [x] Partner tenant, Scanner, grading, payment and auth boundaries are unchanged.
- [x] Fly/Neon/billing authority is absent-safe; no machine, cost, FX, budget or provider-secret value is invented or sent to the browser.
- [x] Infrastructure control remains manual monitor/detect/recommend; Growth MCP and UI contain no infrastructure mutation.
- [x] Target revisions are append-only, actor-attributed and audited in the same database transaction; clearing does not delete history.
- [x] Growth MCP exposes scoreboard read only and no set/update/clear target tool.

## UI and search

- [x] One existing `/admin/growth` product; no decorative duplicate dashboard.
- [x] The commercial scoreboard records and renders period, target, authoritative actual and deterministic status, with a real Super Admin editor.
- [x] Every active control has a real authority/action/result; `BROKEN = 0` on desktop and mobile.
- [x] Campaign Readiness is deterministic or unknown, and a red revenue-path Incident Mode renders ahead of ordinary insights.
- [x] Revenue velocity uses the exact verified-GBP rolling hour and withholds samples below three paid submissions.
- [x] Admin UI preserves the existing black/gold dense command-centre language and canonical tokens/patterns.
- [x] Public pages have self-canonical metadata, truthful structured data, search-visible output, correct sitemap policy and real 404 behaviour.
- [x] No thin doorway pages, keyword stuffing, fake citations or mass content.

## Performance and reliability

- [x] Aggregate queries are bounded/index-supported; absent providers do not generate calls.
- [x] Instrumentation and provider failure fail open for the commercial path.
- [x] No request-log firehose, browser-refresh provider call, per-second telemetry query or unbounded public aggregate.
- [x] Retry/idempotency and rollback/containment are explicit.

## Proof and release

- [x] Focused behavioural tests execute non-vacuously.
- [x] Critical negative/mutation checks bite.
- [x] `npm run check`, `npm run lint`, `npm run build` and exact-range `git diff --check` pass locally.
- [x] All runnable tests pass in the repository-safe split: 5,154 assertions in 311 no-database files plus 62 assertions in the five environment-owned files; focused Growth ordering passes after CI isolation repair.
- [ ] Engineering OS monolithic `npm run test` is green; the prepared local CI topology still reports unrelated Partner/Scanner failures, so this is deferred to exact-SHA remote CI without editing excluded domains.
- [x] Engineering OS graph is rebuilt and current for the release candidate.
- [x] Partner/Admin, Scanner shared-boundary, payment authority, migration inventory/scope and schema-parity regressions pass.
- [x] Rendered desktop 1440px and mobile 390px acceptance passes.
- [x] One independent hostile review is reconciled; all proven in-scope BLOCKER/HIGH are fixed and proven locally.
- [x] The Infrastructure/GBP addendum hostile review covers the future scaling boundary and its result is reconciled.
- [ ] Exact candidate SHA remote CI is terminal green before production.
- [x] Rollback is recorded; deployment and any migration are separately authorized and serialized.
- [ ] Production proof verifies the exact served artifact and real responses, not HTTP 200 alone.
