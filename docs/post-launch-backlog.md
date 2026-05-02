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

## v1.1 — cleanup & latent risk

### Strip dead Vault Club discount branch from checkout review (submit.tsx)

**Context.** [client/src/pages/submit.tsx:705-1050](../client/src/pages/submit.tsx#L705-L1050) still contains a Vault Club percentage-discount path: a `vcPercent` prop, `vcWins` logic, and a "Vault Club discount (X%)" label rendered in the review step. This is currently inert because `/api/vault-club/check-discount` hard-returns `discount_percent: 0` ([server/vault-club.ts:140-163](../server/vault-club.ts#L140-L163), removed 2026-04-19 when the club moved to a perks-and-credits model). The `vcWins` branch never evaluates true, so the bulk-discount label is the only path that ever renders.

**Risk.** Footgun. If anyone re-enables the discount endpoint without also removing the client-side fork, fake "Silver Vault Club discount (X%)" labels would silently appear at checkout review. Same DMCC/CPR exposure class as the dashboard fix shipped 2026-05-02 (commit 17c2487) — a marketing/pricing claim with no traceable code path.

**Scope.** Remove `vcPercent`, `vcTier`, `vcWins`, the `discountLabel` ternary, and the `useQuery` hook fetching `/api/vault-club/check-discount`. Keep the bulk-discount path (legitimate). Run `npm run check` to confirm clean. Should ship as a targeted PR — payment flow, deserves a focused audit, not a tacked-on edit on top of an unrelated change.

**Effort.** ~30 minutes including verification.

**Superseded by.** "Restore 10% grading discount for Silver Vault Club members" (below). The dead branch is being repurposed, not deleted — this item now applies only if the restoration item is itself shelved.

### Welcome email tier-label hardcoded from sub record (email.ts)

**Context.** [server/email.ts:1213-1215](../server/email.ts#L1213-L1215) — `sendVaultClubWelcomeEmail` interpolates `tierLabel` (derived from `data.tier`) into both the subject line (`Welcome to Vault Club ${tierLabel}`) and the email header. After commit 17c2487 (2026-05-02), the body shows Silver-only perks regardless of the subscription's `tier` value. If a re-welcome ever fires on a legacy bronze or gold subscription record, the subject reads "Welcome to Vault Club Bronze" while the body lists Silver perks.

**Risk.** Cosmetic. Realistic likelihood: zero. The welcome email only fires on subscription activation, and no new bronze or gold sign-ups have been possible since 2026-04-19. The only path that could trigger this is a deliberate re-welcome on a legacy sub record, which is not a documented flow.

**Scope.** Two options: (a) drop `tierLabel` from the subject and header and hardcode "Vault Club" or "Vault Club Silver", since Silver is the only live tier; or (b) restore tier-specific welcome bodies if bronze or gold are ever reinstated. Option (a) is the right call unless multi-tier returns.

**Effort.** ~5 minutes.

### Restore 10% grading discount for Silver Vault Club members

**Context.** Silver Vault Club currently offers a perks-and-credits bundle (2 free Authentication add-ons per month, free return shipping, 100 AI Pre-Grade credits, priority queue, activated Showroom). The percentage-discount model was removed 2026-04-19 ([server/vault-club.ts:140-163](../server/vault-club.ts#L140-L163), [server/vault-club-tiers.ts:12](../server/vault-club-tiers.ts#L12) — both have inline comments documenting the removal). The founder has since decided to reinstate a 10% grading discount for active Silver members, layered on top of the existing perks bundle. This is a deliberate reversal of the April 2026 architectural decision, not a regression.

**Risk.** Cross-cutting change. Pricing engine, customer-facing copy across six or more files, T&Cs, and the marketing page must all move together — partial implementation reintroduces the same DMCC/CPR exposure that motivated the 2026-05-02 cleanup (claim without code path). Solicitor review of revised T&Cs is required before any deploy. Margin impact on the £9.99/mo plan must be modelled — Silver perks already cost roughly £30/mo per active member at full utilisation, and a 10% grading discount on top tightens unit economics further. The stacking rule with the existing bulk discount needs an explicit decision; the working assumption is "higher of the two, mutually exclusive" (per the existing memory rule), but that should be confirmed before code lands.

**Scope.**

1. Add `discount_percent: 10` to the Silver tier in [server/vault-club-tiers.ts](../server/vault-club-tiers.ts).
2. Restore `/api/vault-club/check-discount` to return `10` for active Silver subs (currently hard-returns `0` in [server/vault-club.ts:140-163](../server/vault-club.ts#L140-L163)).
3. Re-wire checkout pricing in [server/routes.ts](../server/routes.ts) (around the bulk-discount calc, ~line 1484) to apply the percentage when the user has an active Silver sub, respecting the higher-of stacking rule.
4. Restore `vcPercent` / `vcWins` / `discountLabel` rendering in [client/src/pages/submit.tsx](../client/src/pages/submit.tsx) — repurpose the existing dead branch flagged in the item above; do not delete.
5. Restore the "Discount" stat on the dashboard widget — revert the relevant portion of [client/src/pages/dashboard.tsx](../client/src/pages/dashboard.tsx) from commit 17c2487 (2026-05-02), showing "10%" for Silver.
6. Update the /vault-club marketing page ([client/src/pages/vault-club.tsx](../client/src/pages/vault-club.tsx)) — current copy explicitly states "Not a percentage discount on grading. Perks are flag-based" — that becomes false and must change.
7. Update the home-page Vault Club teasers across all four variants ([home.tsx](../client/src/pages/home.tsx), [home-v2-integrated.tsx](../client/src/pages/home-v2-integrated.tsx), [home-v3.tsx](../client/src/pages/home-v3.tsx), [home-v4.tsx](../client/src/pages/home-v4.tsx)) — restore percentage language alongside the perks list.
8. Update the welcome email — `sendVaultClubWelcomeEmail` in [server/email.ts](../server/email.ts) — to add a "10% off grading" line to the perks list.
9. Revise [content/legal/vault-club-terms.md](../content/legal/vault-club-terms.md) to disclose the 10% discount, refund implications, and edge cases (cancellation mid-submission, downgrade, lapse during in-flight grading, etc.).
10. Solicitor review of the revised T&Cs — Adam J — before deploy.
11. Update memory rule #20 (perks-and-credits model → hybrid: perks + 10% Silver discount, no other tier percentages).
12. Margin model: confirm the £9.99/mo plan remains profitable at expected Silver utilisation including the 10% grading discount on top of 2 free Authentication add-ons, free returns, and 100 AI credits.

**Effort.** 1–2 engineering days plus solicitor turnaround. Cannot ship within the v1 timeframe. Targeted v1.1 release with its own deploy and announcement.

---

These items reference feature branch `feat/vault-club-stripe-phase1-schema` as of commit 17c2487 (2026-05-02). No urgency — post-v1.

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
