# Trusted Intake Connector — Final Safety Gate

Every gate has concrete evidence (a named test + its assertion, or a recorded
number). Status as of the final fresh-cluster run.

| #   | Gate                                                                      | Evidence source                                                              | Status                 |
| --- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------- |
| 1   | ≥100 connector records processed through real G1–G3E code                 | scale test: 100 seeded, asserted                                             | PASS                   |
| 2   | ≥10 concurrent workers / independent connections                          | worker runner `workerCount: 10`, pool max 12                                 | PASS                   |
| 3   | Every valid connector → exactly one destination                           | scale: 80 destinations == importable count                                   | PASS                   |
| 4   | Every valid connector → exactly one completed mapping                     | scale: 80 completed mappings, 0 dup                                          | PASS                   |
| 5   | Every destination → unique reference                                      | scale: 80 distinct == 80 total                                               | PASS                   |
| 6   | Duplicate requests return existing destination                            | scale: 5×20 storm → same dest, 0 new subs                                    | PASS                   |
| 7   | Stale sources create no destination                                       | scale: 10 stale → 0 dest, → validating                                       | PASS                   |
| 8   | Interrupted + expired claims recover per rules                            | scale: 5 interrupted + 5 expired → imported                                  | PASS                   |
| 9   | Lost responses + retries converge on same destination                     | scale lost-response + fault lost-response                                    | PASS                   |
| 10  | Worker crashes leave no permanently stuck lease                           | scale: 0 abandoned-expired after run; fault worker-death                     | PASS                   |
| 11  | Connection-pool saturation bounded + observable                           | fault: pool max 1 + acquire timeout, bounded                                 | PASS                   |
| 12  | No deadlock in tested workload                                            | scale run: 0 failures, single lock order                                     | PASS                   |
| 13  | No grading/cert/counter/label/payment/Stripe/email/webhook/VQ side effect | scale forbidden-side-effect fixtures unchanged                               | PASS                   |
| 14  | Provenance history accurate + unambiguous                                 | scale + provenance tests: completed attempt links exact run/fingerprint/dest | PASS                   |
| 15  | G1–G3E behaviour unchanged                                                | 160 baseline tests still green (17+23+3 + 49+32 + migrations)                | PASS                   |
| 16  | No G4 API / Admin UI built                                                | scope reviewer + grep (no routes, no client/)                                | PENDING REVIEW         |
| 17  | Nothing deployed or enabled                                               | flags OFF (grep), no deploy                                                  | PASS                   |
| 18  | Append-only evidence enforced (no runtime UPDATE/DELETE)                  | migration 0012 grant (SELECT,INSERT only)                                    | PASS                   |
| 19  | Migration idempotent + rollback preserves destinations                    | migration tests (13 tests), isolated-cluster rollback                        | PASS                   |
| 20  | Hot-path indexes verified (no material seq scan)                          | query-plan test (6 tests), EXPLAIN before/after                              | PASS                   |
| 21  | Zero new repository regression                                            | full-suite comparison to pristine main                                       | PENDING (merge review) |
| 22  | Secret scan clean                                                         | secret scan                                                                  | PENDING (merge review) |

Items 16, 21, 22 close in the independent-review + controlled-merge phase.
