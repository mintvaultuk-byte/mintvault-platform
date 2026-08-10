# Implementation budget — mintvault-public-shop-map

| Measure                  |                                                      Estimate |
| ------------------------ | ------------------------------------------------------------: |
| Source files             |                                                             4 |
| Documentation/test files |                                                             4 |
| Lines changed            |                                                           300 |
| Local commits            |                                                             1 |
| Tests                    | 1 focused UI suite + existing public UI suite + browser proof |
| Duration                 |                           one local implementation/proof pass |

The plan deliberately avoids installing a map SDK or adding a provider dependency: stored approved
coordinates are sufficient for a useful launch map and Google Maps hand-off.
