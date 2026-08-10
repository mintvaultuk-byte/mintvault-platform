# Definition of proof — mintvault-supply-operations

| Boundary                | Evidence                                                                                                             | Result                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Migration / rollback    | Disposable PostgreSQL 17 full apply, 0070 standalone rollback/de-journal/reapply, full 0070→0047 descending sequence | Pass                     |
| Current-count integrity | Real service rejects negative/unknown counts, records a valid count and emits an append-only Partner audit event     | Pass                     |
| Derived operations      | A real paid slab order increases paid and awaiting-dispatch units by exactly 50; values are read server-side         | Pass                     |
| Tenant isolation        | Another tenant's 999-unit local count is absent from the Partner shop view and present only in Super Admin aggregate | Pass                     |
| Partner browser         | Deterministic Owner records 125 units and sees a separate 50 paid/awaiting-dispatch slab indicator                   | Pass, 1280px no overflow |
| Finance browser         | Finance Viewer sees indicators/history with zero stock input, count-button, or checkout controls                     | Pass                     |
| Super Admin browser     | Super Admin sees the single-shop 125-unit aggregate and existing paid order operational view                         | Pass, 1280px no overflow |
