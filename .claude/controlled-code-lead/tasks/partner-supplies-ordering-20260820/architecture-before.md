# Architecture before — Partner supplies ordering

```mermaid
flowchart LR
  Partner["Partner secondary route"] --> Placeholder["Supplies placeholder / no durable order authority"]
  Admin["Super Admin"] --> Existing["No canonical supplies-order queue"]
  Resend["Existing Resend integration"]
```

At baseline, supplies are not a durable Partner-order workflow. Existing Partner addresses,
session scope, audit and Resend patterns must be inspected before defining the replacement.
