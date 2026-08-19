# Implementation budget — Public Partner Network + Google Partner Presence

**Written:** 2026-08-19, Stage 4 before product edits

| Metric | Estimate |
|---|---|
| Files expected to change | 30–42 including tests, migration, graph and governance |
| Estimated lines changed | 2,800–4,200 |
| Estimated commits | 3–5 package commits |
| Estimated tests | 10–16 focused files/sections plus full suite |
| Estimated duration | one continuous overnight implementation session |

## Basis

The public surface needs an isolated server/client/SSR path. Google requires an additive schema, cryptographic/provider boundary and two operator views. Existing flags, RBAC, public refs, Maps fallback and certificate-origin data are reused to constrain scope.

## Stage 6 controlled re-manifest

The exact staged inventory is 57 files, 4,576 additions and 91 deletions before generated build output. That is 36% above the original 42-file ceiling, so the original stop/re-manifest rule fired.

The reviewed manifest is revised to **55–60 files / 4,400–4,800 additions**. The difference is accounted for by:

- ten required campaign-control/evidence files plus the canonical execution ledger and Engineering OS decision record;
- separate OAuth crypto, provider, state service and migration/rollback files to preserve trust-boundary isolation;
- independent real PostgreSQL, HTTP callback, cache-revocation, query-budget and controlled-performance tests.

No new product authority or frozen grading/QA/payment/station/credit surface entered the delta. The exact staged inventory falls inside the revised manifest.
