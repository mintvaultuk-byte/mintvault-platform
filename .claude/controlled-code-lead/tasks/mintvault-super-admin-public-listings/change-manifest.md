# Change manifest — mintvault-super-admin-public-listings

| Area                   | Change                                                                                                   | Classification | Recovery |
| ---------------------- | -------------------------------------------------------------------------------------------------------- | -------------- | -------- |
| Existing listing route | Add a read-only server-derived location chooser for the already-authoritative draft creator.             | D              |
| Super Admin UI         | Add a queue/detail view for existing lifecycle, address/coordinates, verification and rating operations. | D              |
| Routes/navigation      | Mount one explicit admin route and expose one AdminShell entry.                                          | D              |
| Focused tests/docs     | Pin transitions, input truthfulness, same-origin authority boundaries and browser proof.                 | A/D            |

No new public API, database migration, rating algorithm, RLS/grant alteration, Partner mutation,
payment, provider connection, live credential or deployment is introduced.
