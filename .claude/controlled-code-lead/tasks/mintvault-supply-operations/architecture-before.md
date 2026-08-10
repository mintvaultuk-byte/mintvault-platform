# Architecture — BEFORE — mintvault-supply-operations

Phase 22 needs operational visibility without inventing warehouse facts.

- `partner_supply_orders` and their immutable items already hold paid ordered quantities.
- `partner_grading_work_items.status='completed'` is the existing per-card completion authority.
- No existing table records a shop's current supply count, so an absent count must render as `Not recorded`, not zero or an estimate.
- The count belongs to the Partner location, not the global product or a customer.
- Owner/Manager purchase capability already distinguishes commercial operators from Reception's historical order-submit capability; Finance Viewer has only view authority.

The design therefore adds a small location-scoped current count, preserves it with an append-only generic Partner audit event, and deliberately displays rather than combines the three independent values.
