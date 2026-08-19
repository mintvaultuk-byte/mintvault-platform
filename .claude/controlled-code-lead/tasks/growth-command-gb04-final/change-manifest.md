# Change manifest — GB-04 final production Growth Command

**Date:** 2026-08-19
**Lead session:** `codex/growth-command-gb04-final` at `cf891246890fd18bc8dfdca90e5bbf44001b5f5e`

## Findings this manifest addresses
- GB04-F1 — replace conflicting historical Growth migration identity with additive `0099` — classification E.
- GB04-F2 — write only Stripe-verified paid values through the existing idempotent paid winner — classification B/E.
- GB04-F3 — give Super Admins authoritative Partner-application list/detail/status operations with an audit trail — classification B.
- GB04-F4 — add real navigation, link generation, empty/error states and only operative UI controls — classification B.

## Files to change

| File | Change | Why | Classification |
|---|---|---|---|
| `migrations/0099_growth_commercial_attribution.sql` | Add privacy-minimised attribution table and paid-window indexes. | GB04-F1 | E |
| `shared/schema.ts` | Add the Drizzle projection for the new table. | GB04-F1 | E |
| `server/commercial-attribution.ts` | Reconcile bounded codes, normalisation, deterministic link generation and persistence. | GB04-F1/F4 | B |
| `client/src/lib/commercial-attribution.ts` | Mirror the server allowlists for query continuity only. | GB04-F4 | B |
| `server/storage.ts`, `server/routes/submissions.ts`, `server/webhookHandlers.ts` | Persist verified PaymentIntent amount/currency/fulfilment time through the existing atomic paid transition. | GB04-F2 | B |
| `server/commercial-growth-service.ts` | Centralise authoritative aggregates, campaign/source performance, lead list/detail/status, and link generation. | GB04-F3/F4 | B |
| `server/routes/admin/commercial-growth.ts`, `server/routes.ts`, `server/lib/request-logger.ts` | Mount Super Admin-only APIs, bounded read/write limits, audit operations, and suppress responses from logs. | GB04-F3/F4 | B |
| `client/src/App.tsx`, `client/src/components/admin/admin-shell.tsx`, `client/src/pages/admin/growth.tsx`, `client/src/pages/submit.tsx`, `client/src/pages/admin/partner-management.tsx` | Add routed, RBAC-aware Growth UI, navigation, submission continuity and the non-provisioning onboarding handoff. | GB04-F3/F4 | B |
| `tests/growth-command-gb04.test.ts` plus focused navigation/migration helpers as needed | Exercise authority, privacy, RBAC, link and no-dead-control contracts. | GB04-F1–F4 | B/E |
| `docs/growth-command/pass-b3/*` | Record architecture, operations, rollout/rollback and the future MCP boundary. | GB04-F1–F4 | A |

## Files explicitly NOT touched
- `migrations/0094_*` through `migrations/0098_*` — canonical ownership is frozen.
- `server/partner/*` — Growth never creates/changes a Partner tenant or operational state.
- Stripe pricing, checkout-session creation and refund/dispute logic — this pass only passes already-verified grading PaymentIntent facts into an existing paid transition.
- Protected MVGS grading logic, certificate allocation and Scanner authority.

## Protected actions required
- [x] Additive canonical migration + conditional production migration — owner-authorised by the GB-04 Final prompt, 2026-08-19; do not execute unless rehearsal, CI and release gates pass.
- [x] Narrow payment-fulfilment code change — owner-authorised by the GB-04 Final prompt, 2026-08-19. It records verified facts only and does not modify price calculation, charging, Stripe configuration, or webhook registration.
- [x] Conditional production deployment — owner-authorised by the GB-04 Final prompt, 2026-08-19; use only the approved guarded deploy after exact-SHA CI.

## Order of operations
1. Reconcile attribution and the additive `0099` migration.
2. Carry verified PaymentIntent facts through the existing atomic paid transition.
3. Implement one server service boundary and Super Admin-only routes for aggregates, leads and deterministic links.
4. Wire the canonical admin navigation and responsive Growth page; add a real onboarding handoff, never provisioning.
5. Add targeted behavioural, migration, privacy, RBAC and dead-control tests; then run broad gates and the release process.

## Regression gates required
- [ ] GB-04 focused behavioural suite and mutation checks
- [ ] B1, GB-03 and Partner/Super Admin regression suites
- [ ] migration identity/scope/schema parity plus production-shaped `62 → 63` rehearsal
- [ ] `npm run check`, `npm run lint`, `npm run build`, full `npm test`, `git diff --check`
- [ ] exact-SHA CI, guarded `0099` production runner and bounded production proof

**Approved to proceed to Stage 5:** Cornelius Oliver — explicit GB-04 Final prompt, 2026-08-19
