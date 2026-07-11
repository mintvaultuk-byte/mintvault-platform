<!--
Template: Confidence scoring (governance v1.1).
Every engineering report (Stage 7, and any interim report the owner reads)
ends with this block. Percentages are honest estimates, not advertising —
a low number with a clear justification is more useful than a high number
with none. Confidence must be consistent with the Definition of Proof: e.g.
Verification Confidence cannot be 95% on Local Proof of a multi-machine
concern.
-->

# Confidence scores — <task name>

| Dimension | Score | Justification (short, concrete) |
|---|---|---|
| **Design Confidence** | NN% | <why the chosen approach is/isn't the right one — what was compared, what's untested about the idea itself> |
| **Implementation Confidence** | NN% | <how sure the code does what the design says — what was traced, what's complex/fragile> |
| **Verification Confidence** | NN% | <tied to the Definition of Proof level actually reached — what was exercised vs what wasn't> |
| **Deployment Confidence** | NN% | <how safely this ships — rollback quality, migration risk, multi-machine/env divergence concerns. "N/A — not deploying" is valid> |

## Calibration guide

- **90%+** — verified with evidence at the appropriate proof level; known
  failure modes checked individually.
- **70-89%** — solid but with named untested paths or assumptions.
- **50-69%** — works in the exercised path; meaningful unknowns remain —
  name them.
- **<50%** — should normally not be shipping; if reporting anyway, say what
  would raise it.

Never present a score without its justification. Never average away a weak
dimension — four numbers, reported separately.
