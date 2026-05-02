# DMCC Step 5a — Vault Club subscription compliance audit

**Date:** 2026-05-02
**Scope:** Pre-launch audit of the Vault Club Silver subscription against
the DMCC 2024 / CCR 2013 / CRA 2015 baseline captured in
`uk-subscription-compliance` skill (sections referenced inline below).
**Status of this audit:** investigation only. No code changes made in
this pass. Findings to be remediated before launch + before solicitor
review.

> ⚠️ Not legal advice. Send the cancellation flow, T&Cs, and pre-contract
> page to a UK consumer-law solicitor before go-live (skill, lines
> 258-269).

---

## 1. `/vault-club` marketing page — pre-contract checklist

Source: [client/src/pages/vault-club.tsx](../client/src/pages/vault-club.tsx)

Compared against the skill checklist at lines 184-198. Each row quotes
actual page copy.

| # | Checklist item | Status | Where on the page |
|---|---|---|---|
| 1 | What Silver includes (credits, grading benefits, exclusions) | ✅ Present | Section II "What you get" (perks list — 5 items, e.g. *"Two free Authentication add-ons every month — Worth £15 each"*); Section IV "What Silver isn't" explicitly excludes percentage discount + bulk-stacking |
| 2 | Monthly price (£9.99) and annual price (£99) | ✅ Present | Hero footnote *"£9.99 / month · 5 perks · Membership paused"*; Section III price cards `{poundsFromPence(SILVER.monthly_price_pence)}` / month and `{poundsFromPence(SILVER.annual_price_pence)}` / year; "Save £20.88" pill |
| 3 | Billing frequency and renewal date logic | ⚠️ Partial | Monthly card: *"Cancel anytime. Bill renews monthly."* / Annual card: *"Equivalent to two months free. Bill renews yearly."* — frequency stated, but renewal date logic (e.g. "renews on the same day each month/year as your trial-end date") is NOT shown |
| 4 | Auto-renewal disclosure in prominent position, not buried | ⚠️ Weak | Only the words "Bill renews monthly" / "Bill renews yearly". No explicit "auto-renews until you cancel" line. Prominence: in the price card body but small (`text-sm`); not flagged with a warning eyebrow |
| 5 | How to cancel — in-app, 24/7, link to cancellation steps | ❌ Missing | Page says *"Cancel anytime"* but no link to `/account/vault-club`, no description of the cancellation channel (Stripe Portal). FAQ #2 says *"Yes. Monthly plans cancel from the next billing cycle. Annual plans run to the end of the paid term — no partial refunds, but you keep every perk until it ends"* — describes effect, not method |
| 6 | Cooling-off right + loss-of-cancellation acknowledgement | ❌ Missing | No mention of the CCR 14-day cooling-off right anywhere. The 14-day **free trial** is unrelated to the CCR cooling-off period and shouldn't be confused with it. No acknowledgement checkbox at sign-up |
| 7 | What happens to credits on cancellation | ⚠️ Partial / inconsistent | FAQ #3 says *"No. Free Authentication add-ons and AI Pre-Grade credits reset every month. Use them within the month or lose them"* — describes monthly reset, NOT cancellation behaviour. FAQ #2 says *"…you keep every perk until it ends"* implying period-end retention. No explicit "on cancellation, your unused credits are X" disclosure |
| 8 | Price-change terms | ❌ Missing | No mention. Skill requires "at least 30 days' written notice of a price increase" (lines 156-165). Not disclosed pre-contract |
| 9 | Reminder notices commitment | ❌ Missing | No mention that we will send pre-renewal reminders. Skill requires this be disclosed pre-contract (line 195) AND the reminders themselves to actually be sent (lines 52-78). Neither half exists |
| 10 | Minimum duration (none, or state it) | ❌ Missing | Page implies no minimum (FAQ #2 "cancel from the next billing cycle") but doesn't state it explicitly |
| 11 | Link to full T&Cs | ❌ Missing | No T&Cs link from `/vault-club`. Footer (FooterV2) may link generically — needs separate audit; not visible from page-level inspection |
| 12 | Link to privacy policy | ❌ Missing | Same as above — relies on footer link, not in-flow |

**Free-trial disclosure (skill lines 126-138)** — separate checklist for pages
offering a free trial. Page DOES offer a 14-day free trial (button copy:
*"Start 14-day free trial →"*).

| Free-trial item | Status | Notes |
|---|---|---|
| Length of the trial | ✅ "14-day free trial" on both buy buttons |
| Date of first charge | ❌ Missing — not stated on the page; user only sees it after committing on Stripe-hosted Checkout |
| Amount of first charge | ⚠️ Implied via the monthly/annual price card; no explicit "first charge will be £9.99 on {trial-end-date}" before sign-up |
| Ongoing price | ✅ Price cards show £9.99/mo and £99/yr |
| How to cancel before first charge | ❌ Missing — no "to cancel before charge, do X" line |

**Trust microcopy under the buy buttons:** *"Card required · Cancel anytime"*.
Truthful but does not satisfy the pre-contract checklist on its own.

### Hero copy contradiction (NOT a DMCC issue but worth flagging)

Hero still reads *"Subscriptions are paused while we finish the perk
system — join the waitlist and you'll be first when it reopens."* and
the eyebrow line says *"Membership paused"* — but the buy buttons in
Section III are live and create real Stripe Checkout Sessions. The hero
copy is stale from the pre-Phase-1 paused state. Misleading by omission
to a regulator's eye even though the section-III buttons function.

---

## 2. Sign-up consent — checkout button → Stripe Checkout

Trace:

1. User clicks **"Start 14-day free trial →"** in
   [vault-club.tsx:351-368](../client/src/pages/vault-club.tsx#L351-L368)
   (monthly) or [:397-414](../client/src/pages/vault-club.tsx#L397-L414)
   (annual). One click = `handleCheckout("month" | "year")`.
2. `handleCheckout` POSTs `/api/vault-club/checkout` with no other body
   beyond `{interval}`. **No checkbox state is captured. No consent
   payload exists in the request.**
3. Server [vault-club-checkout.ts:74-...](../server/vault-club-checkout.ts#L74)
   creates a Stripe Checkout Session with `mode: "subscription"`,
   `payment_method_collection: "always"`, `billing_address_collection:
   "required"`, `subscription_data.trial_period_days: 14`. **No
   `consent_collection` block** (Stripe supports `consent_collection:
   { terms_of_service: 'required' }` to force a tickbox; we don't pass it).
4. User lands on Stripe-hosted Checkout. Stripe collects card +
   billing address. User clicks "Subscribe" → trialing subscription
   created. Browser redirected to `success_url`.

### Consent findings

| Skill requirement (lines 48-51) | Status |
|---|---|
| Specific action to accept the subscription | ✅ The buy button itself is the action — single click, not pre-ticked, not auto-bound |
| Not pre-ticked / pre-bundled with anything else | ✅ Vault Club is a standalone purchase, not bundled with grading or other MintVault products |
| Cooling-off acknowledgement (loss-of-right if service starts within 14 days) | ❌ **NOT captured.** No tickbox saying "I understand my right to cancel, and I agree to begin services immediately" |
| Pre-contract info delivered in durable medium at/before purchase | ❌ Page disclosures are non-durable HTML; no PDF / no email summarising terms is sent **before** the user clicks |
| Pre-contract info confirmed in durable medium **after** purchase | ⚠️ Stripe sends a receipt; `sendVaultClubWelcomeEmail` fires post-checkout. Neither one repeats the pre-contract disclosures (renewal date, how to cancel, cooling-off, credits-on-cancellation). Stripe's receipt is fine for "amount paid" but is not a pre-contract summary |

### Bundle check

Sign-up flow does NOT pre-tick Vault Club inside another flow (e.g. no
pre-ticked "+ Vault Club trial" on grading checkout). Confirmed by
grep — no `"vault_club"` references in `client/src/pages/submit.tsx`,
no pre-bundled Stripe Checkout line items elsewhere. ✅ Clean on the
bundle anti-pattern (skill lines 50-51, 239).

---

## 3. Cancellation flow — `/account/vault-club` → Stripe Portal → done

Trace:

1. **Click 1** — User on `/account/vault-club` clicks "Manage billing & cancel →"
   ([account-vault-club.tsx:407-419](../client/src/pages/account-vault-club.tsx#L407-L419)).
   Single visible button, gold, in a section called "Manage", with
   microcopy *"Cancel anytime · You won't be charged after cancellation"*.
2. POST `/api/vault-club/portal` →
   [vault-club-portal.ts:46-...](../server/vault-club-portal.ts#L46)
   creates a Stripe Billing Portal session, return_url
   `/account/vault-club`. Frontend redirects browser to Stripe Portal.
3. **Click 2** — User clicks "Cancel subscription" inside Stripe Portal.
4. **Click 3** — Stripe asks confirmation. User confirms cancellation.
   (Stripe Portal config in dashboard: optional reason dropdown that
   user can skip — needs verification.)
5. Stripe fires `customer.subscription.updated` (cancel_at_period_end =
   true) → MintVault webhook
   [webhookHandlers.ts:handleSubscriptionUpdated](../server/webhookHandlers.ts)
   → dual-write to `vault_club_subscriptions` + audit row
   `canceled (scheduled)`.
6. Browser redirects back to `/account/vault-club` (return_url). Page
   re-fetches `/api/vault-club/me` and shows the "Ending soon" pill +
   *"Membership ends {date}. Reactivate before then to keep your perks."*

Sign-up click count for comparison: **3 clicks** (Start trial → Stripe
Checkout / land → Submit). Cancellation: **3 clicks** (Manage billing →
Cancel subscription on Stripe → Confirm). **Roughly parity** ✅
(skill line 93 — "Similar or fewer than sign-up").

### Cancellation findings

| Skill test (lines 91-98) | Status |
|---|---|
| Number of clicks | ✅ ~parity with sign-up |
| Same channel (in-app for online sign-up) | ✅ All in-browser, no phone required |
| Retention gauntlet skippable? | ⚠️ Depends on Stripe Portal config — confirm cancellation flow config in Stripe dashboard does not gate behind retention offers we can't bypass |
| Login required? | ✅ Same `mv.sid` session for both sign-up and cancel |
| Business hours restriction? | ✅ None |
| Confirmation in durable medium | ⚠️ Stripe sends an "Your subscription was canceled" email + we trigger `sendVaultClubCancelledEmail` from the webhook. Two emails, both durable |

### What's missing in our cancellation step

| Skill recommended spec (lines 116-123) | Status |
|---|---|
| Pre-confirm screen showing **next billing date** | ❌ Stripe Portal default does this; we don't show it on `/account/vault-club` before redirecting |
| Pre-confirm screen showing **what they lose** (credits / fees waived) | ❌ Not shown anywhere in the MintVault-controlled UI before the user lands on Stripe |
| Pre-confirm showing **fate of unused credits** | ❌ Not shown. This is the most regulator-relevant gap (skill lines 139-154 — credits-on-cancellation must be disclosed before the user confirms) |
| Two buttons "Keep" vs "Confirm cancellation" with equal visual weight | ⚠️ Stripe Portal renders this; we delegate. Verify Stripe Portal config gives equal weight |
| MintVault-sent cancellation confirmation distinct from Stripe receipt | ⚠️ `sendVaultClubCancelledEmail` exists ([email.ts:1239-1262](../server/email.ts#L1239-L1262)) but its body says *"Your Showroom has been set to reserved until you rejoin"* and offers a "REJOIN VAULT CLUB" CTA — it's a retention/re-engagement email more than a cancellation confirmation. **It does not state**: cancellation effective date, what the user keeps until that date (paid period continues), what happens to unused credits (skill 139-154 disclosure), or how to revert if cancelled by mistake within 14 days (CCR cooling-off if applicable). |
| Audit log entry with user, timestamp, method | ✅ Step 3 webhook handler writes a `canceled` audit row to `audit_log` via `writeVaultClubSubscriptionAudit` |

---

## 4. Existing Vault Club Resend templates

Inventory from [server/email.ts](../server/email.ts):

| Function | Lines | Subject | Trigger |
|---|---|---|---|
| `sendVaultClubWelcomeEmail` | 1207-1237 | "Welcome to Vault Club {Tier} — MintVault" | `webhookHandlers.ts:365` — on `checkout.session.completed` for subscription mode |
| `sendVaultClubCancelledEmail` | 1239-1262 | "Your Vault Club membership has been cancelled — MintVault" | `webhookHandlers.ts:635` — on `customer.subscription.deleted` (final cancellation) |
| `sendVaultClubPaymentFailedEmail` | 1264-1287 | "Action required — Vault Club payment failed" | `webhookHandlers.ts:824` — on `invoice.payment_failed` |
| `sendVaultClubGraceExpiredEmail` | 1289-1311 | "We miss you — Vault Club membership ended" | `index.ts:313` — daily `runVaultClubGraceSweep` cron when `vault_club_grace_until < NOW()` |

### Template content gaps for DMCC compliance

- **Welcome email** does NOT include: cancellation method (skill 191), credits-on-cancellation policy (139-154), price-change terms (156-165), reminder notices commitment (52-78). Skill lines 31-46 require pre-contract info to be repeated in durable medium **after** purchase. This template is the natural place; currently it's a marketing welcome, not a contract summary.
- **Cancelled email** is a re-engagement / retention email, not a regulator-grade cancellation confirmation. See Section 3 above.
- **Payment failed email** is reasonable but doesn't say "your card will be retried N more times" (Stripe dunning behaviour). Skill line 213 — "Failed-payment dunning: limit retries to reasonable count; notify customer in plain English, not silent failure".
- **Grace-expired email** is also re-engagement-shaped, not regulator-grade.

### Templates NOT yet existing (skill requires)

| Required template | DMCC trigger | Skill ref |
|---|---|---|
| Trial-ending reminder (before first charge converts) | 1-3 days before `trial_end` | Lines 60, 135, 238 |
| Annual renewal reminder | 10-35 days before annual `current_period_end` | Lines 56-59 |
| Monthly subscription reminder | First renewal that crosses 6 months into the contract, then 6/12-month intervals | Lines 56-58 |
| Price-change notice | At least 30 days before any price change effective date | Lines 156-165 |
| Cancellation confirmation (regulator-grade) | On user-initiated cancel — distinct from existing welcome-back-style template | Lines 116-123 |

---

## 5. Reminder cron / scheduling infrastructure

Search: `grep -rnE "cron|setInterval|pg-boss|node-cron|reminder" server/`.

Existing scheduler infrastructure:

- `setInterval(runPreGradeCleanup, 24h)` — R2 cleanup of stale pre-grade
  images
- `setInterval(runVaultClubGraceSweep, 24h)` — sweeps `users.vault_club_grace_until` for expired grace periods (post-payment-failure)
- `setInterval(runTransferV2Sweep, 1h)` — transfer flow expiries

**No existing reminder dispatcher for subscription renewals or
trial-end. No `subscription_reminders` table. No pg-boss / node-cron
package — `setInterval` in-process is the only scheduler.**

Implication: the in-process `setInterval` pattern is fine for low-frequency
sweeps but is not durable across restarts (a reminder due during a deploy
window could be skipped if it's not idempotent on retry). The Step 5b
build will need:
- A `subscription_reminders` table with `unique(subscription_id,
  reminder_type, scheduled_for)` so retries are idempotent (this PR)
- A dispatcher cron that runs every ~5-15 minutes, picks up rows
  where `sent_at IS NULL AND scheduled_for <= NOW()`, sends, marks sent
- Webhook-driven scheduler that creates rows at the right times (at
  subscription creation: schedule `trial_ending`; at every renewal:
  schedule the next `annual_renewal` / `monthly_6mo` etc.)

---

## Severity summary — what blocks launch

**🚨 Blocker (must fix before public launch):**
- (5) "How to cancel" not disclosed pre-contract on `/vault-club`
- (6) Cooling-off acknowledgement not captured
- (8) Price-change terms not disclosed
- (9) Reminder notices not sent (skill calls this a breach if missing — line 78)
- Trial-end "first charge will be £X on {date}" not shown pre-Stripe-handoff
- Cancellation flow has no MintVault-controlled pre-confirm showing credits-on-cancellation behaviour
- Hero copy says "Subscriptions are paused" while buttons are live

**⚠️ Should fix before launch:**
- (3) Renewal-date logic not stated
- (4) Auto-renewal not flagged prominently
- (7) Credits-on-cancellation policy not stated explicitly
- (10) Minimum duration not stated
- (11/12) T&Cs and privacy links not in pre-contract flow
- Welcome email upgraded to durable-medium contract summary
- Cancellation email upgraded to regulator-grade confirmation

**🔧 Step 5b (this PR — schema + helpers only):**
- `subscription_reminders` table + Drizzle schema
- `scheduleReminder` / `markReminderSent` / `markReminderFailed` helpers with audit-log writes
- (Dispatcher + templates + webhook integration deferred to next PR)

**🔧 Solicitor review (skill lines 258-269):**
- Vault Club T&Cs (don't yet exist)
- Credits-on-cancellation policy text
- Cooling-off mechanism wording
- Price-change notice template
- Reminder notice templates
