# Change manifest — mintvault-supply-operations

| Area                        | Change                                                                                                 | Classification | Recovery                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------- |
| `0070` migration / rollback | Add location-scoped current counts, RLS, narrow runtime column grants and evidence-preserving reversal | E              | Run reviewed `rollback-0070` only when its table has no count records and later migrations have descended. |
| Supply service/routes       | Derive indicators from existing ledgers and allow authorised count recording with Partner audit        | A              | Revert route/service after rollback; no historical commerce data is changed.                               |
| Partner/Admin screens       | Present separate operational facts and Owner/Manager count control                                     | D              | Revert surface only.                                                                                       |
| Browser bootstrap           | Make the local restricted role creation idempotent for repeated fresh disposable database proofs       | D              | Revert fixture change; no deployed role is touched.                                                        |

No live credentials, R2 data, Stripe provider call, deployed database, customer address, payment snapshot, wallet ledger, or MVGS logic is changed.
