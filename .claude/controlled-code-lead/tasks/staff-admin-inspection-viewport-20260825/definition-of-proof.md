# Definition of Proof — Staff Admin grading inspection viewport

| Dimension | Status |
|---|---|
| Design | final and owner-authorised |
| Implementation | complete in the approved local presentation scope |
| Verification | Local Automated — browser/hostile gates open |
| Activation | not deployed; production remains `01d5e4da` |

Local evidence: exact production build; TypeScript; lint with 0 errors;
30 affected/protected files and 778 assertions green; pure repeated CSS-viewport
sequence proof; mounted normalized pin/line/centering-plane proof; shared-role
architecture proof; unchanged Card Tool/crop/MVGS contracts. A prior broad run
on the near-final revision passed 429 files / 6,860 tests / 6 skips. The two
release-gate browser defects found after the first freeze now have direct
mounted/source regressions and narrow presentation-only repairs.

The supported in-app browser supplied real rendered geometry and normalized
feature-anchoring proof and was used to discover the two rejected-candidate
defects. It cannot change browser page zoom, so no Chrome 80–150% matrix is
claimed. Chrome control still fails because the required ChatGPT Chrome
Extension is not installed/enabled. Exact replacement-SHA hostile review is
also pending. Therefore this candidate has not reached Browser/Staging proof.
