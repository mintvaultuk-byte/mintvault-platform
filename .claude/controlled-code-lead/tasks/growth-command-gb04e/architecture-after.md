# GB-04E architecture — as built before provider activation

```mermaid
flowchart LR
  FM["Fly Machines API · GET only"] --> FA["Server-only Fly read adapter"]
  FP["Fly Managed Prometheus · GET only"] --> FA
  FS["Dedicated organisation read-only token"] --> FA
  FA --> C["30-second sanitized single-flight snapshot"]
  C --> H["Site health"]
  C --> K["Deterministic five-minute capacity model"]
  C --> I["Machine intelligence"]
  H --> G["Growth Command aggregate"]
  K --> G
  I --> G
  N["Application DB readiness/pool/latency"] --> G
  G --> U["Authenticated Super Admin UI"]
  G --> M["Aggregate read-only MCP route"]
  O["Neon provider / Search Console / Reviews / external MCP"] -. "owner action" .-> G
```

- The adapter hard-allowlists organisation `personal`, app `mintvault`, the Machines API host and Managed Prometheus host. Redirects and non-GET methods are unavailable.
- Raw provider responses, check output, image digests and credentials do not cross the adapter boundary.
- CPU, RAM, request rate, p95 and 5xx are five-minute provider signals. Missing any expected-machine signal makes capacity UNKNOWN. Request rate is context only.
- The approved fleet floor remains two machines. A lost/unhealthy machine recommends restoring the fleet before any capacity action.
- Successful data is cached for 30 seconds. A failed refresh may display the last successful values for at most five minutes as STALE, but stale values cannot drive capacity.
- The UI, MCP and service expose no provider mutation, scaling, budget, spend or guarded-auto authority.
