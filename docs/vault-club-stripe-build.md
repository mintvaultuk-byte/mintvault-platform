# Vault Club Stripe Subscriptions — build log

Multi-step phased build of paid Silver Vault Club subscriptions
on Stripe. Tracks decisions, status, and blockers per step.

Cross-reference: `/docs/post-launch-backlog.md` (the strategic
decision to shift Vault Club to paid gateway, dated 2026-04-30).

---

## Step 1 — Stripe Price IDs + DB schema foundation

**Status:** Branch `feat/vault-club-stripe-phase1-schema` —
schema + migration helper + audit log wrapper committed,
NOT merged, NOT deployed.

### What's done

- `vault_club_subscriptions` table defined in
  `shared/schema.ts` (Drizzle) — tracks one Stripe Subscription
  per row, indexed by user_id and (status, current_period_end).
- `server/vault-club-subscriptions-schema.ts` — idempotent
  CREATE TABLE IF NOT EXISTS migration helper, pattern matches
  `server/account-auth.ts` `migrateAccountSchema()`. Wired
  into the startup chain in `server/routes.ts` after
  `migrateMarketplaceSchema()`. First boot of any deploy that
  includes this code creates the table; subsequent boots
  no-op.
- `server/vault-club-audit.ts` — thin wrapper over
  `storage.writeAuditLog()` that pins `entity_type =
  "vault_club_subscription"` and the
  `VaultClubAuditAction` union for state-change actions
  (created / trial_started / trial_ended_paid / renewed /
  payment_failed / canceled / reactivated / comped / etc.).
  STUB — not yet called from anywhere. Step 3 webhook
  handlers will use it.

### Schema

| Column | Type | Notes |
|---|---|---|
| `id` | varchar PK | gen_random_uuid() |
| `user_id` | varchar NOT NULL | FK → users.id ON DELETE CASCADE |
| `stripe_customer_id` | text NOT NULL | "cus_..." |
| `stripe_subscription_id` | text NOT NULL UNIQUE | "sub_..." |
| `stripe_price_id` | text NOT NULL | which plan |
| `status` | text NOT NULL | Stripe enum |
| `trial_end` | timestamptz nullable | |
| `current_period_start` | timestamptz NOT NULL | |
| `current_period_end` | timestamptz NOT NULL | |
| `cancel_at_period_end` | boolean NOT NULL DEFAULT false | |
| `canceled_at` | timestamptz nullable | |
| `created_at` | timestamptz NOT NULL DEFAULT now() | |
| `updated_at` | timestamptz NOT NULL DEFAULT now() | |

**Indexes:**
- `idx_vault_club_subs_user_id` on `(user_id)`
- `idx_vault_club_subs_status_period` on `(status,
  current_period_end)` — for dunning queries
- UNIQUE constraint on `stripe_subscription_id` auto-creates
  the index used by webhook-handler lookups

Timestamps are `timestamptz` (vs the codebase's other tables
which use plain `timestamp`). Stripe sends Unix UTC
timestamps; storing them naively would lose timezone. Other
tables' plain-timestamp choice is a long-running quirk —
not fixed here.

### Stripe Price IDs reconnaissance ⚠️ blocker for Step 2

Existing config at [server/vault-club-config.ts](../server/vault-club-config.ts)
hardcodes 6 Price IDs (bronze + silver + gold, monthly +
annual). Bronze and Gold deprecated 2026-04-19 — Silver-only
launch. Only the silver IDs matter going forward.

**Probed via Stripe CLI** (authed against "Mint Vault
Sandbox", test mode, account `acct_1T3qghPFVe8DwVlR`):

```
$ stripe prices list --active=false --limit=20
{ "data": [], ... }                            ← no archived prices

$ stripe prices list --limit=20
{ "data": [], ... }                            ← no active prices

$ stripe products list --limit=10
{ "data": [], ... }                            ← no products

$ stripe prices retrieve price_1TJv4TRN7H2pRqKEISdUbktX
{ "error": { "code": "resource_missing",
             "message": "No such price: ..." } }
```

**Conclusion:** the Stripe sandbox is empty. The Price IDs in
config are stale — they came from a previous test account
that's no longer connected. Need to either:

- **(a)** Run the existing setup endpoint
  `POST /api/admin/vault-club/setup-stripe-products`
  ([server/vault-club.ts](../server/vault-club.ts) line ~150)
  which creates the products + prices via Stripe API and
  echoes the IDs back to console for pasting into config.
  This is the documented happy path (per the comment block
  at the top of `vault-club-config.ts`).
- **(b)** Manually create Silver product + monthly + yearly
  prices in the Stripe dashboard, then paste IDs into config.

Cornelius's call. Either way, the new IDs need to land in
[server/vault-club-config.ts](../server/vault-club-config.ts)
before Step 2 (buy buttons + checkout endpoint) can work,
because Stripe Checkout requires a real Price ID to create
the session.

### Migration safety status

Schema definition + migration helper compiled and
type-checked clean. **Not yet applied to any database** —
deferred per CLAUDE.md golden rule #2 (no destructive DB
commands without explicit approval). Application strategy
options:

- **Auto-apply on next deploy:** The migration is wired into
  the startup chain. When Step 2 (or later) merges and
  deploys, the table gets created on first server boot.
  Idempotent — subsequent boots no-op. Recommended.
- **Pre-apply manually:** Run via `fly ssh console` + node-pg
  to execute the `CREATE TABLE IF NOT EXISTS` directly.
  Faster but requires manual coordination.

Note from session memory: prod and "staging" share the same
Neon DB. The brief mentioned `ep-purple-voice` as a staging
branch — if a separate Neon branch is configured, the
migration could be tested there first via a `MINTVAULT_DATABASE_URL`
override. Not done in this session.

### What Cornelius needs to decide before Step 2

1. **Stripe Price IDs:** revive (impossible — they're gone),
   create new via setup endpoint, or create new manually in
   dashboard? Recommend setup endpoint route (it's the
   documented happy path and the code already exists).
2. **Migration strategy:** auto-apply on Step 2 deploy
   (recommended) vs manual pre-apply.
3. **Test/live mode for Step 2:** Stripe CLI is currently in
   test mode. Step 2 build should target test mode for
   integration testing first; the real `sk_live_*` key swap
   happens at the Step 4/launch boundary alongside webhook
   secret rotation.

### Files added / modified in Step 1

- `shared/schema.ts` — appended `vaultClubSubscriptions` table
  + types (~40 lines)
- `server/vault-club-subscriptions-schema.ts` — NEW (~70
  lines)
- `server/vault-club-audit.ts` — NEW (~55 lines)
- `server/routes.ts` — wire `migrateVaultClubSubscriptionsSchema`
  into startup chain (~4 lines)
- `docs/vault-club-stripe-build.md` — NEW (this file)

### Next: Step 2

Buy buttons on `/vault-club` (replace the current
`mailto:waitlist` CTA with month/year Stripe Checkout
buttons) + `/api/billing/vault-club/checkout` endpoint that
creates a Stripe Checkout Session and redirects.
