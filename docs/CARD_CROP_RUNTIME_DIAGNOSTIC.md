# Card-crop runtime diagnostic (no deploy required)

Every value needed to close the crop report is **already exposed by the LIVE production
bundle** (`36699531`). Verified present in the deployed `GradingWorkstation-*.js`:
`data-inspection-zoom`, `data-inspection-focus-x`, `data-inspection-focus-y`,
`data-inspection-side`, `grading-image-viewport`, `grading-interactive-card-host`.

No instrumentation needs shipping. Nothing below mutates a certificate.

## How to run it

1. Open the affected grading card (e.g. Ash's on `/staff`) exactly as it looked when cropped.
2. Open DevTools → Console.
3. Paste this and press Enter. Send back the output.

```js
(() => {
  const vp = document.querySelector('[data-testid="grading-image-viewport"]');
  const host = document.querySelector('[data-testid="grading-interactive-card-host"]');
  const img = vp && vp.querySelector('img');
  if (!vp || !img) return 'viewport or image not found — is a card open?';
  const R = n => Math.round(n * 10) / 10;
  const v = vp.getBoundingClientRect(), i = img.getBoundingClientRect();
  const h = host ? host.getBoundingClientRect() : null;
  const cs = getComputedStyle(img);
  return {
    zoom: vp.getAttribute('data-inspection-zoom'),
    focusX: vp.getAttribute('data-inspection-focus-x'),
    focusY: vp.getAttribute('data-inspection-focus-y'),
    side: vp.getAttribute('data-inspection-side'),
    mode: vp.getAttribute('data-coordinate-mode'),
    viewport: innerWidth + 'x' + innerHeight,
    natural: img.naturalWidth + 'x' + img.naturalHeight,
    imageRendered: R(i.width) + 'x' + R(i.height),
    frame: R(v.width) + 'x' + R(v.height),
    host: h ? R(h.width) + 'x' + R(h.height) : null,
    transform: cs.transform,
    objectFit: cs.objectFit,
    edgesInsideFrame: {
      top: i.top >= v.top - 1, bottom: i.bottom <= v.bottom + 1,
      left: i.left >= v.left - 1, right: i.right <= v.right + 1
    },
    clippedPx: {
      top: R(Math.max(0, v.top - i.top)), bottom: R(Math.max(0, i.bottom - v.bottom)),
      left: R(Math.max(0, v.left - i.left)), right: R(Math.max(0, i.right - v.right))
    }
  };
})()
```

## How to read the result

**`zoom` > 1** → root cause is active inspection zoom. `transform` will be a non-identity
`matrix(...)`. Fix is reset/default semantics: a different certificate always opens at
fit/zoom 1/centred, and "Reset View" restores fit with zero pan. Same-card stage retention
stays as designed.

**`zoom` === 1 AND `transform` is `none` AND some `clippedPx` > 0** → a genuine layout
mismatch at fit, which none of three reproductions could produce. `host`, `frame`,
`imageRendered` and `natural` then identify it exactly.

**`zoom` === 1 AND all `edgesInsideFrame` true** → nothing was cropped at the moment of
capture; the screenshot showed a zoomed or transient state.

## Why this is the remaining question

Three independent reproductions — the route height chain, the `CardPreviewPanel` chain, and
the portaled ImageViewer rail path — all render the card 100% visible at every viewport
height from 900 down to 620, against a real 2018x2802 production scan. `object-fit: contain`
cannot crop by definition. The only mechanism in the code that can visually crop a complete
card is `transform: scale(zoom)` clipped by the frame's `overflow-hidden`, which requires
`zoom > 1`.
