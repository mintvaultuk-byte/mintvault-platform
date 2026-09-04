# Implementation budget — White Ace local proof repairs

**Written:** 2026-09-04 before implementation; re-baselined after truthful production-shaped fixtures and full-history scanner review.

| Metric | Estimate |
|---|---|
| Product files changed | 0 |
| Test/scanner files changed | 6 (five test files plus `.gitleaksignore`) |
| Governance/evidence files changed | 10–12 |
| Estimated non-governance lines changed | approximately 240, dominated by 138 exact scanner fingerprint entries and a reduced production-shaped certificate fixture |
| Commits | 0 unless the owner asks for a commit |
| Focused tests | 33 object-write assertions, 180 certificate-route assertions, 24 estimate-credit assertions, 62 environment-dependent database assertions, repaired boundary/wiring proofs, plus scanner replay |

The budget was re-baselined after the first full governed gate exposed four stale proof fixtures and the complete-history scan found reviewed historical false positives. Protected `REL-IMAGE-001`, `REL-TOKEN-001`, and `WAA-CREDIT-001` product repairs remain outside this budget pending explicit owner approval.
