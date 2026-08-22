# Architecture after — Partner supplies ordering (proposed)

```mermaid
flowchart LR
  Partner["Scoped Partner user"] --> Form["Supplies + delivery confirmation"]
  Form --> Create["Transactional canonical order + address/item snapshot + audit"]
  Create --> Outbox["Durable notification retry state"]
  Outbox --> Resend["Existing Resend transport"]
  Partner --> MyOrders["Tenant-scoped My Orders"]
  Admin["Super Admin RBAC"] --> Queue["Partner Supplies Orders"]
  Queue --> Status["Processing / Dispatched / Cancelled + audit"]
```

The final design must use one canonical order authority, fail closed for missing delivery data,
and make notification delivery retryable without creating a duplicate order.
