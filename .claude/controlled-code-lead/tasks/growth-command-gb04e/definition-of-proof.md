# GB-04E definition of proof

| Provider/surface                 | Current level                                        | Required evidence                                                                   |
| -------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Fly telemetry/capacity/readiness | Adapter built; live read probe and local tests green | Exact-candidate deployment, both production machines and authenticated UI/API proof |
| Neon provider telemetry          | Design baseline                                      | Live production project/branch provider data or exact owner-action proof            |
| Search Console                   | Design baseline                                      | Actual MintVault property data or exact property/service-identity action            |
| Reviews                          | Design baseline                                      | Canonical destination/sender authority and non-fake lifecycle proof                 |
| MCP external client              | Design baseline                                      | Authenticated read-only aggregate call or exact owner install action                |
| Release                          | Candidate gates in progress                          | Exact candidate CI, guarded deploy, runtime SHA and rollback proof                  |

Local evidence before candidate freeze:

- Live provider read: both LHR production machines returned sanitized CPU/RAM/request/p95/5xx, deployment tag and exact baseline SHA; connection/fleet health GREEN.
- Focused: 4 files / 35 tests passed.
- Full CI-equivalent: 395 files; 6,381 passed; 2 intentional skips; 0 failed against clean disposable PostgreSQL 16/17 services.
- Typecheck, production build and lint passed. Repository-wide format check remains a pre-existing baseline failure; every changed product/test file passes Prettier.
