# Decision: deterministic label fonts, and the Japanese stroke-weight change

**Date:** 2026-07-29
**Status:** Decided — approved by the founder
**Scope:** `server/labels.ts` font registration, `public/brand/fonts/`, the Linux pixel goldens

## Context

The label is a physical product, but its glyphs were resolved by whatever fonts happened to be
installed on the host. The same certificate rendered differently per machine, and a future base-image
rebuild could silently change the typeface on a printed slab. Measured in a Linux production image:
**55 of 55** rendered labels changed when the system fonts were removed.

The fix bundles the exact faces production already resolves to and registers them under private
family names, so no host font can shadow them. After the change, **0 of 55** labels change when every
system font is deleted.

## The Japanese difference — what was actually approved

Latin output is unaffected: **46 of 55** cases, including every numeric grade front and back, Black
Label, all authentication-only kinds, long card and set names, structured variants, rarity strips,
certificate numbers and the claim insert, are **byte-identical** to the pre-change rendering.

**9 of 55** cases differ, all Japanese. Measured, not estimated:

- canvas dimensions, advance widths, QR position, NFC position and layout are **unchanged**;
- the change is a **weight change**, not merely rasterisation: at the card-name weight (600),
  Japanese glyphs previously rendered at regular weight and now render at the bold weight
  (ink `433.2k → 654.6k` for the text run; 0.63 % of label pixels; +1.29 % ink over the whole label);
- Latin is unaffected at every weight;
- no clipping, no overflow, no re-fit, no centring drift.

### Founder decision

**The deterministic Japanese font change is APPROVED**, despite the visibly heavier stroke weight,
because:

- widths are unchanged;
- positions are unchanged;
- layout is unchanged;
- no clipping occurs;
- host-font dependence is removed.

**Do not change the Japanese font again unless required by an independently reproduced defect.**

## Consequence for the pixel goldens

The back-label goldens were originally captured in a Linux container on an **arm64** developer Mac.
Fly production is **linux/amd64** — proven from the deployed image's own manifest
(`registry.fly.io/mintvault:deployment-01KYN8J3JPPTKWZ281B99X2345` →
`{"architecture":"amd64","os":"linux"}`) — and GitHub's ubuntu runners are amd64 too.

Bisected stage by stage across both architectures — blank canvas, QR buffer bytes, PNG decode, each
raster asset scaled, alpha compositing, full composite, PNG encoding — **every stage hashes
identically**. The whole back label differs by **19 pixels out of 1,121,812 (0.0017 %)** with a
**maximum channel delta of 1**: a last-bit anti-aliasing difference in the stroked MVGS mark, the only
place the label strokes vector text instead of filling glyphs. Fronts, which only fill, are
byte-identical on both architectures — which is exactly why fronts passed CI and backs did not.

The goldens were therefore regenerated **inside the real Fly production image**, and every FRONT hash
came back identical to the original table, confirming only the backs had been captured on the wrong
architecture. The golden block is now gated on `linux/x64` and CI asserts that architecture, so it can
never again compare against a non-production reference or skip silently.
