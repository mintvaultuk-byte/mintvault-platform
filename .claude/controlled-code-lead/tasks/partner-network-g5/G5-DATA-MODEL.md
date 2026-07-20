# G5 Data Model (migration 0015 — additive)

`partner_organisations` is NOT altered (parity-locked). All new metadata lives in additive tables. Every tenant-owned table: `tenant_id uuid NOT NULL REFERENCES partner_organisations(id) ON DELETE RESTRICT`, `ENABLE`+`FORCE ROW LEVEL SECURITY`, `%I_tenant_isolation` policy `USING/WITH CHECK (tenant_id = partner_current_tenant())`, index on tenant_id, uuid PK `gen_random_uuid()`, no PUBLIC. Admin path (`partnerAdminQuery`, no RLS context) always filters `WHERE tenant_id=$1` explicitly.

## 1. partner_profiles (1:1 with org)
`id uuid PK, tenant_id uuid NOT NULL UNIQUE REFERENCES partner_organisations(id) ON DELETE RESTRICT, trading_name text, organisation_kind text CHECK IN ('shop','independent_grader','franchise','scanning_centre','enterprise','other'), company_number text, vat_number text, website text, primary_email text, primary_phone text, address_line1 text, address_line2 text, address_city text, address_postcode text, address_country text, onboarding_date date, internal_tier text, health_note text, version integer NOT NULL DEFAULT 1, created_at/updated_at`. GRANT SELECT TO partner_runtime (RLS-scoped read; future portal). Admin writes via admin pool. `version` = the partner-aggregate optimistic lock (profile edits + status changes both check/bump it).

## 2. partner_contacts
`id uuid PK, tenant_id NOT NULL FK org RESTRICT, full_name text NOT NULL, title text, email text, phone text, contact_type text NOT NULL CHECK IN ('general','billing','technical','operations'), is_primary boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true, notes text, version integer NOT NULL DEFAULT 1, created_at/updated_at, created_by_user_id uuid, created_by_email text`. Partial UNIQUE `(tenant_id) WHERE is_primary AND active` (one active primary per org). GRANT SELECT TO partner_runtime. Soft-deactivate (`active=false`), never DELETE. A contact is NOT a login user (G10).

## 3. partner_branding (metadata only, 1 per org)
`id uuid PK, tenant_id NOT NULL UNIQUE FK org RESTRICT, display_name text, logo_r2_key text (reference only — no upload this phase), primary_colour text, secondary_colour text, accent_colour text, support_email text, support_website text, custom_domain text (status/metadata only, no routing), branding_status text CHECK IN ('draft','ready','disabled') DEFAULT 'draft', version integer NOT NULL DEFAULT 1, created_at/updated_at`. GRANT SELECT TO partner_runtime.

## 4. partner_internal_notes (append-only, admin-only)
`id uuid PK, tenant_id NOT NULL FK org RESTRICT, body text NOT NULL, author_user_id uuid NOT NULL, author_email text NOT NULL, supersedes_note_id uuid NULL REFERENCES partner_internal_notes(id) ON DELETE RESTRICT (correction chain), created_at`. Index `(tenant_id, created_at)`. GRANT SELECT, INSERT TO partner_connector_runtime (immutability evidence role — 42501 on UPDATE/DELETE/TRUNCATE). **NO grant to partner_runtime** (never partner-visible). RLS+FORCE (defense-in-depth).

## 5. partner_management_audit (append-only admin-action ledger)
`id uuid PK, partner_organisation_id uuid NOT NULL FK org RESTRICT, action_type text NOT NULL CHECK IN ('profile_updated','status_changed','contact_added','contact_updated','contact_deactivated','branding_updated','note_added'), actor_user_id uuid NOT NULL, actor_email text NOT NULL, request_id text NOT NULL, idempotency_key text, entity_type text, entity_id text, before_state jsonb (safe summary), after_state jsonb, reason text, result text NOT NULL CHECK IN ('attempted','succeeded','failed','no_op'), error_code text, error_summary text, created_at timestamptz NOT NULL DEFAULT now()`. Partial UNIQUE `(idempotency_key) WHERE idempotency_key IS NOT NULL AND result='succeeded'`. Index `(partner_organisation_id, created_at)` — REAL query path (partner audit view + activity union), justified (not speculative). GRANT SELECT, INSERT TO partner_connector_runtime (immutability evidence). NO partner_runtime grant. RLS+FORCE.

## Status lifecycle (on partner_organisations.status — existing values, service-validated, label-only)
Values: `PENDING, ACTIVE, SUSPENDED, REVOKED` (existing; no CHECK added to avoid unverified-live-data risk). Allowed transitions: PENDING→{ACTIVE,REVOKED}; ACTIVE→{SUSPENDED,REVOKED}; SUSPENDED→{ACTIVE,REVOKED}; REVOKED→{} (terminal). Any other → INVALID_STATUS_TRANSITION. Status change: reason-required, version-guarded (partner_profiles.version), audited; NO side effects (no flags/portal/wallet/slots/users/devices/sessions).

## Activity feed (read-time UNION, no new table)
Bounded UNION over `partner_audit_events` (tenant_id), `partner_security_events` (tenant_id), `partner_management_audit` (partner_organisation_id) — all indexed; LIMIT-bounded; via admin pool with explicit tenant filter. Deterministic ORDER BY created_at DESC, id.

## Statistics (bounded, tenant-indexed)
Available: location count, user count (+ by status), connector-record counts by state (queued/…/imported/failed/manual_review/reconciliation_required), last connector activity, submission count (partner_submissions, idx (tenant_id,status)). UNAVAILABLE (labeled): total certificates / graded (MintVault tables have no tenant column — Phase-1 forbids the join). No unbounded scans.
