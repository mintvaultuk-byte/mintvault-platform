# Project Control — real browser responsive proof

**Produced:** 2026-08-02 · **HEAD:** `5fefee78` (+ fixture `.admin-root` fix)
**Tool:** Google Chrome 151.0.7922.71 (already installed on the build machine) driven over the
DevTools Protocol by `scripts/project-control/responsive-proof.mjs`, using the `ws` package that
was already a dependency. **No new npm dependency was added.**

## Why this exists

The previous responsive proof asserted, in happy-dom:

```js
expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
```

happy-dom has no layout engine. `scrollWidth` is a field initialised to `0` and never written by
layout, and `getBoundingClientRect()` returns a bare `DOMRect`. The assertion therefore read
`0 <= 390` and passed for **any** content at **any** viewport — a 99,999px element passed it.
Compounding that, vitest runs with `css: false`, so the media queries under test were never parsed.

That test could not fail, which means it was not a test. These are real measurements instead.

## The 500px trap

Chrome on macOS refuses to size a window below ~500px. `--window-size=390,844` yields a **500px
layout viewport** while still writing a 390×844 PNG — a screenshot that looks like mobile proof
while the layout behind it was computed at 500px. Every viewport here goes through
`Emulation.setDeviceMetricsOverride` instead, and every row asserts the width it actually got
(`innerWidth`) rather than the width it asked for.

A second trap the harness caught during development: a page without
`<meta name="viewport" content="width=device-width">` gets a 980px default layout viewport under
mobile emulation regardless of the override. Both real HTML entries carry the tag; the harness
fails loudly if `innerWidth !== requestedWidth` so this can never pass silently.

## Results — all viewports clean

Measured against the real `ProjectControlDashboard` and its five sub-components, served by Vite
with the real stylesheets applied.

| Viewport | innerWidth | docScrollWidth | bodyScrollWidth | dpr | horizontally scrollable | offenders | positive control fired |
|---|---|---|---|---|---|---|---|
| 1440×900  | **1440** | 1440 | 1440 | 1 | no | 0 | yes |
| 1280×800  | **1280** | 1280 | 1280 | 1 | no | 0 | yes |
| 1024×768  | **1024** | 1024 | 1024 | 1 | no | 0 | yes |
| 768×1024  | **768**  | 768  | 768  | 1 | no | 0 | yes |
| 390×844   | **390**  | 390  | 390  | 2 | no | 0 | yes |

`docScrollWidth == innerWidth` at every viewport, and `scrollWidth > clientWidth` is false
everywhere — there is no horizontal overflow on the document at any tested width.

## Why these numbers can be trusted

1. **Positive control, every run.** A 5000px-wide element is injected, the probe is re-run, and the
   run **fails** unless the probe notices it. A viewport is reported clean only if the canary fired
   *and* nothing overflowed. This is the check the happy-dom version lacked.
2. **Negative control, verified by hand.** Pointed at a page containing a deliberate 1400px div,
   the harness fails 4 of 5 viewports and names the element:
   `overflow: div.deliberate-overflow left=0 right=1400 w=1400`.
3. **Offenders are named, not counted.** A failure prints the selector, left/right edges and width,
   so it is actionable rather than a bare number.
4. **Screen-reader-only text is excluded by signature** (clipped and ≤2px), not by class name — the
   canonical `.sr-only` recipe parks a 1px box at a negative offset and is not visual overflow.
   Detected as a false positive during development and fixed; without this every accessible page
   would fail.

## Captures

Full-page PNGs, clipped to the emulated width so the artefact and the measurement describe the same
layout. These are **true PNGs** — the 18 files in `../final/` are all JPEG data with a `.png`
extension, which is why they are not a reliable pixel-diff baseline.

| File | Pixels |
|---|---|
| `1440x900-project-control.png` | 1440 × 2158 |
| `1280x800-project-control.png` | 1280 × 2179 |
| `1024x768-project-control.png` | 1024 × 2425 |
| `768x1024-project-control.png` | 768 × 2854 |
| `390x844-project-control.png` | 780 × 8628 (390 CSS px at dpr 2, full page) |

The 390px capture is full-page. The previous `390x844-dashboard-mobile.png` was cropped at the
viewport and ended part-way through the pilot-readiness card, so it showed none of the launch-gate
list whose mobile layout it was cited as evidence for. This one shows all ten gates.

## Honest limits

- **These render the visual fixture, not the routed page.** The fixture now carries `.admin-root`
  (added in this pass — without it `color: var(--admin-ink)` never applied and the text rendered
  dark-on-dark, which is what made the older captures look broken). It still does **not** mount
  `AdminShell`'s sidebar/header or `DriftDisclosure`. Layout geometry and typography are now
  production-accurate; page chrome is not.
- **This is a build-machine harness, not a CI gate.** It depends on Chrome being installed at a
  macOS path. Making it a CI check needs a headless browser in the CI image — an owner decision.
- The measurement is conservative in one respect: `.admin-root` sets a 14px base, so a clean result
  is if anything a stronger result than production would need.

## Re-running

```
npx vite --port 5399 --strictPort
node scripts/project-control/responsive-proof.mjs \
  "http://127.0.0.1:5399/project-control-visual-fixture.html?state=current" \
  docs/project-control/visual-acceptance/browser-proof
```

Exit code 0 = every viewport clean. Non-zero = a real overflow, with selectors.
