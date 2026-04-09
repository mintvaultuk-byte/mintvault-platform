# MintVault — Full Feature Inventory
**Date:** 2026-04-09  
**Type:** Read-only audit. No code changed.  
**Author:** Claude Code (automated audit)

---

## PART 1 — ROUTES INVENTORY

| Route | Component | Status | Description | API calls |
|---|---|---|---|---|
| `/` | `pages/home.tsx` | BUILT | Full homepage — hero, trust bar, AI checker CTA, features grid, comparison table, FAQ | `/api/featured-certificates` |
| `/pricing` | `pages/pricing.tsx` | BUILT | Full pricing table for all service tiers, FAQ section | `/api/service-tiers` |
| `/submit` | `pages/submit.tsx` | BUILT | 5-step submission flow with Stripe payment | `/api/create-payment-intent`, `/api/service-tiers`, `/api/cards/autofill` |
| `/submit/success` | `pages/submit-success.tsx` | BUILT | Post-payment confirmation screen | `/api/confirm-payment` |
| `/cert` | `pages/cert-lookup.tsx` | BUILT | Certificate lookup search | `/api/certs/search`, `/api/cert/:id` |
| `/cert/:id` | `pages/cert-detail.tsx` | BUILT | Public certificate detail page | `/api/cert/:id` |
| `/cert/:id/report` | `pages/grading-report.tsx` | BUILT | Full grading report (PDF-ready) | `/api/cert/:id/report` |
| `/vault/:certId` | `pages/vault-report.tsx` | BUILT | Full vault report — grade, ownership, eBay, NFC, defects | `/api/vault/:certId`, `/api/vault/:certId/ebay-prices` |
| `/population` | `pages/population.tsx` | BUILT | Population report with grade distribution | `/api/population` |
| `/population/certs` | `pages/pop-certs.tsx` | BUILT | Cert list for a specific card in population | `/api/population/certs` |
| `/claim` | `pages/claim.tsx` | BUILT | Ownership claim form — sends email verification | `/api/claim/request` |
| `/transfer` | `pages/transfer.tsx` | BUILT | Ownership transfer form — two-party email verification | `/api/transfer/request` |
| `/ownership` | `pages/ownership.tsx` | PARTIAL | Ownership portal (shows claimed certs for logged-in user) | `/api/customer/certificates` |
| `/dashboard` | `pages/dashboard.tsx` | BUILT | Customer dashboard — submissions, certs, Vault Club, Showroom | `/api/customer/me`, `/api/customer/submissions`, `/api/customer/certificates`, `/api/vault-club/me`, `/api/showroom-me` |
| `/stolen-card-protection` | `pages/stolen-card-protection.tsx` | BUILT | Report + check stolen cards — functional form with email verification | `/api/stolen/report`, `/api/stolen/status/:certId` |
| `/club` | `pages/club.tsx` | BUILT | Vault Club subscription page with Stripe checkout | `/api/vault-club/me`, `/api/vault-club/checkout`, `/api/vault-club/portal` |
| `/showrooms` | `pages/showrooms.tsx` | BUILT | Public list of collector showrooms | `/api/showrooms` |
| `/showroom/:username` | `pages/showroom.tsx` | BUILT | Individual collector's public card collection | `/api/showroom/:username` |
| `/tools/estimate` | `pages/tools/estimate.tsx` | BUILT | AI Pre-Grade Checker — uploads card photo, calls Claude | `/api/tools/estimate`, `/api/tools/estimate/credits`, `/api/tools/estimate/checkout` |
| `/track` | `pages/track.tsx` | BUILT | Submission tracker by ID + email | `/api/submissions/:submissionId/track` |
| `/grading-scale` | `pages/grading-scale.tsx` | BUILT | Full grading scale 1–10, AA, NO — real content, styled table | None |
| `/grading-glossary` | `pages/grading-glossary.tsx` | BUILT | 11+ defined terms with full descriptions | None |
| `/grading/eligible-cards` | `pages/grading/eligible-cards.tsx` | BUILT | Eligible card types content page | None |
| `/how-it-works` | `pages/how-it-works.tsx` | BUILT | 5-step process explainer with animations | None |
| `/about/our-story` | `pages/about/our-story.tsx` | BUILT | Company story content page | None |
| `/about/the-mintvault-slab` | `pages/about/the-mintvault-slab.tsx` | BUILT | Branded slab components — VaultLock™, MintSeal™ etc. | None |
| `/vault-reports/about` | `pages/vault-reports/about.tsx` | BUILT | What is a Vault Report — explanation page | None |
| `/vault-reports/how-to-read` | `pages/vault-reports/how-to-read.tsx` | BUILT | How to read a Vault Report — guide page | None |
| `/why-mintvault` | `pages/why-mintvault.tsx` | BUILT | Value proposition page | None |
| `/help/faq` | `pages/help/faq.tsx` | BUILT | FAQ content page | None |
| `/help/contact` | `pages/help/contact.tsx` | BUILT | Contact form + info | None |
| `/login` | `pages/login.tsx` | BUILT | Email+password + magic link dual login | `/api/auth/login`, `/api/auth/magic-link` |
| `/signup` | `pages/signup.tsx` | BUILT | Account registration with email verification | `/api/auth/signup` |
| `/forgot-password` | `pages/forgot-password.tsx` | BUILT | Password reset request form | `/api/auth/forgot-password` |
| `/reset-password` | `pages/reset-password.tsx` | BUILT | New password form (token-gated) | `/api/auth/reset-password` |
| `/verify-email` | `pages/verify-email.tsx` | BUILT | Email verification landing page | `/api/auth/verify-email` |
| `/account/settings` | `pages/account-settings.tsx` | BUILT | Profile, password, email, delete account tabs | `/api/auth/me`, `/api/auth/change-password`, `/api/auth/change-email`, `/api/auth/profile`, `/api/auth/delete-account` |
| `/guides` | `pages/guides.tsx` | PARTIAL | Guides listing page | `/api/guides` (or static) |
| `/guides/:slug` | `pages/guide-detail.tsx` | PARTIAL | Individual guide page | `/api/guides/:slug` |
| `/terms-and-conditions` | `pages/terms.tsx` | BUILT | Terms content page | None |
| `/liability-and-insurance` | `pages/liability.tsx` | BUILT | Liability page content | None |
| `/nfc/:certId` | `pages/nfc-redirect.tsx` | BUILT | NFC scan handler — increments scan count, redirects | `/api/nfc/:certId` |
| `/admin` | `pages/admin` (directory) | BUILT | Full admin panel — 2-step auth, submissions, certs, grading, printing | Many `/api/admin/*` endpoints |
| `/upload/:certId/:imageType` | `pages/mobile-upload.tsx` | BUILT | Mobile phone image capture for admin grading | `/api/upload/:certId/:imageType` |
| `/labels` | `pages/labels.tsx` | BUILT | Admin label management page | `/api/admin/printing/*` |
| `/reports` | `pages/reports.tsx` | BUILT | Admin analytics/stats | `/api/admin/stats` |
| `/api-docs` | `pages/api-docs.tsx` | PLACEHOLDER | API documentation page — likely static content | None |
| `/tcg` | `pages/tcg.tsx` | UNKNOWN | TCG-related page | Unknown |
| SEO pages (10+) | `pages/seo/*.tsx` | PLACEHOLDER | SEO landing pages for keyword targeting | None |

### Routes outside Layout wrapper
- `/admin` — no Layout (full-screen admin)
- `/upload/:certId/:imageType` — no Layout (minimal mobile upload screen)
- `/nfc/:certId` — no Layout (redirect-only)
- `/` — no Layout (homepage has its own full-bleed structure)

---

## PART 2 — DATABASE TABLES INVENTORY

| Table | Purpose | Row count | Actively written | Actively read | Status |
|---|---|---|---|---|---|
| `users` | Account system — email, auth, Vault Club columns, showroom | 25 | YES — signup, OAuth, webhook | YES — auth, dashboard, showroom | ACTIVE |
| `submissions` | Grading submission orders | 316 | YES — submit flow | YES — admin, customer tracking | ACTIVE |
| `submission_items` | Individual cards within a submission | 5 | YES — submit flow | YES — admin | ACTIVE (low usage) |
| `certificates` | Graded certificates — grades, defects, status | 123 | YES — admin grading | YES — vault, cert lookup | ACTIVE |
| `certificate_images` | Front/back images for certs (R2 keys) | 4 | YES — admin upload | YES — vault report, labels | ACTIVE (low) |
| `cards` | Card database (name, set, number, rarity) | 221 | Rarely — import | YES — cert pages, admin | ACTIVE |
| `card_sets` | Card sets metadata | 1 | Rarely | YES — admin | ACTIVE |
| `card_master` | Pokemon TCG card master data | 1 | Rarely | YES — autofill | ACTIVE |
| `card_images` | Card reference images | Unknown | Import | Unknown | LIKELY ACTIVE |
| `tiers` | Legacy grading tiers | 5 | NO | Possibly | LEGACY (superseded by service_tiers) |
| `service_tiers` | Current service tiers — prices, turnaround, maxValue | 8 | YES — admin pricing | YES — submit flow | ACTIVE |
| `tier_capacity` | Max concurrent submissions per tier | 3 | YES — admin | YES — submit flow capacity check | ACTIVE |
| `ownership_history` | Log of ownership claim/transfer events | 1 | YES — claim/transfer | YES — vault report | ACTIVE |
| `claim_verifications` | Email verification tokens for ownership claims | 2 | YES — claim flow | YES — claim verify | ACTIVE |
| `transfer_verifications` | Email tokens for ownership transfers | 0 | YES — transfer flow | YES — transfer verify | ACTIVE (empty) |
| `stolen_reports` | Stolen card reports | 0 | YES — report endpoint | YES — vault report, stolen check | ACTIVE (no reports yet) |
| `ebay_price_cache` | Cached eBay price data (24h TTL) | 0 | YES — eBay fetch | YES — vault report | ACTIVE (never populated yet) |
| `audit_log` | Admin action audit trail | 293 | YES — all admin actions | YES — admin | ACTIVE |
| `label_prints` | Label print job records | 53 | YES — printing workflow | YES — printing admin | ACTIVE |
| `label_overrides` | Per-cert display field overrides | 5 | YES — admin override UI | YES — label generation | ACTIVE |
| `reprint_log` | Reprint tracking | 1 | YES — reprint | YES — admin | ACTIVE |
| `estimate_credits` | Email-based AI estimate credits (legacy, pre-auth) | 1 | YES — estimate endpoint | YES — estimate endpoint | ACTIVE |
| `ai_grade_corrections` | Human corrections to AI grades (ML training) | 0 | Not yet | Not yet | BUILT, UNUSED |
| `grading_sessions` | Admin grading session timing data | 0 | NO | YES — learning analytics | BUILT, UNUSED |
| `ai_accuracy_log` | AI vs human grade comparison log | 0 | NO | YES — learning analytics | BUILT, UNUSED |
| `vault_club_events` | Stripe subscription event log | 0 | YES — webhook | YES — audit | ACTIVE (no subscribers yet) |
| `reholder_credits` | Reholder credits granted per subscription | 0 | YES — webhook | YES — Vault Club | ACTIVE (no subscribers yet) |
| `password_reset_tokens` | Password reset email tokens | 0 | YES — forgot-password | YES — reset-password | ACTIVE |
| `email_verification_tokens` | Email verification tokens | 2 | YES — signup | YES — verify-email | ACTIVE |
| `account_magic_link_tokens` | Account magic link tokens | Not counted | YES — magic-link | YES — verify | ACTIVE |
| `login_attempts` | Failed login attempt tracking (brute force) | Not counted | YES — login | YES — login | ACTIVE |

---

## PART 3 — API ENDPOINTS INVENTORY

### Grading / Submission
| Endpoint | Purpose | Called from | Status |
|---|---|---|---|
| `GET /api/service-tiers` | Public pricing tiers | submit.tsx, pricing.tsx | BUILT |
| `GET /api/capacity` | Current slot availability per tier | submit.tsx | BUILT |
| `GET /api/stripe/publishable-key` | Stripe key for frontend | submit.tsx | BUILT |
| `POST /api/create-payment-intent` | Create Stripe PaymentIntent + submission record | submit.tsx | BUILT |
| `POST /api/confirm-payment` | Confirm payment, mark paid, send email | submit-success.tsx | BUILT |
| `GET /api/submissions/:id` | Public submission status | track.tsx | BUILT |
| `POST /api/submissions/:id/track` | Track by ID+email | track.tsx | BUILT |
| `GET /api/submissions/:id/packing-slip` | Packing slip HTML (token-auth) | dashboard.tsx, admin | BUILT |
| `GET /api/submissions/:id/shipping-label` | Shipping label (token-auth) | dashboard.tsx | BUILT |
| `POST /api/submissions/:id/customer-tracking` | Customer saves outbound tracking number | dashboard.tsx | BUILT |
| `GET /api/submissions/me` | Auth user's submissions | dashboard.tsx | BUILT |
| `GET /api/customer/submissions` | Magic-link session submissions | dashboard.tsx | BUILT |

### Vault / Certificate (Public)
| Endpoint | Purpose | Called from | Status |
|---|---|---|---|
| `GET /api/cert/:id` | Public cert data | cert-detail.tsx, cert-lookup.tsx | BUILT |
| `GET /api/cert/:id/report` | Full grading report JSON | grading-report.tsx | BUILT |
| `GET /api/cert/:id/report/pdf` | Downloadable PDF report | cert-detail.tsx | BUILT |
| `GET /api/cert/:id/population` | Grade distribution for card | cert-detail.tsx | BUILT |
| `GET /api/certs/search` | Full-text cert search | cert-lookup.tsx | BUILT |
| `GET /api/featured-certificates` | Recent certs for homepage | home.tsx | BUILT |
| `GET /api/vault/:certId` | Full vault report payload | vault-report.tsx | BUILT |
| `GET /api/vault/:certId/ebay-prices` | eBay price data (cached 24h) | vault-report.tsx | BUILT |
| `GET /api/v1/verify/:certId` | Public verification API | External / QR scans | BUILT |
| `GET /api/population` | Population stats | population.tsx | BUILT |
| `GET /api/population/certs` | Certs for population drill-down | pop-certs.tsx | BUILT |

### Ownership / Claim / Transfer
| Endpoint | Purpose | Called from | Status |
|---|---|---|---|
| `POST /api/claim/request` | Start ownership claim — sends email | claim.tsx | BUILT |
| `GET /api/claim/verify` | Verify claim via email token | Email link redirect | BUILT |
| `POST /api/transfer/request` | Start transfer — notifies current owner | transfer.tsx | BUILT |
| `GET /api/transfer/owner-confirm` | Current owner confirms via token | Email link redirect | BUILT |
| `GET /api/transfer/new-owner-confirm` | New owner confirms → transfer complete | Email link redirect | BUILT |
| `GET /api/customer/certificates` | Certs owned by customer session | dashboard.tsx | BUILT |

### Stolen Card Registry
| Endpoint | Purpose | Called from | Status |
|---|---|---|---|
| `POST /api/stolen/report` | File stolen report → sends email | stolen-card-protection.tsx | BUILT |
| `GET /api/stolen/verify/:token` | Verify report via email link | Email link redirect | BUILT |
| `GET /api/stolen/status/:certId` | Check if cert is flagged stolen | stolen-card-protection.tsx, vault report | BUILT |
| `GET /api/admin/stolen` | Admin list of active stolen flags | admin | BUILT |
| `POST /api/admin/stolen/:certId/clear` | Admin clears stolen flag | admin | BUILT |

### AI Pre-Grade Checker
| Endpoint | Purpose | Called from | Status |
|---|---|---|---|
| `POST /api/tools/estimate` | Upload image → Claude estimate → deduct credit | tools/estimate.tsx | BUILT |
| `GET /api/tools/estimate/credits` | Check remaining credits | tools/estimate.tsx | BUILT |
| `POST /api/tools/estimate/checkout` | Stripe checkout for credit packs | tools/estimate.tsx | BUILT |

### Population
| Endpoint | Purpose | Called from | Status |
|---|---|---|---|
| `GET /api/population` | Aggregate population data | population.tsx | BUILT |
| `GET /api/population/certs` | Cert list for a card | pop-certs.tsx | BUILT |

### Admin — Submissions
| Endpoint | Purpose | Status |
|---|---|---|
| `GET /api/admin/submissions` | List with filters | BUILT |
| `GET /api/admin/submissions/export-csv` | CSV export | BUILT |
| `GET /api/admin/submissions/:id` | Single submission + items | BUILT |
| `POST /api/admin/submissions/:id/status` | Advance status, trigger emails | BUILT |
| `POST /api/admin/submissions/:id/mark-received` | Mark received + upload photos | BUILT |
| `PATCH /api/admin/submissions/:id/items/:itemId` | Edit card details | BUILT |
| `PATCH /api/admin/submissions/:id/notes` | Admin notes + flagged | BUILT |
| `POST /api/admin/submissions/:id/return-label` | Record return tracking | BUILT |

### Admin — Certificates
| Endpoint | Purpose | Status |
|---|---|---|
| `GET /api/admin/certificates` | List certs | BUILT |
| `PUT /api/admin/certificates/:id/grade` | Set subgrades + centering | BUILT |
| `PUT /api/admin/certificates/:id/approve` | Approve → status active | BUILT |
| `PUT /api/admin/certificates/:id/approve-grade` | Approve + promote AI defects → verified | BUILT |
| `POST /api/admin/certificates/:id/analyze` | AI grade analysis via Claude | BUILT |
| `POST /api/admin/certificates/:id/identify` | AI card identification | BUILT |
| `POST /api/admin/certificates/:id/nfc` | Write NFC data | BUILT |
| `GET /api/admin/certificates/:id/label/:side` | Generate label PNG | BUILT |
| `GET /api/admin/certificates/:certId/certificate-document` | Official certificate PDF | BUILT |
| `GET /api/admin/certificates/:certId/claim-insert` | Claim insert PNG/PDF | BUILT |

### Admin — Printing
| Endpoint | Purpose | Status |
|---|---|---|
| `GET /api/admin/printing/queue` | Print queue | BUILT |
| `POST /api/admin/printing/generate-sheet` | Generate sheet PDF | BUILT |
| `POST /api/admin/printing/mark-printed` | Mark printed | BUILT |
| `POST /api/admin/printing/reprint/:certId` | Reprint single | BUILT |

### Admin — Auth / Config
| Endpoint | Purpose | Status |
|---|---|---|
| `POST /api/admin/login` | Password challenge | BUILT |
| `POST /api/admin/pin` | PIN verification | BUILT |
| `GET /api/admin/db-info` | DB stats | BUILT |
| `GET /api/admin/stats` | Dashboard stats | BUILT |
| `GET /api/admin/service-tiers` | List tiers | BUILT |
| `PUT /api/admin/service-tiers/:id` | Update tier pricing | BUILT |
| `PUT /api/admin/capacity/:tierSlug` | Set capacity limits | BUILT |

### Authentication / Users
| Endpoint | Purpose | Status |
|---|---|---|
| `POST /api/auth/signup` | Register account | BUILT |
| `POST /api/auth/login` | Login with password | BUILT |
| `POST /api/auth/magic-link` | Send magic link | BUILT |
| `GET /api/auth/magic-link/verify` | Verify magic link | BUILT |
| `POST /api/auth/forgot-password` | Send reset email | BUILT |
| `POST /api/auth/reset-password` | Reset password via token | BUILT |
| `GET /api/auth/verify-email` | Verify email | BUILT |
| `GET /api/auth/me` | Current user | BUILT |
| `PUT /api/auth/change-password` | Change password | BUILT |
| `PUT /api/auth/change-email` | Change email | BUILT |
| `PUT /api/auth/profile` | Update display name | BUILT |
| `DELETE /api/auth/delete-account` | Soft delete + anonymise | BUILT |
| `POST /api/customer/magic-link` | Legacy magic link (customer session) | BUILT |
| `GET /api/customer/verify/:token` | Verify customer session | BUILT |
| `GET /api/customer/me` | Customer session info | BUILT |

### Stripe / Payment
| Endpoint | Purpose | Status |
|---|---|---|
| `POST /api/create-payment-intent` | Create submission + PaymentIntent | BUILT |
| `POST /api/confirm-payment` | Mark paid, send confirmation | BUILT |
| `POST /api/tools/estimate/checkout` | Estimate credits purchase | BUILT |
| `POST /api/vault-club/checkout` | Vault Club subscription | BUILT |
| `POST /api/vault-club/portal` | Stripe billing portal | BUILT |
| `POST /api/stripe/webhook` | Stripe webhook handler | BUILT |

### Showroom / Vault Club
| Endpoint | Purpose | Status |
|---|---|---|
| `GET /api/vault-club/me` | Current subscription | BUILT |
| `GET /api/vault-club/check-discount` | Grading discount % | BUILT |
| `GET /api/showroom/:username` | Public showroom | BUILT |
| `GET /api/showrooms` | List all showrooms | BUILT |
| `POST /api/showroom/claim` | Claim username | BUILT |
| `PUT /api/showroom/settings` | Update bio | BUILT |
| `GET /api/showroom-me` | Current user's showroom | BUILT |

---

## PART 4 — KEY FEATURE DEEP DIVE

### 1. Submitting a card for grading
**Works end-to-end.** A user visits `/submit`, selects service type (Grading/Crossover/Reholder/Authentication), fills in card details and count, enters their email + return address, then hits the payment screen. Stripe PaymentIntent is created on the server which also creates a submission record with `paymentStatus=pending`. Stripe.js handles the card input client-side. On success, the page redirects to `/submit/success` which calls `POST /api/confirm-payment`. The webhook handler (`payment_intent.succeeded`) also runs as a backup, calling `markSubmissionAsPaid()` and `setEstimatedCompletionDate()` (based on tier: Standard 20 days, Priority 10, Express 5 working days). A confirmation email is sent via Resend. Vault Club discounts are applied at PaymentIntent creation time via `check-discount` endpoint.

### 2. Viewing a Vault report
**Works with live data.** `/vault/MV1` (or any certId) calls `GET /api/vault/:certId`. This endpoint returns: card name, set, grade, all subgrades, defect list (with verified_defects promoted from AI), centering data, NFC status, ownership history, population data, and `stolenStatus`. eBay prices are a separate call (`GET /api/vault/:certId/ebay-prices`) with 24h caching. The eBay feature uses real API credentials (EBAY_APP_ID/CERT/DEV_ID confirmed in Fly.io secrets) but the cache table has 0 rows, meaning it hasn't been hit yet in production. Images are served from Cloudflare R2 via presigned URLs.

### 3. Claiming ownership of a card
**Works end-to-end.** User visits `/claim`, enters their certId and email. `POST /api/claim/request` checks the cert exists + is active + has a claim_code. If the code matches, it creates a `claim_verifications` record and sends an email with a token link. When the user clicks the link, `GET /api/claim/verify?token=...` verifies the token, updates `certificates.owner_email`, inserts into `ownership_history`, and deletes the token. There are 2 rows in `claim_verifications` — either 2 people have tried to claim, or 2 completed claims exist (ownership_history has 1 row).

### 4. Transferring ownership
**Works end-to-end with two-party confirmation.** Three steps: (1) Current owner requests transfer, sends email to current owner to confirm they intend to transfer. (2) Current owner clicks confirm link. (3) New owner receives email and clicks confirm. Both confirmation tokens are stored in `transfer_verifications`. 0 rows currently — no transfers have been initiated in production.

### 5. Reporting a card as stolen
**Fully functional.** The `/stolen-card-protection` page has a working form that POSTs to `POST /api/stolen/report`. This inserts into `stolen_reports` and sends an email with a verification link. When clicked, `GET /api/stolen/verify/:token` sets `certificates.stolen_status = 'verified'` and `stolen_reported_at`. The vault report and public cert page both surface the stolen status. Admin can view flags at `GET /api/admin/stolen` and clear them. Currently 0 stolen reports in production — feature is built but never used.

### 6. AI Pre-Grade Checker
**Fully functional.** User visits `/tools/estimate`, uploads a card photo. The frontend calls `POST /api/tools/estimate` with the image. Server: (1) checks credit balance, (2) resizes image with sharp (max 1500×1500), (3) sends base64 image to Anthropic API using `claude-haiku-4-5-20251001` with a detailed grading prompt, (4) parses JSON response containing estimated grade, centering notes, corner notes, edge notes, surface notes, (5) deducts 1 credit, (6) returns result. `ANTHROPIC_API_KEY` is confirmed in Fly.io secrets. The first estimate is free (1 free credit). Additional credits purchasable via Stripe. `estimate_credits` table has 1 row — one email has purchased/used credits.

### 7. Admin grading workflow
**Fully built.** An admin logs in via `/admin` with email + ADMIN_PASSWORD, then ADMIN_PIN (6-digit). Once in:
- Sees submission list — filterable by status, date, searchable by name/email
- Can advance submission status: new → received → in_grading → ready_to_return → shipped → completed
- On "mark received" — can upload up to 6 receipt photos (uploaded to R2)
- Can create a certificate record, use mobile upload (`/upload/:certId/:imageType`) to capture front/back images on a phone
- AI grading: `POST /api/admin/certificates/:id/analyze` calls Claude Vision to suggest grades and identify defects
- Admin reviews AI suggestion, manually enters or adjusts grades
- `PUT /api/admin/certificates/:id/approve-grade` promotes AI defects to verified and sets status active
- Label generation: PNG labels (827×236px @300DPI) generated on-server via canvas; sheet PDFs generated via pdfkit
- Print queue management — mark sheets as printed, generate cut-mark sheets
- NFC data can be written to cert record (`/nfc` endpoints)
- 53 rows in `label_prints`, 5 in `label_overrides`, 1 in `reprint_log` — print workflow has been used in production

### 8. Pop report / leaderboard
**Live database data.** `GET /api/population` queries `certificates` table and aggregates grade counts per card. The population page renders this with a search/filter UI. The `population/certs` drill-down queries live cert data. All data from database — nothing hardcoded. 123 certs in database.

### 9. eBay listings on Vault report
**Built but never triggered in production.** The code is fully written in `server/ebay.ts`. It uses the eBay Browse API (`EBAY_APP_ID`, `EBAY_CERT_ID`, `EBAY_DEV_ID` all confirmed in Fly.io secrets). The `ebay_price_cache` table has **0 rows** — meaning no vault report has successfully fetched eBay data yet. Possible explanations: (a) the eBay API key is configured but not yet activated for the Browse API, (b) no vault report has been loaded on the live domain since the eBay feature was deployed. Results are cached 24h per certId once they start flowing.

### 10. Vault Club / Showroom
**Fully built, no subscribers yet.** The full Stripe subscription system exists: 3 tiers × 2 billing intervals = 6 Stripe prices. Stripe webhooks handle subscription creation, updates, cancellation, payment failures, and monthly credit refills. Users table has all Vault Club columns (tier, status, renews_at, cancels_at, grace_until, AI credits). `vault_club_events` table has 0 rows — no one has subscribed yet in production. Showroom is gated by `showroom_active = true` which is set when a Vault Club subscription activates. The showroom page at `/showroom/:username` renders a user's graded cards from the DB. `showrooms.tsx` lists all active showrooms. No showrooms claimed yet (0 rows in vault_club_events, users table has 25 rows but likely all `showroom_active = false`).

---

## PART 5 — ENVIRONMENT VARIABLES CROSS-CHECK

From `flyctl secrets list --app mintvault`:

| Secret | Status | Notes |
|---|---|---|
| `MINTVAULT_DATABASE_URL` | ✅ Deployed | |
| `SESSION_SECRET` | ✅ Deployed | |
| `SIGNED_URL_SECRET` | ✅ Deployed | |
| `ADMIN_PASSWORD` | ✅ Deployed | |
| `ADMIN_PIN` | ✅ Deployed | |
| `STRIPE_SECRET_KEY` | ✅ Deployed | |
| `STRIPE_PUBLISHABLE_KEY` | ✅ Deployed | |
| `STRIPE_WEBHOOK_SECRET` | ✅ Deployed | |
| `ANTHROPIC_API_KEY` | ✅ Deployed | |
| `RESEND_API_KEY` | ✅ Deployed | |
| `R2_ENDPOINT` | ✅ Deployed | |
| `R2_ACCESS_KEY_ID` | ✅ Deployed | |
| `R2_SECRET_ACCESS_KEY` | ✅ Deployed | |
| `R2_BUCKET_NAME` | ✅ Deployed | |
| `EBAY_APP_ID` | ✅ Deployed | |
| `EBAY_DEV_ID` | ✅ Deployed | |
| `EBAY_CERT_ID` | ✅ Deployed | |
| `APP_URL` | ✅ Deployed | Used for email callback URLs |
| `POKEMON_TCG_API_KEY` | ✅ Deployed | Used for card autofill |
| `RESEND_DOMAIN_VERIFIED` | ✅ Deployed | Flag for domain verification state |

**Missing / suspicious:**
- `STRIPE_WEBHOOK_SECRET_2` — referenced in `webhookHandlers.ts` as optional second webhook secret for DNS cutover scenarios. Not in Fly.io secrets. This is fine — it's optional.
- No `REPLIT_DOMAINS` or `REPLIT_DEV_DOMAIN` — referenced in CLAUDE.md as used for webhook URL registration. Not in Fly.io secrets — Fly.io doesn't use Replit's connector system. The code in `server/stripeClient.ts` fetches the Stripe secret key from Fly.io secrets (`STRIPE_SECRET_KEY`) directly, not from Replit's Connectors API. This is correct.

**All critical secrets are deployed.**

---

## PART 6 — LIVE vs LOCAL

### Machine status
Both machines on image `mintvault:deployment-01KNRDXXA4FAP6F6W2MQ0M1RC4`, version 163, region `lhr`, state `started`, health checks passing. **Both machines are in sync.**

### Uncommitted local changes
`git status` shows **many modified files** — essentially the entire codebase has local modifications that have never been committed to git. This means:
- Git history does not reflect what's actually deployed
- There is no clean rollback point via git
- The deployed code on Fly.io matches the local working directory (last deploy was this session)
- But if something breaks, `git checkout .` would revert to an OLDER state, not the current deployed state

**⚠️ WARNING: The local codebase has no clean git commits for the current state. All changes since the initial commit have been deployed directly via `flyctl deploy` without `git commit`. This is a risk — there is no git-based rollback for any of the recent work.**

---

## PART 7 — SUMMARY TABLE

| Feature | Status | Notes |
|---|---|---|
| Homepage | BUILT | Full Manrope typography, trust bar, AI checker CTA, featured certs |
| Submit flow (grading) | BUILT | All service types work, Stripe PaymentIntent, confirmation email |
| Submit flow (crossover) | BUILT | Extra fields for crossover company/cert/grade |
| Submit flow (reholder) | BUILT | Extra fields; Vault Club members get free reholder credits |
| Submit flow (authentication) | BUILT | Extra fields for auth reason/concerns |
| Vault report | BUILT | 9+ sections, live data, NFC status, defects, ownership history |
| Certificate lookup | BUILT | Search by certId or card name |
| Certificate public page | BUILT | Grade display, images, PDF download |
| Grading report PDF | BUILT | 2-page PDF with images embedded from R2 |
| eBay prices on Vault | PARTIAL | Code fully built, real API keys set, but 0 cache hits in production — unconfirmed working |
| Population report | BUILT | Live DB data, grade distribution, drill-down to cert list |
| Ownership claim | BUILT | Two-step email verification, works end-to-end |
| Ownership transfer | BUILT | Three-step, two-party email verification |
| Stolen card protection | BUILT | Full report form, email verification, vault page integration — never used in production |
| Customer dashboard | BUILT | Submissions, certs, Vault Club section, Showroom section, 7-step tracker |
| Submission tracker | BUILT | 7-step progress bar driven by timestamps |
| Vault Club subscriptions | BUILT | Full Stripe subscription system, 3 tiers, webhooks — 0 subscribers yet |
| Showroom (collector profile) | BUILT | Username claim, public card display — 0 claimed showrooms yet |
| Showrooms list | BUILT | Paginated list of all showrooms — empty in production |
| AI Pre-Grade Checker | BUILT | Real Claude Vision call (haiku model), credit system, Stripe purchase — 1 user has used it |
| Label generation (PNG) | BUILT | Canvas-based front + back labels at 300 DPI |
| Label generation (PDF) | BUILT | pdfkit wrapping for print sheets |
| Admin login (2-step) | BUILT | Password + 6-digit PIN → session |
| Admin submissions | BUILT | Full workflow — filter, view, status advance, photo upload |
| Admin grading | BUILT | Manual grade entry + AI analysis via Claude Vision |
| Admin cert approve | BUILT | Approve grade, promote AI defects to verified |
| Admin printing | BUILT | Queue, sheet generation, mark printed, reprint — actively used (53 prints) |
| Admin NFC management | BUILT | Write/lock/verify NFC chips on certs |
| Admin capacity gating | BUILT | Set max concurrent submissions per tier |
| Admin service tier pricing | BUILT | Edit prices, turnaround, maxValue |
| Admin label overrides | BUILT | Per-cert display overrides for label text |
| Admin analytics / stats | BUILT | Grade distribution, cert counts, recent activity |
| Admin AI learning analytics | BUILT | Accuracy tracking — 0 rows in DB, never used |
| Admin stolen cards | BUILT | View and clear stolen flags — 0 reports so far |
| Slab label (physical product) | BUILT | Front + back label PNG at 827×236px @300DPI |
| Claim insert card | BUILT | Separate claim insert PDF for packing |
| Official certificate PDF | BUILT | Full certificate document with branding |
| Email — submission confirmation | BUILT | Sent on payment via Resend |
| Email — cards received | BUILT | Sent when admin marks received (with photo thumbnails) |
| Email — grading complete | BUILT | Sent on ready_to_return / completed status |
| Email — shipped | BUILT | Sent with Royal Mail tracking number |
| Email — delivered | BUILT | Sent when marked delivered |
| Email — Vault Club welcome | BUILT | Sent on subscription |
| Email — Vault Club cancelled | BUILT | Sent on subscription cancellation |
| Email — payment failed | BUILT | Sent on invoice failure |
| Email — claim verification | BUILT | Sent to verify ownership claim |
| Email — transfer verification | BUILT | Sent to both parties for transfer |
| Email — stolen report verify | BUILT | Sent to verify stolen report |
| Account system (full) | BUILT | Signup, login, magic link, password reset, email verify, change email/password, delete |
| NFC redirect handling | BUILT | `/nfc/:certId` increments scan count, redirects to vault |
| Mobile image upload | BUILT | Admin can send phone link to capture front/back images |
| SEO landing pages | PLACEHOLDER | 10+ static keyword pages, no backend |
| Grading scale page | BUILT | Complete with all grades, descriptions, criteria |
| Grading glossary | BUILT | 11+ defined terms |
| Eligible cards page | BUILT | Content page for supported card types |
| How it works | BUILT | 5-step animated explainer |
| About / Our story | BUILT | Content page |
| The MintVault Slab | BUILT | Branded component breakdown (VaultLock, MintSeal, etc.) |
| Why MintVault | BUILT | Value prop comparison page |
| Vault Reports — About | BUILT | Explanation page |
| Vault Reports — How to Read | BUILT | Guide page |
| Help / FAQ | BUILT | Content page |
| Help / Contact | BUILT | Contact form + info |
| Terms & Conditions | BUILT | Content page |
| Liability & Insurance | BUILT | Content page |
| Guides | PARTIAL | Listing + detail pages exist — need to verify if guides are seeded in DB or static |
| API Docs | PLACEHOLDER | Page exists, likely static content |
| Public Verification API | BUILT | `GET /api/v1/verify/:certId` — CORS-open, rate-limited, for third-party integrations |

---

## BROKEN NOW — Items Flagged for Attention

### 🚨 HIGH: No git commits for current codebase state
Every deployed file has local modifications with no git commit. `git checkout .` would revert to an older version and lose all recent work. **Recommend: `git add -A && git commit -m "Checkpoint: full feature build"` before next session.**

### ⚠️ MEDIUM: eBay prices unconfirmed in production
`ebay_price_cache` has 0 rows. The eBay Browse API credentials are set in Fly.io, but it's unknown whether they're provisioned for the Browse API scope (separate from Trading/Finding API). If the Browse API call fails silently, vault reports just show no eBay data without an error. Recommend: manually trigger a vault report on the live site and check server logs for any eBay API errors.

### ⚠️ MEDIUM: `submission_items` has only 5 rows vs 316 submissions
The submit flow creates submission items (individual card details per submission). 316 submissions but only 5 items suggests most submissions were created before the item system was added, OR the item insert is silently failing. Recommend: check recent submissions in admin to verify items are being created.

### ⚠️ LOW: `tiers` table (5 rows) appears to be legacy
The active pricing data is in `service_tiers` (8 rows). The original `tiers` table in schema.ts looks like an older version. Some admin code may still reference it. No immediate breakage but worth cleaning up.

### ⚠️ LOW: `RESEND_DOMAIN_VERIFIED` secret exists but purpose unclear
CLAUDE.md mentions Resend domain verification was pending. A custom secret `RESEND_DOMAIN_VERIFIED` is in Fly.io. Check `server/email.ts` to confirm the from-address is sending from a verified domain, not the sandbox address.

### ℹ️ INFO: Vault Club and Showroom are fully built but have 0 users
`vault_club_events`: 0 rows. `reholder_credits`: 0 rows. No one has subscribed to Vault Club in production yet. The system is ready but untested with real Stripe webhooks in production. Recommend: do a test subscription with a real (or test-mode) Stripe card before launching publicly.

### ℹ️ INFO: AI learning features built but unused
`ai_grade_corrections`, `grading_sessions`, `ai_accuracy_log` all have 0 rows. The accuracy tracking system (admin learning analytics) is built but hasn't captured any data. Likely the grading session timing code needs to be triggered manually by admin during grading.

---

*End of inventory. Generated 2026-04-09.*
