# Implementation budget — Partner Pilot final-scale completion

**Written:** 2026-08-12, Stage 4 before product edits.

| Metric                   | Estimate                                            |
| ------------------------ | --------------------------------------------------- |
| Files expected to change | 18–24                                               |
| Estimated lines changed  | 900–1,200                                           |
| Estimated commits        | 3–5                                                 |
| Estimated tests          | 14–20 regression cases plus the existing full suite |
| Estimated duration       | multiple controlled implementation passes           |

## Basis

The queue and version repairs are narrow. Scanner-native start/reserve and bounded finalisation cross the station, Partner and Scanner contracts, so each is isolated into its own logical package with regressions.

## 25% rule

If the source change exceeds 1,500 lines or 30 files, stop and split the new scope into a separate manifest before continuing.
