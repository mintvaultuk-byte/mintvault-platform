# Architecture — BEFORE — mintvault-super-admin-credit-control

```mermaid
flowchart LR
  A["Append-only partner credit ledger"] --> B["Super Admin wallet balances and adjustments"]
  C["Stripe Checkout webhook purchase writer"] --> A
  B -. "stale unavailable claim" .-> D["Purchase history not visible"]
```

- The Super Admin dashboard already derives wallet balances from the append-only ledger and uses
  the audited adjustment service for grants/corrections.
- The live partner credit Checkout webhook also writes `purchase`/`stripe` ledger entries, but the
  wallet DTO still labels purchase history unavailable. That operational claim is now false.
