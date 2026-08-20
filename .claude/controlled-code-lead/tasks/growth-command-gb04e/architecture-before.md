# GB-04E architecture — live baseline

```mermaid
flowchart LR
  F["Fly production app v1113"] --> G["Growth Command server aggregates"]
  N["Neon application database"] --> G
  G --> U["Authenticated Super Admin UI"]
  G --> M["Read-only Growth MCP route"]
  FT["Fly provider telemetry: not connected"] -.-> G
  NT["Neon provider telemetry: not connected"] -.-> G
  SC["Search Console: not connected"] -.-> G
  R["Review destination/sender: not activated"] -.-> G
  EC["External MCP client: not connected"] -.-> M
```

- Provider absence is rendered as unknown/not connected, not healthy.
- Application database readiness is live; provider-level Neon telemetry is absent.
- Infrastructure mode is manual/recommendation-only; guarded auto is off.
- No provider secrets are available to the browser.
