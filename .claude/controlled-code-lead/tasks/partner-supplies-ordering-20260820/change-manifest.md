# Change manifest — Partner supplies ordering

## User-visible behaviour

1. Partner **More** (a secondary control, never the five-item primary rail) exposes **Supplies** and **My Orders** on desktop and mobile.
2. Supplies presents only three fixed, server-owned products: Plastic graded slabs, Print paper / label stock, and NFC tags. A Partner confirms the server-resolved delivery snapshot and submits exactly one canonical order for a stable request idempotency key.
3. Missing location selection, incomplete location delivery address/postcode, or missing active operational contact fails closed with a truthful action to contact the Partner Owner/MintVault administrator; the browser never supplies authority for the address, contact, tenant, location, status, or product catalogue.
4. My Orders is scoped to the signed-in Partner tenant and shows reference, immutable item snapshots, creation time and status.
5. Super Admin gets one Partner Network **Supplies Orders** workspace to read all orders and transition only `RECEIVED → PROCESSING|CANCELLED` and `PROCESSING → DISPATCHED|CANCELLED`.
6. Canonical order, line items, event/audit evidence and notification outbox commit before Resend is called. Resend retries reuse the same provider idempotency key and cannot create another order.

## Exact source changes

- Add `migrations/0102_partner_supplies_orders.sql` and matching additive Drizzle mirrors in `shared/partner-schema.ts`.
- Add only explicit `partner.supplies.view` and `partner.supplies.submit` RBAC permissions to the canonical map and migration seed; no existing permission is revoked.
- Add `server/partner/supplies-service.ts`, `server/partner/supplies-routes.ts`, and `server/partner/supplies-admin-routes.ts`; mount through the existing authenticated Partner and Super Admin composition only.
- Add a narrow `sendPartnerSuppliesOrderNotification` template to the existing Resend authority and a bounded advisory-locked retry tick. No new provider, no hard-coded recipient, and no payment code.
- Add Partner Supplies/My Orders pages, typed API helpers, lazy routes, and a responsive secondary More surface only. Replace the two existing placeholder route uses; leave all unrelated placeholder routes untouched.
- Add Super Admin Supplies Orders page/link inside existing Partner Network navigation.
- Add focused real-Postgres, route/RBAC, Resend/outbox, source/UI and migration-scope tests; extend the realistic Partner migration allowlist intentionally.
- Preserve the current staging full-resolution evidence release (`aab526ea`) by normal merge, as the guarded live-ancestry check requires. Reconcile only the shared Partner shell: retain its exact five primary items and add Supplies/My Orders to its existing responsive More section.

## Explicit non-changes

- No production deploy, migration, data write, provider call or stock fulfilment.
- No Stripe/payment, Scanner, Canon, grading/MVGS, R2, Partner authentication/session, credit or wallet change.
- No primary navigation item beyond Dashboard, New Submission, Grading, Completed, Credits & Billing.
- No dynamic SKU, price, shipping-charge, checkout, or per-card placement calibration.

## Protected-operation plan

The only later protected operation is a **staging-only additive migration and guarded deploy**, then one deliberately labelled test order and its existing-Resend notification. The owner expressly authorised this in the request. It is not performed until the final candidate is committed, tests pass, the migration runner dry-run is clean, the current live SHA resolves, and a fresh bounded local approval record identifies the exact candidate SHA, command, scope, expiry and rollback. Production remains prohibited.
