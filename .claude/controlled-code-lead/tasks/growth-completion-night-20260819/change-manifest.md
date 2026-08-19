# Change Manifest — Runtime Candidate

**Frozen:** 2026-08-19 21:45 BST
**Lead:** `codex/growth-completion-night-20260819@facfd36f`
**Authority:** the owner explicitly authorised GB-04B closeout, a dedicated read-only MCP identity/transport, a genuine review engine, privacy-safe public authority, conversion instrumentation and integration into the existing Growth Command. This authorises local code, tests, additive migration authoring and documentation within those exact boundaries. It does **not** authorise applying a migration, writing a secret, pushing/merging, changing a provider account, or deploying before the separate release gates.

## Accepted application changes

| Package | Runtime contract                                                                                                                                                                                             | Expected files                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| A       | Remove the unconsumed Partner lead-context claim; reconcile the documented capacity read contract                                                                                                            | Growth page and GB-04B handover/test                                                                     |
| B       | Add a stateless Streamable-HTTP-compatible MCP JSON-RPC endpoint with dedicated SHA-256 bearer-token identity, fixed aggregate tool allowlist, IP/token rate limiting and PII-free audit                     | new MCP route/service, route registration, tests/docs                                                    |
| C       | Add an additive review outbox/lifecycle, neutral email, bounded retries, deterministic provider idempotency, suppression/cancellation and aggregate-only Growth reporting; tighten manual delivery authority | migration `0101`, schema, review service, email, admin delivery route, scheduler, Growth route/UI, tests |
| D       | Strengthen the existing Population authority surface with minimum-sample suppression, bounded cache/rate controls and crawler-visible allowlisted JSON-LD; do not create doorway pages                       | public population route/storage, SEO config/static/page, tests                                           |
| E       | Keep Fly and Search Console `NOT_CONNECTED`; update exact server-only connection contract because no credentials or property authority exists                                                                | provider/blocker docs and truthful UI text only                                                          |
| F       | Persist privacy-minimised, idempotent submission/checkout-start events; checkout event is best-effort after real PaymentIntent creation and cannot affect payment                                            | migration `0101`, schema, conversion service, checkout route, Growth aggregates/tests                    |
| G       | Add one real Reviews tab to `/admin/growth`; preserve existing shell/router compatibility and black/gold admin system                                                                                        | Growth page/routes/tests                                                                                 |

## Explicit exclusions

- No MVGS/grading, payment authority, Stripe fulfilment, Partner tenant/credits, Scanner/station, owner auth, secret value, provider account, outreach or automatic scaling changes.
- No public customer-level review data, arbitrary recipient/URL, review gating, grade/sentiment eligibility or fake provider metrics.
- No new dependency; native Express, crypto, fetch/AbortController, SQL and existing Resend are sufficient.
- No production/staging write, migration application, push, PR, merge or deploy during implementation.

## Protected-system containment

- Migration `0101` is additive and single-owner. Creation is in the explicitly requested review/conversion scope; application remains separately gated.
- MCP authentication is a new dedicated boundary explicitly requested by the owner. It never accepts a browser session or owner password, never exposes arbitrary queries and remains disabled unless a secret hash is configured.
- `server/routes/submissions.ts` may gain one fail-open event write only after Stripe returns a real PaymentIntent; payment authority and response semantics remain unchanged.
- `server/routes/admin-submissions.ts` may tighten manual-delivery preconditions and create/cancel review lifecycle state in the same transaction; no grading logic changes.

## Implementation stop condition

If the runtime change exceeds 30 files, 2,750 net lines, two migration identities, or introduces a dependency/provider write, stop and re-freeze this manifest before further edits.
