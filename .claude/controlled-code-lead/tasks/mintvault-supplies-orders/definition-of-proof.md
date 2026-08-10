# Definition of proof — mintvault-supplies-orders

| Boundary           | Evidence                                                                                                                                 | Result                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Migration          | Real PostgreSQL 17 full migration, schema parity, standalone `0069` apply, rollback and reapply                                          | Pass                                      |
| Checkout authority | Forged price/tax ignored; unpriced NFC refused; approved/override addresses and gross/VAT snapshots inspected in real SQL                | Pass                                      |
| Payment            | Signed Stripe session metadata is the only PAID transition; replay collapses; transient session failure retries the same immutable order | Pass                                      |
| Refunds            | Partial/full original-payment refunds are recorded; no Partner credit ledger row is created; dispatched request becomes an exception     | Pass                                      |
| Tenant/RBAC        | Restricted login cannot see another tenant or rewrite status; Finance Viewer sees orders but has no checkout/address controls            | Pass                                      |
| Object storage     | Fresh loopback MinIO bucket, CI bucket-creation guard, real upload/HEAD/sign/read/delete test                                            | 2 passed                                  |
| Partner HTTP       | Real mounted grading HTTP routes and full two-card Partner pilot use disposable PostgreSQL and MinIO                                     | 27 + 21 passed                            |
| Browser            | Partner Owner at 1280×800 and 1024×768; Finance Viewer read-only; Super Admin fulfilment, audit and Needs Attention                      | Pass, no horizontal overflow              |
| Provider network   | Actual Stripe TEST charge/refund                                                                                                         | External credential required; not claimed |
