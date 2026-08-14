# Definition of Proof — Canonical compact grading workstation density

| Dimension | Status |
|---|---|
| **Design Status** | drafted |
| **Implementation Status** | complete locally |
| **Verification Status** | local runtime/source/protected suites passed; exact-PR CI pending |
| **Activation Status** | not deployed |

## Required evidence

- Browser baselines and after measurements at 1280×800, 1024×768, 1440×900, and 800×700 for Card Details, Grade, and Review.
- Geometry parity across Super Admin, Pending Review, Staff, Grader, and Partner.
- Front/Back, zoom/pan, state persistence, real certificate preview, review no-write, revision barrier, manual/auto CAS, scanner/station, Partner RBAC/MFA, architecture, and MVGS proof.
- Required protected-PR CI, merge, and only then production health/artifact verification if deployment is performed.

## Local proof recorded 2026-08-14

- 1024×768 browser comparison: rail 40%→35%; card viewport 289×404 at y170→334×467 at y121; certificate 266×76→230×66; filter-button count 1→0; Card Details scroll distance 427→331.
- Grade comparison: overall 212→154px, MVGS 129→113px, centering 413→310px, centering input 30→26px, right-side Grade scroll distance 1779→1418px; threshold reference is closed by default.
- Focused regression result after final source change: 15 files / 383 tests passed; earlier comprehensive focussed set: 32 files / 581 passed, 76 environment-marked skips.
- Deliberate temporary `shared/mvgs-scoring.ts` mutation made the protected guard fail closed; file was restored and the guard passed.
- Independent hostile source reviewer: no evidence-backed BLOCKER/HIGH; see `reviewer-report.md`.
