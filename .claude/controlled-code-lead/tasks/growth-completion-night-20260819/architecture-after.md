# Architecture — After (Frozen Design)

```mermaid
flowchart LR
  SA["Super Admin browser"] -->|"session + CSRF"| GR["/api/super-admin/growth"]
  GR --> CG["commercial + intelligence aggregates"]
  CG --> IC["manual infrastructure status + readiness + incident + velocity"]
  GR --> RR["review aggregate read"]
  MCP["Approved ChatGPT connection"] -->|"dedicated revocable bearer; read only"| MR["/mcp/growth"]
  MR --> AL["fixed aggregate tool allowlist"]
  AL --> CG
  AL --> RR
  ADMIN["Admin delivery confirmation"] -->|"completed + shipped only"| OUT["review_requests outbox"]
  JOB["advisory-locked review worker"] --> OUT
  JOB -->|"neutral email; provider idempotency"| RESEND["Resend"]
  CHECKOUT["real Stripe PaymentIntent created"] -. "best-effort, fail open" .-> CE["conversion_events"]
  CE --> CG
  PUB["/population + initial HTML"] --> AUTH["suppressed public aggregates + JSON-LD"]
  FLY["Fly telemetry"] -. "NOT_CONNECTED until owner authority" .-> CG
  NEON["Neon telemetry"] -. "availability real; pressure NOT_CONNECTED" .-> IC
  BILL["Fly / Neon / R2 / Resend billing"] -. "NOT_CONNECTED until read authority" .-> IC
  GSC["Search Console"] -. "NOT_CONNECTED until owner authority" .-> CG
```

## Trust boundaries

- MCP can call only named aggregate tools; it has no DB/query parameter, lead detail, mutation, Super Admin session, payment, Partner, Scanner, infrastructure write, budget, spend or deploy capability.
- Review eligibility is server-derived from carrier delivery plus the completed/shipped/paid submission truth. Destination and recipient are server-owned; no client chooses either.
- Conversion event persistence is auxiliary and fail-open. It cannot change Stripe requests, fulfilment, prices, payment responses or customer identity.
- Public authority output comes from approved/public aggregates only and suppresses small samples; server metadata is allowlisted and safely serialized.
- Missing external credentials remain explicit states, not zero values or inferred telemetry.
- Infrastructure mode is `MANUAL` monitor/detect/recommend. `GUARDED AUTO` is documentation-only and needs a separate privileged identity, sustained/correlated evidence, hard machine/capacity/budget limits, cooldown, confirmation, audit, verification and rollback.

## Performance boundaries

- Growth snapshots and public aggregates are bounded/cached; no external provider call is made per browser refresh.
- Review work is advisory-lock serialized, atomically claimed and batch-limited.
- MCP has a strict request/tool/rate budget and returns aggregate DTOs only.
