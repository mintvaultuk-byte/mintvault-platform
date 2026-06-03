-- MVGS v2 columns — PROD schema-mismatch fix.
--
-- WHY: the deployed code (feat/mvgs-v2-engine) SELECTs these 5 columns from
-- `certificates`, but they were only ever migrated onto the STAGING Neon
-- branch (ep-purple-voice-abfez796), never prod. On prod every SELECT on
-- `certificates` errors ("Failed query") and pages render empty. Data is
-- intact (db-info: certificates_count = 77) — this is a missing-column
-- mismatch, NOT deletion. Adding the columns un-breaks the read path.
--
-- This file consolidates, for prod, the column DDL that already lives in:
--   • migrations/add-mvgs-v2-measurements.sql  (whitening_lines, crease_span_pct,
--                                                wrinkle_severity, tear_severity)
--   • migrations/add-mvgs-v2-crease-lines.sql  (crease_lines)
-- Both of those are marked "STAGING ONLY until Phase 3" — see the prod-run
-- note at the bottom of this file before running.
--
-- Types verified against shared/schema.ts (certificates table, lines 537-584):
--   whitening_lines   jsonb     NOT NULL DEFAULT '[]'   (schema: jsonb .notNull().default([]))
--   crease_span_pct   numeric(4,1)  NULL                (schema: decimal precision 4 scale 1)
--   crease_lines      jsonb     NOT NULL DEFAULT '[]'   (schema: jsonb .notNull().default([]))
--   wrinkle_severity  text          NULL                (schema: text)
--   tear_severity     text          NULL                (schema: text)
--
-- SAFETY: additive only. No DROP, no DELETE, no UPDATE, no rewrite of any
-- existing cert. The two jsonb columns get an empty-array default; the other
-- three default to NULL. Existing 77 certs are untouched and (per the source
-- migrations' own notes) continue to score identically — empty/NULL = "no v2
-- measurement", so the legacy fallback still applies. CHECK constraints and the
-- reporting index from the staging migrations are intentionally NOT included
-- here (you asked for just the columns); add them later for full staging parity.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS — safe to run more than once and safe
-- on the staging branch (where these already exist) as a no-op dry run.
--
-- Usage:
--   psql "$MINTVAULT_DATABASE_URL" -f migrations/add-mvgs-v2-columns-prod.sql

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS whitening_lines jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS crease_span_pct numeric(4, 1);

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS crease_lines jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS wrinkle_severity text;

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS tear_severity text;
