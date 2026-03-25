# MintVault UK — Asset Register
### Every image, icon, logo, and media file used in the application
### March 2026

---

# BRAND ASSETS

---

## 1. MintVault Logo (frontend)

| Property | Value |
|---|---|
| Filename | `file_000000002550720aada646b736a25622_1772023165771.png` |
| Location | `attached_assets/` (imported via `@assets/` alias) |
| Used in | Header (`layout.tsx`), Hero section (`pricing.tsx`) |
| Import syntax | `import logoPath from "@assets/file_000000002550720aada646b736a25622_1772023165771.png"` |
| Display size (header) | `h-10 w-auto` (40px height, auto width) |
| Display size (hero) | `w-64 md:w-80 h-auto` (256px mobile / 320px desktop, auto height) |
| Loading | `eager` (hero), default (header) |
| Alt text (header) | `MintVault UK - Professional Pokemon and Trading Card Grading` |
| Alt text (hero) | `MintVault UK - Professional Pokemon and Trading Card Grading Service` |
| Format | PNG, transparent background |
| Notes | Gold gradient text logo on transparent |

## 2. MintVault Logo (server-side labels)

| Property | Value |
|---|---|
| Filename | `logo.png` |
| Location | `public/brand/logo.png` |
| Referenced in | `server/labels.ts` line 55 |
| Path construction | `path.join(process.cwd(), "public", "brand", "logo.png")` |
| Used for | Back label left zone (240px draw size, centred vertically) |
| Draw size on back label | **240×240px** (constrained, aspect-preserving) |
| Blend mode | `source-over` (transparent PNG on dark background) |
| Format | PNG, transparent background |
| Notes | Must have transparent background — screen blend was removed as it incorrectly hid the graphic |

## 3. MintVault Logo (vector)

| Property | Value |
|---|---|
| Filename | `MintVault_Logo_Vector_PDF_1773933920316.pdf` |
| Location | `attached_assets/` |
| Used in | Not directly used in app — source file for print/brand work |
| Format | PDF (vector) |
| Notes | Master vector version of logo for print production |

---

# NFC ASSETS

---

## 4. NFC Tap Icon (colour)

| Property | Value |
|---|---|
| Filename | `nfc-tap-icon.png` |
| Location | `public/brand/nfc-tap-icon.png` |
| Used in | Not directly referenced in current code (white version used instead) |
| Format | PNG |
| Notes | Original colour version — kept as source file |

## 5. NFC Tap Icon (white, for labels)

| Property | Value |
|---|---|
| Filename | `nfc-tap-icon-white.png` |
| Location | `public/brand/nfc-tap-icon-white.png` |
| Referenced in | `server/labels.ts` line 57 |
| Path construction | `path.join(process.cwd(), "public", "brand", "nfc-tap-icon-white.png")` |
| Used for | Back label centre zone — NFC icon |
| Draw size on back label | **100×100px** (centred vertically, centred horizontally between logo and QR) |
| Fallback | If loading fails, draws 3-arc contactless icon via `drawContactlessIcon()` |
| Format | PNG, white on transparent |
| Notes | Pre-generated via `scripts/process-nfc-icon.js` from colour version |

## 6. NFC Logo (reference image)

| Property | Value |
|---|---|
| Filename | `nfc-near-field-communication-logo-png_seeklogo-206633_1773470554910.png` |
| Location | `attached_assets/` |
| Used in | Not used in app — reference image for NFC icon design |
| Format | PNG |

---

# HERO / MARKETING IMAGES

---

## 7. Premium Slab Close-up

| Property | Value |
|---|---|
| Filenames | `premium-slab-closeup.webp`, `premium-slab-closeup.png` |
| Location | `public/images/` |
| Used in | Homepage grading section (`pricing.tsx` → `GradingImage()`) |
| Display aspect ratio | `4/3` |
| Display container | `rounded-xl overflow-hidden shadow-lg max-w-md mx-auto border border-[#D4AF37]/20` |
| WebP source | `<source srcSet="/images/premium-slab-closeup.webp" type="image/webp">` |
| PNG fallback | `<img src="/images/premium-slab-closeup.png">` |
| Alt text | `MintVault premium grading slab close-up – professional trading card grading` |
| Loading | `lazy` |
| Fallback on error | `<PremiumSlabFallback />` component (gradient + Award icon + text) |
| Overlay text | `Sample Image` (bottom-right, 10px, 25% white opacity) |
| Caption below | `Professional grading. Tamper-evident precision slabs.` |

## 8. Reholder Upgrade (before/after)

| Property | Value |
|---|---|
| Filenames | `reholder-upgrade.webp`, `reholder-upgrade.png`, `reholder-upgrade-mobile.webp` |
| Location | `public/images/` |
| Used in | Homepage reholder section (`pricing.tsx` → `ReholderImage()`) |
| Display aspect ratio | `4/3` |
| WebP source | `<source srcSet="/images/reholder-upgrade.webp" type="image/webp">` |
| PNG fallback | `<img src="/images/reholder-upgrade.png">` |
| Alt text | `MintVault reholder upgrade – before and after slab comparison` |
| Loading | `lazy` |
| Overlay labels | Top-left: `Standard Slab` (black/75% bg) · Top-right: `MintVault Upgrade` (gold bg, black text) |
| Mobile version | `reholder-upgrade-mobile.webp` (not currently used in picture element but available) |
| Caption below | `Upgrade your slab for a stronger, cleaner, premium finish.` |

## 9. Collector Lifestyle

| Property | Value |
|---|---|
| Filenames | `collector-lifestyle.webp`, `collector-lifestyle.png`, `collector-lifestyle-mobile.webp` |
| Location | `public/images/` |
| Used in | Homepage bottom lifestyle section (`pricing.tsx` → `LifestyleImage()`) + OG image |
| Display aspect ratio | `40/21` |
| WebP source (desktop) | `<source srcSet="/images/collector-lifestyle.webp" type="image/webp">` |
| WebP source (mobile) | `<source media="(max-width: 480px)" srcSet="/images/collector-lifestyle-mobile.webp" type="image/webp">` |
| PNG fallback | `<img src="/images/collector-lifestyle.png">` |
| Alt text | `Premium graded trading card collection – MintVault UK card grading service` |
| Loading | `lazy` |
| Container | `rounded-xl overflow-hidden shadow-xl border border-[#D4AF37]/20` |
| Overlay text | `Sample Image` (bottom-right, 10px, 25% white opacity) |
| Caption below | `Trusted by collectors across the UK to protect and authenticate their most valuable cards.` |
| Also used as | Schema.org Organization logo URL, OG image URL |

---

# FALLBACK COMPONENTS (no physical file)

---

## 10. PremiumSlabFallback (React component)

| Property | Value |
|---|---|
| Used when | Any hero image fails to load (`onError`) |
| Background | `linear-gradient(160deg, #1A1400 0%, #0D0D00 45%, #000000 100%)` |
| Icon | Award (lucide-react), 28px, `#D4AF37` |
| Icon container | 56×56px circle, `bg: rgba(212,175,55,0.12)`, `border: 1px solid rgba(212,175,55,0.3)` |
| Title text | `MintVault Premium Slab` (14px, uppercase, tracked) |
| Body text | `Professional grading. Tamper-evident precision encapsulation.` (12px, gray-300) |
| Sub-labels | Centering · Corners · Edges · Surface (10px, gold/70%, bordered pills) |

---

# SERVER-GENERATED ASSETS

---

## 11. QR Codes (back label)

| Property | Value |
|---|---|
| Generated by | `qrcode` npm package (`QRCode.toBuffer()`) |
| Size | 150×150px (label) |
| Margin | 1 module |
| URL format | `https://mintvaultuk.co.uk/cert/{certId}` |
| Used in | Back label top-right corner |
| Background | White box flush to inner gold borders |

## 12. QR Codes (claim insert)

| Property | Value |
|---|---|
| Size | 200×200px |
| Margin | 1 module |
| URL | `https://mintvaultuk.com/claim` |
| Used in | Claim insert card right side |
| Background | White rounded rectangle (6px radius) |

## 13. QR Codes (certificate detail page — client-side)

| Property | Value |
|---|---|
| Generated by | `qrcode` npm package (`QRCode.toDataURL()`) in browser |
| Size | 220px width |
| Margin | 1 module |
| Error correction | M |
| Colours | Dark: `#1a1100`, Light: `#ffffff` |
| URL format | `https://mintvaultuk.com/cert/{certId}` |

## 14. Certificate Front Images (R2)

| Property | Value |
|---|---|
| Storage | Cloudflare R2 (S3-compatible) |
| Path pattern | `certificates/{certId}/front.jpg` (or .png/.webp) |
| Used in | Cert detail page, admin cert browser, featured certs carousel |
| Display aspect (featured) | `3/4` (portrait) |
| Display size (admin thumb) | Object-cover in small container |
| Alt text pattern | `{cardName} — MintVault Certificate {certId}` |

## 15. Certificate Back Images (R2)

| Property | Value |
|---|---|
| Storage | Cloudflare R2 |
| Path pattern | `certificates/{certId}/back.jpg` (or .png/.webp) |
| Used in | Cert detail page, admin cert browser |
| Display | Same sizing as front images |

## 16. Generated Label PNGs

| Property | Value |
|---|---|
| Generated by | `server/labels.ts` → `generateLabelPNG()` |
| Canvas size | 827×236px |
| Format | PNG (`canvas.toBuffer("image/png")`) |
| Used in | Admin printing preview, PDF export, A4 sheet |

## 17. Generated Label PDFs

| Property | Value |
|---|---|
| Generated by | `server/labels.ts` → `generateLabelPDF()` |
| Page size (single side) | PDF_W × PDF_H (mm-to-pt conversion) |
| Page size (both sides) | PDF_W × (PDF_H × 2) |
| Format | PDF |
| Metadata title | `MintVault Label - {certId}` |
| Metadata author | `MintVault Trading Card Grading` |

## 18. Generated Claim Insert PNGs

| Property | Value |
|---|---|
| Generated by | `server/claim-insert.ts` → `generateClaimInsertPNG()` |
| Canvas size | 1011×638px |
| DPI | 300 |
| Print size | 85.6×54mm |
| Format | PNG |

## 19. Generated Claim Insert PDFs (single)

| Property | Value |
|---|---|
| Page size | 242.3×152.9pt (credit card size in PDF points) |
| Format | PDF |

## 20. Generated Claim Insert A4 Sheet PDFs

| Property | Value |
|---|---|
| Page size | A4 (595.28×841.89pt) |
| Layout | 2 columns × 5 rows = 10 per page, no gaps, centred |
| Format | PDF |

---

# ATTACHED REFERENCE FILES

---

## 21–28. Reference/spec images in attached_assets/

| Filename | Purpose |
|---|---|
| `file_0000000024dc724392281b60ea19d65d_1772115514993.png` | UI reference image |
| `file_000000002550720aada646b736a25622_1772022844171.png` | Logo variant |
| `file_000000002550720aada646b736a25622_1772022953752.png` | Logo variant |
| `file_000000002550720aada646b736a25622_1772023077840.png` | Logo variant |
| `file_000000002550720aada646b736a25622_1772023165771.png` | **Active logo** (used in app) |
| `file_000000002550720aada646b736a25622_1772115500372.png` | Logo variant |
| `file_000000002550720aada646b736a25622_1772118997218.png` | Logo variant |
| `file_000000002550720aada646b736a25622_1772119087833.png` | Logo variant |
| `file_000000006cb872438ad1975f40634794_1772059240280.png` | Reference image |
| `image-7336249205470028657_1772226435601.jpg` | Reference photo |

---

# ASSET SUMMARY TABLE

| # | Asset | File | Location | Used in code | Format |
|---|---|---|---|---|---|
| 1 | Frontend logo | `file_...3165771.png` | `attached_assets/` | Yes — `@assets/` import | PNG |
| 2 | Server logo | `logo.png` | `public/brand/` | Yes — labels back | PNG |
| 3 | Vector logo | `MintVault_Logo_Vector_PDF.pdf` | `attached_assets/` | No — source file | PDF |
| 4 | NFC icon (colour) | `nfc-tap-icon.png` | `public/brand/` | No — source file | PNG |
| 5 | NFC icon (white) | `nfc-tap-icon-white.png` | `public/brand/` | Yes — labels back | PNG |
| 6 | NFC ref logo | `nfc-...seeklogo.png` | `attached_assets/` | No — reference | PNG |
| 7 | Slab closeup | `premium-slab-closeup.*` | `public/images/` | Yes — homepage | WEBP+PNG |
| 8 | Reholder upgrade | `reholder-upgrade.*` | `public/images/` | Yes — homepage | WEBP+PNG |
| 9 | Collector lifestyle | `collector-lifestyle.*` | `public/images/` | Yes — homepage + OG | WEBP+PNG |
| 10 | Slab fallback | (React component) | `pricing.tsx` | Yes — fallback | JSX |
| 11 | Label QR | (generated) | server memory | Yes — labels | PNG buffer |
| 12 | Claim QR | (generated) | server memory | Yes — claim inserts | PNG buffer |
| 13 | Screen QR | (generated) | browser memory | Yes — cert detail | Data URL |
| 14 | Card front | (R2 uploaded) | Cloudflare R2 | Yes — cert pages | JPG/PNG/WEBP |
| 15 | Card back | (R2 uploaded) | Cloudflare R2 | Yes — cert pages | JPG/PNG/WEBP |
| 16 | Label PNG | (generated) | server memory | Yes — admin print | PNG |
| 17 | Label PDF | (generated) | server memory | Yes — admin export | PDF |
| 18 | Claim insert PNG | (generated) | server memory | Yes — admin print | PNG |
| 19 | Claim insert PDF | (generated) | server memory | Yes — admin export | PDF |
| 20 | Claim insert A4 | (generated) | server memory | Yes — admin batch | PDF |

---

*End of asset register.*
