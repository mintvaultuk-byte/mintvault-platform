# Architecture — AFTER — Partner Pilot final-scale completion

**State:** PROPOSED (Stage 4)
**Date:** 2026-08-12

```mermaid
flowchart LR
  Operator["MFA Partner operator"] --> Scanner["Signed MintVault Scanner"]
  Scanner -->|"Start one card, idempotency key"| Start["Server: reserve exact credit / drive canonical intake"]
  Start --> Allocation["Existing global allocator / immutable Partner origin"]
  Allocation --> Target["One station-bound target"]
  Target --> Evidence["Front then back: immutable TIFF evidence"]
  Evidence --> Ready["Evidence-derived Ready to Grade"]
  Ready --> MVGS["Server MVGS"] --> QA["100% Super Admin QA"] --> Print["Existing print authority"]
  Scanner -->|"signed heartbeat + monotonic app version"| Station["Station version/health"]
  Evidence --> Bounded["bounded R2 finalisation / durable retry"]
```

## Deliberately preserved

- No Scanner-local credit balance, target, MV number, grade, QA or print decision.
- Existing global transactional allocator and exact reservation invariant.
- Existing server-authoritative MVGS and print/QA boundary.
- Production topology remains fail-closed until separately corrected.

## AS-BUILT confirmation

Pending Stage 6. Any migration, live role, deployment, R2 or Canon evidence is not implied by this proposed architecture.
