# Architecture — BEFORE — mintvault-stripe-credit-purchase

```mermaid
flowchart LR
  A["Partner package id"] --> B["Server price catalogue"]
  B --> C["Stripe Checkout"]
  D["Signed webhook"] --> E["Append-only credit ledger"]
  E --> F["Wallet projection"]
  C -. "no real PostgreSQL fulfilment coverage" .-> E
```

- The authoritative package catalogue, Checkout creator, webhook branch and idempotent ledger writer
  already exist.
- Pure tests prove malformed metadata and package rules, but the full paid fulfilment/replay path
  lacked a dedicated real-PostgreSQL proof across the actual credit-purchase service.
