# G5 — Partner Management — Task Ledger

## Stage 0 — Baseline (recorded)
- Authoritative baseline: `origin/main = 4d0c370f` (published G4 merge; confirmed unchanged).
- G5 branch: `feat/partner-network-g5-partner-management`.
- G5 worktree: `/Users/cornelius/mintvault-worktrees/partner-network-g5-partner-management` (from 4d0c370f, clean; node_modules symlinked, lockfile identical).
- Shared checkout (`/Users/cornelius/mintvault-platform`) on `feat/partner-network-phase-1-runtime` @ 9082cb1d with unrelated dirty files — NOT used for G5.
- G4 merge-review worktree retained separately — NOT reused for G5 implementation.

## Scope (owner-authorised)
Internal Super-Admin Partner MANAGEMENT only: partner org list/search/filter, partner detail (overview/profile/contacts/branding/activity/notes/audit/connector-summary), profile edit + validated status lifecycle, contacts CRUD (+ soft deactivate), branding METADATA only, append-only internal notes, activity feed from existing events, safe bounded statistics, partner-focused audit. requireAdmin only.

## Prohibited (owner, non-negotiable)
No wallet/credits/ledger; no grading slots; no Stripe/billing; no external Partner Portal; no portal mount; no `partner_portal_enabled`/`partner_connector_enabled` write; no deploy; no live migration; no G6. No grading/grade/cert/cert-number/label/print/payment/Stripe/email/notification/webhook/Vault-Quest creation or mutation. No wallet/slot controls or future-phase nav placeholders in the UI. Suspension = business-status label only (no silent enforcement/revocation). Branding = metadata only (no domain routing / cert-label skinning / public activation). The existing G4 page at /admin/partner-network must keep working.

## Protected actions (require owner approval each time)
push, deploy, migration APPLICATION (authoring + disposable-PG proof only this pass), auth-logic edits, payment/Stripe edits, protected-system edits (MVGS/cert_counter/labels).

## Stage log
- Stage 0 baseline: COMPLETE.
- Stage 1 discovery: 4 read-only reviewers dispatched (A partner schema/tenancy; B admin auth/API; C admin UI/nav; D migration/testing/protected).
- Next authorised action: receive + verify discovery → write G5 design docs → author migration 0015 (disposable PG only) → service/API → UI → tests → 7 reviews → gates → Final Release Authority → merge-review (no push). No protected action.
