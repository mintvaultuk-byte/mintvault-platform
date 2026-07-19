# Trusted Intake Connector — Final Safety Gate

Every gate must have concrete evidence (a named test + its assertion, or a
recorded number) before merge. Status filled after the final run.

| #   | Gate                                                              | Evidence source                                                  | Status  |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------------------- | ------- |
| 1   | ≥100 connector records processed through real G1–G3E code         | scale test seed count assertion                                  | pending |
| 2   | ≥10 concurrent workers / independent connections                  | worker-runner config + pool `max`                                | pending |
| 3   | Every valid connector → exactly one destination                   | scale test: destination count == importable count                | pending |
| 4   | Every valid connector → exactly one completed mapping             | scale test: completed-mapping count                              | pending |
| 5   | Every destination → unique reference                              | scale test: distinct tracking_number count                       | pending |
| 6   | Duplicate requests return existing destination                    | duplicate-storm assertion                                        | pending |
| 7   | Stale sources create no destination                               | stale-subset assertion (0 destinations)                          | pending |
| 8   | Interrupted + expired claims recover per rules                    | interrupted/expired subset → imported                            | pending |
| 9   | Lost responses + retries converge on same destination             | lost-response assertion                                          | pending |
| 10  | Worker crashes leave no permanently stuck lease                   | post-run stuck-lease query == 0                                  | pending |
| 11  | Connection-pool saturation bounded + observable                   | pool-saturation fault test                                       | pending |
| 12  | No deadlock in tested workload                                    | run reports 0 deadlocks                                          | pending |
| 13  | No grading/cert/label/payment/Stripe/email/webhook/VQ side effect | forbidden-side-effect assertions                                 | pending |
| 14  | Provenance history accurate + unambiguous                         | provenance tests (completed attempt links exact run/fingerprint) | pending |
| 15  | G1–G3E behaviour unchanged                                        | 160 baseline tests still green                                   | pending |
| 16  | No G4 API / Admin UI built                                        | scope reviewer + grep                                            | pending |
| 17  | Nothing deployed or enabled                                       | flag grep + no deploy                                            | pending |
| 18  | Append-only evidence enforced (no runtime UPDATE/DELETE)          | migration grant test                                             | pending |
| 19  | Migration idempotent + rollback preserves destinations            | migration test                                                   | pending |
| 20  | Zero new repository regression                                    | full-suite comparison to pristine main                           | pending |
| 21  | Secret scan clean                                                 | secret scan                                                      | pending |
