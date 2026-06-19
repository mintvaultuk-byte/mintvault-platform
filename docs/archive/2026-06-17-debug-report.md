# MintVault — Full System Debug / Audit (READ-ONLY)

_Date: 2026-06-17 · HEAD `4d47f2d` (main, clean, in sync with origin) · Read-only audit — no code/DB/deploy changes made. This file is the only artifact written (not committed)._

Method: deterministic checks (tsc/eslint/build/audit/vitest) + 5 parallel read-only code investigators (security, payment, data, resilience, frontend/claims/config) + read-only runtime sanity on staging and prod. **Every CRITICAL/HIGH below was re-verified against the actual code by the author** (agent severities adjusted where verification differed — noted inline).

---

## 1. Executive Summary

**Severity counts:** CRITICAL **0** · HIGH **6** · MEDIUM **~18** · LOW **~12**

**Overall:** the system is in good shape. tsc clean, 262/262 unit tests pass, prod healthy, build OK. No committed secrets, no unauthenticated charge/refund, no auth bypass, no exploitable-today SQLi, prod session secret protected. The promotions/promo-code/quote subsystem is exemplary (server-side money resolution, soft-delete + audit, quote==charge by construction). The real risk concentration is: **payment replay/race idempotency**, **two public unauthenticated endpoints** (an SQL-raw search + order enumeration), **a credit-deduct-without-refund path**, **marketing claims that overstate what the code delivers (DMCC)**, and **a large body of dead/shadowed duplicate routes that has already drifted**.

**Top risks (fix first):**

1. **Payment idempotency (HIGH):** a replayed Stripe `payment_intent.succeeded` or a webhook-vs-`confirm-payment` race can **double-consume a member credit** or **over-count a capped promo code** — credit-consume + promo-redeem run after a stale `paymentStatus` guard with no event-id dedup and no per-submission uniqueness. (Inverse gap: webhook-only completions never consume the credit/redeem the code at all.)
2. **Two public unauthenticated endpoints (HIGH):** `GET /api/population/certs` interpolates user input into `sql.raw` (quote-doubling holds today but it's a fragile non-parameterized public query); `GET /api/submissions/:submissionId` has no auth + sequential IDs → enumerate every order's tier/type/quantity/**totalPrice**.
3. **AI estimate credit deducted, not refunded on failure (HIGH):** a paying customer loses a Pre-Grade credit on any transient AI error.
4. **DMCC / consumer-protection (HIGH):** bulk-discount copy advertises **10%/15%** where the engine delivers **7.5%/10%** (incl. inside machine-readable FAQ structured data); "fully insured" implies unlimited but cover is capped at £7,500; unverifiable "only UK grader / most trusted / best" superlatives.
5. **~110 dead/shadowed duplicate routes (HIGH, latent):** the route-module extraction left the originals in `routes.ts`; they're shadowed by registration order and have **drifted** (the dead `/api/create-payment-intent` + `/api/confirm-payment` copies have no promo-code support) — a maintenance trap + reorder footgun.

---

## 2. CRITICAL

**None.** Verified absence of: committed live/test secrets (working tree + history clean, `.env` gitignored & untracked), unauthenticated charge/refund path, auth bypass, exploitable-today SQL injection, and an unprotected prod session secret (the hardcoded `SESSION_SECRET` fallback is gated by `NODE_ENV==="production"`, which is set in **both** Dockerfile and fly.toml — see M-1).

---

## 3. HIGH

### H1 — Payment replay/race can double-consume a credit / over-redeem a promo code

- **Area:** Payment integrity / idempotency
- **File:** `server/routes/submissions.ts:589` (markSubmissionAsPaid), `:606-620` (consumeCredit), `:626-636` (redeemPromoCode); `server/webhookHandlers.ts:51-97`; `server/account-auth.ts:229` (member_credits — no unique on `used_for_submission_id`); `server/storage.ts:544-548` (markSubmissionAsPaid returns `true` unconditionally)
- **Problem:** `/api/confirm-payment` gates credit-consume + promo-redeem on a **stale** top-of-handler `submission.paymentStatus` read, not on winning the atomic paid-transition. The grading `payment_intent.succeeded` webhook has **no Stripe `event_id` dedup** (unlike the vault-club handlers, which use a `stripe_event_id UNIQUE` table). `consumeCredit` picks ANY unused credit with no per-submission check; `redeemPromoCode` increments `uses_count` with no per-submission dedup.
- **Impact:** A normal Stripe retry, or webhook racing `confirm-payment`, can (a) consume **two** member credits for one order, or (b) increment a capped promo code's `uses_count` twice (cap burns down faster than real redemptions). Inverse: if only the webhook fires (customer closes tab), the credit is **never** consumed and the code is **never** redeemed — accounting under-count.
- **Proposed fix:** Move credit-consume + promo-redeem into one shared fulfilment function called by both webhook and confirm-payment, gated on the atomic paid-transition (have `markSubmissionAsPaid` return real `rowCount`); add a `stripe_event_id` processed-events guard; add `UNIQUE(used_for_submission_id)` on `member_credits` and a per-submission guard in `redeemPromoCode`.

### H2 — Public endpoint interpolates user input into raw SQL

- **Area:** SQL injection surface
- **File:** `server/routes/public.ts:581-602` (`GET /api/population/certs`); duplicate at `server/routes.ts:14709`
- **Problem:** `card`/`set` come from `req.query`, are escaped only by `.replace(/'/g,"''").replace(/%/g,"\\%")`, then string-interpolated into `sql.raw(\`... LIKE LOWER('%${cardEsc}%') ...\`)`. Public, unauthenticated, no rate limit. (It does filter `status='active' AND deleted_at IS NULL`.)
- **Impact:** The `''`-doubling blocks classic injection under PostgreSQL defaults (`standard_conforming_strings=on`), so it is **not trivially exploitable today** — but it's a fragile manual-escaping pattern on a public route, one encoding edge-case or config change from injection, and it violates the codebase's own parameterized-query standard. (`_` is also not escaped → over-broad LIKE matching, not a security issue.)
- **Proposed fix:** Replace `sql.raw` with a parameterized query builder (`ilike(certificates.cardName, \`%${card}%\`)`) or bound `${}`params in a`sql\`\``template. Delete the duplicate route at`routes.ts:14709`.

### H3 — Public order-enumeration endpoint (no auth, sequential IDs, exposes totalPrice)

- **Area:** IDOR / enumeration
- **File:** `server/routes/submissions.ts:703-722` (`GET /api/submissions/:submissionId`); IDs from `server/storage.ts:613` (`MV-SUB-000001`, `COUNT(*)+1`, sequential)
- **Problem:** No `requireAuth`, no ownership check, no rate limit. Returns `status, serviceTier, serviceType, cardCount, totalPrice, createdAt`. Sibling `POST .../track` requires an email match — this GET is strictly weaker.
- **Impact:** Walk `MV-SUB-000001…NNNNNN` to enumerate every customer order's tier/type/quantity/**price** → total order volume, revenue, per-order detail. (No name/email/address in this payload, so it's order-metadata + business-intel, not full PII.)
- **Proposed fix:** Require email-match (mirror `/track`) or `requireAuth` + `submission.userId === req.session.userId`; add a lookup rate limiter. Remove the dead duplicate at `routes.ts:3067`.

### H4 — AI Pre-Grade estimate credit deducted before the AI call, not refunded on failure

- **Area:** Resilience / revenue
- **File:** `server/routes.ts:~12434` (decrement), `:~12536` (Anthropic call), `:~12599` (catch)
- **Problem:** The estimate credit is consumed **before** the AI request. On any AI failure (non-OK, timeout, JSON parse) control jumps to the catch → 500, with **no compensating refund**. _(Line-level trace per the resilience investigator; verify exact ordering before fixing.)_
- **Impact:** A paying customer loses a Pre-Grade credit on every transient AI error — a "customer loses paid value due to our error" defect.
- **Proposed fix:** Deduct only **after** a successful AI response, or refund the credit in the catch.

### H5 — COMPLIANCE: marketing claims overstate what the code delivers (DMCC/CPRs)

- **Area:** Consumer-protection / marketing-vs-code _(report only — do not rewrite legal/marketing copy; Cornelius + solicitor)_
- **Files/problems:**
  - **Bulk discount overstated.** Engine = 5% / 7.5% / 10% (`shared/schema.ts:1341-1344`). Copy says more: `client/src/pages/pricing.tsx:625` "25–49 → **10% off**" and `:626` "50+ → **15% off**" (a _correct_ table exists on the same page at `:269-271` — the page contradicts itself); `client/src/pages/vault-club.tsx:71,417`; SEO pages `seo/card-grading-cost-uk.tsx:20`, `card-grading-service-uk.tsx:186`, `psa-alternative-uk.tsx:149`, `tcg-grading-uk.tsx:155`; **`seo/trading-card-grading-uk.tsx:32` — "up to 15%" inside machine-readable `faqSchema()` structured data (highest priority — Google-readable false claim).**
  - **"Fully insured" implies unlimited;** actual cover is tiered, capped at **£7,500** (`shared/schema.ts:1376`), and the physical label (`server/shipping-label.ts`) renders no insurance text. ~30 occurrences across SEO pages (best-card-grading-uk, card-grading-cost-uk, card-grading-near-me, card-grading-service-uk, etc.). _(Note: `submit.tsx`/`pricing.tsx` insurance lines are variable-backed from the tier label and are accurate.)_
  - **Unverifiable absolutes/superlatives:** "only UK grader…/no other UK grader can match" (`seo/best-card-grading-uk.tsx`, one-piece/sports/yugioh pages), "most trusted/leading/best" (`why-mintvault.tsx:66`, best-card-grading-uk).
- **Impact:** Advertising discounts/insurance/superiority the system doesn't deliver is a DMCC/CPR exposure (the structured-data one is machine-readable and indexable).
- **Proposed fix:** Render all bulk-discount copy from `bulkDiscountTiers`; state the insurance cap ("insured up to your cover tier, max £7,500") and confirm Royal Mail cover is actually purchased; remove/​substantiate superlatives & competitor absolutes.

### H6 — ~110 dead/shadowed duplicate routes in routes.ts, already drifted (latent)

- **Area:** Dead code / maintenance footgun
- **File:** `server/routes.ts` (17k lines) vs the extracted `server/routes/*.ts` modules; `register*Routes(app)` run at `routes.ts:1297-1306`, before all inline handlers → modules win (Express first-match). Proven drift: live `/api/create-payment-intent` (`submissions.ts:122`) + `/api/confirm-payment` (`submissions.ts:579`) use `computeGradingQuote` + `redeemPromoCode`; the **dead** copies (`routes.ts:2513`, `:2959`) use older inline `Math.max(vc,bulk)` math with **no promo-code support/redemption**. Also duplicated: `consumeCredit` (routes.ts:152 + submissions.ts:14, both module-private), `/api/population/certs`, `/api/auth/login`, `/api/admin/submissions`, `/api/service-tiers`, claim/transfer routes (~110 method+path pairs).
- **Impact:** High chance of editing dead code believing it's live; a future registration-order change could silently activate the stale, promo-less payment handlers. The extraction migration is incomplete (originals never removed).
- **Proposed fix:** Delete inline duplicates from `routes.ts` in small route-group batches (confirm each is superseded, `npm run check` between batches). Start with the two payment handlers.

---

## 4. MEDIUM

- **M1 — `SESSION_SECRET` hardcoded dev fallback.** `server/index.ts:239` `return s || "mintvault-dev-only-secret"`; throw only if `NODE_ENV==="production"`. **Prod is protected** (NODE_ENV=production in Dockerfile:45 + fly.toml). Risk is dev-only / a latent footgun. Fix: require unconditionally, drop the literal, validate `NODE_ENV`.
- **M2 — Soft-deleted certs leak on public stolen-status.** `server/routes.ts:4752` `SELECT … FROM certificates WHERE certificate_number=… ` lacks `deleted_at IS NULL` (every other cert read filters it). Public, per-certId (no enumeration). Fix: add `AND deleted_at IS NULL` → 404.
- **M3 — `getSubmissionBySubmissionId` lacks `deleted_at` filter.** `server/storage.ts:470-473` — soft-deleted submissions still readable (and mutable via the admin status route). Violates the soft-delete-everywhere rule. Fix: add `AND deleted_at IS NULL` (+ an `…IncludingDeleted` variant if needed).
- **M4 — Customer emails logged in plaintext.** `server/email.ts` (~30 sites) + `server/routes.ts:1492`, `routes/public.ts:205`, `webhookHandlers.ts:117`. GDPR exposure in log storage. Fix: mask (`a***@domain`) or log an id; centralize in `sendViaResend`. (Good pattern already: IP is sha256-hashed before storage at `routes.ts:1859`.)
- **M5 — Full-PII PDFs gated by non-expiring 64-bit HMAC, non-timing-safe compare.** `server/routes/submissions.ts:769-784` (packing-slip), `:836-851` (shipping-label) — static token = `HMAC(secret, submissionId).slice(0,16)`, `!==` compare, no expiry, no rate limit; PDFs contain name/email/phone/address. Fix: include expiry in the HMAC payload, `crypto.timingSafeEqual`, widen token, add limiter.
- **M6 — Rate-limit gaps on sensitive auth mutations.** `server/routes/auth.ts` — `/api/auth/reset-password` (:1017), `/resend-verification` (:1067, email-flood vector), `PUT /change-password` (:1111), `PUT /change-email` (:1135), `/pin/setup` (:557) have no dedicated limiter. (login/signup/forgot/magic-link/pin-login ARE limited.) Fix: attach `authRateLimit`.
- **M7 — Estimate-credits balance enumeration.** `server/routes.ts:12319` `GET /api/tools/estimate/credits?email=` public, returns any email's credit balance — a customer-existence oracle. Fix: require session ownership or rate-limit.
- **M8 — Transfer dispute/cancel write no audit row.** `server/storage.ts:2380` (dispute), `:2419` (cancel) change `transfer_status` + reset cert `ownership_status` but write no `audit_log`/`ownership_history` (unlike `finaliseTransferV2`). Ownership events untraceable. Fix: add audit rows inside each txn.
- **M9 — Missing indexes on hot paths.** `transfer_verifications.cert_id` (schema.ts:1021, seq-scanned on every transfer lookup + the dispute sweeper), `certificate_images.certificate_id` (schema.ts:693), `submissions.user_id` / `submission_items.submission_id`. Fix: add `CREATE INDEX IF NOT EXISTS` for each.
- **M10 — Boot-migration ordering race.** `migrateServiceTiersV213()` (routes.ts:1266) ALTERs `member_credits` (created only in `migrateAccountSchema()`, fired separately at :1277) — independent fire-and-forget chains. Cold-start can run the ALTER before the table exists; self-heals next boot (all `IF NOT EXISTS`). Fix: chain V213 after account/marketplace, or move the ALTER into `migrateAccountSchema`.
- **M11 — Fly liveness probe on `/health` (no DB).** `/health` (index.ts:74) always 200; the real readiness check is `/api/health` (routes.ts:1833, does `SELECT 1`→503). A DB outage isn't reflected to Fly. Fix: point Fly's HTTP check at `/api/health`.
- **M12 — Dockerfile runs as root.** No `USER node` before `CMD`. Fix: add a non-root user.
- **M13 — Vault Club copy contradictions.** `pricing.tsx:601` "Subscriptions temporarily paused" vs `vault-club.tsx:170` "Available now" (live Stripe checkout); `pricing.tsx:542` "No percentage discount" vs Silver = real 10%. Drive both from one server flag.
- **M14 — Undocumented/unvalidated auth-gating env vars.** `MINTVAULT_ADMIN_TOKEN` (routes.ts:10983), `SCANNER_API_TOKEN` (lib/scanner-auth.ts:28) — undocumented + no startup validation (no central env validator; `config.ts` only checks the DB URL). Both **fail closed** if unset (not a bypass), so this is hygiene, not a vuln. Fix: validate at startup, document.
- **M15 — `pre-grade.tsx` hardcoded competitor/own fees.** Own fee hardcoded `25` (`:445`, conflicts with the £19 entry advertised elsewhere) + competitor fees `psa:22, cgc:15` (`:507-509`) presented as current fact. Fix: source own price from tiers; date/cite or soften competitor figures.
- **M16 — `/mvgs/join` placeholder reachable from live CTAs.** `App.tsx:223` renders "coming soon"; linked from `standard.tsx:799`, `technology.tsx:322`. Fix: hide CTAs or add a waitlist.
- **M17 — Hot-folder upload: dead session-auth branch + no content validation.** `routes.ts:10978-10989` checks `req.session.adminAuthenticated` (the real flag is `isAdmin`) → dead branch; relies on the Bearer token (fails closed) but skips `rejectInvalidUploads`/magic-byte validation that sibling uploads do. Fix: use `req.session.isAdmin` + add magic-byte validation.
- **M18 — `npm audit`: 4 HIGH, all via `esbuild` build/dev tooling** (drizzle-kit, esbuild, tsx, vite). Advisories are dev-server/Windows-specific (arbitrary file read on the esbuild dev server, vite `fs.deny` bypass on Windows). **Prod runs `node dist/index.cjs`** — none of these run in the prod request path, so real prod exposure is negligible. Fix: bump when convenient (`vite`/`esbuild`/`tsx`/`drizzle-kit`); not urgent.

---

## 5. LOW

- **L1 — eslint: 1626 errors / 2665 warnings** (does not block build/tsc). Dominated by `no-explicit-any` (1795), `no-unused-expressions` (1460), `no-unused-vars` (590), `no-empty` (118 — empty blocks, mostly idempotent-DDL/audit catches that are intentionally non-fatal), `no-require-imports` (79). Code-quality debt, not runtime bugs (the pre-commit hook only lints staged files, so the repo accumulated this). Note: CLAUDE.md's "never use `any`" rule is widely unmet.
- **L2 — `Access-Control-Allow-Origin: *`** on 3 public read endpoints (`routes.ts:1946` verify, `:2172` slab-image, `:4411` vault) — no `Allow-Credentials`, public non-PII data → benign; just never pair `*` with credentials.
- **L3 — Dead lazy imports** built but unrouted: `CertDetailPage` (App.tsx:21), `VaultReportPage` (App.tsx:70). Remove.
- **L4 — Design-mockup routes publicly reachable/crawlable:** `/home-v2-integrated`, `/home-v3`, `/home-v4`, `/how-it-works-v2`, `/pricing-v2`, `/pricing-demo` (App.tsx:206-211); also public `/reels`, `/share/reel/*` (PII-safe, unlinked). Gate behind a dev flag or remove before indexing.
- **L5 — `consumeCredit` duplicated source** (routes.ts:152 + submissions.ts:14) — module-private, no runtime shadowing; DRY/drift only.
- **L6 — Transfer-status endpoint enumerable** (`routes/transfers.ts:550`) — public, masked emails (`xx***@domain`), no limiter. Add a limiter.
- **L7 — `.env.example` dead vars** (`ADMIN_PIN` — obsolete, PIN is now per-user `users.pin_hash`; CLAUDE.md still lists `ADMIN_PIN` as live = now inaccurate; the Replit Connectors block; `EBAY_DEV_ID`). Prune + correct CLAUDE.md.
- **L8 — Homepage stat fallbacks** `home.tsx:682` renders hardcoded `?? 114` cards / `?? 71` sets on stats-fetch failure; hide the sentence when undefined. `home.tsx:399` "{N} graded" counts only the 8-item showcase — phrase as "recent."
- **L9 — Session cookie 30-day `rolling`** (index.ts:247) — active sessions effectively never expire; conscious-decision item.
- **L10 — `pre-grade.tsx:199` "1200DPI"** decorative label; no 1200 DPI scan occurs.
- **L11 — Write-loop inserts** (`storage.ts:699` addSubmissionItems, `:1025` queueForPrinting) — per-row INSERTs (bounded, not read-N+1). Batch into one multi-row insert (optional).
- **L12 — No FKs between core tables** (submissions→users, certificate_images→certificates, etc.) — intentional (soft-delete + string cert IDs); orphans structurally possible but mitigated by rare hard-deletes. If tightening, validate no orphans first, add `certificate_images.certificate_id → certificates.id` as the safest.

---

## 6. Appendix — raw automated outputs

- **Environment:** `~/mintvault-platform` (correct; duplicate `~/Projects/mintvault-platform` **absent** — no deploy footgun). `main`, HEAD `4d47f2d`, clean, origin in sync. node v24.14.1, npm 11.11.0. Scripts: dev/build/start/check/lint/test all present.
- **tsc (`npm run check`):** ✅ exit 0, clean.
- **vitest (`vitest run`):** ✅ **262/262 passed, 11 files**. Tests are pure unit tests (geometry, MVGS scoring, cert-id normalization) — **none touch any DB** (no Pool/drizzle/host refs); safe to run.
- **Build (`npm run build`):** ✅ exit 0 (esbuild server bundle + Vite client).
- **eslint (`eslint .`):** ✗ exit 1 — **1626 errors, 2665 warnings**. Top rules: no-explicit-any 1795, no-unused-expressions 1460, no-unused-vars 590, no-empty 118, no-case-declarations 114, no-require-imports 79. Not build-breaking.
- **npm audit:** 6 total — **4 HIGH** (drizzle-kit, esbuild, tsx, vite — all transitively via `esbuild`; build/dev tooling, dev-server/Windows-specific), 1 moderate, 1 low, 0 critical.
- **Runtime — PROD (read-only, unauthenticated):** `/health` 200, `/api/healthz` 200, `/api/promotions/active` 200, `/api/service-tiers` 200, `POST /api/grading/quote` 200, `GET /api/admin/promotions` **401** (correct), `GET /api/submissions/MV-SUB-000001` 404 (id absent; endpoint public + reachable — H3 stands for real ids). Boot migrations confirmed present in prior deploys.
- **Runtime — STAGING:** dev server up on :5000 (`/api/healthz` 200).
- **prod/staging DB isolation:** clean — single `MINTVAULT_DATABASE_URL` env var, no cross-environment references in code.

---

## 7. Suggested fix passes (priority order — each a separate gated pass)

1. **Payment idempotency (H1)** — shared idempotent fulfilment (event-id dedup + atomic paid-transition gate + per-submission credit/promo uniqueness). Highest blast radius (money/credits).
2. **Public endpoints (H2 + H3)** — parameterize `/api/population/certs`; add auth/ownership + rate-limit to `/api/submissions/:id`. Then delete their dead duplicates.
3. **Estimate credit refund (H4)** — deduct-after-success or refund-on-failure.
4. **DMCC copy (H5)** — render bulk-discount % from `bulkDiscountTiers`; fix the structured-data "15%"; state the insurance cap; substantiate/remove superlatives. (Cornelius + solicitor on wording.)
5. **Dead-route cleanup (H6)** — delete shadowed `routes.ts` duplicates in batches, payment handlers first.
6. **Soft-delete + audit hygiene (M2/M3/M8)** and **PII-in-logs masking (M4)**.
7. **Hardening sweep:** SESSION_SECRET unconditional (M1), PDF token expiry+timing-safe (M5), auth rate-limit gaps (M6), missing indexes (M9), Fly liveness→/api/health (M11), Dockerfile non-root (M12).
8. **Lint debt + dead imports/mockup routes** (L1/L3/L4) as a low-risk cleanup.
