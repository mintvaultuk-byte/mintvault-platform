# Architecture — AFTER — mintvault-supplies-orders

```mermaid
flowchart LR
  P["Partner Owner / Manager"] -->|"items + optional one-off shop address"| R["Restricted Partner routes"]
  R -->|"tenant/location from session"| S["Supply service"]
  S --> O["Immutable order/item/payment snapshots"]
  S --> C["Stripe Checkout\nserver-derived line items"]
  C --> W["Signed Stripe webhook"]
  W -->|"PENDING_PAYMENT → PAID once"| O
  A["Super Admin"] --> F["Fulfilment / refund / exception routes"]
  F --> O
  F --> E["Append-only order events + Partner audit"]
  E --> N["Needs Attention alert"]
```

- `partner_supply_products` holds the locked slab definition and configurable, possibly unpriced products.
- `partner_supply_tax_settings` begins explicitly `UNCONFIGURED`; each order/payment copies gross, VAT treatment, rate, net and VAT totals.
- Partner runtime is RLS-bound to its tenant and cannot update order/payment status, totals or refunds. It can append checkout evidence only.
- Delivery is an approved-location or authorised one-off snapshot. Customer records are never referenced.
- Refunds call the original Stripe payment mechanism. After dispatch/completion the only product action is a manual exception record and Needs Attention alert.
