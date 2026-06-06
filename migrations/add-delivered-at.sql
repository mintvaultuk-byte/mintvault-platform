-- Add delivered_at timestamp column to submissions.
--
-- Nullable, no backfill, no constraint changes. Holds the
-- delivery-confirmation time, distinct from `completed_at` because
-- "completed" is an operational status the admin sets when grading work
-- is done, whereas "delivered" can only be truthfully known when the
-- carrier confirms it.
--
-- Today: set manually by an admin via POST /api/admin/submissions/:id/
--        mark-delivered (audit action='delivery_confirmed_manual',
--        details.source='manual_admin'). MANUAL BRIDGE — superseded
--        later by Royal Mail Tracking API polling writing the same
--        column with details.source='royalmail_api'.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) — re-runnable. The column may
-- already exist on prod from an earlier ad-hoc schema add; this
-- migration brings the column under repo control without rewriting it.
--
-- Run via: psql "$DB_URL" -f migrations/add-delivered-at.sql

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMP;
