# G5 Scope Guard

## In scope
Internal Super-Admin Partner MANAGEMENT: partner org list/search/filter; partner detail (Overview/Profile/Contacts/Branding/Activity/Notes/Audit/Connector-Summary tabs); profile edit + validated status transition; contacts CRUD + soft-deactivate; branding METADATA; append-only internal notes; activity feed from existing events; safe bounded statistics; partner-focused audit. All behind `requireAdmin` at `/api/super-admin/partner-management` + `/admin/partner-network/partners*`.

## Hard boundaries (owner, non-negotiable — asserted by tests + reviews)
- No wallet/credits/ledger; no grading slots; no Stripe/billing; no external Partner Portal; no portal mount (`createPartnerApp` stays test-only); no `partner_portal_enabled`/`partner_connector_enabled` write; no deploy; no live migration; no G6.
- No grading/grade/cert/cert-number/label/print-batch/payment/Stripe/email/notification/webhook/Vault-Quest creation or mutation.
- Suspension/status = business-status LABEL only — must NOT enable flags, mount portal, alter wallet, create slots, alter submissions/certificates, delete tenant data, or silently revoke users/devices/sessions.
- Branding = METADATA only — no custom-domain routing, no certificate/label skinning, no public white-label rendering, no live DNS, no production R2 upload (store reference/metadata; upload integration deferred), no public activation.
- Internal notes = append-only, MintVault-staff-only, never partner-visible; no UPDATE/DELETE (correction = new note).
- Statistics only from authoritative current data; unavailable metrics (cert/grade counts) LABELED, never faked; bounded queries only, no unbounded cross-table scans, no join to MintVault submissions/certificates.
- No `partner_organisations` ALTER (parity-locked); no new nav SECTION / no nav reorder; no future-phase controls (wallet/credits/slots/billing/devices/pricing/marketplace/portal) in the UI; no misleading disabled placeholders.

## Deferred (documented; NOT built)
Logo R2 upload (store metadata/reference only), custom-domain routing/verification, per-partner cert/grade statistics (need a tenant-linked read-model), any enforcement side effect of status/suspension.

## Files expected to change (allow-list for drift checks)
- `migrations/0015_partner_management.sql`, `migrations/rollback-partner-management.sql`
- `server/partner/partner-management-service.ts`, `partner-management-errors.ts`, `partner-management-routes.ts` (NEW), `server/routes.ts` (ONE registration line + import)
- `client/src/pages/admin/partner-management.tsx`, `partner-management-detail.tsx`, `partner-management-helpers.ts` (NEW), `client/src/App.tsx` (routes), `client/src/components/admin/admin-shell.tsx` (ONE NavLink)
- `tests/partner-management-*.test.ts` (NEW), `tests/helpers/partner-realistic-db.ts` (add 0015 list), `tests/partner-connector-migration.test.ts` (14→15 count)
- `.claude/controlled-code-lead/tasks/partner-network-g5/*` (docs)
Any file outside this list in `git diff --stat` = STOP and explain.
