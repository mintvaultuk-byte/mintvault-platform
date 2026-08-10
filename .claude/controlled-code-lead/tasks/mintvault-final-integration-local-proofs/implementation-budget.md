# Implementation budget — mintvault-final-integration-local-proofs

**Written:** 2026-08-10, before the F1 edit. Updated with actuals after the required same-pass repairs.

| Metric                   | Estimate                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Files expected to change | 15 — 4 application/test files; the authoritative issue register; the shared index; and 9 required task-governance records |
| Estimated lines changed  | ±420                                                                                                                      |
| Estimated commits        | 1                                                                                                                         |
| Estimated tests          | 1 new focused test; local Partner/Admin HTTP; browser viewport journey; TypeScript; relevant integration suite            |
| Estimated duration       | one local proof session                                                                                                   |

## Basis

The mismatch is a single unconditional `ssl` option in the session pool versus the already-tested loopback branch in the application pool. The repair centralizes only that decision and does not alter authentication policy. The original estimate omitted the mandatory durable task records; this correction occurs before further code work and does not change the product repair scope.

## Actuals

| Metric              | Actual                                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files changed       | 37, including 12 durable local-proof records.                                                                                                       |
| Lines changed       | 1,287 insertions and 43 deletions.                                                                                                                  |
| Commits             | 1 bounded local-proof completion commit.                                                                                                            |
| Regression evidence | Real R2/Pilot HTTP (23), rollback round trip (47), Partner matrix (22 suites), focused guards (93), UI guards (54), typecheck and production build. |

**Budget correction:** The controller required same-pass repair of three further reproduced HIGH defects (F2/F3) and two missing client product surfaces (P1/P2). The added scope remained inside the existing Partner, migration, browser, and client-route boundaries; it did not change protected payment settlement, grading authority, production deployment, or any live credential boundary.
