# Partner Network Legacy Parity Inventory

Scope: P10 inventory for `feat/super-admin-partner-network-consolidation`, derived from the interactive controls in `client/src/pages/admin/partner-dashboard.tsx`, `partner-management.tsx`, `partner-management-detail.tsx`, and `partner-network.tsx`.

This inventory records presentation relocation only. It does not grant any new authority.

| Legacy surface / interactive element | Canonical destination or retained surface | API / guard / audit parity | Status |
| --- | --- | --- | --- |
| Partner Master Dashboard summary, pipeline and alerts | `/admin/partners` R2 consolidated Overview | Existing dashboard service; `requireSuperAdmin → dashboardReadRateLimit → requirePartnerReadVisibility`; dashboard read audit retained | MIGRATED |
| Dashboard Partner table: Partner, Staff, pipeline, credits, security, activity | Exact Partner workspace tab | Existing dashboard reads; no new mutation | MIGRATED |
| Dashboard alert: credit / lock / onboarding / connector / security | Credits / Staff / Onboarding / Infrastructure / Security by stable alert-source ID | Existing dashboard read and audit; navigation only | MIGRATED |
| Dashboard wallet adjustment | Partner workspace Credits | Existing `POST /api/super-admin/partner-dashboard/partners/:id/credits/adjust`, `requireAdminStepUp`, append-only audit/idempotency unchanged | MIGRATED |
| Dashboard drill-down overview, submissions, corrections, devices, audit | Retained in existing dashboard detail until further non-campaign retirement proof | Existing guarded dashboard sections and audit unchanged | RETAINED |
| Partner Management directory search/filter/pagination | `/admin/partners/shops` — the one canonical network-wide shop list. `/admin/partners/directory` and `/admin/partner-network/partners` both redirect to it | Existing partner-management reads, `requireSuperAdmin` unchanged | MIGRATED |
| Create Partner | `/admin/partners/shops` ("Onboard a shop" → the 10-step wizard) | Existing current-main create authority; no P2 provisioning assumption | MIGRATED |
| Partner Pilot flags | `/admin/partners/settings` retained current management surface | Existing flag authority/guards unchanged | REDIRECTED |
| Wallet backfill `WALLET-BACKFILL1` | Retained directory control | Existing environment gate, identity pin, confirmation, Super Admin guard, rate limit, idempotency and audit unchanged | RETAINED |
| Legacy Partner detail Overview / Users / Locations / Profile / Contacts / Branding / Activity / Notes / Audit / Connector | Canonical Partner workspace; full legacy detail remains when feature flag is off | Existing partner-management routes, mutations, reason/confirmation and audit unchanged | MIGRATED / RETAINED FOR ROLLBACK |
| Location create/edit/status and Google Maps address action | Partner Workspace Locations | Existing location authority and audit unchanged; Maps is encoded external navigation only | MIGRATED |
| Fleet station filters and lifecycle actions | `/admin/partners/settings/stations` (Settings → Advanced). Network-wide station problems now surface on Overview → Needs Attention with an inline Approve Scanner action; per-shop lifecycle stays in the shop workspace | Existing `GET /api/super-admin/fleet/stations` and existing step-up POSTs unchanged | MIGRATED |
| Connector Operations filters, record drawer and action controls | `/admin/partners/settings/infrastructure` (Settings → Advanced); `/admin/partners/infrastructure` redirects | Existing `/api/super-admin/connector-ops`; deliberately retained `requireAdmin` guard (SEC-CONNECTOR-GUARD-ASYMMETRY) | REDIRECTED |

## Redirect compatibility

| Legacy URL | Canonical URL when `VITE_PARTNER_NETWORK_CONSOLIDATION=true` | Compatibility behavior |
| --- | --- | --- |
| `/admin/partners/dashboard` | `/admin/partners` | Query string and fragment retained; application log emitted |
| `/admin/partner-network/partners` | `/admin/partners/shops` | Query string and fragment retained; application log emitted |
| `/admin/partner-network/partners/:partnerId` | `/admin/partners/:partnerId` | Partner UUID, query string and fragment retained; application log emitted |
| `/admin/partners/directory` | `/admin/partners/shops` | Renamed to the operator's word for it; query string and fragment retained |
| `/admin/partners/stations` | `/admin/partners/settings/stations` | Moved out of everyday navigation into Settings → Advanced; capability unchanged |
| `/admin/partners/infrastructure` | `/admin/partners/settings/infrastructure` | Moved out of everyday navigation into Settings → Advanced; capability unchanged |
| `/admin/partner-network` | `/admin/partners/infrastructure` | Query string and fragment retained; application log emitted |

Legacy components are not removed in this campaign. They remain for at least two releases or 90 days, whichever is longer. The telemetry in `client/src/App.tsx` is `console.info` application logging only and never writes `audit_log`.

## Explicit non-parity claims

No source represents a new Partner quality score, Scanner registry, embedded map, grading writer, QA review component, approval/return/reject endpoint, P2 provisioning flow, P6 scanner authority, or database migration. These are not silently represented as zeros or as completed work.
