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
| 0098   | `0098_scanner_operator_credit_view.sql`           | Scanner / Partner     | Retained. It gives `SCANNER_OPERATOR` only the existing credit-view permission required for the server-authoritative zero-credit lockout.    |

`0099` is the next free number in this integrated source tree. Growth GB-04 must rebase onto this candidate and allocate a new migration identity there; its existing `0097_growth_commercial_attribution.sql` is not changed by this decision.

## Production backlog and rehearsal

The read-only production journal contains 41 applied identities, including `0095`. The canonical
runner plans the following 21 unapplied files, in this exact order:

| Classification                               | Canonical files                                                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| APPLY                                        | `0030`, `0078`, `0079`, `0080`, `0081`, `0082`, `0083`, `0084`, `0085`, `0086`, `0087`, `0088`, `0089`, `0091`, `0092`, `0093`, `0094`, `0096`, `0097`, `0098`                                               |
| ALREADY REPRESENTED / IDEMPOTENT CONVERGENCE | `0090_lineage_convergence_scanner.sql` — its scanner objects were delivered by journalled `0046`/`0047`; the canonical runner still records the convergence assertion rather than fabricating a journal row. |
| SUPERSEDED                                   | The unjournalled `0094_partner_management_audit_card_job_void.sql`; its strict-superset canonical successor is `0096_partner_card_job_void_management_audit.sql`.                                            |
| BLOCKED                                      | None in source. Production application remains owner-authorised only.                                                                                                                                        |

`tests/canonical-lineage-production-rehearsal.test.ts` builds that 41-row topology in a disposable
PostgreSQL 17 cluster, runs the real migration planner and runner with its destructive gate enabled,
and verifies `62` consistent journal entries afterwards. It exercises the approved Scanner index
replacement (`0094`) and audit CHECK replacement (`0096`) plus the separately owner-approved
location CHECK widening (`0084`); it also verifies the existing NFC column receives `0088`'s unique
index, rather than allowing the migration to no-op.

The rehearsal uses a non-superuser migration identity. Because historic `0041` assigns
`partner_credit_reservations` to the dedicated credit schema owner, `0080` needs the migration
identity to have `REFERENCES` on that table before it can attach its FK. This is an explicit
production release-preflight capability to prove for the actual deployment identity; it was not
silently bypassed with a superuser in the rehearsal.

## Production boundary

No production journal row, schema object, release image, secret, Stripe configuration, or customer data was changed. Historical production backlog classification remains governed by the GB-04 forensic record and requires a production-shaped rehearsal before any owner-authorised migration run.
