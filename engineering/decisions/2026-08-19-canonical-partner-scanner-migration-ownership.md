# Canonical Partner/Scanner migration ownership

- **Date:** 2026-08-19
- **Decision:** Integrate GB-03 (`e689389b`) and active Partner/Scanner (`ae7fd387`) onto one candidate, while preserving all valid application changes and no production mutation.
- **Why:** Two unjournalled source files claimed migration `0094`; GB-04 separately claimed `0097`, which active Partner checkout already owns.

## Canonical ownership

| Number | Canonical file                                    | Programme             | Resolution                                                                                                                                   |
| ------ | ------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 0093   | `0093_partner_credit_pack_currency.sql`           | Partner               | Retained from the active Partner line.                                                                                                       |
| 0094   | `0094_scanner_capture_physical_release.sql`       | Scanner               | Retained. It is the protected physical-release index replacement.                                                                            |
| 0095   | `0095_growth_partner_applications.sql`            | Growth GB-03          | Retained from the deployed GB-03 lineage; its production journal row already exists.                                                         |
| 0096   | `0096_partner_card_job_void_management_audit.sql` | Partner / Super Admin | Retained as the strict-superset audit CHECK repair. The unjournalled duplicate `0094_partner_management_audit_card_job_void.sql` is removed. |
| 0097   | `0097_partner_credit_checkout_sessions.sql`       | Partner payments      | Retained. It records server-created Partner Stripe Checkout provenance.                                                                      |

`0098` is the next free number in this integrated source tree. Growth GB-04 must rebase onto this candidate and allocate a new migration identity there; its existing `0097_growth_commercial_attribution.sql` is not changed by this decision.

## Production boundary

No production journal row, schema object, release image, secret, Stripe configuration, or customer data was changed. Historical production backlog classification remains governed by the GB-04 forensic record and requires a production-shaped rehearsal before any owner-authorised migration run.
