# Architecture — AFTER — GB-04 final production Growth Command

**State:** AS-BUILT (Stages 5–6 complete; release evidence pending)
**Date:** 2026-08-19

```mermaid
flowchart LR
  Public[Public /partners or /submit with bounded UTM] --> Capture[Fail-open submission/application capture]
  Capture --> Attribution[(submission_acquisition)]
  Stripe[Verified PaymentIntent] --> Winner[Existing single-winner paid transition]
  Winner --> Submissions[(submissions payment facts)]
  Attribution --> GrowthService[Commercial Growth service]
  Submissions --> GrowthService
  Leads[(partner_applications)] --> GrowthService
  GrowthService --> API[Super Admin Growth API]
  API --> GrowthUI[/admin/growth]
  GrowthUI --> Handoff[Existing Partner Management navigation]
```

## What changes

| Change | Why | Classification |
|---|---|---|
| `0099` attribution table and indexes | Record bounded first-party campaign context separately from submission PII. | E |
| Verified payment facts in atomic winner | Make date-window revenue/card aggregates authoritative. | B |
| Commercial Growth service/API | One reusable authority for UI now and a future MCP read adapter later. | B |
| Super Admin Growth page | Give the owner a usable, responsive commercial control surface. | B |
| Partner-lead status transition | Record reviewed lead state without creating operational Partner entities. | B |

## Deliberately unchanged

- No client event or UTM can mark an order paid or create revenue.
- No API returns customer data in aggregate responses.
- No Growth control creates a Partner organisation, credit balance, station, staff member, or operational approval.
- No external MCP endpoint, analytics SDK, cookie, pixel, or fingerprinting is introduced.

## AS-BUILT confirmation

Focused regression, the real-runner `0099` rehearsal, static quality gates and
local rendered desktop/mobile acceptance have passed. Remote exact-SHA CI,
production migration and live proof remain release-stage evidence.
