# GB-04F proposed architecture

```mermaid
flowchart LR
  R[Finished HTTP response] --> T[Bounded process-local telemetry]
  T --> C[Safe route template + traffic class]
  T --> M[Machine-local aggregate]
  T --> D[Fixed dependency timing summary]
  C --> I[Growth intelligence read model]
  M --> I
  D --> I
  F[Read-only Fly fleet metrics] --> I
  I --> U[Authenticated Growth Command diagnostics]
  U --> G[Radial / digital / status presentation]
```

All telemetry remains machine-local and volatile. Fly remains the sole fleet authority. The UI labels this scope and never combines an internal or low-sample p95 into a customer-health claim.
