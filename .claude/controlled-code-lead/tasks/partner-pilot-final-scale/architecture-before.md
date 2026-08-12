# Architecture — BEFORE — Partner Pilot final-scale completion

**Date captured:** 2026-08-12
**Captured from:** production `/api/version`/Partner endpoint probes; candidate `f3e90e63`; source tracing of Scanner, credit reservations, capture and grading routes.

## Scope

The constrained Partner runtime, Scanner-to-server capture flow, credit lifecycle, certificate allocator and grading/QA/print path.

```mermaid
flowchart LR
  Scanner["Scanner: claims an existing target"] --> Capture["Signed capture endpoint"]
  Portal["Partner portal: legacy multi-card submission"] --> Reserve["Reserve one credit per submitted card"]
  Reserve --> Import["Connector import / global certificate allocation"]
  Import --> Target["Existing station target"]
  Target --> Capture
  Capture --> Evidence["TIFF staging/finalisation"]
  Evidence --> Grade["Canonical grading workstation"]
  Grade --> QA["Super Admin QA"] --> Print["Print authority"]
  Runtime["Restricted Partner DB URL"] -. current topology mismatch .-> Partner503["Partner endpoints: 503"]
```

## Evidenced facts

| Fact | Evidence |
|---|---|
| Live Partner endpoints fail safely | 503 responses recorded in `deployment-state.md` |
| Scanner cannot start a card | `scripts/scanner-app/renderer/app.js:537-559` requires an already armed target |
| Credit reservation occurs after legacy submission | `server/partner/submission-service.ts:894-927` |
| Current queue is not evidence-derived | `server/partner/grading-routes.ts:417-499` |

## Constraints

No scanner-local credit, target or MV-number authority; global allocator remains transactional; Partner data requires tenant/location/station provenance; the protected MVGS algorithm and label rendering are out of scope.
