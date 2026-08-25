# Confidence scores — Staff Admin grading inspection viewport

| Dimension | Score | Justification |
|---|---:|---|
| Design | 95% | Owner-locked FIT semantics, 50–500%, per-side state and coordinate invariants are represented directly in pure geometry and mounted contracts. |
| Implementation | 95% | Two release-gate HIGHs found in runtime acceptance are repaired with red/green regressions; typecheck, lint (0 errors), production build and 778 exact affected/protected assertions pass. |
| Verification | 84% | Automated proof plus supported in-app rendered geometry/anchoring evidence is strong, but the mandatory Chrome page-zoom matrix still cannot run without the Chrome control extension and the replacement SHA still requires hostile review. |
| Deployment | 0% | No staging or production action was authorised or taken; staging readiness is explicitly withheld pending browser and hostile proof. |
