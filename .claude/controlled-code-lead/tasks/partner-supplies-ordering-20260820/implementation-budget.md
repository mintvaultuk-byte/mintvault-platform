# Implementation budget — Partner supplies ordering

| Area | Budgeted change | Guard |
|---|---|---|
| Data model | Four additive Partner tables plus composite identity constraints, RLS, grants and status trigger. | Numbered migration, SQL lint, real Postgres RLS/transition tests. |
| Partner authority | One small service/router using existing session and explicit supply permissions. | Server-derived tenant/user/location/address/contact; request fingerprint/idempotency. |
| Provider | One escaped operational template and one dedicated durable outbox worker. | Stable Resend key, leased claim, retry outcome/event tests. |
| Admin authority | One Super Admin-only list/status router/page. | Existing Super Admin gate + capability; transition/audit test. |
| UI | Two Partner pages, one More surface, one admin workspace. | Five primary items remain exact; desktop/mobile no-dead-CTA tests. |
| Verification | Focused + full relevant Partner suites; build/typecheck/lint/diff/hostile review. | No staging/prod claim without measured execution. |

Any schema, auth, payment, grading, Scanner, production or navigation expansion outside this table is out of scope and requires a new owner decision.
