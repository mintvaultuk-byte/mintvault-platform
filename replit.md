# MintVault - Professional Card Grading Service

## Overview
MintVault is a UK-based trading card grading service offering professional grading with a focus on a mobile-first, black and gold themed user interface. The project aims to provide a robust platform for card collectors to submit cards for grading, track their orders, and view graded card certificates, with a strong emphasis on data integrity, security, and a streamlined submission process. Key capabilities include a multi-step submission wizard, public certificate lookup, and an admin portal for managing certificates, pricing, and system data.

## User Preferences
I prefer clear, concise summaries and direct answers. For coding tasks, I value well-structured, readable code with a focus on maintainability and performance. I expect the agent to ask for clarification when ambiguities arise and to propose solutions with a brief explanation of the trade-offs. I prefer an iterative development approach, where changes are made in small, verifiable steps. Do not make changes to the `server/config.ts` file without explicit instruction and a thorough review of its implications.

## System Architecture
MintVault is built as a Single Page Application (SPA) using React with Wouter for routing, styled with Tailwind CSS and Shadcn UI components. The backend is an Express.js API server. Data persistence is handled by PostgreSQL, accessed via Drizzle ORM. Stripe is integrated for payment processing using one-time Payment Intents. Cloudflare R2 is utilized for storing card images and labels, served via presigned URLs. Authentication for the admin portal is session-based with a 2-step login process (password + PIN). The UI/UX features a custom black background with gold accents, designed to be mobile-first.

**Key Technical Implementations:**
- **Certificate Management:** CRUD operations for certificates (create, update, void), with no hard deletes. Voided certificates are permanently marked but remain auditable.
- **Grading System:** Supports integer-only grades from 1-10, plus "Authentic Only" (NO) and "Authentic Altered" (AA). Subgrades exist at the database level but are NOT exposed on the public certificate page or API.
- **Label Generation:** Labels are canvas-drawn (V2 system) at 300 DPI, featuring a custom black and gold design with logo, text, and auto-generated QR codes linking to public certificate pages. Outputs include PNG and print-ready PDF formats.
- **Submission Wizard:** A 5-step guided process for users to submit cards for grading or reholdering, including tier selection, card details, review, shipping, and payment.
- **Security:** Robust admin authentication with 2-step login (password + PIN), timing-safe comparisons, brute-force protection, rate limiting, and optional IP allowlisting. Data protection includes soft deletes for sensitive records and comprehensive audit logging.
- **Data Integrity:** Strict server-side validation for grades (integer-only), prevention of hard deletes, and controlled certificate numbering.
- **Styling:** Custom black (#000000) background with gold (#D4AF37) accent theme for a premium, professional look.
- **Variant System:** Searchable dropdown with 27 standard variants (Holo, Reverse Holo, Full Art, Alt Art, Secret Rare, Illustration Rare, SIR, Promo, 1st Edition, Shadowless, Unlimited, etc.) plus "Other (manual)" option with free-text `variantOther` field. Legacy free-text variants auto-mapped to codes via `mapVariantTextToCode()`. Display logic: NONE=hidden, OTHER=show variantOther, known code=show label, unknown=show raw text. Options defined in `client/src/lib/variantOptions.ts`, server labels in `VARIANT_LABELS` map in `server/routes.ts`.
- **Rarity System:** Searchable dropdown with codes plus "Other / Unknown" option with free-text `rarityOther` field (shown when rarity code is "OTHER"). Options defined in `client/src/lib/rarityOptions.ts`, server labels in `RARITY_LABELS` map. Includes standalone "Holo" option (code: HOLO) distinct from "Holo Rare" (RARE_HOLO). Display uses `rarityDisplayLabel()` which resolves OTHER to the custom text.
- **Collection/Subset:** Searchable dropdown with 22 options (Classic Collection, Black Star Promo, 1st Edition, Shadowless, Trainer Gallery, etc.) plus "Other (manual)" with free-text `collectionOther` field. DB columns: `collection_code TEXT`, `collection_other TEXT`. Display logic: code→label map, OTHER→collectionOther, blank→omit. Shown on labels as its own line between set name and card name (uppercase, gold text), public cert page, and CSV export. Options defined in `client/src/lib/collectionOptions.ts`, server labels in `COLLECTION_LABELS` map in `server/routes.ts`.
- **Certificate ID Format:** Normalized to `MV{number}` (e.g. MV3) everywhere via `normalizeCertId()`. DB may store old format `MV-0000000001`. All API responses, labels, CSVs, and filenames use normalized format.

## External Dependencies
- **PostgreSQL:** Primary database for all application data, accessed via Drizzle ORM.
- **Stripe:** Payment gateway for processing one-time Payment Intents. Utilizes `stripe-replit-sync` for webhook handling.
- **Cloudflare R2:** Object storage for card images and generated grading labels.
- **Express.js:** Web application framework for the backend API.
- **React:** Frontend library for building the user interface.
- **Wouter:** Lightweight router for React SPAs.
- **Tailwind CSS:** Utility-first CSS framework for styling.
- **Shadcn UI:** Reusable UI components.
- **`express-session` and `connect-pg-simple`:** Used for server-side session management for admin authentication.
- **`helmet`:** Express.js middleware for setting security-related HTTP headers.
- **`crypto` module:** Node.js built-in module used for timing-safe comparisons in authentication.
- **Resend:** Email delivery service for transactional emails (submission confirmation, cards received, grading complete, shipped). Templates in `server/email.ts`.

## Certificate Ownership System
- **Claim Flow:** Email-only verification. Users enter cert number + 12-char claim code + email at `/claim`. System sends verification email via Resend. Clicking email link completes ownership transfer.
- **Schema:** `certificates` table extended with `current_owner_user_id`, `ownership_status` (unclaimed/pending/claimed/transferred), `claim_code_hash`, `claim_code_created_at`, `claim_code_used_at`. New tables: `ownership_history`, `claim_verifications`.
- **Claim Codes:** 12-char alphanumeric, stored as SHA-256 hash. Generated per-cert by admin or via batch backfill.
- **Verification Tokens:** 32 random bytes hex, SHA-256 hash stored, 24h expiry.
- **Admin Tools:** Per-cert ownership panel (view status, owner email, regenerate claim code, manual assign). Backfill button on dashboard generates codes for all unclaimed certs and downloads CSV.
- **Routes:** `POST /api/claim/request`, `GET /api/claim/verify`, `GET /api/admin/certificates/:certId/ownership`, `POST /api/admin/certificates/:certId/regenerate-claim-code`, `POST /api/admin/certificates/:certId/assign-owner`, `POST /api/admin/backfill-claim-codes`.
- **Claim Insert Cards:** Credit-card sized (85.6×54mm) printable insert cards for each sold card. Canvas-drawn at 300 DPI with MintVault branding, cert number, formatted claim code (XXXX-XXXX-XXXX), QR code to claim URL, and 3-step instructions. Single insert PDF/PNG per cert, or batch A4 print sheet (2×5 per page, up to 50). Each insert generation creates a fresh claim code. Routes: `POST /api/admin/certificates/:certId/claim-insert`, `POST /api/admin/claim-insert-sheet`.
- **Files:** `client/src/pages/claim.tsx`, `client/src/components/ownership-section.tsx`, `server/storage.ts` (ownership methods), `server/email.ts` (sendClaimVerification), `server/claim-insert.ts` (insert card generator).

## Phase 2 Features
- **Email Notifications:** 4 automated email triggers via Resend: payment confirmed, cards received, grading complete, shipped. Fire-and-forget (non-blocking). FROM: mintvaultuk@gmail.com.
- **Public Tracking Page:** `/track` — customers enter submission ID + email to view status, card count, tier, tracking info. Email verification prevents unauthorized access.
- **Submission Items:** Per-card rows stored in `submission_items` table on payment. Customers can optionally enter per-card intake details (game, card_name, set_name, card_number, year, declared_value, notes) during submission wizard Step 2 — all stored as unverified customer-declared data. Admin can review, correct, and link items to certificates via `submission_item_id` column. Admin PATCH endpoint (`/api/admin/submissions/:id/items/:itemId`) allows editing individual item fields.
- **Certificate-Submission Linking:** Admin can link a new certificate to an unlinked submission item via dropdown. Auto-populates card game, set, name, number, year.
- **Admin Filtering:** Submissions filterable by status, email, date range. Certificates filterable by grade, card name, set, date range.
- **Terms & Conditions:** Mandatory checkbox before payment. Server-enforced. DB columns: `terms_accepted`, `terms_accepted_at`, `terms_version`.

## SEO System
- **SEO Infrastructure:** Reusable components in `client/src/components/`: `seo-head.tsx` (dynamic meta/OG/schema), `breadcrumb-nav.tsx` (with BreadcrumbList schema), `faq-section.tsx` (accordion with FAQPage schema + aria-expanded), `cta-section.tsx`, `related-guides.tsx`.
- **SEO Landing Pages:** 6 pages in `client/src/pages/seo/`: pokemon-card-grading-uk, trading-card-grading-uk, card-grading-service-uk, psa-alternative-uk, how-to-grade-pokemon-cards, tcg-grading-uk. Each has unique H1, 700-1200+ words, FAQ section, CTA, internal links, Service+BreadcrumbList+FAQPage schema.
- **Guides System:** 15 static guide articles in `client/src/data/guides.ts`. Hub page at `/guides` with search. Detail pages at `/guides/:slug` with table of contents, Article schema, related guides, CTA. Pages: `client/src/pages/guides.tsx`, `client/src/pages/guide-detail.tsx`.
- **Homepage SEO:** `pricing.tsx` has proper H1, content sections (How Grading Works, Why Grade, Why MintVault, What Cards Can Be Graded), FAQ, Organization+WebSite+LocalBusiness+FAQPage schema.
- **Sitemap & Robots:** Dynamic `/sitemap.xml` and `/robots.txt` routes in `server/routes.ts`. Sitemap includes all public pages, SEO pages, and guide slugs. Robots disallows /admin and /api/admin.
- **Footer SEO:** Three-column footer with Services, Guides, Company link sections. Header nav includes Guides link.
- **index.html:** Default OG tags, Twitter card meta, proper lang attribute.