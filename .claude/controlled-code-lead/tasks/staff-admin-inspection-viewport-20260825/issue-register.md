# Issue register — Staff Admin grading inspection viewport

| ID | Summary | Source | Severity | Confidence | File:Line | Class | Lead-verified | Proof level | Impl commit | Staging | Prod | Activation | Status | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| SIV-001 | Browser zoom crosses the `md` layout into a stacked rail capped at `55vh`, while adaptive width and height ratchets can re-fit from their own output | Production report + Lead code trace | high | confirmed | `CanonicalGradingWorkstationShell.tsx`; `WorkstationPreviewAside.tsx`; `image-viewer.tsx` | C | yes | Local automated | local candidate | blocked | unchanged | not activated | implemented / browser pending | Replaced with a 540 CSS-px responsive boundary and direct current-viewport FIT with no prior-render input or browser-zoom detection. |
| SIV-002 | The 100% authoritative card loses space to duplicated side controls, a two-row utility stack and a wrapping bottom toolbar | Production report + Lead code trace | high | confirmed | `grading-panel.tsx`; `image-viewer.tsx` | C | yes | Local automated | local candidate | blocked | unchanged | not activated | implemented / browser pending | One non-wrapping utility row and a card-only measured flex viewport give FIT the available inspection area. |
| SIV-003 | MARK DEFECTS uses a separate explicit-size/native-scroll path, caps at 600%, blocks wheel scrolling without zoom, and does not share per-side inspection state | Production report + Lead code trace | high | confirmed | `image-viewer.tsx`; `inspection-viewport-geometry.ts` | C | yes | Local automated | local candidate | blocked | unchanged | not activated | implemented / browser pending | Main and MARK share FIT-relative 50–500%, per-side focus, anchored zoom, pan and one normalized transform plane. |
| SIV-004 | Card Tool post-crop coordinate provenance can diverge from historical pins | Prior independent investigation | medium | confirmed pre-existing | `manual-card-tool.tsx`; `grading-panel.tsx` crop lifecycle | H | yes | Designed | n/a | n/a | unchanged | unchanged | deferred | Explicitly out of scope; do not change Card Tool, Manual Crop or stored annotations. |
| SIV-005 | Mandatory real-Chrome zoom/anchoring matrix cannot be executed through the approved browser channel | Chrome skill diagnostics | high release evidence | confirmed | Local Chrome profiles lack ChatGPT Chrome Extension `hehggadaopoacecdllhhajmbjkdcmajg` | G | yes | Blocked | n/a | blocked | unchanged | not activated | open external gate | Install/enable the extension, reconnect browser control and run the exact owner sequence; no unsupported fallback accepted. |

## Release-blocking acceptance

- Existing `x_percent`/`y_percent`, line endpoints and centering frames remain image-relative percentages.
- FRONT/BACK zoom/focus is independent within one card and reset for a different card.
- Browser zoom sequence `80 → 90 → 100 → 110 → 125 → 150 → 100`, including repeats, has no cliff or cumulative shrink.
- Staff Admin, Super Admin, Staff, Grader and Partner role harnesses retain the same capability boundaries.
- Card Tool, Manual Crop and protected MVGS regressions stay green.
