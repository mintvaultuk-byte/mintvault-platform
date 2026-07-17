# Task Ledger — partner-network-phase0-audit

**Task:** Phase 0 read-only discovery audit + architecture proposal for Approved Grading Partner network.
**Date started:** 2026-07-17
**Branch at baseline:** codex/grading-two-column-workstation @ b5fe522c (clean)
**Scope:** READ-ONLY. No app code changes, no migrations, no commits, no pushes, no deploys, no env changes.
**Prohibited:** everything in Section 1 of the owner's instruction (all mutations).
**Protected systems in play (read-only inspection only):** MVGS grading, Stripe webhook, auth, cert_counter, R2 signing, labels.

## Stages
- [x] Stage 0 baseline recorded
- [ ] Stage 1 review plan (6 reviewers, non-overlapping)
- [ ] Stage 2 reviewer reports received
- [ ] Stage 3 Lead verification
- [ ] Stage 7 final audit report to owner (no Stage 4-6 — no implementation this phase)

## Reviewers
1. backend-reviewer — auth/sessions/roles/routes/admin+staff surfaces/audit logging/feature flags
2. security-reviewer — tenant isolation risks, IDOR, client-trusted IDs, replay, scoping gaps
3. database-reviewer — full schema inventory, tenant support, cert_counter, migration process
4. provider-reviewer — Stripe flow, webhook, refunds, idempotency, credits/promos, Resend
5. controlled-reviewer — grading workflow, scanning, card ID, labels, certs, NFC, scanner app
6. infrastructure-reviewer — deploy/rollback, backups, tests, env config, flags, device mgmt

## Locked decisions (owner, 2026-07-17)
1. Commercial pilot: SHOP-FUNDED prepaid wholesale credits only (Model B). Keep architecture capable of Model A (customer-funded) but do NOT build it for pilot. One credit reserved per card, consumed only at controlled completion. Partners can never create/upload/edit/increase credits.
2. Cert numbering: partner certs use the SAME central MV sequence. No visible partner range. Store origin_type, partner_id, location_id, grader_id, device_id as internal metadata. Central server-only allocation, AFTER payment+credit+grading+QA conditions met. Devices never preallocate/choose/edit numbers.
3. Architecture lock: separate partner auth, cookie, route namespace, permission middleware, tenant-aware controllers/services, DB RLS on partner data, device-signed requests, server-derived tenant/location. Never expose numeric-ID admin routes to partner principals. Reuse pure grading services only (MVGS, Pristine, central cert alloc, labels, NFC validate, public verify).

## Prod DB read-only inspection (owner-approved, 2026-07-17)
Method: metadata-only queries run INSIDE prod Fly machine via env var; connection string never left machine or printed. No temp file on prod (stdin pipe). SET default_transaction_read_only=on.
Findings: PostgreSQL 17.10 (Neon, db=<database_name>, user=<database_role> single-privileged). Extensions: plpgsql, vector. RLS=0 tables (confirmed, matches staging). 115 tables (89 non-vq) — prod AHEAD of staging (drift confirmed). NO migration journal (schema_migrations + __drizzle_migrations both absent). cert_counter last_issued=581 == max MV581, total 581 (HEALTHY, in sync). nfc_uid unique constraint PRESENT on prod. No partner tables, no tenant columns. Pokemon/AI/credits tables all present on prod.
Drop hazard quantified: 30 live prod tables absent from schema.ts + not vq_ → db:push would DROP them. Full list in PHASE-0.5-MIGRATION-SAFETY-PROPOSAL.md §2.

## Deliverables produced (governance docs only — NO app code)
- PHASE-0-REPORT.md (created)
- PHASE-0.5-MIGRATION-SAFETY-PROPOSAL.md (created)
- task-ledger.md (this file)

Next authorised action: AWAIT owner approval for Phase 0.5, then Phase 1. NOT authorised: any app code/config/schema/migration edit, any protected action.
