# Issue register — GB-04 final production Growth Command

| ID | Summary | Reviewer/Source | Severity | Confidence | File:Line | Class | Lead-verified | Proof level | Impl commit | Staging | Prod | Activation | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| GB04-F1 | The old Growth migration uses identity `0097`, now canonically owned by Partner credit checkout. | Old GB-04 vs canonical inventory | high | confirmed | `migrations/0099_growth_commercial_attribution.sql` | E | yes | Automated + reviewed | pending | pending | pending | not-activated | fixed | Reconciled as additive `0099`; `0094–0098` remain untouched. |
| GB04-F2 | Paid reporting cannot honestly time-window or value production payments because canonical paid-transition writes no verified Stripe amount/currency/timestamp. | Current `storage.ts`, submission confirmation, webhook | high | confirmed | `server/storage.ts`, `server/routes/submissions.ts`, `server/webhookHandlers.ts` | B/E | yes | Automated + reviewed | pending | pending | pending | not-activated | fixed | Only confirmed PaymentIntent/webhook data reaches the atomic single-winner paid transition. |
| GB04-F3 | Existing GB-03 applications have no Super Admin lead list/detail/status operation, so the owner cannot act on prospective Partners. | Current `partner-applications.ts` and old GB-04 UI | high | confirmed | `server/commercial-growth-service.ts` | B | yes | Automated + rendered | pending | pending | pending | not-activated | fixed | Reuses `partner_applications`, strict state set and transactional PII-free audit; no tenant/account provisioning. |
| GB04-F4 | Old GB-04 has only an aggregate page; it lacks the required controlled link generator, explicit zero/dead-control states, and canonical navigation treatment. | Old GB-04 page vs owner acceptance scope | medium | confirmed | `client/src/pages/admin/growth.tsx` | B | yes | Automated + rendered | pending | pending | pending | not-activated | fixed | Real routes/actions only; desktop/mobile fixture sweep has BROKEN=0. |
| GB04-F5 | Narrow Growth Command panels expanded to their table min-content width, causing page-level horizontal overflow. | Rendered 390px fixture | medium | confirmed | `client/src/styles/admin-tokens.css:292` | B | yes | Rendered | pending | pending | pending | not-activated | fixed | `.admin-panel { min-width: 0 }` preserves local table scrolling; 390px proof has scrollWidth=clientWidth=390. |

## Rejected findings (with reason)
- None.

## Deferred findings (with unblock condition)
- GB-04B MCP endpoint — intentionally deferred by owner scope; the internal service boundary is documented only.

## Fixed findings (with evidence)
- None yet.
