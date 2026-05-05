# Post-launch backlog

Decisions and engineering work deferred to after MintVault v1
launches. v1 ships the existing product as-is; this file is
the canonical record of what gets revisited and when.

---

## Vault Club paid subscription gateway

**Decision date:** 2026-04-30
**Target launch:** Q3 2026 (after v1 has 50+ real submissions
and we have actual usage data)

### Strategic shift

Silver Vault Club transitions from optional perks-and-credits
add-on (current model) to a **paid subscription gateway** that
provides access to the vault dashboard. Grading remains a
one-time fee (£19/£25/£45) that pays for the slab, cert, and
grade — those stay forever. But the ongoing platform features
(dashboard, transfers, registry, Population Report) become
gated behind an active subscription.

### Model

- **£9.99/mo recurring** via Stripe Subscriptions (proper
  Subscription objects, not one-off charges)
- **14-day free trial**, card on file required to start,
  auto-converts to paid at day 14
- **Trial only triggers on first card grading submission** —
  non-graders cannot start trial standalone (grading is the
  acquisition gateway)
- **On lapse: hybrid model**
  - Slab + cert + grade remain visible publicly via /verify
    (forever, paid for at grading)
  - Logged-in dashboard becomes read-only
  - Transfers, registry visibility, Population Report access,
    and any future premium features lock until subscription
    resumed

### Engineering blocks

- Stripe Subscriptions integration:
  - Customer + Subscription + Price objects
  - Webhook handler for: customer.subscription.created /
    updated / deleted, invoice.payment_failed,
    customer.subscription.trial_will_end
  - Test mode parity before production keys
- Trial state machine in users table:
  - trial_started_at, trial_ends_at, paid_status,
    lapse_grace_until, last_billing_event_id
- Dashboard gating middleware: read-only mode based on
  subscription status; per-route enforcement
- Email automation (use existing Resend integration):
  - trial-started (day 0)
  - day-12 reminder (DMCC 2024 requirement)
  - day-14 conversion confirmation
  - payment-failed retry sequence (Stripe Smart Retries +
    custom messaging)
  - lapse-grace warning (e.g. 7-day grace before full lockout)
  - subscription-cancelled-confirmation
- Migration: every existing v1 customer (those who graded
  before this rollout) gets grandfathered with full vault
  access at no cost — communicated via email when paid model
  launches. Specific grandfather window (forever vs
  transition period) decided at launch time.
- New /vault-club page copy + Stripe checkout flow integration
- Cancel-anytime self-service in account dashboard
- Audit log entries for every subscription state change
  (per Cornelius's locked rule on user-facing changes)

### Legal blocks (uk-subscription-compliance skill applies)

- Pre-contract info per DMCC 2024 subscription contracts
  chapter — must be presented before any payment
- Reminder notice requirements (day-12 reminder is hard
  legal requirement, not optional)
- Easy cancellation flow — must be at least as easy to cancel
  as to subscribe, no dark patterns
- 14-day cooling-off period handling (separate from the trial)
- Refund policy for partial-month cancellations
- T&Cs for subscription specifically — separate section in
  T&Cs or dedicated subscription terms doc
- Solicitor review of all subscription-facing copy + flows
  before any go-live
- Privacy notice update — subscription billing data is
  additional personal data being processed; needs DPIA review

### Pre-launch validation (during v1)

- Current /vault-club page (mailto: waitlist CTA) stays live
  during v1 — captures interest from real customers
- Track waitlist signups as the demand signal
- Decision points based on data:
  - 20+ waitlist signups by month 2 → paid Vault Club moves
    up the priority list
  - <5 signups → deprioritise or rethink the model
  - Look at WHO signs up (high-value submitters vs casual)

### Decisions deferred to post-v1-launch

- Whether to grandfather existing v1 customers permanently
  (free vault access forever) or only for a transition period
  (e.g. 6 months free, then convert)
- Annual pricing — keep at £99 or restructure
- Whether to add Bronze (cheaper, fewer features) or Gold
  (premium tier with extras) once Silver has data
- Whether to bundle physical perks (e.g. discount on
  Authentication add-ons) or keep digital-only

### Why deferred (not done now)

Adding paid Vault Club to v1 launch would add 2-3 weeks of
engineering on top of an already-loaded sprint. v1 has six
unresolved blockers (DVLA logbook, transfer flow, legal pack,
end-to-end test on 5 cards, GoDaddy domain, reference number
system). Stripe Subscriptions, DMCC compliance, trial state
machine, email automation, and migration story for existing
customers are each non-trivial. Better to ship grading first,
get real usage data, then build the subscription model on
evidence rather than guesses.

---

## Registry stats — return when volume justifies

**Decision date:** 2026-04-30
**Trigger:** When totalGraded > 100, restore the "At a Glance"
section on /registry.

Removed in 5668274 because at v1 launch volume (15/15/4/4) the
small numbers undermine the page's positioning as the public
ledger of every graded card. Better hidden than shown small.

When restoring, consider:
- Conditional render via `if stats.total_graded > 100`
- Or keep removed permanently and replace with a more
  qualitative section (e.g. "Recent additions" ticker)
- Decide based on what the registry page is doing for users
  at that point — credibility builder, search interface, or
  social proof?

---

## v1.1 — Draft grade exposure on public cert page

The `certificates.grade` column is written by both `draft_save` (debounced auto-save during admin editing) AND `approve` (final publish). The public `/cert/:id` page reads `grade` directly without checking `grade_approved_at`. Result: any draft-state edit immediately leaks to the public QR-scan view.

**Risk:** low for v1 (Cornelius is sole admin, won't open the workstation if not committed to grading). High for v1.1+ when (a) other admin graders are added, or (b) any auto-save triggers fire during partial edits.

**Fix options (pick one in v1.1):**
1. Gate public `grade` on `grade_approved_at IS NOT NULL` — return `ai_draft_grade` or NULL otherwise
2. Stop writing draft state to `grade`. Use `ai_draft_grade` as the working state, only write `grade` on `/approve`
3. Add `grade_visibility` flag to certificates and gate public read

Option 2 is cleanest and matches the existing schema split (`ai_draft_grade` already exists for this purpose).

**Affected files:**
- [server/routes.ts:7501](../server/routes.ts#L7501) (`/approve` handler)
- The `/grade` auto-save handler (find via grep)
- `server/routes.ts` public cert lookup (`certToPublic`)

---

## v1.1 — Mobile admin layout overhaul

The entire `/admin` area was built desktop-first. On mobile (~390px width) every page squashes the desktop layout into the leftmost ~33% with empty whitespace on the right. Affects: cert browser, cert edit form, grading workstation (forms not crop UI — that was fixed separately in v1.0), submissions list, transfers, scans, intake, pricing, capacity, printing, learning, AI workstation panel.

Scope: 8+ hours. Should be done as a single dedicated sprint, not piecemeal. Strategy:
1. Audit every admin page for missing responsive classes
2. Convert `grid-cols-N` to `grid-cols-1 sm:grid-cols-N`
3. Add mobile-friendly form layouts (full-width inputs, stacked labels)
4. Test every page at 390px width
5. Regression-test every page at desktop width before merge

Affects only the operator (admin user). Customers see the customer-facing pages which are already responsive. Not a launch blocker. Workaround: use desktop for `/admin` work.

---

## v1.1 — Admin tooling polish (assignOwnerManual follow-ups)

Surfaced by the 2026-05-03 owner_email sync hotfix. Manual Assign
now writes correct data but the surrounding UX is still rough.

- Rename `Manual Assign` button to `Reassign Owner` (current label
  ambiguous — implies first-time assignment)
- Add reason-code dropdown to assign-owner endpoint (customer email
  change / account recovery / support ticket / test cleanup) —
  persisted in audit_log details
- Send notification email to previous owner on reassign (DMCC
  consideration — confirm whether triggers required notice)
- Add two-step confirmation modal in admin UI (re-type cert ID to
  confirm)

---

## v1.1 — Transfer flow polish (TRANSFER_FLOW_LIVE follow-ups)

Surfaced when TRANSFER_FLOW_LIVE was flipped to true on 2026-05-04. Flow
is functional but four edges remain rough; none are launch-blocking.

- **Wire `sendTransferV2IncomingReminder` into `runTransferV2Sweep`** ([server/email.ts:945](../server/email.ts#L945) is defined but never called). Fire at day 7 and day 12 of the incoming keeper's 14-day acceptance window so they don't miss the deadline by accident. Without this, an incoming keeper who delays gets only the initial confirmation email and then an `Expired` email — no nudge in between.
- **Admin "freeze auto-finalise" toggle for the first wave of real transfers.** `runTransferV2Sweep` at [server/index.ts:328](../server/index.ts#L328) auto-finalises any `pending_dispute` transfer past its `dispute_deadline` with no human review. For early prod traffic, an admin-controlled freeze flag (or per-cert hold) would let support manually inspect each transfer before the sweep finalises it. DRN rotation + logbook version bump are durable changes — irreversible without a manual repair script.
- **Audit transfer email templates for legal-pack URL integrity.** `LEGAL_PAGES_LIVE=false` in prod, so any `/legal/<slug>` link in the V2 transfer email bodies will currently 404 when the recipient clicks it. Either (a) audit the templates and remove/rewrite legal links until LEGAL_PAGES_LIVE flips, or (b) gate the V2 transfer templates on `LEGAL_PAGES_LIVE` so they don't go out until the legal pack is live.
- **`/transfer` UI launch announcement.** The flag flip is silent — `/transfer`, `/transfer/accept`, `/transfer/claim-by-code` pages already rendered before the flip (submissions just 503'd). A user who tried it last week and saw an error has no way to know it works now. Consider a launch banner on `/transfer` or a one-shot email to existing cert-owners announcing the feature is live.

---

## v1.1 — Submit-flow follow-ups (Phase 1 E2E test, MV-SUB-000317)

Surfaced 2026-05-04 by physical E2E test on submission MV-SUB-000317. Display fixes (PDF row-numbering, address-box overflow, success-page totalPrice) shipped same day in commit `ec99bd9`. The four items below are intentionally deferred — none are launch-blocking but all need to land before high-volume payment traffic.

- **`payment_amount` and `payment_timestamp` are not written by `markSubmissionAsPaid`** ([server/storage.ts:283-294](../server/storage.ts#L283-L294)). The UPDATE clause sets only `status`, `payment_status`, `updated_at`. As a result, all paid submissions in prod (315, 316, 317) have NULL in those two columns. Breaks any future reconciliation against Stripe (e.g. "did the amount we charged match the amount stored?"). Fix: extend the method signature to accept `amountPence` + `paidAt`, plumb from both call sites (webhook handler at [server/webhookHandlers.ts:67](../server/webhookHandlers.ts#L67) and `/api/confirm-payment` at [server/routes.ts:601](../server/routes.ts#L601)). Backfill of existing rows from Stripe API optional but recommended.

- **Zero `audit_log` rows for the /submit lifecycle.** Locked-rule violation. The infrastructure (`storage.writeAuditLog`) is fine and used heavily elsewhere, but no submission-flow code path calls it. Three call sites need adding: [server/routes.ts:1480](../server/routes.ts#L1480) (`submission.created` at create-payment-intent), [server/routes.ts:601](../server/routes.ts#L601) (`submission.payment_received` at confirm-payment), [server/webhookHandlers.ts:51](../server/webhookHandlers.ts#L51) (mirror at webhook for back-up coverage). Decide canonical action names + use `tracking_number` as `entity_id` for consistency with admin pattern. Note: the `terms_accepted` audit at [server/routes.ts:1523-1539](../server/routes.ts#L1523-L1539) is gated on `FEATURE_FLAGS.LEGAL_PAGES_LIVE` (currently `false`) so it's a no-op in prod — that one will start firing automatically when the legal pack ships.

- **Tier dictionary collision between PDF and confirmation page.** [server/packingSlip.ts:92-95](../server/packingSlip.ts#L92-L95) has a private `tierNames` map with 5 keys (`basic`/`standard`/`premier`/`ultra`/`elite`) while [shared/schema.ts:905](../shared/schema.ts#L905) has the canonical `pricingTiers` with different ids and names (`standard`→"VAULT QUEUE", `priority`→"STANDARD", `express`→"EXPRESS"). Result: PDF says "Standard" while confirmation page says "VAULT QUEUE" for the same submission. Worse, the PDF dictionary has 4 ghost keys that don't exist in pricingTiers and is missing `priority` + `express`. Fix: delete `tierNames` from packingSlip.ts, import `pricingTiers` from `@shared/schema`, look up by id. Single source of truth. Note: this will mean the PDF starts showing "VAULT QUEUE" for the £19 tier — separate product question whether that's the right name.

- **Card-detail entry section is collapsed by default.** [client/src/pages/submit.tsx:457](../client/src/pages/submit.tsx#L457): `useState(state.cardItems.length > 0)` → defaults to `false` for a fresh wizard. Customer has to click "Add Card Details (Optional)" to open it. Phase 1 test customer (Cornelius) didn't open the section, so all 5 `submission_items` rows have NULL game/card_set/card_name/card_number/year. PDF correctly renders "—" for NULL — no code bug, but **UX call needed**: required, default-expanded, or keep optional? Recommend default-expanded as low-friction nudge.

- **Receipt photo URLs expire after 7 days.** Hotfix `2727172` (2026-05-04) capped `getR2SignedUrl` at AWS SigV4's 7-day max. The handler at [server/routes.ts:6597](../server/routes.ts#L6597) stores fully-signed URLs directly in `submissions.on_receipt_photo_urls` (TEXT JSONB). After 7 days these URLs return 403, breaking both the customer "we received your cards" email links and admin photo display. **Long-term fix:** persist R2 keys (not URLs) in `on_receipt_photo_urls`; mint fresh ~1h presigned URLs on demand from (a) an authenticated admin photo-view endpoint and (b) a token-signed customer-facing endpoint embedded in emails. Touch sites: the mark-received handler (drop the signing call, store keys), the admin-submissions detail render, the `sendCardsReceived` email template. Also add a cleanup script for orphan `receipt/*` R2 objects whose parent submission has `on_receipt_photo_urls IS NULL` — the failed Phase 2 attempts left two ~3MB orphans at `receipt/MV-SUB-000317/` (different timestamps, same image) that won't be reachable post-fix.

### Stripe webhook misconfiguration (operational, not code)

Discovered during Phase A3 diagnostic. Stripe TEST-mode webhook endpoint is registered at the stale `https://mint-vault.replit.app/api/stripe/webhook` URL (Replit hosting from the pre-Fly era) and only subscribes to `checkout.session.completed` — `payment_intent.succeeded` is not subscribed. Fly app is therefore unreachable from Stripe; `payment_intent.succeeded` events fire but never deliver. Status='paid' is currently set entirely by the client-driven `/api/confirm-payment` path (which does verify with Stripe via `paymentIntents.retrieve`, so payments are real — just no webhook safety net).

Action items (Stripe Dashboard, no code):
- Update webhook URL to `https://mintvaultuk.com/api/stripe/webhook` (and/or `https://mintvault.fly.dev/api/stripe/webhook`)
- Subscribe to `payment_intent.succeeded` and `payment_intent.payment_failed`
- Verify/rotate `STRIPE_WEBHOOK_SECRET` in Fly env to match new endpoint signing secret
- Repeat for LIVE-mode webhook endpoint before the launch flip

### Latent security check in /confirm-payment

[server/routes.ts:601](../server/routes.ts#L601) `/api/confirm-payment` retrieves the PI server-side (so the client cannot fake a successful PI status), but does **not** verify the PI belongs to the submission. Add cross-checks: `submission.paymentIntentId === paymentIntentId` (we already store this at create-time at [server/routes.ts:1579-1581](../server/routes.ts#L1579-L1581)) and ideally `paymentIntent.metadata.submissionId === submissionId`. PI IDs are 36-char random strings so guessing is hard, but defending against ID-substitution is a 2-line hardening worth bundling with the audit-log additions above.

---

## Retired infra — do not re-add

- **`ADMIN_PIN` env var** — deleted 2026-05-04 after PIN auth migration
  (commits `9cc6fca`, `66aab7b`). Per-user bcrypt PIN on
  `users.pin_hash` is the only admin PIN source. Do not re-add the env
  var; if a regression ever requires it, the design has reverted, not
  the env-var-as-source-of-truth.
