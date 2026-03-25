# MintVault UK — Final Content Inventory
### Every heading, paragraph, CTA, label, and message as live in the codebase
### March 2026

---

# GLOBAL COMPONENTS

---

## Header (`<Header />` in layout.tsx)

**Logo alt text:** `MintVault UK - Professional Pokemon and Trading Card Grading`

**Navigation menu items (mobile slide-down):**

| Order | Label | Link | Type |
|---|---|---|---|
| 1 | Pricing | `/` | Direct link |
| 2 | Why MintVault | — | Dropdown parent |
| 2a | Why Grade | `/why-mintvault#why-grade` | Submenu |
| 2b | Our Labels | `/why-mintvault#our-labels` | Submenu |
| 2c | Grading Scale | `/why-mintvault#grading-scale` | Submenu |
| 2d | Population Report | `/why-mintvault#population-report` | Submenu |
| 2e | Blog | `/why-mintvault#authority` | Submenu |
| 3 | Explore MintVault | — | Dropdown parent |
| 3a | Our Labels | `/labels` | Submenu |
| 3b | Grading Reports | `/reports` | Submenu |
| 3c | Population Report | `/population` | Submenu |
| 3d | Certificate Lookup | `/cert` | Submenu |
| 3e | Supported TCGs | `/tcg` | Submenu |
| 3f | Guides & Articles | `/guides` | Submenu |
| 4 | Certificate Lookup | `/cert` | Direct link |
| 5 | Guides | `/guides` | Direct link |
| 6 | Submit Cards | `/submit` | Direct link (bold) |

---

## Footer (`<Footer />` in layout.tsx)

### Column 1: Services
| Label | Link |
|---|---|
| Pokemon Card Grading UK | `/pokemon-card-grading-uk` |
| Trading Card Grading UK | `/trading-card-grading-uk` |
| Card Grading Service UK | `/card-grading-service-uk` |
| PSA Alternative UK | `/psa-alternative-uk` |
| How to Grade Cards | `/how-to-grade-pokemon-cards` |
| TCG Grading UK | `/tcg-grading-uk` |

### Column 2: Guides
| Label | Link |
|---|---|
| How to Grade Pokemon Cards | `/guides/how-to-grade-pokemon-cards-uk` |
| What Cards Are Worth Grading | `/guides/what-pokemon-cards-are-worth-grading` |
| Grading Costs Explained | `/guides/pokemon-card-grading-costs-explained` |
| Raw vs Graded Cards | `/guides/raw-vs-graded-pokemon-cards` |
| Beginner's Collecting Guide | `/guides/beginners-guide-pokemon-card-collecting-uk` |
| All Guides | `/guides` |

### Column 3: Company
| Label | Link |
|---|---|
| Pricing | `/` |
| Submit Cards | `/submit` |
| Certificate Lookup | `/cert` |
| Track Submission | `/track` |
| Why MintVault | `/why-mintvault` |
| Terms & Conditions | `/terms-and-conditions` |
| Liability & Insurance | `/liability-and-insurance` |

### Email signup
- **Heading:** `Join our email list`
- **Placeholder:** `Enter your email`
- **Button:** `Subscribe`

### Footer text
- `MintVault UK — Professional Trading Card Grading Service`
- `© 2026 MintVault. All rights reserved.`
- `BUILD: {BUILD_STAMP}` (e.g. `MV-P5-20260225-nohalf`)

---

## CTA Section (`<CtaSection />`)

**Default props:**
- Title: `Ready to Grade Your Cards?`
- Subtitle: `Join thousands of UK collectors who trust MintVault for professional card grading.`

**Buttons:**
| Label | Icon | Link |
|---|---|---|
| `Submit Your Cards` | ArrowRight | `/submit` |
| `View Pricing` | CreditCard | `/` |
| `Check Certificates` | Search | `/cert` |

**Override variants used on SEO pages:**

| Page | Title | Subtitle |
|---|---|---|
| pokemon-card-grading-uk | `Grade Your Pokemon Cards Today` | `Professional UK-based grading with fast turnaround and insured return shipping.` |
| trading-card-grading-uk | `Get Your Trading Cards Graded` | `Professional UK-based grading for all major trading card games. Fast turnaround and insured shipping.` |
| card-grading-service-uk | `Start Grading Your Cards Today` | `Professional UK card grading service with no customs, no delays, and fully insured returns.` |
| psa-alternative-uk | `Grade Your Cards in the UK` | `No customs, no international shipping risks. Professional grading from £12 per card with insured returns.` |
| how-to-grade-pokemon-cards | `Ready to Grade Your Pokemon Cards?` | `Submit your cards to MintVault for professional UK-based grading. Fast turnaround and insured returns.` |
| tcg-grading-uk | `Grade Your TCG Cards with MintVault` | `Professional UK-based grading for all major trading card games. Fast turnaround, competitive pricing, insured returns.` |

---

# PAGE-BY-PAGE CONTENT

---

## `/` — Homepage / Pricing

### SEO
- **Title:** `Pokemon Card Grading UK | Professional TCG Grading | MintVault UK`
- **Meta description:** `Professional Pokémon and trading card grading service in the UK. Fast turnaround, secure certification and premium slabs. Submit your cards to MintVault today.`
- **Canonical:** `https://mintvaultuk.com/`
- **OG image:** `https://mintvaultuk.com/images/collector-lifestyle.webp`

### Hero
- **Logo alt:** `MintVault UK - Professional Pokemon and Trading Card Grading Service`
- **H1:** `Professional Pokemon Card Grading Service in the UK`
- **Paragraph 1:** `MintVault UK offers professional trading card grading for Pokémon, Yu-Gi-Oh!, Magic: The Gathering and all major TCGs. Based in the United Kingdom, we provide fast turnaround, tamper-evident precision slabs, and fully insured return shipping.`
- **Paragraph 2:** `Whether you are a collector looking to protect your most valuable pulls or a seller wanting to maximise resale value, our UK card grading service delivers trusted, professional results.`

### Hero CTAs
| Label | Icon | Link |
|---|---|---|
| `Submit Your Cards` | ArrowRight | `/submit` |
| `Check a Certificate` | — | `/cert` |

- **Sub-CTA text:** `Tracked, insured and handled with care` (with Truck icon)

### How It Works (5 steps)

| # | Title | Description |
|---|---|---|
| 01 | Submit your cards online | Choose your service tier, enter your card details, and pay securely online in minutes. |
| 02 | Send them securely to MintVault | Pack your cards using penny sleeves and top loaders. Post to us via tracked, insured shipping. |
| 03 | We grade and encapsulate | Expert graders assess centering, corners, edges, and surface. Cards are sealed in tamper-evident precision slabs. |
| 04 | Track your order online | Follow every status update in real time. Each certificate is verifiable online the moment it is issued. |
| 05 | Cards returned fully insured | Your slabbed cards are returned via fully insured tracked delivery, protected for the entire journey. |

### Why Collectors Grade Their Cards

**Heading:** `Why Collectors Grade Their Cards`

> Card grading transforms a raw trading card into a professionally authenticated, condition-verified collectible sealed in a protective slab. For Pokémon card collectors and investors across the UK, grading provides several key benefits.
>
> **Increased value** — graded cards consistently sell for more than raw cards of similar condition. A card graded Gem Mint 10 can be worth many multiples of its raw counterpart, as buyers have confidence in the card's authenticated condition.
>
> **Protection** — once sealed in a tamper-evident slab, your card is protected from handling damage, moisture, UV exposure, and accidental bending. This preserves the card's condition indefinitely.
>
> **Authentication** — grading confirms your card is genuine, not a counterfeit or altered reproduction. Each MintVault certificate can be verified online.
>
> Learn more in our guide on why graded cards sell for more.

### Why Choose MintVault (5 items)

| Icon | Title | Description |
|---|---|---|
| FileCheck | Transparent grading criteria | Centering, corners, edges, and surface — we explain every point deduction clearly. |
| Clock | Fast turnaround times | From 2 to 60 working days depending on your tier. Track your submission status online. |
| Eye | Secure online verification | Every certificate is verifiable at mintvaultuk.com/cert — scannable by anyone, forever. |
| Star | Premium slab design | Tamper-evident precision encapsulation. Your card protected and presented at its best. |
| MapPin | UK-based service | Your cards stay in the UK — no international shipping, no customs fees, no import duties. |

**Footer link:** `Compare MintVault to international services in our PSA alternative guide.`

### What Cards Can Be Graded?

**Heading:** `What Cards Can Be Graded?`
**Intro:** `MintVault UK grades cards from all major trading card games. Our grading standards are consistent across all supported TCGs:`

**Games listed:** Pokémon, Yu-Gi-Oh!, Magic: The Gathering, One Piece, Dragon Ball Super, Lorcana, Flesh and Blood, Digimon, Star Wars: Unlimited, Weiss Schwarz, Cardfight!! Vanguard, MetaZoo

**Footer:** `See our full list of supported trading card games.` (links to `/tcg`)

### Featured Certificates

**Heading:** `View Real MintVault Certificates`
**Subtext:** `Real graded cards. Live certificates. Tap any card to verify.`

### Trust Badges Strip (4 items)

| Icon | Label |
|---|---|
| Lock | Secure Payments |
| Truck | Fully Insured Return |
| MapPin | UK-Based Service |
| Eye | Online Verification |

### Service Type Selector

**Heading:** `CARD {SERVICE_TYPE} PRICES`
**Trust line:** `Trusted by collectors across the UK`
**Urgency line:** `⚡ Limited slots available this month`

| Button | Description |
|---|---|
| Grading | Grade your raw cards with MintVault. |
| Reholder | Upgrade your existing MintVault slab. |
| Crossover | Move cards graded by another company into MintVault. |
| Authentication | Verify your card is genuine without grading. |

### Service image captions
- Grading: `Professional grading. Tamper-evident precision slabs.`
- Reholder: `Upgrade your slab for a stronger, cleaner, premium finish.`
- Reholder price anchor: `From £7.99 per card`
- Reholder urgency: `⚡ Limited intake — slots fill daily`

### Pricing Tier Badges

| Tier ID | Badge Text | Availability |
|---|---|---|
| basic | Economy Service | Good Availability |
| standard | Most Popular | Good Availability |
| priority | Fast Turnaround | Good Availability |
| express | Priority Service | Limited Availability |
| premium | Fastest Service | Limited Availability |

### Tier Card Labels
- `Price` (row label)
- `Turnaround` (row label)
- `Includes` (feature list heading)
- CTA button: `Submit Your Cards`
- Popular tier urgency: `⚡ Turnaround times filling quickly`

### Bulk Discounts

**Heading:** `BULK DISCOUNTS`
**Subtitle:** `Save more when you submit more cards`
**Table headers:** `Quantity` | `Bulk Deal`

| Range | Discount |
|---|---|
| 1–9 cards | No discount |
| 10–24 cards | 3% off |
| 25–49 cards | 5% off |
| 50–99 cards | 7% off |
| 100+ cards | 10% off |

**Footer note:** `Bulk discounts apply to service fees only (not shipping or add-ons). Discounts are applied automatically at checkout.`

### FAQ (8 questions)

| Q | A (summary) |
|---|---|
| How does Pokémon card grading work in the UK? | Submit → inspect → grade 1-10 → sealed in slab → returned insured |
| Is card grading worth it? | Gem Mint 10 can multiply value; even mid-grade cards benefit from protection/auth |
| What cards should I grade? | Cards in excellent condition with value above grading cost; vintage, chase, full art, first editions |
| How long does card grading take? | Basic 60 days, Standard 20, Premier 10, Ultra 5, Elite 2 |
| How much does card grading cost in the UK? | From £12/card Basic; 5 tiers; bulk discounts up to 10%; includes insured return |
| How do I send my cards for grading safely? | Penny sleeves + top loaders + padded envelope + tracked insured shipping |
| Why use a UK grading company instead of PSA or BGS? | Faster turnaround, no international shipping risks, no customs, local support |
| What affects a card's grade? | Centering, corners, edges, surface — four factors assessed individually |

### Learn More Links

| Label | Link |
|---|---|
| Pokemon Card Grading UK | `/pokemon-card-grading-uk` |
| Trading Card Grading UK | `/trading-card-grading-uk` |
| Card Grading Service UK | `/card-grading-service-uk` |
| UK PSA Alternative | `/psa-alternative-uk` |
| How to Grade Pokemon Cards | `/how-to-grade-pokemon-cards` |
| TCG Grading UK | `/tcg-grading-uk` |
| All Guides & Articles | `/guides` |
| Why MintVault | `/why-mintvault` |

### Lifestyle Image Caption
`Trusted by collectors across the UK to protect and authenticate their most valuable cards.`

---

## `/submit` — Submission Wizard

### Step Labels (progress bar)
`Tier` → `Cards` → `Review` → `Shipping` → `Payment`

### Step 1: Tier Selection
- **H2:** `SELECT YOUR {TYPE} TIER`
- **Subtitle:** `Select your {typeName} speed and coverage tier`

### Step 2: Cards
- **H2:** (implied — card count and declared value)
- **Quantity label:** (number input)
- **Declared value label:** (currency input)
- **Insurance display:** `Insured shipping: {tier.label} — £{price}`
- **Surcharge display:** `Insurance protection: {surcharge.label} (£{perCard}/card avg)`
- **Mismatch warning:** Amber border warning when per-card declared values don't sum to total

### Step 3: Review
- Order summary with all selected options

### Step 4: Shipping
- **Fields:** First Name, Last Name, Email, Phone, Address Line 1, Address Line 2, City, County, Postcode
- **Terms checkbox:** Required before payment

### Step 5: Payment
- **Stripe card element**
- **Button states:**
  - Default: `Pay £{amount}`
  - Loading: `Processing...`

### Crossover-specific fields
- Company select: `Select company...` (PSA, BGS, CGC, SGC, TAG, Other)
- Original grade input
- Cert number input

### Reholder-specific fields
- Company select: `Select company...`
- Reason select: `Select reason...` (Upgrade slab, Damaged slab, etc.)
- Condition select
- **Note:** `Reholdering applies to MintVault slabs only. Cards from other grading companies are subject to review. The original grade is retained unless a new grading service is also requested.`

### Authentication-specific fields
- Reason select: `Select reason...`
- Concerns textarea
- **Note:** `Authentication results in a certificate confirming the card is genuine. No condition grade is assigned. Cards found to be counterfeit will not be returned without prior arrangement.`

---

## `/track` — Track Submission

- **H1:** `TRACK YOUR SUBMISSION`
- **Description:** `Enter your submission ID and email address to check the status of your grading order.`
- **Input 1 placeholder:** `Submission ID (e.g. MV-SUB-001)`
- **Input 2 placeholder:** `Email address used at checkout`
- **Button:** `Track Submission` / `Looking up...` (loading)
- **Error:** `Submission not found. Please check your submission ID.`

### Status stages (tracking result)
| Key | Label |
|---|---|
| new | Submitted |
| received | Received |
| grading | Grading |
| dispatched | Dispatched |
| complete | Complete |

---

## `/cert` — Certificate Lookup

- **H1:** `CERTIFICATE LOOKUP`
- **Description:** `Verify the authenticity of any MintVault graded card. Enter the certificate number below.`
- **Input placeholder:** `e.g. MV3`
- **Button:** `Search`

---

## `/cert/:id` — Certificate Detail

- **Print watermark:** `MintVault Certified Copy`
- **Print header:** `MINTVAULT` (900 weight, 0.25em tracking)
- **Print subheader:** `Certificate of Authenticity`
- **QR size (screen):** 220px, correction level M, dark `#1a1100`, light `#ffffff`
- **Cert URL base:** `https://mintvaultuk.com/cert/`

---

## `/claim` — Claim Ownership

- **Icon:** Shield (gold, 48px)
- **H1:** `CLAIM YOUR CARD`
- **Subtitle:** `Register ownership of your MintVault graded card`
- **Card title:** `Ownership Claim`

### Form labels
| Field | Label | Placeholder | Helper text |
|---|---|---|---|
| certId | Certificate Number | `e.g. MV-2025-0042` | — |
| claimCode | Claim Code | `Enter your 12-character claim code` | `Your claim code was provided with your graded card or by MintVault directly.` |
| email | Your Email Address | `your@email.com` | `We'll send a verification link to confirm your ownership.` |

### Button
- Default: `CLAIM OWNERSHIP` (with Mail icon)
- Loading: `Submitting...` (with spinning Loader2 icon)

### How it works (footer)
1. Enter your certificate number and claim code
2. Provide your email address
3. Check your inbox for a verification link
4. Click the link to confirm ownership

### Result messages
- **Success (claim request):** Server-returned message (e.g. `Verification email sent to {email}. Please check your inbox to complete the claim.`)
- **Success (verification return):** `Ownership of certificate {certId} has been successfully claimed and linked to your email.`
- **Error (invalid code):** `Invalid certificate number or claim code.`
- **Error (already claimed):** `Invalid certificate number or claim code.` (deliberately same — security)
- **Error (missing fields):** `Certificate number, claim code, and email are required.`
- **Error (generic):** `An error occurred. Please try again.`

---

## `/why-mintvault` — Why MintVault

- **H1:** `WHY MINTVAULT`
- **Subtitle:** `Professional grading, premium encapsulation, and trusted verification — built for UK collectors.`

### Sections

| ID | Headline | Body text |
|---|---|---|
| why-grade | Why Grade Your Cards? | Professional grading protects your investment, increases buyer confidence, and creates verified market value. MintVault provides independent, consistent grading with secure tamper-evident encapsulation and full online certification lookup. |
| our-labels | Premium MintVault Labels | MintVault labels are designed for clarity, security, and prestige. Each label features a unique certificate number, QR verification, and anti-counterfeit design elements. |
| grading-scale | MintVault Grading Scale | Our grading system evaluates every card across multiple criteria to ensure consistent and transparent scoring. |
| population-report | Population Reporting | MintVault tracks graded cards to provide transparency in scarcity and grading distribution. Our population report shows how many cards have been graded at each level. |
| authority | Built for Collectors. Trusted by Investors. | MintVault combines professional grading standards with modern verification technology. Our goal is to provide collectors and investors with confidence, transparency, and long-term value protection. |

### Bullet points per section

**why-grade:** Independent multi-point grading system · Tamper-evident precision slab · Secure online verification · Long-term asset protection · Increased resale confidence

**our-labels:** Unique certification number · QR code verification · Clean professional layout · Anti-tamper slab integration · Premium gold-accent finish

**grading-scale:** Centering · Corners · Edges · Surface
- **Footer:** `Each card receives individual subgrades and an overall MintVault grade from 1 to 10, including half grades where applicable.`

**population-report:** Total graded count · Higher / Same / Lower comparisons · Market transparency · Updated regularly

---

## SEO Pages

### `/pokemon-card-grading-uk`
- **Title:** `Pokemon Card Grading UK | Professional Grading Service | MintVault`
- **H1:** `Pokemon Card Grading UK`

### `/trading-card-grading-uk`
- **Title:** `Trading Card Grading UK | Grade Pokemon, Yu-Gi-Oh & More | MintVault`
- **H1:** `Trading Card Grading UK`

### `/card-grading-service-uk`
- **Title:** `Card Grading Service UK | Professional Trading Card Grading | MintVault`
- **H1:** `Card Grading Service UK`

### `/psa-alternative-uk`
- **Title:** `PSA Alternative UK | UK Card Grading Service | MintVault`
- **H1:** `PSA Alternative UK`

### `/how-to-grade-pokemon-cards`
- **Title:** `How to Grade Pokemon Cards | Step-by-Step Guide | MintVault UK`
- **H1:** `How to Grade Pokemon Cards`

### `/tcg-grading-uk`
- **Title:** `TCG Grading UK | Professional Trading Card Game Grading | MintVault`
- **H1:** `TCG Grading UK`

---

## Schema.org Structured Data (homepage)

**Organization:**
- name: `MintVault UK`
- description: `Professional UK trading card grading service offering Pokémon, Yu-Gi-Oh!, Magic: The Gathering and TCG card grading with tamper-evident slabs and insured return shipping.`

**LocalBusiness:**
- description: `Professional Pokémon and trading card grading service in the UK. Expert grading on a 1–10 scale, tamper-evident precision slabs, and fully insured return shipping.`
- priceRange: `£12–£50 per card`
- serviceType: `Trading Card Grading`

**Offers (5):**
- Basic Grading £12.00
- Standard Grading £15.00
- Premier Grading £18.00
- Ultra Grading £25.00
- Elite Grading £50.00

**WebSite SearchAction:**
- target: `https://mintvaultuk.com/cert?q={search_term_string}`

---

## Supported Card Games (wizard + homepage)

Pokémon · Yu-Gi-Oh! · Magic: The Gathering · Dragon Ball Super · One Piece · Digimon · Flesh and Blood · Lorcana · Weiss Schwarz · Cardfight!! Vanguard · Final Fantasy TCG · Star Wars: Unlimited · MetaZoo · UniVersus · Other

---

*End of content inventory.*
