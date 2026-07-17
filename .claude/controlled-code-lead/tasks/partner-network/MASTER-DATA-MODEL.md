# Master Data Model — Partner Network

All partner data lives in a new `partner_*` table family (ADR-012), managed by
`drizzle-partner.config.ts` (`tablesFilter: ["partner_*"]`) and applied via the Phase 0.5
numbered-migration workflow (never `db:push`). Every partner-owned row carries the ownership
columns below; RLS on a restricted role enforces isolation (ADR-002). This is the planned model —
exact columns are finalised per phase and recorded in the phase's change manifest.

## Canonical naming (resolves review findings 1, 5, 7, 8)
- The top-level org/tenant table is **`partner_organisations`** (canonical). `tenant_id` = its id.
  Earlier drafts said `partners`; `partner_organisations` is the single canonical name; the
  super-admin route label `/api/super-admin/grading-partners/*` is a route surface, not the table.
- Chain of custody is modelled by **`partner_custody_checkpoints`** only (canonical). There is NO
  separate `partner_custody_events` table; a handover is a `HANDOVER` checkpoint row.
- **`field_welders`** is a MintVault-internal (super-admin) registry table, **NOT** in the
  tenant-scoped `partner_*` RLS family — it has no `tenant_id`/RLS predicate; it references a
  location for assignment but is owned by MintVault. Seals reference it.
- Naming note: per-technician accreditation **status** `APPROVED` (on `partner_accreditation`) is
  distinct from partner-org **level** `APPROVED_PARTNER` (ADR-017). Different namespaces.

## Ownership columns (on every partner-owned table)
`partner_id` (FK partner_organisations) · `tenant_id` (= partner_id at org level; kept explicit for RLS) ·
`location_id` (FK partner_locations, where location-scoped) · `created_by` (partner_users) ·
`created_at` · `updated_at`. Sensitive-action tables also carry `device_id`.

RLS predicate (conceptual): `USING (tenant_id = current_setting('app.tenant_id')::uuid AND
(location_id IS NULL OR location_id = current_setting('app.location_id')::uuid))`. Missing setting
→ no rows (fail closed).

## Tables by phase

### Phase 1 — foundation
- `partner_organisations` — org identity, legal name, status (`PENDING|ACTIVE|SUSPENDED|REVOKED`),
  health, `accreditation_level` (ADR-017). (Canonical org table; = `tenant_id` source.)
- `partner_locations` — shop location, address, status.
- `partner_users` — membership + partner role (`OWNER|MANAGER|TECHNICIAN|RECEPTION|FINANCE|TRAINEE`),
  MFA state, credential_version. (Do NOT overload existing `users.role`.)
- `partner_sessions` (or partner-scoped session store), `partner_api_keys` (if needed).
- `partner_permissions` / role→permission mapping (server-enforced).
- `partner_audit_log` — append-only (or existing `audit_log` extended with tenant columns);
  actor/tenant/location/device/action/record/before/after/ip/session/ts/reason/correlation.
- `partner_feature_flags` — per-partner/location flags.

### Phase 2 — onboarding/compliance
- `partner_documents` — type, storage_ref, hash, issue/expiry, verification_status
  (`REQUIRED|UPLOADED|UNDER_REVIEW|APPROVED|REJECTED|EXPIRING|EXPIRED|REPLACED`), version.
- `partner_agreements` — signed agreement records + versions.
- `partner_insurance` — cover type, insurer, expiry.

### Phase 3 — training/accreditation
- `partner_training_modules`, `partner_training_completions`, `partner_assessments`,
  `partner_accreditation` — status (`TRAINING|PROBATION|APPROVED|ENHANCED_MONITORING|SUSPENDED|
  REVOKED|PERMANENTLY_REMOVED`), scores, renewal date.

### Phase 4 — devices
- `partner_devices` — device_id, type (mac/scanner/printer/nfc_writer/**mobile** — the Field
  Officer's registered phone/iPad, ADR-009), public_key,
  app_installation_id, serial ref, status (`PENDING_APPROVAL|ACTIVE|LIMITED|PAUSED|QUARANTINED|
  REVOKED|LOST_OR_STOLEN|REPLACED`), app_version, last_seen, approvals, revocation.
- `partner_device_nonces` — replay protection.

### Phase 5 — money
- `partner_credit_products` — bundle definitions (10/25/50/100), central prices, credit_type.
- `partner_credit_ledger` — **append-only** entries (ADR-008), idempotency_key, correlation_id,
  source_payment/order/card, reservation_id.
- `partner_credit_reservations` — reserve→release/consume lifecycle, TTL.
- `partner_payments` — Stripe payment records; `partner_stripe_events` — event-id dedup.

### Phase 6 — intake
- `partner_customers` — minimal PII (name/email/phone), location-scoped.
- `partner_orders`, `partner_order_items` — retail £20 display, declared value, terms.
- `partner_customer_terms` — accepted version + timestamp + method.

### Phase 7 — capture
- `partner_cards` — the submission; identity fields; the six status fields (ADR-006); custody
  packaging number; storage location; technician/device attribution; image fingerprint ref.
- `partner_scans` — front/back/surface/edge image refs (partner R2 keys), scan profile, calibration.
- `partner_mvgs_evidence` — MVGS defect map captured by the technician (input to Supreme Grader).
- (Chain of custody is `partner_custody_checkpoints`, Addendum A — NOT a separate events table.)

### Phase 8–11 — grading/field/completion
- `partner_grading_reviews` — Supreme Grader decisions, grade versions (prev/new/reason/who).
- `partner_qa_reviews` — risk score, outcome.
- `partner_field_visits` — visit batch, officer, schedule, status queue (ADR field statuses).
- `partner_authentications` — field officer outcome (closed set, ADR-013), custody/tamper checks.
- `field_welders` — MintVault-internal welder registry (NOT tenant-scoped; see Canonical naming).
- `partner_labels` — label/print/reprint tracking (reason + audit).
- `partner_nfc_tags` — nfc_uid (unique), status lifecycle, read-back verification.
- `partner_slabs`, `partner_seals` — sealing events + final photo refs.
- (Certificate itself is the central `certificates` row with `origin_type=PARTNER` metadata,
  ADR-005 — created by the shared allocation service, not a partner table.)

### Phase 12–18 — operations
- `partner_stock_ledger` (slabs/NFC/labels/packaging), `partner_stock_transactions`.
- `partner_strikes`, `partner_strike_appeals` (reversal = new record), `partner_incidents`.
- `partner_support_tickets`, `partner_messages`, `partner_announcements`,
  `partner_acknowledgements`.
- `partner_collections` — PIN/signature, timestamp, employee.
- `partner_reconciliation_runs` + `partner_reconciliation_alerts`.

## Existing-table touch (minimal, additive — ADR-012)
- `certificates`: additive nullable `origin_type`, `partner_id`, `location_id`, and the partner
  actor/device metadata columns; NULL = first-party. Added via numbered migration + index before
  any hot partner query. No change to existing semantics.

## Integrity constraints (financial/identity)
- `partner_credit_ledger`: no UPDATE/DELETE (append-only enforced by role privileges + review);
  unique `idempotency_key`; balance derived.
- `partner_nfc_tags.nfc_uid` unique; one NFC per card; one card per NFC.
- `partner_cards` status transitions enforced server-side; publish gate = all approvals + seal.
- Real FKs throughout (do not inherit the existing dangling-`cert_id` pattern).

## Addendum A — new subsystems (ADR-015…018)

### Digital Chain of Custody checkpoints (ADR-015)
- `partner_custody_checkpoints` — append-only. Columns: id, partner_id, tenant_id, location_id,
  card_id (FK partner_cards), checkpoint_type (`RECEIVED|ARRIVAL_PHOTOS|PACKAGED|STORED|SCANNED|
  HANDOVER|FIELD_CUSTODY_VERIFIED|SEALED|COLLECTED`), sequence_no, actor_user_id, device_id,
  packaging_number (nullable), image_fingerprint_ref (nullable), evidence_ref, created_at.
  Unique (card_id, checkpoint_type) where a type is once-only; ordered by sequence_no. The card
  state machine refuses to advance without the required prior checkpoint.

### MintVault Verified outcome (ADR-016)
- On `partner_cards`: `certificate_status` gains terminal value `VERIFIED`, set only at the full
  dual-verification gate. Public cert page derives the "MintVault Verified" badge from that gate,
  never from a stored partner-settable flag. No private technician/officer identity is exposed.

### Partner Accreditation Levels (ADR-017)
- On `partner_organisations`: `accreditation_level`
  (`PROVISIONAL_PARTNER|APPROVED_PARTNER|SILVER_PARTNER|GOLD_PARTNER|PLATINUM_PARTNER`).
- `partner_accreditation_events` — append-only history of level changes (prev/new/reason/decided_by
  /evidence/auto_or_manual). Level maps to a configurable `partner_level_parameters` row (daily/
  active-card/declared-value limits, bundle access, QA frequency, doc-review frequency, location/
  technician counts, priority support, marketing permissions). Levels NEVER gate away the critical
  controls (ADR-017).

### Ultrasonic welder governance (ADR-018)
- `field_welders` (MintVault-internal registry, not tenant-scoped) — machine_id, serial,
  assigned_officer_id, service_date, calibration_date,
  fault_history (jsonb), seal_count, status (`ACTIVE|SERVICE_DUE|PAUSED|QUARANTINED|LOST_OR_STOLEN|
  RETIRED`), location history, last_use. Seal events (`partner_seals`) FK the welder + officer +
  device; completion gate checks welder status + service/calibration validity.
