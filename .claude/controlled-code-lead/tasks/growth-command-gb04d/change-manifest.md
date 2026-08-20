# Change manifest — GB-04D Growth Command

**State:** AUTHORISED FOR LEAD IMPLEMENTATION — 2026-08-20.

Only the Lead may edit the files below. Provider secrets, production data, migrations,
payment/webhook semantics, infrastructure mutation and Git push remain outside this
manifest.

| File | Finding(s) | Authorized change |
|---|---|---|
| `server/routes/growth-mcp.ts` | GB04D-001 | Bind the existing read limiter to the proven Fly client-IP resolver; no auth/tool change. |
| `server/growth-runtime-telemetry.ts` (new) | GB04D-002/003 | Bounded, PII-free, process-local request and provider outcome aggregation. |
| `server/lib/request-logger.ts` | GB04D-002 | Feed aggregate completion outcomes into the bounded meter; preserve logging. |
| `server/email.ts` | GB04D-002 | Observe Resend attempts/accepted/errors and rethrow unchanged; no email semantics change. |
| `server/growth-intelligence-service.ts` | GB04D-002/003/006/010 | Surface truthful runtime health, request activity, DB latency/pool pressure and completed conversion metrics. |
| `server/growth-conversion-service.ts` | GB04D-003 | Add prior-period cohort query; no event-write or payment-flow change. |
| `server/growth-infrastructure-intelligence.ts` | GB04D-006/010 | Accept app DB metrics and restore-fleet recommendation; no provider client/mutation. |
| `server/growth-search-console.ts` (new) | GB04D-009 | Dormant, server-only, read-only Search Console adapter with fixed property allowlist, cache/timeout and stale/error truth. |
| `client/src/pages/admin/growth.tsx` | GB04D-003/004/005/007 | Render conversion metrics and radial status gauges; make URL the tab authority; reset stale copy result. |
| `tests/growth-runtime-telemetry.test.ts` (new) | GB04D-002/010 | Bounded outcome, privacy, expected-auth and pressure tests. |
| `tests/growth-search-console.test.ts` (new) | GB04D-009 | Missing/invalid/connected/stale/error adapter tests with mocked fetch only. |
| `tests/growth-infrastructure-control.test.ts` | GB04D-003/006/007 | Capacity precedence, conversion/Gauge assertions and GBP/no-write preservation. |
| `tests/growth-command-gb04b.test.ts` | GB04D-002/003/010 | Reconcile prior placeholder expectations with real-but-insufficient runtime authority. |
| `tests/growth-completion-reviews-conversion.test.ts` | GB04D-003 | Funnel percentages and prior-period comparison. |
| `tests/growth-completion-mcp-authority.test.ts` | GB04D-001 | Trusted Fly identity wiring and write-denial regression. |
| `tests/admin-client-ip-authority.test.ts` | GB04D-001 | Add Growth MCP to protected limiter wiring proof. |
| `docs/growth/GB-04D-GROWTH-COMMAND-HANDOVER.md` (new) | all | Canonical architecture, sources, limits, owner actions, proof and rollback. |

## Protected-action gates

- No new migration and no database write outside existing MCP audit/review/conversion behaviour.
- No secret/env creation or mutation.
- No Fly/Neon/R2/Resend/Google provider mutation.
- No infrastructure control surface is authorized while cost, budget, write authority,
  durable idempotency and current-state policy are absent.
- No production deploy until local/full/hostile/exact-SHA CI/staging gates pass and
  Git-push authority is separately resolved.

## Required verification

Focused Vitest suites, full `npm test`, `npm run check`, `npm run lint`,
`npm run build`, `git diff --check`, Graphify check/update, Engineering OS validate,
rendered desktop/mobile interaction proof, independent hostile review, then exact-SHA
remote CI/staging/live proof if the remaining owner gates are supplied.
