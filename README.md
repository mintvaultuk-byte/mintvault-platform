# MintVault UK — Professional Trading Card Grading Service

MintVaultUK is a full-stack web application for a UK-based trading card grading, reholdering, crossover, and authentication service. It provides a public-facing submission flow, admin portal, certificate lookup, label printing, ownership claim system, and NFC tag support.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Wouter, TanStack Query v5, Tailwind CSS, Shadcn UI |
| Backend | Express.js (Node.js) |
| Database | PostgreSQL (Neon) via Drizzle ORM |
| Payments | Stripe (Payment Intents) |
| Image storage | Cloudflare R2 (S3-compatible) |
| Email | Resend |
| Label generation | Node-canvas (server-side, 827×236px PNG/PDF) |
| PDF generation | PDFKit |
| QR codes | `qrcode` npm |

---

## Features

### Public
- **Submission wizard** — 5-step flow: tier selection → card details → review → shipping → payment
- **Certificate lookup** — `/cert` — any visitor can look up a cert by ID
- **Certificate detail** — full grade, subgrades, QR code, NFC verification
- **Submission tracking** — `/track` — customers track order by submission ID + email
- **Ownership claim** — `/claim` — email-verified ownership registration with 12-char claim codes
- **SEO landing pages** — 6 optimised pages for UK card grading search terms
- **Guides system** — 15 static articles with table of contents and related links

### Admin (`/admin`)
- Two-step login: password + PIN
- Certificate CRUD (create, edit, void — no hard deletes)
- Submission management with status workflow
- Label printing (front/back PNG + PDF, Brother ScanNCut CM300 compatible)
- Claim insert cards (credit card size, A4 batch sheets of 10)
- Pricing tier management
- Population report
- CSV exports: certificates, ownership, submissions
- NFC tag management

### Labels
- **Front label** — ACE-style: artwork + card metadata + grade panel + bottom strip with barcode + cert ID
- **Back label** — 3-zone: MintVault logo (left) + NFC icon + URL (centre) + QR code + cert ID (right)
- **Canvas size** — 827×236px (Brother ScanNCut CM300 label stock)
- **Claim insert** — 85.6×54mm at 300 DPI, with QR code, claim code, instructions

---

## Project Structure

```
├── client/                    # React frontend
│   ├── src/
│   │   ├── App.tsx            # Route definitions
│   │   ├── components/        # Shared UI components
│   │   │   ├── layout.tsx     # Header + footer
│   │   │   ├── seo-head.tsx   # Meta/OG/schema tags
│   │   │   ├── faq-section.tsx
│   │   │   ├── cta-section.tsx
│   │   │   ├── certificate-form.tsx
│   │   │   └── ownership-section.tsx
│   │   ├── pages/             # Route components
│   │   │   ├── pricing.tsx    # Homepage / pricing
│   │   │   ├── submit.tsx     # Submission wizard
│   │   │   ├── cert-lookup.tsx
│   │   │   ├── cert-detail.tsx
│   │   │   ├── track.tsx
│   │   │   ├── claim.tsx
│   │   │   ├── admin*.tsx     # Admin portal pages
│   │   │   └── seo/           # 6 SEO landing pages
│   │   ├── lib/               # Utilities, options, API client
│   │   └── data/              # Static guide content
│   └── index.html
├── server/                    # Express backend
│   ├── index.ts               # App entry point
│   ├── routes.ts              # All 42+ API routes
│   ├── storage.ts             # Data access layer (IStorage interface)
│   ├── db.ts                  # Drizzle ORM connection
│   ├── config.ts              # Env var validation (uses MINTVAULT_DATABASE_URL)
│   ├── auth.ts                # Admin 2-step auth
│   ├── labels.ts              # Front/back label canvas generation
│   ├── claim-insert.ts        # Ownership claim insert card generation
│   ├── label-sheet.ts         # A4 batch sheet generation
│   ├── email.ts               # Resend transactional emails
│   ├── r2.ts                  # Cloudflare R2 image storage
│   ├── packingSlip.ts         # PDF packing slip generation
│   ├── stripeClient.ts        # Stripe client init
│   ├── webhookHandlers.ts     # Stripe webhook handler
│   └── vite.ts                # Vite dev server integration
├── shared/
│   └── schema.ts              # Drizzle schema + Zod validators + pricing logic
├── docs/                      # Project documentation
│   ├── implementation-blueprint.md    # Full technical spec (v2)
│   ├── content-inventory.md           # All page copy, headings, CTAs, messages
│   ├── asset-register.md              # All images, icons, logos
│   └── label-print-production-spec.md # Label/print geometry (locked values)
├── public/
│   ├── brand/                 # logo.png, nfc-tap-icon-white.png
│   └── images/                # Hero images (WEBP + PNG)
├── drizzle.config.ts
├── package.json
├── tailwind.config.ts
├── tsconfig.json
├── vite.config.ts
└── README.md
```

---

## Database

**Connection:** `MINTVAULT_DATABASE_URL` environment variable (EU Neon PostgreSQL)

**Key tables:**

| Table | Purpose |
|---|---|
| `certificates` | Graded card certificates (57 columns incl. ownership, NFC) |
| `submissions` | Customer orders |
| `submission_items` | Individual card line items per order |
| `certificates` | Graded card records |
| `ownership_history` | Ownership transfer audit log |
| `claim_verifications` | Email verification tokens for ownership claims |
| `users` | Customer accounts |
| `tiers` | Service tier config |
| `cards` | Individual card records |
| `card_sets` | TCG set reference |
| `card_master` | Card catalogue |

---

## Service Tiers

| Tier | Price/card | Turnaround | Declared Value Cap |
|---|---|---|---|
| Basic | £12 | 60 working days | £500 |
| Standard | £15 | 20 working days | £500 |
| Premier | £18 | 10 working days | £1,500 |
| Ultra | £25 | 5 working days | £3,000 |
| Elite | £50 | 2 working days | £7,500 |

**Bulk discounts** apply to service fees: 3% (10+), 5% (25+), 7% (50+), 10% (100+)

**Insurance surcharges** per card by declared value: £0 (≤£500), +£2 (≤£1,500), +£5 (≤£3,000), +£10 (≤£7,500)

---

## Admin Authentication

Two-step process:
1. POST `/api/admin/login` — email + password → `{ step: "PIN_REQUIRED" }`
2. POST `/api/admin/pin` — 6-digit PIN → `{ success: true }`

Admin email: `admin@mintvaultuk.co.uk`

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `MINTVAULT_DATABASE_URL` | PostgreSQL connection string (Neon EU) |
| `RESEND_API_KEY` | Resend email service |
| Stripe keys | Managed via Replit Stripe integration |
| R2 credentials | Cloudflare R2 bucket access |

---

## Grading System

- **Numeric grades:** 1–10 (integer only, no half grades currently). Subgrades: centering, corners, edges, surface
- **Non-numeric:** `NO` (Authentic Only), `AA` (Authentic Altered)
- **Grade labels:** GEM MT (10) → MINT (9) → NM-MT (8) → NM (7) → EX-MT (6) → EX (5) → VG-EX (4) → VG (3) → GOOD (2) → PR (1)
- **Certificate IDs:** Normalized to `MV{number}` format (e.g. MV1, MV42). DB may store `MV000000001` — `normalizeCertId()` handles this everywhere

---

## Label Specification (LOCKED)

- **Canvas:** 827×236px
- **Inner zone:** 15px margin (gold border 12px stroke centred at 9px from edge)
- **Front label:** Left 68% (artwork + card text) · Right 32% (grade panel 148px)
- **Back label:** Left 29% (logo 240px) · Centre (NFC icon 100px + URL + tap text) · Right (QR 150px)
- **Claim insert:** 85.6×54mm, 300 DPI → 1011×638px
- **A4 claim batch:** 2×5 = 10 per page, no gaps, centred

See `docs/label-print-production-spec.md` for exact pixel values.

---

## Key Domain Facts

- **Domain:** mintvaultuk.com (live), mintvaultuk.co.uk (alt)
- **Company:** MintVault UK Ltd
- **Cert URL format:** `https://mintvaultuk.com/cert/{certId}`
- **Claim URL:** `https://mintvaultuk.com/claim`
- **Style:** Black (#000000) background, gold (#D4AF37 → #FFD700) accents
- **Mobile-first** responsive design
