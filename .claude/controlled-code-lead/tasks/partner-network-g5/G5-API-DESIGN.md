# G5 API Design

Namespace `/api/super-admin/partner-management`, single `r.use(requireAdmin)`. Own mutation rate-limiter (G4 pattern + documented in-process/per-machine caveat). Global CSRF covers it. Reads = explicit safe projections (no SELECT *), deterministic ORDER BY … , id, bounded LIMIT/OFFSET (clampPagination, max 100). Mutations = reason where high-risk, `expectedVersion` for versioned aggregates, idempotency-key short-circuit, audited (attempt+terminal into partner_management_audit), stable error envelope `{error:{code,message,operatorAction}}`, requestId (prefix `g5-`). Actor server-derived (`actorOf`). Every query filters `WHERE tenant_id=$1` explicitly (admin pool has no RLS context).

## Reads
- `GET /partners?search=&status=&kind=&connectorHealth=&page=&pageSize=` → `{ partners:[{id, legalName, status, accreditationLevel, health, tradingName, organisationKind, primaryContactName, primaryEmail, createdAt, lastActivityAt, locationCount, userCount, connectorSummary:{total,failed,manualReview,reconciliationRequired}}], page, pageSize, total, totalPages }`. Search by legal/trading name; email search only against partner_profiles.primary_email/contacts (safe). Deterministic ORDER BY created_at DESC, id ASC.
- `GET /partners/:partnerId` → `{ organisation, profile, primaryContact, counts, recentActivity[] }` (redacted).
- `GET /partners/:partnerId/contacts` → contacts (active + inactive), deterministic.
- `GET /partners/:partnerId/branding` → branding metadata (or null).
- `GET /partners/:partnerId/notes?page=&pageSize=` → append-only internal notes, newest first.
- `GET /partners/:partnerId/activity?page=&pageSize=` → bounded UNION feed.
- `GET /partners/:partnerId/statistics` → `{ locationCount, userCount, connectorCountsByState, lastConnectorActivityAt, submissionCount, certificatesCount:null(unavailable), gradedCount:null(unavailable) }` with an `unavailable:["certificatesCount","gradedCount"]` marker.
- `GET /partners/:partnerId/audit?page=&pageSize=` → partner_management_audit rows (partner-focused).

## Mutations (reason where noted; expectedVersion for versioned; idempotencyKey optional; audited)
- `POST /partners` (create) — body {legalName, [profile fields]} → creates org + profile. Reason optional. (Design decision: create IS in scope per task Phase 6 "create partner if approved in design" → APPROVED, admin-only, minimal.)
- `PATCH /partners/:partnerId/profile` — body {profile fields, expectedVersion} → VERSION_CONFLICT on stale. Audited profile_updated.
- `POST /partners/:partnerId/status` — body {status, reason(required), expectedVersion} → validated transition; INVALID_STATUS_TRANSITION otherwise; label-only, no side effects. Audited status_changed.
- `POST /partners/:partnerId/contacts` — body {full_name, contact_type, email?, phone?, title?, is_primary?} → CREATE; DUPLICATE_PRIMARY_CONTACT if is_primary conflicts (partial-unique + pre-check). Audited contact_added.
- `PATCH /partners/:partnerId/contacts/:contactId` — {fields, expectedVersion} → CONTACT_NOT_FOUND / VERSION_CONFLICT / DUPLICATE_PRIMARY_CONTACT. Audited contact_updated.
- `POST /partners/:partnerId/contacts/:contactId/deactivate` — {reason?} → soft `active=false` (never DELETE). Audited contact_deactivated.
- `PUT /partners/:partnerId/branding` — {metadata, expectedVersion} → upsert one row per tenant. Audited branding_updated.
- `POST /partners/:partnerId/notes` — {body(required), supersedesNoteId?, idempotencyKey?} → append-only INSERT. Audited note_added.

## Stable error codes
`PARTNER_NOT_FOUND, CONTACT_NOT_FOUND, BRANDING_NOT_FOUND, INVALID_PARTNER_STATUS, INVALID_STATUS_TRANSITION, DUPLICATE_PRIMARY_CONTACT, VERSION_CONFLICT, VALIDATION_ERROR, REASON_REQUIRED, UNAUTHORISED, FORBIDDEN, RATE_LIMITED, IDEMPOTENCY_CONFLICT, REQUEST_ALREADY_COMPLETED, INTERNAL_ERROR`. HTTP: 401/403/404/409(conflict/version/dup/idempotency)/400(validation/reason/transition)/200(already-completed)/500(internal). Unknown → INTERNAL_ERROR safe message (no SQL/stack).
