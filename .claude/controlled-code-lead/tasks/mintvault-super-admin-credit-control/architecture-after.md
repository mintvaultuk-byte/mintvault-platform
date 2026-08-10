# Architecture — AFTER — mintvault-super-admin-credit-control

```mermaid
flowchart LR
  A["Append-only partner credit ledger"] --> B["Ledger-derived available / reserved / consumed"]
  A --> C["Recent ledger with source and reference"]
  A --> D["Separate bounded purchase history"]
  E["Audited Super Admin adjustment"] --> A
```

- Purchase history is a safe, bounded read from the immutable ledger; it is not a live Stripe call
  and cannot rewrite a payment result.
- The browser receives only snapshotted package, pence, currency and provider-reference fields.
- Partner selection remains in the server-owned dashboard route; adjustment actor and tenant are
  derived from the authenticated Super Admin and URL, and all balance changes stay append-only.
