# Confidence scores — Staff Admin grading inspection viewport

| Dimension | Score | Justification |
|---|---:|---|
| Design | 95% | Owner-locked FIT semantics, 50–500%, per-side state and coordinate invariants are represented directly in pure geometry and mounted contracts. |
| Implementation | 95% | Two release-gate HIGHs and one hostile-review MEDIUM are repaired with direct regressions; the exact 30-file matrix passes 780 assertions with typecheck, lint and production build green. |
| Verification | 84% | Automated proof plus supported in-app rendered geometry/anchoring evidence is strong, but the final replacement still needs hostile re-review, and the mandatory Chrome page-zoom matrix still cannot run without the Chrome control extension. |
| Deployment | 0% | No staging or production action was authorised or taken; staging readiness is explicitly withheld pending browser and hostile proof. |
