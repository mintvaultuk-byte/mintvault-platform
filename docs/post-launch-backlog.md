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
