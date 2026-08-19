# Partner Network Consolidation Issue Register

Scope: P7 → P10 on `feat/super-admin-partner-network-consolidation` from `origin/main` `f64e67fbfd9e8b5a5b647dd78265ada4478b485d`.

| ID | Severity | Source | Reproduction / impact | Repair | Proof | Status |
| --- | --- | --- | --- | --- | --- | --- |
| PNC-001 | HIGH | Hostile review P7 F1 | A cert beyond the normal 200-row queue cap did not open from `/admin/staff?certId=`. | Added a certId scope to existing R1 queue read; the Staff client sends it and admits only `pending_review`. | Route contract test; focused runtime test pending dependency installation. | FIXED — re-review pending |
| PNC-002 | HIGH | Hostile review P7 F2 | P5 proof set did not cover enough server readiness branches. | Added six-dimension pure tests and two-audience renderer tests; P2-dependent database fixture deliberately excluded because P2 is a campaign non-goal. | Focused test files; execution blocked because this fresh worktree has no `vitest`/`tsc`. | FIXED — re-review pending |
| PNC-003 | HIGH | Hostile review P7 F3 | Canonical routes lacked visible top-level Partner Network navigation. | Added Overview, Partners, Stations, Infrastructure, and Settings navigation and an R3 read-only network stations page. | Route contract test; execution blocked by missing dependencies. | FIXED — re-review pending |
| PNC-004 | MEDIUM | Hostile review P7 M1 | Partner filter could fall into the legacy queue response when status was omitted. | Partner/cert scoped queue calls now always take the rich existing queue branch. | Source contract test. | FIXED — re-review pending |
| PNC-005 | MEDIUM | Hostile review P7 M2 | Malformed certId direct link was not explained. | Normal Staff queue remains visible and a plain invalid-id message is shown. | Route contract test. | FIXED — re-review pending |
