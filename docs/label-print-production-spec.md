# MintVault UK — Label & Print Production Spec
### Standalone production document for all physical/print outputs
### March 2026 — FINAL AND LOCKED

---

# 1. FRONT LABEL

---

## Overview

The front label is the primary display face of the MintVault slab. It shows card artwork, card metadata, grade panel, and cert ID strip.

## Canvas

| Property | Value | Status |
|---|---|---|
| Canvas width | **827 px** | LOCKED |
| Canvas height | **236 px** | LOCKED |
| Export format | PNG (`canvas.toBuffer("image/png")`) | LOCKED |
| Font stack | `Arial, Helvetica, sans-serif` (bold) | LOCKED |
| Rendering engine | Node.js `canvas` (node-canvas) | LOCKED |

## Structure (outside → in)

```
┌─────────────────────────────────────────────────────────┐
│ 3px white gap (flush to canvas edge)                    │
│  ┌─────────────────────────────────────────────────────┐│
│  │ 12px gold border stroke (centre at 9px from edge)   ││
│  │  ┌─────────────────────────────────────────────────┐││
│  │  │ INNER CONTENT ZONE (I_LEFT…I_RIGHT × I_TOP…I_BOT)│
│  │  │                                                  ││
│  │  │  ┌───────────────────────┬──────────┐           ││
│  │  │  │ LEFT 68%              │ RIGHT 32%│           ││
│  │  │  │ Art + Card Text       │ Grade    │           ││
│  │  │  │                       │ Panel    │           ││
│  │  │  ├───────────────────────┴──────────┤           ││
│  │  │  │ BOTTOM STRIP 38px               │           ││
│  │  │  │ Barcode | Logo | Cert#           │           ││
│  │  │  └─────────────────────────────────┘           ││
│  │  └─────────────────────────────────────────────────┘││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

## Border system

| Layer | Offset from canvas edge | Size | Colour |
|---|---|---|---|
| Canvas fill | 0px | Full canvas | `#000000` |
| White gap | 0px → 3px | 3px strip each side | `#FFFFFF` |
| Gold border | Centre at 9px | 12px stroke | `#C9A227` (GOLD) |
| Gold border outer edge | 3px from canvas edge | — | = white gap end |
| Gold border inner edge | 15px from canvas edge | — | = content zone start |

## Inner content zone coordinates

| Coordinate | Value | Derivation |
|---|---|---|
| I_LEFT | **15 px** | GOLD_CENTER + BORDER_STROKE/2 = 9+6 |
| I_RIGHT | **812 px** | PX_W - I_LEFT = 827-15 |
| I_TOP | **15 px** | Same as I_LEFT |
| I_BOTTOM | **221 px** | PX_H - I_LEFT = 236-15 |
| I_W | **797 px** | I_RIGHT - I_LEFT |
| I_H | **198 px** | I_BOTTOM - I_TOP |

## Left panel — artwork + card text (68% of width)

### Background
- Inner gradient (top → bottom within content zone):
  - 0%: `#1A1208`
  - 30%: `#0D0B07`
  - 70%: `#0D0B07`
  - 100%: `#1A1208`

### Card artwork
- If cert has `frontImagePath` → load from R2 URL
- Scaling: **cover fill** — `max(I_W / art.width, I_H / art.height)`
- Position: centred in content zone
- Dark overlay gradient: left-to-right fade on top of art

### MINTVAULT header text
| Property | Value |
|---|---|
| Text | `MINTVAULT` |
| Font | **44px bold Arial** |
| Top padding | 8px below I_TOP |
| Text Y position | I_TOP + 8 = **27px** |
| Text bottom | 27 + 44 = **71px** |
| Colour | Gold gradient (see below) |
| Alignment | Centre of left panel (between I_LEFT and panelX) |
| Letter spacing | +3px per character (8 gaps × 3px = 24px added) |
| Decorative lines | Gold gradient lines flanking text, 3px stroke |

### Gold text gradient (MINTVAULT header + back label text)
```
0%:   #FFF3B0
25%:  #F5D06F
55%:  #D4AF37
75%:  #B8962E
100%: #A67C00
```
Direction: top → bottom of text bounding box.

### Card metadata text zone
| Property | Value |
|---|---|
| Zone top | MV_HDR_BOT + 5px = **76px** |
| Text left margin | I_LEFT + 28px = **43px** |
| Text max width | panelX - textLeft - gutter |

### Card text hierarchy (3 lines)

| Line | Content | Font size | Weight | Min font | Colour |
|---|---|---|---|---|---|
| 1 — Card Name | `cardName` | **43px** (SZ_NM) | Bold | 28px (fit) | White |
| 2 — Year + Set | `year setName` | **29px** (SZ_YS) | Bold | — | White |
| 3 — Variant | `variant` (if present) | **29px** (SZ_VAR) | Bold | — | White |

- Line height multiplier: **1.12×** font size
- Overflow: `fitFontSize()` shrinks card name to min 28px; then `truncateText()` adds "…"
- Word wrap: `balancedWrap()` for 2-line splits, choosing visual midpoint split
- Combined height calculated dynamically; block is vertically positioned in available space

### Card number + language line
- Content: `#{cardNumber} {LANG_ABBR}`
- Font: 22px normal Arial
- Colour: White at 85% opacity

## Right panel — grade panel (32%)

| Property | Value |
|---|---|
| Panel width (PANEL_W) | **148 px** |
| Panel X start | I_RIGHT - 148 = **664 px** |
| Panel centre X | 664 + 74 = **738 px** |
| Panel top | I_TOP = 15px |
| Panel height | I_H - STRIP_H = 198 - 38 = **160 px** |
| Background | Dark gold gradient |
| Shine effect | 3px light strip at top and bottom of panel |

### Grade panel content (numeric grades)

| Row | Content | Font | Size range | Colour |
|---|---|---|---|---|
| 1 — Card number | `#{cardNumber}` | Bold Arial | Fit to width | White |
| 2 — Grade abbreviation | e.g. `GEM MT` | Bold Arial | 12–35px (fit) | White |
| 3 — Grade number | e.g. `10` | Bold Arial | 48–133px (fit) | White |

- Grade number takes maximum available vertical space
- `fitFontSize()` scales from 48px up to min(133px, maxByH) to fill panel
- Vertically centred in remaining space below abbreviation

### Grade panel content (non-numeric: AUTHENTIC / ALTERED)

| gradeType | Display text | Font size |
|---|---|---|
| `"NO"` | `AUTHENTIC` | 18–30px (fit to PANEL_W-8) |
| `"AA"` | `AUTH ALTERED` (two lines) | 22px bold + 28px bold |

## Bottom strip

| Property | Value |
|---|---|
| Strip height (STRIP_H) | **38 px** |
| Strip Y start | I_BOTTOM - 38 = **183 px** |
| Background | `#000000` (near-black) |
| Content | Barcode (left) · MintVault logo (centre) · Cert ID (right panel) |
| Cert ID font | Up to 28px bold Arial (fit to PANEL_W-14) |
| Cert ID colour | `#D4AF37` |
| Cert ID position | Grade panel centre X, vertical centre of strip |

---

# 2. BACK LABEL

---

## Canvas

Same dimensions as front label:
- **827px × 236px**
- Same border system (3px white → 12px gold → 15px inner edge)

## Three-zone layout

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  ┌──────────┬──────────────────┬───────────────────┐    │
│  │  LEFT    │    CENTRE        │    RIGHT           │    │
│  │  Logo    │  URL + NFC + Tap │    QR Code         │    │
│  │  240px   │  (centred)       │    150×150px       │    │
│  │  ~29%    │                  │    flush top-right  │    │
│  └──────────┴──────────────────┴───────────────────┘    │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### LEFT ZONE — MintVault logo

| Property | Value |
|---|---|
| Draw size | **240×240px** (aspect-preserving) |
| Position X | I_LEFT + 4 = **19px** |
| Position Y | Vertically centred in full canvas: `round((236-240)/2)` |
| Blend mode | `source-over` (transparent PNG) |
| Notes | Gold border redrawn on top after logo to prevent bleed into frame |

### CENTRE ZONE — URL + NFC icon + tap instruction

**Centre X calculation:** midpoint between logo right edge and QR left edge
`NFC_ICON_CX = round((LOGO_LX + LOGO_DRAW + gfLeft) / 2)`
where gfLeft = 657 (QR white box left edge)

#### Website URL (top)
| Property | Value |
|---|---|
| Text | `mintvaultuk.com` |
| Font | **38px bold Arial** |
| Position Y | I_TOP + 24 = **39px** |
| Colour | Gold gradient (same 5-stop as front MINTVAULT) |
| Letter spacing | 1.5px |
| Glow | `rgba(255,215,0,0.25)` blur 6px |

#### NFC Icon (middle)
| Property | Value |
|---|---|
| Size | **100×100px** |
| Position | NFC_ICON_CX centred, vertically centred in canvas (y = round(236/2) - 50) |
| Image | `public/brand/nfc-tap-icon-white.png` |
| Fallback | Draws 3-arc contactless symbol via `drawContactlessIcon()` |

#### Contactless icon fallback (drawContactlessIcon)
| Property | Value |
|---|---|
| Arc radii | 30%, 60%, 90% of `size` parameter |
| Stroke width | `max(2.5, size × 0.13)` |
| Centre dot | `max(2, size × 0.13)` radius |
| Arc angle | −60° → +60° (opening rightward) |
| Colour | White (`#FFFFFF`) |

#### Tap instruction (bottom)
| Property | Value |
|---|---|
| Text | `Tap NFC to verify` |
| Font | **34px bold Arial** |
| Position Y | I_BOTTOM - 31 = **190px** |
| Position X | NFC_ICON_CX - 12 (slight left offset) |
| Colour | Gold gradient (same 5-stop) |
| Letter spacing | 1.5px |
| Glow | `rgba(255,215,0,0.25)` blur 6px |

### RIGHT ZONE — QR code

| Property | Value |
|---|---|
| QR size | **150×150px** |
| QR quiet zone pad | **5px** (left and bottom only) |
| QR top (qrY) | I_TOP = **15px** (flush to inner border) |
| QR right edge | I_RIGHT = **812px** (flush to inner border) |
| QR left (qrX) | I_RIGHT - 150 = **662px** |
| White box left (wbLeft) | 662 - 5 = **657px** |
| White box top (wbTop) | I_TOP = **15px** |
| White box width (wbW) | 150 + 5 = **155px** |
| White box height (wbH) | 150 + 5 = **155px** |
| White box bottom | 15 + 155 = **170px** |
| QR URL | `https://mintvaultuk.co.uk/cert/{certId}` |
| QR library | `qrcode` npm, margin: 1 module |

#### Cert ID below QR
| Property | Value |
|---|---|
| Text | cert.certId (e.g. `MV001`) |
| Font | Up to 30px bold Arial (fit to wbW-8) |
| Min font | 14px |
| Colour | `#FFFFFF` (white) |
| Position Y | wbBottom + 14 + round(30/2) = **199px** |
| Position X | QR centre X = 662 + 75 = **737px** |
| Shadow | `rgba(0,0,0,0.35)` blur 2, offset 0,1 |

---

# 3. LABEL PDF EXPORT

---

## Single label PDF

| Property | Value |
|---|---|
| Source function | `generateLabelPDF()` in `server/labels.ts` |
| Side options | `"front"`, `"back"`, `"both"` |
| Page width | PDF_W = PX_W in pt (mm → pt conversion) |
| Page height (single) | PDF_H |
| Page height (both) | PDF_H × 2 (front stacked above back) |
| Margin | 0 |
| PDF library | `pdfkit` (PDFDocument) |
| Title metadata | `MintVault Label - {certId}` |
| Author metadata | `MintVault Trading Card Grading` |
| Image placement | `doc.image(pngBuf, 0, yOffset, { width: PDF_W, height: PDF_H })` |

## A4 Label Sheet

**Not currently implemented in labels.ts** — sheet generation exists only for claim inserts. Individual labels are generated and exported as single PDFs or PNGs.

---

# 4. CLAIM INSERT CARD

---

## Overview

Credit-card-sized ownership claim insert. Printed and included in the physical slab packaging. Contains QR code linking to claim page, formatted claim code, and instructions.

## Canvas

| Property | Value | Status |
|---|---|---|
| Physical width | **85.6 mm** | LOCKED |
| Physical height | **54 mm** | LOCKED |
| DPI | **300** | LOCKED |
| Canvas width (PX_W) | `round(85.6 × 300/25.4)` = **1011 px** | LOCKED |
| Canvas height (PX_H) | `round(54 × 300/25.4)` = **638 px** | LOCKED |
| Export format | PNG (`canvas.toBuffer("image/png")`) | LOCKED |

## Layout

```
┌─────────────────────────────────────────────────────────┐
│ 4px gold gradient border                                │
│                                                         │
│  [LOGO 65px]        ┌───────────────────┐              │
│                      │                   │              │
│  "Claim ownership"   │     QR CODE       │              │
│  XXXX-XXXX-XXXX     │     200×200px      │              │
│  "at mintvaultuk..."│                   │              │
│  XXXX-XXXX-XXXX     │                   │              │
│                      └───────────────────┘              │
│  1. Scan the QR...                                      │
│  2. Enter code...   "mintvaultuk.com/claim"            │
│  3. Confirm via...                                      │
│                                                         │
│  "This code is unique..." (footer italic)              │
└─────────────────────────────────────────────────────────┘
```

## Exact layout values

| Element | Property | Value |
|---|---|---|
| Border | Stroke width | **4px** |
| Border | Stroke centre | 2px from edge |
| Border | Colour | Gold gradient (horizontal, same 5-stop) |
| Border | Corner radius | None (strokeRect) |
| Content padding | All sides | **30px** |
| Logo | Height | **65px** (auto width, proportional) |
| Logo | Position | contentLeft (30px), contentTop (30px) |
| Cert ID label | Font | **bold 28px Arial** |
| "Claim ownership" | Font | **bold 22px Arial** |
| Formatted claim code | Font | **bold 36px Courier New monospace** |
| "at mintvaultuk..." | Font | **bold 22px Arial** |
| Code repeat | Font | **bold 34px Courier New monospace** |
| Step instructions | Font | **17px Arial** |
| Footer text | Font | **italic 14px Arial** |

## QR Code

| Property | Value |
|---|---|
| QR size | **200×200px** |
| QR padding in box | **5px** per side |
| QR box total | **210×210px** |
| QR box position X | PX_W - pad - qrBoxSize = 1011 - 30 - 210 = **771px** |
| QR box position Y | `round(PX_H/2 - qrBoxSize/2) + 10` ≈ **224px** |
| QR box corner radius | **6px** (roundRect) |
| QR box fill | White |
| QR URL | `https://mintvaultuk.com/claim` |
| Label below QR | `mintvaultuk.com/claim` — 13px Arial, centred below box |

---

# 5. CLAIM INSERT A4 BATCH SHEET

---

## Page setup

| Property | Value | Status |
|---|---|---|
| Page size | **A4** (595.28 × 841.89 pt) | LOCKED |
| Columns per page | **2** | LOCKED |
| Rows per page | **5** | LOCKED |
| Cards per page | **10** | LOCKED |
| Horizontal gap | **0 pt** (no gap) | LOCKED |
| Vertical gap | **0 pt** (no gap) | LOCKED |

## Margins (auto-centred)

| Property | Calculation | Value |
|---|---|---|
| Card width (pt) | `85.6 × (72/25.4)` | **242.3 pt** |
| Card height (pt) | `54 × (72/25.4)` | **152.9 pt** |
| Total grid width | 2 × 242.3 = **484.6 pt** | — |
| Total grid height | 5 × 152.9 = **764.5 pt** | — |
| Left margin | `(595.28 - 484.6) / 2` = **55.3 pt** | Auto |
| Top margin | `(841.89 - 764.5) / 2` = **38.7 pt** | Auto |

## Card placement

```
Position[col][row]:
  x = marginLeft + col × cardW
  y = marginTop + row × cardH
```

Each card rendered as PNG first, then placed via `doc.image(png, x, y, { width: cardW, height: cardH })`.

Multi-page: if more than 10 inserts, new A4 pages are added automatically.

---

# 6. SVG CUT PATH WORKFLOW

---

## Brother ScanNCut CM300 Integration

| Property | Value |
|---|---|
| Machine | Brother ScanNCut CM300 |
| Cut mode | **Direct cut** (no built-in scanner alignment needed) |
| CUT_STROKE | **0px** — no black cut outline on the label canvas |
| Cut guide format | Separate SVG file |
| Cut guide content | Rectangle path at exact label dimensions |

## Cut guide details

- The label PNG itself has **no black cut line** — `CUT_STROKE = 0`
- The gold border outer edge starts at 3px from the canvas edge (white gap)
- The SVG cut guide is a separate file providing the cut path to the ScanNCut
- Cut should follow the **canvas edge** (827×236px bounding box)

## Printing workflow

1. Generate label PNG via admin panel (POST `/api/admin/labels/generate`)
2. Print PNG at full resolution on label stock
3. Load SVG cut guide into ScanNCut CM300
4. Align and execute direct cut
5. Apply cut label to slab

## Print settings (recommended)

| Setting | Value |
|---|---|
| Paper type | Glossy label stock / adhesive vinyl |
| Print quality | Maximum/Photo quality |
| Colour profile | sRGB |
| Scaling | None (100%, do not fit to page) |
| Bleed | Label includes own white gap — no additional bleed needed |

---

# 7. EXPORT FORMATS SUMMARY

---

| Output | Route | Format | Dimensions |
|---|---|---|---|
| Front label PNG | POST `/api/admin/labels/generate` (side=front) | PNG | 827×236px |
| Back label PNG | POST `/api/admin/labels/generate` (side=back) | PNG | 827×236px |
| Both labels PNG | POST `/api/admin/labels/generate` (side=both) | PNG × 2 | 827×236px each |
| Label PDF (single) | POST `/api/admin/labels/generate` (format=pdf) | PDF | 1 page |
| Label PDF (both) | POST `/api/admin/labels/generate` (side=both, format=pdf) | PDF | 2 pages stacked |
| Claim insert PNG | POST `/api/admin/certificates/:certId/claim-insert` (format=png) | PNG | 1011×638px |
| Claim insert PDF | POST `/api/admin/certificates/:certId/claim-insert` (format=pdf) | PDF | Credit card size |
| Claim insert A4 sheet | POST `/api/admin/claim-insert-sheet` | PDF | A4, 10 per page |

---

# 8. WHAT IS FINAL AND LOCKED

---

## LOCKED — DO NOT CHANGE

| Item | Value | Reason |
|---|---|---|
| Back label canvas | 827×236px | Matches ScanNCut CM300 label stock |
| Front label canvas | 827×236px | Same stock, same cut guide |
| Border system | 3px white → 12px gold → 15px content | Verified on print output |
| Gold border hex | `#C9A227` | Matched to physical slab colour |
| Grade panel width | 148px | Proportional to label width |
| Bottom strip height | 38px | Barcode + cert ID layout |
| MINTVAULT font | 44px bold Arial | Brand consistency |
| Card name font | 43px bold Arial | Hierarchy locked |
| QR size (label) | 150×150px | Scan reliability verified |
| QR position | Top-right flush to inner borders | Scan zone locked |
| Claim insert | 85.6×54mm at 300 DPI | Credit card standard |
| Claim insert QR | 200×200px | Larger QR for consumer scanning |
| A4 sheet | 2×5, no gaps, centred | Maximises cards per sheet |
| Gold gradient | 5-stop (#FFF3B0→A67C00) | Brand identity locked |
| CUT_STROKE | 0 (no cut outline on label) | Uses separate SVG cut guide |
| NFC icon size | 100×100px | Visual balance on back label |
| Logo draw size (back) | 240×240px | ~29% of label width |

## UNLOCKED — Can be adjusted

| Item | Current value | Notes |
|---|---|---|
| Year/Set font size | 29px | Can adjust for readability |
| Variant font size | 29px | Can adjust for readability |
| Card name min font | 28px | Minimum before truncation |
| QR URL domain | mintvaultuk.co.uk | May change if domain consolidates |
| Claim insert text sizes | 13–36px range | Cosmetic adjustments OK |
| NFC icon fallback arcs | 3 arcs, 30/60/90% | Cosmetic |

---

# 9. COLOUR REFERENCE (PRINT)

---

All print colours are specified in sRGB hex for digital printing. No Pantone or CMYK conversions are currently defined.

| Colour name | Hex | Usage |
|---|---|---|
| Black (canvas fill) | `#000000` | Background |
| White (gaps, QR bg) | `#FFFFFF` | Structure |
| Gold (border) | `#C9A227` | Outer border |
| Gold light (border redraw) | (GOLD_LIGHT const) | Border redrawn after logo |
| Gradient stop 1 | `#FFF3B0` | Lightest gold |
| Gradient stop 2 | `#F5D06F` | Warm gold |
| Gradient stop 3 | `#D4AF37` | Primary gold |
| Gradient stop 4 | `#B8962E` | Deep gold |
| Gradient stop 5 | `#A67C00` | Darkest gold |
| Inner BG gradient top | `#1A1208` | Warm dark |
| Inner BG gradient mid | `#0D0B07` | Near-black |
| QR glow (back label) | `rgba(255,215,0,0.25)` | Text glow |
| Cert ID shadow | `rgba(0,0,0,0.35)` blur 2 | Subtle drop |

---

*MintVault UK — Print Production Spec*
*This document covers all physical print outputs generated by the MintVault system.*
*Update version and date when making structural changes to label layout.*
