# G5 Admin UI

Inside the existing admin app. Nav is 2-level + owner-frozen → keep `/admin/partner-network` (G4 ops page) UNCHANGED; add ONE additive `NavLink` "Partners" → `/admin/partner-network/partners`. Routes (flat siblings, most-specific-first, before the Layout catch-all): `/admin/partner-network/partners/:partnerId` then `/admin/partner-network/partners`. IA (Overview/Partners/Connector-Ops/Audit) = in-page tabs + a link to the existing Connector Operations page (no sidebar restructure, no rename → avoids nav-testid collision + `next=` drift).

Each page: self-auth-gate (`fetch("/api/admin/session")` → redirect `/admin/login?next=…`), `AdminShell` (activeTab="dashboard", title/crumb overrides), TanStack Query with `enabled: authed===true` + EXPLICIT `queryFn` (keys may hold filter objects), `apiRequest`, prefix `invalidateQueries`, admin primitives (Panel/StatCard/Badge/AdminButton/Chip), gold/Manrope tokens via `var(--admin-*)`. Pure logic → `partner-management-helpers.ts` (status→badge, transition validity, reason/version validation, query-key builders, query-string) — unit-tested.

## Pages
1. **Partners list** (`/partners`): search box; status filter chips (PENDING/ACTIVE/SUSPENDED/REVOKED + All); kind filter; connector-health filter; table (name, trading name, status badge, kind, primary contact/email, locations, users, connector summary, last activity); pagination; loading/empty/error states; row → detail. "Create partner" action (reason-optional modal).
2. **Partner detail** (`/partners/:partnerId`): in-page `useState<TabKey>` tabs:
   - Overview (org summary + counts + recent activity + status badge).
   - Company Profile (view + edit modal: trading name, kind, company number, VAT, website, primary email/phone, address, tier, onboarding date, health note — reason-optional, `expectedVersion`).
   - Contacts (table; add/edit modal; deactivate action; primary flag; contact_type; soft-deactivate never delete).
   - Branding (metadata form: display name, logo key (reference, no upload — labeled "upload deferred"), colours, support email/site, custom-domain status, branding_status; `expectedVersion`).
   - Activity (bounded feed, deterministic).
   - Internal Notes (append-only list + "Add note" modal; clearly labeled INTERNAL; no edit/delete controls).
   - Audit (partner_management_audit rows: actor, action, entity, reason, result, timestamp, request id).
   - Connector Summary (read-only counts + link to the existing Connector Operations page for this partner).
3. **Status change**: modal with the allowed target statuses (computed from current), REQUIRED reason, `expectedVersion`, confirmation; SUSPENDED/REVOKED = high-risk → typed-confirm (`CONFIRM`). Clear "this is a business-status label; no accounts/devices/flags are changed" note.

## Safety UX
Reason field + confirmation modal for mutations; typed-confirm for high-risk (suspend/revoke, contact-deactivate-after-primary); disabled controls for invalid actions with a visible reason (unavailableReason); no optimistic completion (await server → invalidate); loading/empty states; a11y (role=dialog, aria-labelledby, `<label htmlFor>`, Escape, autofocus, visible focus, no colour-only status — badges carry text). Unavailable statistics rendered as an explicit "Unavailable — no tenant-linked source yet" chip, never a fake 0.

## Out (negative source-asserts in tests)
No wallet/credits/slots/billing/devices/pricing/marketplace controls; no "Buy Credits"; no wallet balance; no portal links/writes; no future-phase placeholders.

## Testing (no DOM harness)
Pure-helper units + source-assertion (data-testids, AdminShell reuse, /api/admin/session gate, reason/expectedVersion gating, a11y attrs, unavailable-metric labels) + negative-scope asserts + API integration.
