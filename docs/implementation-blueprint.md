# MintVault UK — Full Implementation Blueprint
### Version 2.0 | March 2026 | Exact Build Spec — Implementation Level

> This document contains the exact pixel values, field names, colour codes, pricing, canvas dimensions, and system logic as implemented in the live codebase. It can be handed to a developer or AI and rebuilt accurately.

---

# 1. FULL ROUTE MAP

## Public Frontend Routes

| Route | Component | Notes |
|---|---|---|
| `/` | `PricingPage` | Homepage + pricing tiers |
| `/submit` | `SubmitPage` | Multi-step submission wizard |
| `/submit/success` | `SubmitSuccessPage` | Post-payment confirmation |
| `/track` | `TrackPage` | Submission status lookup |
| `/cert` | `CertLookupPage` | Certificate search page |
| `/cert/:id` | `CertDetailPage` | Individual certificate detail |
| `/population` | `PopulationPage` | Grade population report |
| `/reports` | `ReportsPage` | Grade analytics |
| `/claim` | `ClaimPage` | Ownership claim flow |
| `/why-mintvault` | `WhyMintVaultPage` | Brand trust page |
| `/tcg` | `TcgPage` | Multi-game overview |
| `/guides` | `GuidesPage` | Article index |
| `/guides/:slug` | `GuideDetailPage` | Individual article |
| `/terms-and-conditions` | `TermsPage` | Legal terms |
| `/liability-and-insurance` | `LiabilityPage` | Insurance policy |
| `/nfc/:certId` | `NfcRedirectPage` | NFC tap → cert redirect |
| `*` (catch-all) | `NotFound` | 404 page |

## SEO Landing Pages (live)

| Route | Component |
|---|---|
| `/pokemon-card-grading-uk` | `PokemonCardGradingUkPage` |
| `/trading-card-grading-uk` | `TradingCardGradingUkPage` |
| `/card-grading-service-uk` | `CardGradingServiceUkPage` |
| `/psa-alternative-uk` | `PsaAlternativeUkPage` |
| `/how-to-grade-pokemon-cards` | `HowToGradePokemonCardsPage` |
| `/tcg-grading-uk` | `TcgGradingUkPage` |

## Admin Routes

| Route | Notes |
|---|---|
| `/admin` | Login → dashboard (tabbed SPA, no sub-routes) |

Admin tabs (client-side, not URL-based): **Dashboard | Certs | Submissions | Labels | Settings**

## API Routes — Public

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/version` | Build version info |
| GET | `/api/cert/:id` | Fetch single certificate (public) |
| GET | `/api/featured-certificates` | Featured certs for homepage |
| GET | `/api/cert/:id/population` | Grade distribution for a card |
| GET | `/api/certs/search` | Search certs by query |
| GET | `/api/service-tiers` | Pricing tiers (query: `?serviceType=`) |
| GET | `/api/cards/autofill` | Card name autocomplete |
| GET | `/api/cards/sets` | Card set list |
| POST | `/api/create-payment-intent` | Stripe payment intent |
| POST | `/api/confirm-payment` | Post-payment confirmation |
| GET | `/api/submissions/:submissionId` | Track submission (public) |
| POST | `/api/submissions/:submissionId/track` | Update tracking (public-facing) |
| GET | `/api/submissions/:submissionId/packing-slip` | PDF packing slip |
| GET | `/api/nfc/:certId` | NFC tag lookup |
| POST | `/api/claim/request` | Request ownership claim verification email |
| GET | `/api/claim/verify` | Complete ownership claim via token |
| GET | `/sitemap.xml` | XML sitemap |
| GET | `/robots.txt` | Robots file |

## API Routes — Admin (all require session auth)

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/admin/login` | Step 1: password auth |
| POST | `/api/admin/pin` | Step 2: PIN auth |
| GET | `/api/admin/session` | Session check |
| DELETE | `/api/admin/session` | Logout |
| GET | `/api/admin/stats` | Dashboard statistics |
| GET | `/api/admin/certificates` | List certs (filterable) |
| GET | `/api/admin/certificates/export-csv` | All certs CSV (includes Ownership column) |
| GET | `/api/admin/ownership-export` | Ownership-specific CSV |
| POST | `/api/admin/certificates` | Create certificate |
| GET | `/api/admin/certificates/:id` | Get single cert (admin) |
| PATCH | `/api/admin/certificates/:id` | Update certificate |
| POST | `/api/admin/certificates/:id/void` | Void certificate |
| GET | `/api/admin/certificates/:certId/ownership` | Get ownership + history |
| POST | `/api/admin/certificates/:certId/generate-claim-code` | Generate claim code |
| POST | `/api/admin/certificates/:certId/assign-owner` | Manual assign |
| POST | `/api/admin/certificates/:certId/revoke-owner` | Revoke ownership |
| GET | `/api/admin/certificates/:certId/ownership-history` | Full history |
| POST | `/api/admin/certificates/:certId/claim-insert` | Generate claim insert PDF/PNG |
| POST | `/api/admin/claim-insert-sheet` | Batch claim insert A4 sheet |
| POST | `/api/admin/backfill-claim-codes` | Generate codes for all uncoded certs |
| GET | `/api/admin/submissions` | List submissions |
| GET | `/api/admin/submissions/:id` | Single submission |
| POST | `/api/admin/submissions/:id/status` | Update submission status |
| PATCH | `/api/admin/submissions/:id/items/:itemId` | Update submission item |
| GET | `/api/admin/service-tiers` | Admin tier list |
| PUT | `/api/admin/service-tiers/:id` | Update tier pricing |
| POST | `/api/admin/labels/generate` | Generate label PNG/PDF |
| POST | `/api/admin/labels/sheet` | Generate label sheet |
| GET | `/api/admin/db-info` | Database info |

---

# 2. PAGE-BY-PAGE WIREFRAME

---

## `/` — Homepage / Pricing (`PricingPage`)

### Section order (desktop, top → bottom):

**1. Nav bar** (fixed, z-50)
- Height: ~64px
- Background: `rgba(0,0,0,0.85)` + `backdrop-filter: blur(12px)`
- Border bottom: `1px solid rgba(212,175,55,0.15)`
- Logo: left — "MintVault" in gold gradient, "UK" superscript
- Nav links (centre/right): Why MintVault · Guides · Verify · Track
- CTA button (rightmost): "Submit Your Cards" — gold outlined pill

**2. Hero section**
- Full width, dark background
- H1: `MintVault UK offers professional trading card grading for Pokémon, Yu-Gi-Oh!, Magic: The Gathering and all major TCGs.`
- Sub-text: `Based in the United Kingdom, we provide fast turnaround, tamper-evident precision slabs, and fully insured return shipping.`
- Featured image: `/images/premium-slab-closeup.webp` (fallback `.png`)
- Alt: `MintVault premium grading slab close-up – professional trading card grading`

**3. How It Works — 3 steps**
- Step 01: "Submit your cards online" — Choose tier, enter card details, pay securely online
- Step 02: "Package and send your cards" (implied)
- Step 03: "Receive your graded slab"
- Icons: lucide-react Package icon for step 01

**4. Trust strip**
- Items: Fast turnaround times (2–60 working days), UK-based, insured shipping
- `Clock` icon for turnaround line

**5. TCG game list**
- Heading: `MintVault UK grades cards from all major trading card games. Our grading standards are consistent across all supported TCGs:`
- Lists: Pokémon, Yu-Gi-Oh!, Magic: The Gathering, sports cards (implied)

**6. Service type selector + pricing tiers**
- Tab selector for service type (grading / reholder / crossover / authentication)
- Fetched from: `GET /api/service-tiers?serviceType={type}`
- Tiers rendered as cards:
  - `standard`: badge "Most Popular" (popular: true), availability "Good Availability" (emerald text)
  - `express`: badge "Priority Service", availability "Limited Availability" (amber text)
  - `premium`: badge "Fastest Service", availability "Limited Availability" (amber text)

**Tier card layout (per card):**
```
Tier name (uppercase, tracked)  [Badge text]
[Availability text]
Price per card (large, white bold)
Turnaround (semibold white)
Feature list (checkmarks, D4AF37/90 text, 14px)
[Submit CTA button] → /submit?type={activeService}&tier={tier.id}
```

**Live pricing tiers (from database — grading service):**

| Tier ID | Name | Price | Turnaround | Max Declared Value |
|---|---|---|---|---|
| basic | Basic | £12/card | 60 working days | £500 |
| standard | Standard | £15/card | 20 working days | £500 |
| premier | Premier | £18/card | 10 working days | £1,500 |
| ultra | Ultra | £25/card | 5 working days | £3,000 |
| elite | Elite | £50/card | 2 working days | £7,500 |

**Static fallback tiers (hardcoded in client):**
- Premier: £18/card, 10 working days, features: professional grading, fast-track queue, grader notes, tamper-evident slab, tracking, insured return
- Ultra: £25/card, 5 working days, adds: priority handling, hi-res imaging
- Elite: £50/card, 2 working days, adds: senior + secondary review, population inclusion

**7. Grade scale explainer**
- Slab upgrade section note: `Upgrade your slab for a stronger, cleaner, premium finish.`

**8. FAQ section** (accordion)
- Q: Turnaround times → A includes all 5 tiers with exact days
- Q: Pricing → A mentions from £12, bulk discounts up to 10%
- Q: Why UK-based? → links to `/psa-alternative-uk`

**9. Footer**

### Mobile behaviour:
- Nav: hamburger menu, full-screen overlay
- Pricing cards: single column, swipeable or stacked
- Hero: image below text
- Trust strip: stacked vertically

---

## `/submit` — Submission Wizard (`SubmitPage`)

### Wizard steps (stored in localStorage as `mv-wizard-v2`):

**Step 1: Service type + tier selection**
- Query params pre-fill: `?type={serviceType}&tier={tierId}`
- Tab select: Grading / Reholdering / Crossover / Authentication
- Heading: `Select your {typeName} speed and coverage tier`
- Pricing cards (same as homepage, clickable to select)
- Default tier: `standard`

**Step 2: Card count + declared value**
- Heading: `Enter the number of cards and total declared value`
- Input: Number of cards (integer, ≥1)
- Input: Total declared value (£, optional)
- Input: data-testid `input-declared-value`
- When declaredValue > 0, shows insurance tier info:
  ```
  Insured shipping: {insurance.label} — £{shipping price}
  Insurance protection: {surcharge.label} (£{per card avg}/card avg)
  ```
- Insurance tiers (triggered by total declared value):
  | Max Value | Shipping | Label |
  |---|---|---|
  | £500 | £4.99 | Up to £500 cover |
  | £1,500 | £9.99 | Up to £1,500 cover |
  | £3,000 | £14.99 | Up to £3,000 cover |
  | £7,500 | £24.99 | Up to £7,500 cover |

- Insurance surcharge per card (based on per-card declared value):
  | Per-card max | Surcharge | Label |
  |---|---|---|
  | £500 | £0 | No surcharge |
  | £1,500 | £2.00/card | +£2 per card |
  | £3,000 | £5.00/card | +£5 per card |
  | £7,500 | £10.00/card | +£10 per card |

**Step 3: Card details (optional per-card detail entry)**
- Per-card form: Game, Set, Card Name, Card Number, Year, Declared Value, Notes
- Mismatch warning (amber banner) if sum of per-card declared values ≠ total declared value
- data-testid: `text-declared-value-mismatch`

**Step 4: Customer details**
- First name, Last name, Email, Phone
- Return address: Line 1, Line 2, City, County, Postcode

**Step 5: Review + T&C**
- Order summary table
- Terms checkbox (required): must check before payment
- Submission notes textarea

**Step 6: Payment (Stripe Elements)**
- POST `/api/create-payment-intent` → Stripe
- Card input, submit button
- On success → POST `/api/confirm-payment` → redirect `/submit/success`

### localStorage key: `mv-wizard-v2`
State shape:
```typescript
{
  serviceType: string;       // "grading" | "reholder" | "crossover" | "authentication"
  tier: string;              // tier ID e.g. "standard"
  quantity: number;
  declaredValue: number;     // total in £, integer
  notes: string;
  submissionName: string;
  customerEmail: string;
  customerFirstName: string;
  customerLastName: string;
  phone: string;
  returnAddressLine1: string;
  returnAddressLine2: string;
  returnCity: string;
  returnCounty: string;
  returnPostcode: string;
  cardItems: CardItem[];     // per-card detail array
  termsAccepted: boolean;
  showCardDetails: boolean;
}
```

---

## `/cert/:id` — Certificate Detail (`CertDetailPage`)

### Sections (top → bottom):

**1. Cert header bar**
- Cert ID (monospace gold)
- Status badge: Active (emerald) / Voided (red)
- Grade type badge if non-numeric

**2. Card images**
- Front image left, back image right
- Image aspect: ~3:4 (portrait card proportions)
- Border: `1px solid rgba(212,175,55,0.20)`
- Fallback: placeholder with Image icon

**3. Grade display**
- Grade number: Very large (48–72px) white bold
- Grade label: e.g. "GEM MT", "MINT", "VG-EX"
- Sub-scores: Centering / Corners / Edges / Surface (if numeric)

**4. Card metadata table**
- Game, Set, Collection/Subset, Card Name, Card Number, Rarity, Designations, Variant, Language, Year

**5. Authentication strip**
- "Verified by MintVault" with checkmark
- Issued date

**6. QR code panel**
- 150×150px QR (links to this URL)
- "Scan to verify" label

**7. NFC panel** (if nfcEnabled=true)
- NFC icon with pulse animation
- Chip type, UID (partial), last scan

**8. Ownership panel**
- If unclaimed: CTA → `/claim`
- If claimed: "Owned · Verified" gold badge (no personal info publicly)

**9. Population data**
- Grade distribution for this specific card
- Source: `GET /api/cert/:id/population`

---

## `/claim` — Claim Ownership (`ClaimPage`)

### Sections:
**1. Explanation block**
- Heading about what ownership means
- Brief 3-step instructions

**2. Claim form**
- Input: Certificate ID (certId) — data-testid relevant
- Input: Claim code (XXXX-XXXX-XXXX format)
- Input: Email address
- Submit button → POST `/api/claim/request`
  - Body: `{ certId, claimCode, email }`

**3. Success state**
- Message: `"Verification email sent. Please check your inbox to complete the claim."`

**4. Error states**
- Invalid code: `"Invalid certificate number or claim code."`
- Already claimed: `"Invalid certificate number or claim code."` (same message — security)
- Missing fields: `"Certificate number, claim code, and email are required."`

**Verification flow:**
- Email sent via Resend contains link: `{domain}/api/claim/verify?token={token}`
- Token valid for 24 hours (stored as SHA-256 hash)
- On GET to `/api/claim/verify?token=...` → claim completed, cert ownershipStatus → "claimed"

---

## `/track` — Track Submission

**Form:** Submission ID input → lookup `GET /api/submissions/:submissionId`

**Status stages:** draft → received → grading → dispatched → complete

**Result display:** Submission ID, status, card count, per-item list, timestamps (receivedAt, shippedAt, completedAt)

---

## `/population` — Population Report

**Filters:** Game (dropdown), Card name search, Grade type
**Content:** Total certs count, grade distribution histogram per card, top graded cards list
**Source:** Database aggregation of certificates table

---

# 3. EXACT DESIGN TOKENS

## Colours

### Brand Gold

| Token | Hex | Usage |
|---|---|---|
| Gold Primary | `#D4AF37` | Main brand gold — borders, icons, cert IDs |
| Gold Bright | `#FFD700` | High-emphasis accents, NFC badge |
| Gold Light | `#FFF3B0` | Gradient highlight start, shimmer |
| Gold Warm | `#F5D06F` | Gradient 25% stop |
| Gold Mid | `#D4AF37` | Gradient 55% stop |
| Gold Deep | `#B8962E` | Gradient 75% stop, hover states |
| Gold Dark | `#A67C00` | Gradient end, deep shadow gold |
| Gold Border | `#C9A227` | Label outer border (from labels.ts) |

### Gold Gradient (labels + brand mark)

```css
linear-gradient(to bottom,
  #FFF3B0 0%,
  #F5D06F 25%,
  #D4AF37 55%,
  #B8962E 75%,
  #A67C00 100%
)
```

### Background Scale

| Token | Hex | HSL | Usage |
|---|---|---|---|
| Page background | `#000000` | `0 0% 0%` | Body/page |
| Card surface | `#0F0F0F` | `0 0% 6%` | Cards, panels |
| Sidebar | `#0A0A0A` | `0 0% 4%` | Admin sidebar |
| Elevated card | `#111111` | ~`0 0% 7%` | Nested card blocks |
| Popover | `#0F0F0F` | `0 0% 6%` | Dropdowns, popovers |

### Text

| Token | Hex | HSL | Usage |
|---|---|---|---|
| Text primary | `#EBEBEB` | `0 0% 92%` | All body text |
| Text muted | `#C4A96E` | `43 20% 68%` | Metadata, labels, secondary |
| Text dimmed | `#555555` | — | Placeholders, disabled |
| Text gold | `#D4AF37` | — | Cert IDs, section labels |
| Text white | `#FFFFFF` | — | Hero headlines |

### Border

| Token | Value | Usage |
|---|---|---|
| Border default | `rgba(212,175,55,0.15)` | All card/panel borders |
| Border muted | `rgba(212,175,55,0.08)` | Subtle separators |
| Border hover | `rgba(212,175,55,0.40)` | On hover |
| Border active | `rgba(212,175,55,0.70)` | Active/focus |
| Border strong | `#D4AF37` | Highlighted panels |
| CSS custom prop | `--border: 43 50% 20%` | shadcn default |

### CSS Custom Properties (index.css — full)

```css
--background: 0 0% 0%;
--foreground: 0 0% 92%;
--card: 0 0% 6%;
--card-foreground: 0 0% 92%;
--card-border: 43 50% 18%;
--sidebar: 0 0% 4%;
--sidebar-foreground: 0 0% 92%;
--sidebar-border: 43 50% 15%;
--sidebar-primary: 50 100% 50%;
--sidebar-primary-foreground: 0 0% 0%;
--sidebar-accent: 43 50% 12%;
--sidebar-accent-foreground: 0 0% 92%;
--sidebar-ring: 50 100% 50%;
--popover: 0 0% 6%;
--popover-foreground: 0 0% 92%;
--popover-border: 43 50% 18%;
--primary: 50 100% 50%;
--primary-foreground: 0 0% 0%;
--secondary: 0 0% 10%;
--secondary-foreground: 0 0% 92%;
--muted: 0 0% 10%;
--muted-foreground: 43 20% 68%;
--accent: 43 50% 12%;
--accent-foreground: 0 0% 92%;
--destructive: 0 72% 51%;
--destructive-foreground: 0 0% 100%;
--input: 43 50% 20%;
--ring: 50 100% 50%;
--border: 43 50% 20%;
--radius: 0.5rem;
--font-sans: 'Inter', sans-serif;
--font-mono: Menlo, monospace;
--font-serif: Georgia, serif;
```

### Status / Alert

| Status | Text Hex | Background | Border |
|---|---|---|---|
| Active / Valid | `#10B981` | `rgba(16,185,129,0.15)` | `rgba(16,185,129,0.30)` |
| Voided / Error | `#EF4444` | `rgba(239,68,68,0.15)` | `rgba(239,68,68,0.30)` |
| Pending / Amber | `#F59E0B` | `rgba(245,158,11,0.15)` | `rgba(245,158,11,0.30)` |
| Claimed (Gold) | `#D4AF37` | `rgba(212,175,55,0.20)` | `rgba(212,175,55,0.40)` |
| Unclaimed | `#555555` | `#111111` | `#222222` |
| Warning (orange) | `#F97316` | `rgba(249,115,22,0.15)` | — |

### Hover / Interactive

| Element | Default border | Hover border | Hover bg | Transition |
|---|---|---|---|---|
| Card | `rgba(212,175,55,0.15)` | `rgba(212,175,55,0.35)` | — | `200ms` |
| Button secondary | `rgba(212,175,55,0.30)` | `#D4AF37` | `rgba(212,175,55,0.10)` | `150ms` |
| Filter button active | `rgba(212,175,55,0.40)` | — | `rgba(212,175,55,0.20)` | — |
| Input focus | `rgba(212,175,55,0.25)` | `#D4AF37` | — | `200ms` |

### Glow Values

| Level | Value |
|---|---|
| Weak | `0 0 8px rgba(212,175,55,0.25)` |
| Medium | `0 0 16px rgba(212,175,55,0.40)` |
| Strong | `0 0 24px rgba(212,175,55,0.60)` |
| Pulse | `0 0 32px rgba(255,215,0,0.50)` |
| Gold CTA | `box-shadow: 0 0 0 1px rgba(212,175,55,0.50), 0 0 16px rgba(212,175,55,0.30)` |

### Shadow Values

All shadows in the CSS custom properties are set to 0 opacity (transparent) — elevation is handled via border + glow rather than traditional box-shadow.

---

# 4. EXACT TYPOGRAPHY SCALE

## Font Families

| Role | Value |
|---|---|
| Body / UI | `'Inter', system-ui, sans-serif` |
| Monospace | `Menlo, 'Courier New', monospace` |
| Serif (decorative) | `Georgia, serif` |
| Canvas/labels | `Arial, Helvetica, sans-serif` (server-side node-canvas) |

## Scale

| Element | px | rem | Weight | Tracking | Line height | Transform |
|---|---|---|---|---|---|---|
| Hero H1 (display) | 48–64px | 3–4rem | 800 | `0.05em` | 1.1 | Sentence |
| Page H1 | 32–40px | 2–2.5rem | 700 | `0.08em` | 1.2 | Uppercase |
| Section H2 | 24–28px | 1.5–1.75rem | 700 | `0.06em` | 1.3 | Uppercase |
| Card H3 | 18–20px | 1.125–1.25rem | 600 | normal | 1.4 | Title case |
| Body large | 16px | 1rem | 400 | normal | 1.6 | — |
| Body base | 14px | 0.875rem | 400 | normal | 1.5 | — |
| Body small | 13px | 0.8125rem | 400 | normal | 1.4 | — |
| Button text | 13–14px | 0.8125rem | 600–700 | `0.06em` | 1 | Uppercase |
| Badge / label | 10–12px | 0.625–0.75rem | 600–700 | `0.10em` | 1 | Uppercase |
| Cert ID (mono) | 12–14px | 0.75rem | 700 | `0.05em` | 1 | Uppercase |
| Caption / meta | 11px | 0.6875rem | 400 | normal | 1.3 | — |
| Table header | 11px | — | 600 | `0.10em` | — | Uppercase |
| Admin sidebar | 12px | — | 600 | `0.08em` | — | Uppercase |

## Key Rules

- Cert IDs always: `font-family: Menlo, monospace` + `color: #D4AF37` + `font-weight: 700`
- Section labels always: `text-transform: uppercase` + `letter-spacing: 0.08–0.10em` + `font-size: 11–12px`
- Grade numbers: `font-size: 48–72px` + `font-weight: 800` + `color: #FFFFFF`
- Grade abbreviations (GEM MT etc): `font-size: 14–16px` + `font-weight: 700` + `color: #D4AF37`

## Grade Labels (numeric 1–10)

| Grade | Abbreviation | Full Name |
|---|---|---|
| 10 | GEM MT | Gem Mint |
| 9 | MINT | Mint |
| 8 | NM-MT | Near Mint-Mint |
| 7 | NM | Near Mint |
| 6 | EX-MT | Excellent-Mint |
| 5 | EX | Excellent |
| 4 | VG-EX | Very Good-Excellent |
| 3 | VG | Very Good |
| 2 | GOOD | Good |
| 1 | POOR | Poor |

Half grades (e.g. 9.5) use the same abbreviation as the full grade below (e.g. 9.5 → MINT). gradeType `"NO"` = "AUTHENTIC". gradeType `"AA"` = "ALTERED AUTHENTIC" / "AUTHENTIC ALTERED".

---

# 5. EXACT SPACING SYSTEM

## Page Layout

| Property | Value |
|---|---|
| Page max width (certs/admin) | `max-w-5xl` = 1024px |
| Page max width (marketing) | `max-w-7xl` = 1280px |
| Page horizontal padding | `px-4` = 16px (mobile), `px-6` = 24px (sm+) |
| Page vertical padding | `py-6` = 24px (admin), `py-10`+ (marketing) |
| Section gap (major) | `mb-8` = 32px or `gap-8` = 32px |
| Section gap (minor) | `mb-4` = 16px or `gap-4` = 16px |

## Cards

| Property | Value |
|---|---|
| Card padding | `p-4` = 16px (list cards), `p-5` = 20px (detail cards) |
| Card border radius | `rounded-lg` = 8px |
| Card gap in grid | `gap-4` = 16px (mobile), `gap-6` = 24px (desktop) |
| Card inner gap | `gap-3` = 12px |

## Buttons

| Property | Value |
|---|---|
| Button height (standard) | 36–40px (auto from padding) |
| Button horizontal padding | `px-4` = 16px (standard), `px-3` = 12px (small) |
| Button vertical padding | `py-2` = 8px (standard) |
| Button border radius | `rounded` = 4px or `rounded-lg` = 8px |
| Button icon size | 14–16px |
| Button gap (icon+text) | `gap-2` = 8px |
| Action icon buttons | 28×28px touch target |

## Inputs

| Property | Value |
|---|---|
| Input height | ~40px (`py-2 px-3`) |
| Input padding | `px-3 py-2` = 12px horizontal, 8px vertical |
| Input border radius | `rounded` = 4px or `rounded-lg` = 8px |
| Focus ring offset | `0 0 0 2px rgba(212,175,55,0.10)` |

## Modal

| Property | Value |
|---|---|
| Modal padding | `p-6` = 24px |
| Modal max-width (small) | 480px |
| Modal max-width (medium) | 560px |
| Modal max-width (large) | 760px |
| Modal border radius | `rounded-xl` = 12px |
| Backdrop | `rgba(0,0,0,0.80)` + `blur(4px)` |

## Tables

| Property | Value |
|---|---|
| Row padding | `px-4 py-2` = 16px h, 8px v |
| Row height (typical) | 48px |
| Header row padding | `px-4 py-2` with uppercase 11px labels |
| Row hover | `rgba(212,175,55,0.04)` |
| Row border | `border-b 1px solid rgba(212,175,55,0.08)` |

## Admin Specific

| Property | Value |
|---|---|
| Admin sidebar width | ~240px |
| Admin content max-w | `max-w-5xl` = 1024px |
| Stat tile padding | `p-5` = 20px |
| Stat tile grid | `grid-cols-1 sm:grid-cols-3 gap-4` |
| Chart section grid | `grid-cols-1 md:grid-cols-2 gap-6` |
| Admin content py | `py-6` = 24px |

---

# 6. CERTIFICATE / LABEL SYSTEM

## Back Label (Brother ScanNCut CM300 format)

### Dimensions

| Property | Value |
|---|---|
| Canvas width | **827 px** |
| Canvas height | **236 px** |
| Print DPI | Not explicitly set in labels.ts (set by printer driver) |
| Print size (approx at 96dpi) | ~219mm × 62mm |
| White gap (outer edge) | **3 px** |
| Gold border stroke | **12 px** |
| Gold border center from edge | **9 px** |
| Gold border outer edge | 3 px from canvas edge |
| Gold border inner edge | 15 px from canvas edge |
| Gold border colour | `#C9A227` |

### Inner Content Area

| Coordinate | Value |
|---|---|
| I_LEFT (content left edge) | **15 px** |
| I_RIGHT (content right edge) | **812 px** |
| I_TOP (content top edge) | **15 px** |
| I_BOTTOM (content bottom edge) | **221 px** |
| I_W (inner width) | **797 px** |
| I_H (inner height) | **198 px** |

### Background

- Full canvas fill: `#000000`
- White gap fill: `#FFFFFF` (3px strips at each edge)
- Inner content gradient (top→bottom):
  ```
  0%:   #1A1208  (very dark warm black)
  30%:  #0D0B07  (near-black)
  70%:  #0D0B07
  100%: #1A1208
  ```

### Right Grade Panel

| Property | Value |
|---|---|
| Panel width | **148 px** |
| Panel X start | I_RIGHT - 148 = **664 px** |
| Panel center X | 664 + 74 = **738 px** |
| Panel top | I_TOP = 15 px |
| Panel height | I_H - STRIP_H = 198 - 38 = **160 px** |
| Grade number font size | 48–133px bold Arial (fit to panel) |
| Grade abbreviation font | up to 35px bold Arial (fit to width-10px) |
| Card number font | fit to width, min 12px, max varies |
| Panel gradient | dark gold tints |
| Shine effect height | 3px at top and bottom |

### Bottom Strip

| Property | Value |
|---|---|
| Strip height | **38 px** |
| Strip Y start | I_BOTTOM - 38 = **183 px** (= I_BOTTOM - STRIP_H, where I_BOTTOM=221) |
| Strip background | `#000000` |
| Cert ID font | 28px bold Arial (fit to PANEL_W-14) |
| Cert ID colour | `#D4AF37` |
| Cert ID position | Right panel center X, vertical center of strip |

### MINTVAULT Brand Header (left panel)

| Property | Value |
|---|---|
| Font size | **44 px** bold Arial |
| Top padding | **8 px** |
| Text Y (top) | I_TOP + 8 = **27 px** |
| Text bottom | 27 + 44 = **71 px** |
| Text colour | Gold gradient (FFF3B0→F5D06F→D4AF37→B8962E→A67C00) |
| Center X | I_LEFT + (panelX - I_LEFT) / 2 |
| Decorative lines | Gold gradient lines flanking text, 3px stroke |
| Line letter spacing | +3px per character gap (8 gaps × 3px = +24px to measured width) |

### Card Text Zone (below MINTVAULT header)

| Property | Value |
|---|---|
| Text zone top | MV_HDR_BOT + 5 = **76 px** |
| Text left margin | I_LEFT + TXT_PAD = 15 + 28 = **43 px** |
| Text max width | panelX - textLeft - gutter |
| Card name font | **43 px** bold Arial (SZ_NM), fit if overflows |
| Card name min font | **28 px** |
| Year/Set font | **29 px** bold Arial (SZ_YS) |
| Variant font | **29 px** bold Arial (SZ_VAR) |
| Line height multiplier | 1.12 × font size (lh function) |

### QR Code (back label)

| Property | Value |
|---|---|
| QR size | **150 × 150 px** |
| Quiet zone pad | **5 px** (left and bottom) |
| QR top | I_TOP = **15 px** (flush) |
| QR right | I_RIGHT = **812 px** (flush) |
| QR left | I_RIGHT - 150 = **662 px** |
| White box left | 662 - 5 = **657 px** |
| White box width | 150 + 5 = **155 px** |
| White box height | 150 + 5 = **155 px** |
| QR URL format | `https://mintvaultuk.co.uk/cert/{certId}` |
| Cert ID below QR | `#D4AF37` 30px bold Arial |
| Gap QR bottom to text | **14 px** |

### NFC Icon (back label)

| Property | Value |
|---|---|
| Shape | Three arcs, opening rightward |
| Arc radii | 30%, 60%, 90% of `size` parameter |
| Stroke width | `max(2.5, size × 0.13)` |
| Center dot radius | `max(2, size × 0.13)` |
| Colour | `#D4AF37` gold |

### Left Panel Art Zone

| Property | Value |
|---|---|
| Art area | I_LEFT to panelX (664px), full I_H |
| Art scaling | `cover` — `max(I_W/art.w, I_H/art.h)` scale |
| Art position | Centered in zone |
| Left panel overlay | Gradient fade to left (dark, covering art) |

### Export Formats (back label)

| Format | Route |
|---|---|
| Single PNG | POST `/api/admin/labels/generate` |
| A4 sheet PDF | POST `/api/admin/labels/sheet` |
| Cut guide | Separate SVG cut guide for ScanNCut CM300 |

---

## Claim Insert Card

### Dimensions

| Property | Value |
|---|---|
| Card width | **85.6 mm** (credit card standard) |
| Card height | **54 mm** (credit card standard) |
| DPI | **300** |
| Canvas width | `round(85.6 × 300/25.4)` = **1011 px** |
| Canvas height | `round(54 × 300/25.4)` = **638 px** |
| PDF card width | `85.6 × (72/25.4)` = **242.3 pt** |
| PDF card height | `54 × (72/25.4)` = **152.9 pt** |

### Layout

| Property | Value |
|---|---|
| Border stroke | **4 px** |
| Border centre | 2 px from edge |
| Border colour | Gold gradient |
| Content padding | **30 px** |
| Logo height | **65 px** (auto-width, proportional) |
| QR code size | **200 × 200 px** |
| QR pad (box) | **5 px** |
| QR box total | 210 × 210 px |
| QR X position | PX_W - pad - qrBoxSize = 1011 - 30 - 210 = **771 px** |
| QR Y position | `round(PX_H/2 - qrBoxSize/2) + 10` |
| QR URL | `https://mintvaultuk.com/claim` |
| Cert ID text | bold 28px Arial |
| "Claim ownership" label | bold 22px Arial |
| Formatted code | bold 36px Courier New monospace |
| "at mintvaultuk.com/claim" | bold 22px Arial |
| Code below text | bold 34px Courier New monospace |
| Step instructions | 17px Arial |
| Footer italic | italic 14px Arial |

### A4 Batch Sheet

| Property | Value |
|---|---|
| A4 width (PDF pt) | **595.28 pt** |
| A4 height (PDF pt) | **841.89 pt** |
| Columns per page | **2** |
| Rows per page | **5** |
| Cards per page | **10** |
| Gap horizontal | **0 pt** |
| Gap vertical | **0 pt** |
| Left margin | `(595.28 - 2×cardW) / 2` (centred) |
| Top margin | `(841.89 - 5×cardH) / 2` (centred) |

---

# 7. IMAGE / MEDIA SPECS

| Image | Dimensions | Aspect | Crop | Format | Usage |
|---|---|---|---|---|---|
| Cert front | Variable (original) | ~3:4 | Cover fit | JPEG/PNG/WEBP | Slab front scan |
| Cert back | Variable (original) | ~3:4 | Cover fit | JPEG/PNG/WEBP | Slab back scan |
| Cert thumbnail (admin list) | 40×56px | 5:7 | Cover | Display scaled | Admin cert list, cert browser |
| Homepage hero image | Any (≥1200px w) | Free | — | WEBP + PNG fallback | `/images/premium-slab-closeup.webp` |
| Label art | Loaded from R2 URL | Variable | Cover fill | Any (canvas loadImage) | Back label left panel background |
| Logo (server canvas) | Variable | Proportional | — | PNG file | `/public/brand/nfc-tap-icon-white.png` |
| NFC icon | File on disk | — | — | PNG | Rendered on back label |

**Image storage:** Cloudflare R2 (S3-compatible)
- Environment vars: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_ENDPOINT`
- Path pattern: `certificates/{certId}/front.jpg`, `certificates/{certId}/back.jpg`
- Max upload size: Not hard-limited in app; governed by Express body parser

---

# 8. COMPONENT-BY-COMPONENT SPEC

---

## `<CertRow />` (admin dashboard list)

**Purpose:** Single row in the admin cert list
**Props:** `cert: CertificateRecord`, `onEdit`, `onVoid`, `onPreview`
**Layout:**
```
[image 40×56px] [cert info block flex-1] [action buttons shrink-0]

Cert info block:
  Row 1: [CertID mono gold] [status badge] [ownership badge] [grade label]
  Row 2: Card name (white, 14px, bold, truncate)
  Row 3: Game · Set · Card# [variant if present] (gray-500, 12px, truncate)

Action buttons (right):
  [Edit] [Void] [Print] [Preview]
  Each: p-1.5 border border-[#D4AF37]/20 rounded icon-only 12px
```

**data-testids:**
- `cert-row-{cert.id}` — container
- `text-cert-id-{cert.id}` — cert ID span
- `text-cert-name-{cert.id}` — card name
- `badge-owned-{cert.id}` — claimed badge
- `badge-unclaimed-{cert.id}` — unclaimed badge
- `button-edit-{cert.id}` — edit button

**Ownership badge styles:**
- Claimed: `bg-[#D4AF37]/20 text-[#D4AF37]` + Shield icon 9px
- Unclaimed: `bg-gray-800 text-gray-600`

---

## `<BrowserRow />` (admin cert browser)

**Purpose:** Compact cert row in the cert browser panel
**Layout:**
```
[Print/reprint status icon] [cert info] [action buttons]

Cert info:
  [CertID yellow mono] [grade badge outline] [reprint count badge] [ownership badge]
  Card name (gray-400, 12px, truncate) · Set name
  Date issued (10px gray-600)
```

**Ownership badge styles (browser):**
- Claimed: `border-[#D4AF37]/40 text-[#D4AF37]` + Shield 10px icon
- Unclaimed: `border-gray-700 text-gray-600`

**data-testids:**
- `certid-browser-{cert.certId}` — cert ID span
- `cardname-browser-{cert.certId}` — card name
- `badge-ownership-browser-{cert.certId}` — ownership badge

---

## `<PricingCard />` (homepage + wizard)

**Props:** tier object (id, name, price, turnaround, features, badge?, availability?)
**Container:** `border border-[#D4AF37]/15 rounded-lg p-5`
**Highlighted (popular):** stronger border, badge shown
**Layout:**
```
[Tier name uppercase tracking-widest] [Badge "Most Popular" / "Priority Service"]
[Availability text — emerald or amber]
[Price: text-xl white bold]
[Turnaround: white semibold]
[Feature list — check icons D4AF37, 14px text]
[Submit CTA button — full width]
```
**CTA link:** `/submit?type={activeService}&tier={tier.id}`
**data-testids:** `tier-{id}`, `text-tier-name-{id}`, `badge-{id}`, `text-price-{id}`, `text-turnaround-{id}`, `button-submit-{id}`

---

## `<DashboardStatTile />` (admin)

**Layout:**
```
[Icon top-right 20px gold]
[Value: 36px white bold]
[Label: 11px uppercase tracking gold]
[Trend: small % text emerald/red]
```
**Grid:** `grid-cols-1 sm:grid-cols-3 gap-4`
**Container:** `border border-[#D4AF37]/20 rounded-lg p-5`

---

## `<OwnershipSection />` (admin cert editor)

**Purpose:** Manage ownership for a specific cert
**Sections:**
1. Current status display (Claimed/Unclaimed + owner email if claimed)
2. Claim code display (formatted XXXX-XXXX-XXXX, monospace gold)
3. Generate / Regenerate code button
4. Manual assign form (email + user ID inputs + Assign button)
5. Revoke button (if claimed, destructive)
6. Print Claim Insert button → POST `/api/admin/certificates/:certId/claim-insert`
7. Ownership history table:
   - Columns: Event type, From user, To email, Timestamp, Notes
   - eventType values: `initial_claim`, `transfer`, `revoke`, `manual_assign`

---

## `<NFCPanel />` (admin cert editor)

**Sections:**
1. NFC status: Enabled (green badge) / Disabled (gray badge)
2. NFC UID field (read-only or editable text)
3. Chip type field
4. NFC URL field
5. Lock status
6. Stats: Scan count, Last scan at, Last scan IP
7. Written at / by

---

## `<GradeBadge />`

**Purpose:** Coloured grade display
**Sizes:** xs (`text-xs px-1.5 py-0.5`), sm (default), lg
**Grade → colour mapping:**

| Grade range | Background | Text |
|---|---|---|
| 10.0 | Gold gradient | Black |
| 9.0–9.9 | `rgba(16,185,129,0.20)` | `#10B981` |
| 8.0–8.9 | `rgba(20,184,166,0.20)` | `#14B8A6` |
| 7.0–7.9 | `rgba(234,179,8,0.20)` | `#EAB308` |
| 6.0–6.9 | `rgba(249,115,22,0.20)` | `#F97316` |
| ≤5.9 | `rgba(239,68,68,0.20)` | `#EF4444` |
| AUTHENTIC (NO) | `rgba(59,130,246,0.20)` | `#3B82F6` |
| ALTERED AUTH (AA) | `rgba(168,85,247,0.20)` | `#A855F7` |
| Voided (any) | `rgba(107,114,128,0.20)` | `#6B7280` |

---

## Filter Buttons (cert list)

**Ownership filters (3 buttons):**
- "All Ownership" — active: `bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37]/40`
- "Claimed (N)" — active: same gold active style, includes Shield 9px icon, shows count
- "Unclaimed" — active: `bg-gray-700 text-gray-300 border-gray-600`
- data-testids: `filter-ownership-all`, `filter-ownership-claimed`, `filter-ownership-unclaimed`

**Status filters:** All / Active / Voided
**Grade type filters:** Numeric / Auth Only / Altered

---

## Export Buttons (dashboard header)

| Button | data-testid | href/action |
|---|---|---|
| Export CSV | `button-export-csv` | `<a href="/api/admin/certificates/export-csv">` |
| Ownership CSV | `button-export-ownership-csv` | `<a href="/api/admin/ownership-export">` |
| Backfill Claim Codes | `button-backfill-claim-codes` | `onClick` → POST `/api/admin/backfill-claim-codes` |

---

# 9. ADMIN SYSTEM DETAIL

## Login Flow

**Step 1:** POST `/api/admin/login`
- Body: `{ password: string }`
- Success: `{ step: "PIN_REQUIRED" }` + sets `session.pendingAdmin = true`
- Failure: `{ error: "Invalid credentials" }` (401)
- Rate limit: 5 attempts per 10 minutes (in-memory, resets on server restart)

**Step 2:** POST `/api/admin/pin`
- Body: `{ pin: string }`
- Requires: `session.pendingAdmin === true`, not expired (TTL applied)
- Success: `{ success: true }` + sets `session.isAdmin = true`, `session.adminEmail`
- Max PIN failures: 5 before session reset
- Rate limit: separate in-memory store

**Session check:** GET `/api/admin/session` → `{ authenticated: boolean, email: string }`
**Logout:** DELETE `/api/admin/session`
**Admin email:** `admin@mintvaultuk.co.uk`

---

## Dashboard Tab

**Stat tiles (3 columns on sm+):**
- Total Certificates
- Total Submissions
- Claimed Certs (ownership)

**Grade Distribution chart:** Bar chart, grades 1–10 on X axis

**Grade Type breakdown:**
- Numeric: total - authenticOnly - authenticAltered
- Authentic Only (NO): `authenticOnlyCount`
- Altered Auth (AA): `authenticAlteredCount`

**Recent Certs list:** Latest 5–10 certs with clickable cert ID

**Action buttons (header row):**
- Search bar: filters by cert ID
- Export CSV link
- Ownership CSV link
- Backfill Claim Codes button

**data-testids:**
- `text-grade-dist-title`, `text-grade-type-title`
- `text-backfill-status` (result message after backfill)
- `button-export-csv`, `button-export-ownership-csv`, `button-backfill-claim-codes`
- `input-quick-search`, `button-quick-search`

---

## Certificates Tab (CertList)

**Filters:**
- Text search: cert ID, card name, set (client-side filter)
- Status: All / Active / Voided (buttons)
- Grade type: Numeric / Auth Only / Altered (toggle buttons)
- Grade value: dropdown (All grades / 1–10)
- Date from: date input
- Date to: date input
- Ownership: All Ownership / Claimed (N) / Unclaimed (buttons)
- Clear filters button (shown when hasActiveFilters=true)

**API filter params (server-side on initial load):**
`GET /api/admin/certificates?cardName=&setName=&grade=&dateFrom=&dateTo=&status=&ownershipStatus=`

**Cert count display:**
`{totalCount} total records · {voidedCount} voided (filtered)`

**New Certificate button:** `button-new-cert`
**Filter data-testids:** `filter-all`, `filter-active`, `filter-voided`, `filter-gradetype-numeric`, `filter-gradetype-authentic`, `filter-gradetype-altered`, `filter-ownership-all`, `filter-ownership-claimed`, `filter-ownership-unclaimed`, `select-grade-filter`, `input-date-from-certs`, `input-date-to-certs`, `button-clear-filters-certs`, `input-search-certs`

---

## Certificate Editor (modal or inline panel)

**Sections / fields:**

**A. Grade section:**
- Grade Type: Select (Numeric 1–10 / Authentic Only / Altered Authentic)
- If Numeric: Grade Overall (decimal), Centering, Corners, Edges, Surface
- If Non-numeric: no sub-scores, auto-labelled

**B. Card Details:**
- Card Game: text
- Set Name: text
- Collection/Subset: dropdown (collectionCode) + "Other" text
- Card Name: text
- Card Number: text
- Rarity: dropdown + "Other" text
- Designations: multi-select (Foil, 1st Edition, Error, Shadowless, etc.)
- Variant: dropdown + "Other" text
- Language: text (default "English")
- Year: text

**C. Images:**
- Front image upload → Cloudflare R2
- Back image upload → Cloudflare R2
- Preview thumbnails

**D. Status:**
- Active / Voided selector
- Void action (destructive confirm required)

**E. NFC Section:**
- Enable/disable toggle
- NFC UID field
- Chip type text
- Lock toggle

**F. Ownership Section** (OwnershipSection component):
- Current status badge
- Owner email / user ID (if claimed)
- Claim code panel (formatted XXXX-XXXX-XXXX in monospace gold)
- Generate / Regenerate / Clear buttons
- Manual assign form
- Revoke button (if claimed)
- Print Claim Insert button
- Ownership history table

---

## Submissions Tab

**Filter:** Status dropdown (All / draft / received / grading / dispatched / complete)

**Per submission row:**
- Submission ID (tracking number)
- Customer name + email
- Status badge
- Card count
- Total price
- Created date

**Submission status progression:**
`draft → received → grading → dispatched → complete`

**Per submission detail view:**
- Customer info: name, email, phone, return address
- Service tier + type
- Card items list (editable: game, set, card name, card number, year, declared value, notes)
- Assign cert ID per item
- Status update buttons
- Packing slip PDF download

---

## Labels Tab

**Sheet generation:**
- Select certs to include (or use cert browser)
- Preview label before printing
- Generate A4 sheet PDF
- Download button

**Individual label:**
- Single cert label PNG
- Quick Print button

---

## Settings Tab

**Service tier editor:**
- List all tiers (Basic, Standard, Premier, Ultra, Elite)
- Per-tier: name, price (pence), turnaround days, turnaround label, declared value cap
- PUT `/api/admin/service-tiers/:id`

---

# 10. DATA + FIELD MAP

## `certificates` table

| Column | DB Name | Type | Notes |
|---|---|---|---|
| id | id | serial PK | Auto-increment |
| certId | certificate_number | text UNIQUE | e.g. "MV001" |
| status | status | varchar(10) | "active" / "voided" |
| createdAt | issued_at | timestamp | Auto-set on insert |
| gradeOverall | grade | decimal(4,1) | e.g. 9.5 |
| gradeCentering | centering_score | decimal(4,1) | |
| gradeCorners | corners_score | decimal(4,1) | |
| gradeEdges | edges_score | decimal(4,1) | |
| gradeSurface | surface_score | decimal(4,1) | |
| gradeType | grade_type | text | "numeric" / "NO" / "AA" |
| cardGame | card_game | text | e.g. "Pokémon" |
| setName | set_name | text | |
| cardName | card_name | text | |
| cardNumber | card_number_display | text | e.g. "025/102" |
| rarity | rarity | text | |
| rarityOther | rarity_other | text | Custom rarity |
| designations | designations | jsonb (string[]) | ["1st Edition","Foil"] |
| variant | variant | text | |
| variantOther | variant_other | text | |
| collection | collection | text | |
| collectionCode | collection_code | text | Short code |
| collectionOther | collection_other | text | Custom collection |
| language | language | text | Default "English" |
| year | year_text | text | |
| frontImagePath | front_image_path | text | R2 URL or path |
| backImagePath | back_image_path | text | R2 URL or path |
| nfcUid | nfc_uid | text | Physical chip UID |
| nfcEnabled | nfc_enabled | boolean | Default false |
| nfcChipType | nfc_chip_type | text | |
| nfcUrl | nfc_url | text | |
| nfcLocked | nfc_locked | boolean | |
| nfcWrittenAt | nfc_written_at | timestamp | |
| nfcLockedAt | nfc_locked_at | timestamp | |
| nfcLastVerifiedAt | nfc_last_verified_at | timestamp | |
| nfcWrittenBy | nfc_written_by | text | Admin email |
| nfcScanCount | nfc_scan_count | integer | Default 0 |
| nfcLastScanAt | nfc_last_scan_at | timestamp | |
| nfcLastScanIp | nfc_last_scan_ip | text | |
| ownershipStatus | ownership_status | varchar(20) | "unclaimed"/"claimed" |
| claimCodeHash | claim_code_hash | text | SHA-256 of raw code |
| claimCodeCreatedAt | claim_code_created_at | timestamp | |
| claimCodeUsedAt | claim_code_used_at | timestamp | When claimed |
| ownerEmail | owner_email | text | Claimed owner email |
| ownerUserId | owner_user_id | text | Claimed owner user ID |
| deletedAt | deleted_at | timestamp | Soft delete |

## `ownership_history` table

| Column | DB Name | Type | Notes |
|---|---|---|---|
| id | id | serial PK | |
| certId | cert_id | text | FK → certificates.certId |
| fromUserId | from_user_id | varchar | Previous owner (nullable) |
| toUserId | to_user_id | varchar | New owner (required) |
| toEmail | to_email | text | New owner email |
| eventType | event_type | text | "initial_claim" / "transfer" / "revoke" / "manual_assign" |
| createdAt | created_at | timestamp | Auto |
| notes | notes | text | Optional admin note |

## `claim_verifications` table

| Column | DB Name | Type | Notes |
|---|---|---|---|
| id | id | serial PK | |
| certId | cert_id | text | Target cert |
| email | email | text | Claimant email |
| tokenHash | token_hash | text | SHA-256 of UUID token |
| expiresAt | expires_at | timestamp | Now + 24 hours |
| createdAt | created_at | timestamp | Auto |

## `submissions` table (key fields)

| Column | DB Name | Type |
|---|---|---|
| id | id | serial PK |
| trackingNumber | tracking_number | text UNIQUE |
| status | status | varchar(30) — "draft"/"received"/"grading"/"dispatched"/"complete" |
| cardCount | card_count | integer |
| totalPrice | total_price | decimal(10,2) |
| totalDeclaredValue | total_declared_value | integer (pence) |
| paymentStatus | payment_status | varchar(20) — "unpaid"/"paid" |
| paymentIntentId | payment_intent_id | text |
| paymentAmount | payment_amount | decimal(10,2) |
| serviceType | service_type | text — "grading"/"reholder"/"crossover"/"authentication" |
| serviceTier | service_tier | text — tier ID |
| turnaroundDays | turnaround_days | integer |
| customerEmail | customer_email | text |
| customerFirstName | customer_first_name | text |
| customerLastName | customer_last_name | text |
| shippingInsuranceTier | shipping_insurance_tier | text |
| shippingCost | shipping_cost | integer (pence) |
| gradingCost | grading_cost | integer (pence) |
| termsAccepted | terms_accepted | boolean |
| termsAcceptedAt | terms_accepted_at | timestamp |
| receivedAt | received_at | timestamp |
| shippedAt | shipped_at | timestamp |
| completedAt | completed_at | timestamp |

## `tiers` table

| Column | DB Name | Type |
|---|---|---|
| id | id | serial PK |
| name | name | text UNIQUE |
| pricePerCard | price_per_card | decimal(10,2) — in GBP (e.g. 15.00) |
| turnaroundWorkingDays | turnaround_working_days | integer |
| declaredValueCap | declared_value_cap | integer (£, not pence) |
| features | features | text (JSON array string) |
| requiresSeniorReview | requires_senior_review | boolean |

## `label_prints` table

| Column | DB Name | Type |
|---|---|---|
| id | id | serial PK |
| certId | cert_id | text |
| queuedAt | queued_at | timestamp auto |
| printedAt | printed_at | timestamp nullable |
| printedBy | printed_by | text |

## `reprint_log` table

| Column | DB Name | Type |
|---|---|---|
| id | id | serial PK |
| certId | cert_id | text |
| reprintReason | reprint_reason | text |
| reprintedAt | reprinted_at | timestamp auto |
| reprintedBy | reprinted_by | text |

## Ownership Claim Code Format

- Raw format: `XXXXXX-XXXXXX-XXXXXX` (3 groups of 6 uppercase alphanumeric)
  *Note: admin displays as XXXX-XXXX-XXXX in some views*
- Storage: SHA-256 hash of `code.toUpperCase().trim()`
- Lookup: hash the input, compare against stored hash
- On regenerate: new code generated, old hash invalidated, new `claimCodeCreatedAt` set
- On claim: `claimCodeUsedAt` set, `ownershipStatus` → "claimed"

## Grade Types

| gradeType value | Display Label | Abbreviation | Notes |
|---|---|---|---|
| `"numeric"` | Numeric (1–10) | e.g. GEM MT | Standard grade with sub-scores |
| `"NO"` | Authentic Only | AUTHENTIC | No grade number, authentic only |
| `"AA"` | Altered Authentic | AUTH ALTERED | Altered card, authenticated |

## Valid Service Types

```typescript
["grading", "reholder", "crossover", "authentication"]
```

---

# 11. RESPONSIVE RULES

## Breakpoints (Tailwind defaults)

| Name | Min width | Used as |
|---|---|---|
| `sm` | 640px | Most layout switches |
| `md` | 768px | Chart grids, some forms |
| `lg` | 1024px | Full sidebar (admin) |
| `xl` | 1280px | Marketing max-width |

## Admin Dashboard

| Element | Mobile | sm+ |
|---|---|---|
| Stat tiles | 1 column | 3 columns (`sm:grid-cols-3`) |
| Charts | 1 column | 2 columns (`md:grid-cols-2`) |
| Cert list header | `flex-col` | `flex-row` (`sm:flex-row`) |
| Set name in cert row | Hidden | Visible (`hidden sm:inline`) |
| Cert ID date column | Hidden | Visible (`hidden sm:inline`) |

## Cert Browser (admin)

- Full-width list on all sizes
- Row actions: always visible (icon-only buttons)
- Set name column: `hidden sm:inline`

## Pricing Page (marketing)

| Element | Mobile | sm+ |
|---|---|---|
| Pricing cards | 1 column, scrollable | 2–3 column grid |
| Hero image | Below text | Beside text |
| Trust strip | Vertical stack | Horizontal row |
| FAQ | Full width accordion | Same |

## Nav

- Desktop: inline horizontal links + CTA button
- Mobile: hamburger → full-screen overlay
- Mobile nav: `fixed inset-0 z-50 bg-black` with close button

## Submission Wizard

- Always single-column form
- Pricing tier cards: 1 column mobile, 2–3 desktop
- Progress bar: full width at all sizes

---

# 12. COPY / CONTENT INVENTORY

## Homepage

**H1 / Intro paragraph:**
> MintVault UK offers professional trading card grading for Pokémon, Yu-Gi-Oh!, Magic: The Gathering and all major TCGs. Based in the United Kingdom, we provide fast turnaround, tamper-evident precision slabs, and fully insured return shipping.

**Meta title:**
> MintVault UK — Professional Trading Card Grading Service

**Meta description:**
> Professional Pokémon and trading card grading service in the UK. Fast turnaround, secure certification and premium slabs. Submit your cards to MintVault today.

**How It Works Step 1:**
> "Submit your cards online" — Choose your service tier, enter your card details, and pay securely online in minutes.

**Trust point — turnaround:**
> Fast turnaround times — From 2 to 60 working days depending on your tier. Track your submission status online.

**FAQ — Turnaround:**
> Turnaround depends on your chosen service tier. Our Basic tier offers 60 working days, Standard is 20 working days, Premier is 10 working days, Ultra is 5 working days, and Elite provides just 2 working day turnaround. You can track your submission status online at any time.

**FAQ — Pricing:**
> Our grading prices start from just £12 per card for our Basic tier. We offer five tiers to suit different needs and budgets, with bulk discounts of up to 10% for larger submissions. All prices include fully insured return shipping based on your declared value.

**FAQ — Why UK?**
> Using a UK-based service like MintVault means faster turnaround, no international shipping risks, no customs fees, and local customer support. Your cards stay within the UK throughout the process, reducing the chance of loss or damage.

**Slab upgrade note:**
> Upgrade your slab for a stronger, cleaner, premium finish.

## Claim Page

**Success message:** `Verification email sent. Please check your inbox to complete the claim.`
**Error — wrong code:** `Invalid certificate number or claim code.`
**Error — missing fields:** `Certificate number, claim code, and email are required.`

## Submission Wizard

**Step 1 heading:** `Select your {typeName} speed and coverage tier`
**Step 2 heading:** `Enter the number of cards and total declared value`
**Insurance label:** `Insured shipping: {tier.label} — £{price}`
**Surcharge label:** `Insurance protection: {surcharge.label} (£{perCard}/card avg)`
**Mismatch warning:** Amber banner — declared value mismatch between total and per-card sum

## Admin Labels

| Label | Value |
|---|---|
| Certs section title | `CERTIFICATES` |
| Stats tile (grade dist) | `Grade Distribution` |
| Stats tile (grade type) | `By Grade Type` |
| Grade types | `Numeric (1–10)`, `Auth Only`, `Altered Auth` |
| Filter: ownership | `All Ownership`, `Claimed (N)`, `Unclaimed` |
| Export CSV button | `Export CSV` |
| Ownership CSV button | `Ownership CSV` |
| Backfill button | `Backfill Claim Codes` |
| Status: active | `active` |
| Status: voided | `voided` |

---

# 13. SEO PAGE TEMPLATES

## Template structure (all SEO pages follow this)

```
<title>{Keyword} | MintVault UK</title>
<meta name="description" content="{120–155 char description with keyword + UK + trust signal}">
<link rel="canonical" href="https://mintvaultuk.com/{slug}">

H1: {Exact target keyword, Title Case}
Intro (150–200 words): What it is, why it matters, MintVault's approach to it

H2: How MintVault {Verb} {Category}
  → 3–4 paragraphs on process, expertise, standards

H2: {Category} Grading Prices
  → Tier table (Basic–Elite) with prices and turnarounds
  → Note on bulk discounts

H2: How It Works
  → Step 1/2/3 (same as homepage)

H2: Frequently Asked Questions
  → 4–6 FAQs specific to this category
  → Accordion component

H2: Submit Your {Category} Cards Today
  → CTA block → /submit

Internal links: / (homepage), /why-mintvault, /cert (verify), /population
```

## Live SEO Pages

| Route | H1 | Primary keyword |
|---|---|---|
| `/pokemon-card-grading-uk` | Pokémon Card Grading UK | Pokémon card grading UK |
| `/trading-card-grading-uk` | Trading Card Grading UK | trading card grading UK |
| `/card-grading-service-uk` | Card Grading Service UK | card grading service UK |
| `/psa-alternative-uk` | PSA Alternative UK | PSA alternative UK |
| `/how-to-grade-pokemon-cards` | How to Grade Pokémon Cards | how to grade pokémon cards |
| `/tcg-grading-uk` | TCG Grading UK | TCG grading UK |

## Schema.org (recommended)

```json
{
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  "name": "MintVault UK",
  "description": "Professional trading card grading service based in the UK",
  "url": "https://mintvaultuk.com",
  "areaServed": "GB",
  "priceRange": "££"
}
```

For cert detail pages, add:
```json
{
  "@type": "Product",
  "name": "{card name} — MintVault Certificate {certId}",
  "description": "Grade {grade} — {gradeLabel}. Verified by MintVault UK."
}
```

---

# 14. TECHNICAL APPENDIX

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + TypeScript, Vite, Tailwind CSS v3, Shadcn/UI |
| Routing | `wouter` (client-side) |
| Forms | `react-hook-form` + `@hookform/resolvers/zod` |
| Data fetching | `@tanstack/react-query` v5 |
| Backend | Node.js + Express + TypeScript |
| ORM | Drizzle ORM |
| Database | PostgreSQL via Neon (EU West 2) |
| Validation | Zod (shared between client + server via `@shared/schema`) |
| Payments | Stripe (payment intents) |
| Image storage | Cloudflare R2 (S3-compatible) |
| Email | Resend |
| PDF generation | `pdf-lib` (packing slips), `canvas` (labels + claim inserts) |
| QR codes | `qrcode` npm package |
| Deployment | Replit (autoscale) |
| DNS | Cloudflare (proxied) |
| Session | `express-session` (in-memory) |

## Build

| Command | Purpose |
|---|---|
| `npm run dev` | Dev server (Vite + Express together, port 5000) |
| `npm run build` | Production build (Vite → dist/) |
| `npm start` | Production run (`node dist/index.cjs`) |
| `npm run db:push` | Sync Drizzle schema to database |

## Domain Structure

| Domain | Purpose | Status |
|---|---|---|
| `mint-vault-pricing.replit.app` | Replit origin | Live, HTTP 200 |
| `mintvaultuk.com` | Primary custom domain | Must point to Replit via Cloudflare CNAME |
| `mintvaultuk.co.uk` | Secondary domain | Also affected by DNS |
| `mintvaultuk.co.uk/cert/` | QR code label URL | Used on labels (canonical cert verification URL) |
| `mintvaultuk.com/claim` | Claim insert QR URL | Used on claim insert cards |

**Cloudflare DNS fix required:**
- `mintvaultuk.com` currently points to `23.227.38.67` (Shopify IP) — incorrect
- Correct: CNAME `@` → `mint-vault-pricing.replit.app` (Cloudflare proxied)
- SSL: Cloudflare Full or Flexible mode
- Replit: custom domain must be added in Replit deployment settings

## Environment Secrets

| Variable | Purpose | Required |
|---|---|---|
| `MINTVAULT_DATABASE_URL` | Neon EU West PostgreSQL connection string | ✅ |
| `DATABASE_URL` | Fallback Neon connection | ✅ |
| `RESEND_API_KEY` | Transactional email (claim verifications, packing slips) | ✅ |
| `R2_ACCESS_KEY_ID` | Cloudflare R2 image storage | ✅ |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 secret | ✅ |
| `R2_BUCKET_NAME` | R2 bucket name | ✅ |
| `R2_ENDPOINT` | R2 S3-compatible endpoint URL | ✅ |
| `ADMIN_PASSWORD` | Admin login password (step 1) | ✅ |
| `ADMIN_PIN` | Admin 2FA PIN (step 2) | ✅ |
| `SESSION_SECRET` | Express session signing key | ✅ |
| `STRIPE_SECRET_KEY` | Stripe backend secret | ✅ |
| `VITE_STRIPE_PUBLISHABLE_KEY` | Stripe frontend key | ✅ |
| `TELEGRAM_BOT_TOKEN` | Telegram notifications (optional) | ⚪ |
| `TELEGRAM_CHAT_ID` | Telegram chat target | ⚪ |

## Auth Constants

| Value | Note |
|---|---|
| Admin email | `admin@mintvaultuk.co.uk` |
| Rate limit | 5 failed logins per 10 minutes (in-memory, resets on restart) |
| PIN failure limit | 5 per pending session |
| Pending admin TTL | Applied (session-level) |
| Claim token TTL | 24 hours |

---

# 15. BUILD PRIORITY

## Current Live System (implemented)

- ✅ Full submission wizard (5-step) with Stripe payment
- ✅ Certificate CRUD (create, edit, void, delete)
- ✅ Certificate public verification page (`/cert/:id`)
- ✅ Certificate lookup / search (`/cert`)
- ✅ Population report (`/population`)
- ✅ Admin two-step login (password + PIN)
- ✅ Admin dashboard with stats and grade charts
- ✅ Admin cert browser with filters + ownership filter
- ✅ Submission management (status, items, packing slips)
- ✅ Label generation (back label, Brother ScanNCut CM300 format)
- ✅ A4 label sheet printing
- ✅ NFC system (UID, locked, scan tracking, `/nfc/:certId` redirect)
- ✅ Ownership system (claim codes, SHA-256 hashed, XXXX-XXXX-XXXX format)
- ✅ Claim page (`/claim`) with email verification
- ✅ Ownership history tracking (`ownership_history` table)
- ✅ Claim insert card generator (credit-card size, A4 batch)
- ✅ Ownership CSV export (`/api/admin/ownership-export`)
- ✅ Ownership badges in cert list + cert browser
- ✅ Backfill claim codes for all existing certs
- ✅ Stripe integration + service tier pricing (5 tiers in DB)
- ✅ Insurance surcharge calculation
- ✅ Cloudflare R2 image storage
- ✅ Resend email (claim verification, packing slip)
- ✅ 6 SEO landing pages
- ✅ Guides system (`/guides` + `/guides/:slug`)
- ✅ XML sitemap + robots.txt
- ✅ LocalStorage wizard state persistence (`mv-wizard-v2`)
- ✅ Audit log table

## Missing / Not Yet Built

- ❌ Customer login / account system (ownership is email-only, no persistent customer accounts)
- ❌ Ownership transfer (transfer to another owner after initial claim)
- ❌ Card Passport page (`/passport/:certId`) — full provenance chain
- ❌ Marketplace / listings
- ❌ Dealer portal
- ❌ Worth grading tool
- ❌ Resale comps
- ❌ Public ownership registry
- ❌ Blog CMS / admin-editable guides
- ❌ Admin-editable homepage content
- ❌ Bulk void / bulk cert operations
- ❌ Multi-page admin (currently single SPA page)
- ❌ Telegram notification integration (env vars present but unused)

## Next Build Priorities (recommended order)

**Priority 1 — Operations critical:**
1. Fix `mintvaultuk.com` DNS (Cloudflare → Replit CNAME) — zero code change, admin task
2. Ownership transfer flow (so sold slabs can change hands)
3. Customer email account system (portal to see owned certs, track submissions)

**Priority 2 — Growth features:**
4. Card Passport page (full provenance — grading + ownership chain)
5. Additional SEO pages (`/card-grading-cost-uk`, `/psa-vs-mintvault`, game-specific pages)
6. Telegram notification on new submission / payment

**Priority 3 — Monetisation:**
7. Marketplace / listings (graded card resale, ownership-gated)
8. Dealer portal (volume pricing, bulk submission, invoice billing)
9. Worth grading calculator

**Priority 4 — Platform maturity:**
10. Admin-editable blog / guides CMS
11. Public ownership registry
12. Resale comps (eBay or internal sold data)

---

*MintVault UK · mintvaultuk.com*
*This is a living implementation document. Update version number and date when making structural changes.*
