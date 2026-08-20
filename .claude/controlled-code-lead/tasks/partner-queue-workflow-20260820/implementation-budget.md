# Implementation budget — Partner queue evidence and shop-floor workflow

**Written:** 2026-08-20, before Stage 5. Re-baselined before further Stage 5 implementation.

| Metric                   | Estimate                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Files expected to change | 25 (11 reconciled evidence files, queue contract/UI, navigation/dashboard/wizard, and focused regression tests) |
| Estimated lines changed  | ±2,400                                                                                                          |
| Estimated commits        | 2                                                                                                               |
| Estimated tests          | 35–45 new/updated checks plus full suite                                                                        |
| Estimated duration       | One working session                                                                                             |

## Basis

The working-evidence candidate is known (`a4491693`) and can be reconciled narrowly. Queue and navigation need new server/client contracts but no schema change.

## Re-baseline rationale

The evidence-only reconciliation itself is 1,072 changed lines (739 insertions and
333 deletions). The original estimate therefore could not cover the separately
authorised queue contract, safe queue rendering, primary/secondary navigation,
non-CRM submission flow, and regression coverage. The scope is unchanged; this
updates the implementation budget before those additions are made.

## Actuals

| Metric        | Actual  | Within 25%? |
| ------------- | ------- | ----------- |
| Files changed | 32 | no — the reconciled evidence contract plus governance record exceeded the pre-build estimate; scope did not expand beyond owner-approved queue/workflow/evidence work. |
| Lines changed | 3,118 (1,782 additions / 1,336 deletions) | no — the compact dashboard replaces a larger prior implementation and evidence regression coverage is deliberately explicit. |
| Commits       | 2 | yes |
| Tests         | 5,463 full-suite passes; 365 focused passes across queue/evidence and protected MVGS suites | above planned coverage |
| Duration      | one working session | yes |
