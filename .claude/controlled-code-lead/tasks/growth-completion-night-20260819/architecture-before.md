# Architecture — Before

**Captured:** 2026-08-19 from source, Fly status, `/api/version` and a read-only production DB query.

```mermaid
flowchart LR
  SA["Super Admin browser"] -->|"session + CSRF"| GR["/api/super-admin/growth"]
  GR --> CG["commercial-growth-service"]
  GR --> GI["growth-intelligence-service"]
  CG --> PG["Production PostgreSQL"]
  GI --> PG
  PUB["Public MintVault routes"] --> APP["Express + React application"]
  FLY["Fly telemetry"] -. "not connected" .-> GI
  GSC["Google Search Console"] -. "not connected" .-> GI
  CHAT["External ChatGPT/MCP"] -. "no external transport/identity" .-> GI
  REV["Review provider"] -. "destination not proven" .-> APP
```

## Evidenced facts

- Production and main serve `facfd36f`; Fly v1109 has two healthy machines.
- Growth uses bounded Super Admin routes and aggregate-only services.
- Production journal is applied through `0100`; both existing Growth tables are present.
- Provider metrics, external MCP and conversion-start cohorts are absent/truthfully unavailable in GB-04B.

## Constraints

No payment, auth, MVGS, Partner operational, Scanner or secret boundary may change. Provider/data additions require bounded caches, privacy-safe aggregates and truthful failure states.
