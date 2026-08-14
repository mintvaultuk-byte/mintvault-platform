# Definition of Proof — Canonical grading left-rail refinement

| Dimension | Status |
|---|---|
| Design Status | final owner-directed presentation-only repair |
| Implementation Status | complete locally; one shared presentation component only |
| Verification Status | focused/browser/build evidence complete; exact protected-PR CI pending |
| Activation Status | not wired; deployment remains conditional on exact-SHA CI and refreshed lineage |

## Evidence to be added at Stage 6/7

- Real five-role development harness at 1280×800 and 1024×768, measured before/after: each role gains 54.9px card height (587.1→642px at 1280; 555.1→610px at 1024); thumbnail is 266 × 76px, no horizontal overflow, normal scroll ownership retained.
- 141 mounted component/revision/review/no-write/stale/retry/inspection/architecture assertions are green. The serial full run exits 0 (4,554 passed; 771 intentional CI-variable-gated skips); typecheck, lint, build and diffcheck are green. A deliberate reintroduction of the removed heading made the compact-layout test fail, then restored green after exact restoration.
- The exact protected-PR CI and, only if merged, production health/artifact confirmation remain required.
