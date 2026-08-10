# Architecture — BEFORE — mintvault-super-admin-public-listings

```mermaid
flowchart LR
  A["Admin public-listing HTTP routes"] --> B["Lifecycle / address / coordinates / rating operations"]
  C["Super Admin navigation"] -. "no UI route" .-> B
```

- The existing server already owns listing lifecycle, public identity/address/coordinates, rating
  evidence/recalculation/override and audit. The browser exposes none of these operations as a
  Super Admin product screen.
- The Partner Dashboard labels rating/device gaps honestly but cannot inspect or govern public
  listing records.
