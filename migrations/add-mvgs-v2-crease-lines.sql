-- MVGS v2 — multi-crease persistence (companion to add-mvgs-v2-measurements.sql).
--
-- Adds:
--   • crease_lines   jsonb  default '[]'   — Array<{id, side, spanPct, start, end, color?}>.
--                                            Multiple persistent creases per cert,
--                                            with the operator's actual drawn segment
--                                            so the line redraws on reload (parity
--                                            with whitening_lines after 9084ad4).
--
-- Engine input derivation (server-side, at the call boundary):
--   creaseSpanPct = max(crease_lines.spanPct)   // longest crease wins; spec §4/§5
-- The legacy `crease_span_pct numeric(4,1)` column stays as a derived mirror
-- (max of crease_lines.spanPct on save) so any reader that hasn't been updated
-- still sees the worst span — back-compat without forking the read path.
--
-- Back-fill of legacy rows happens at the application layer (GET /grading
-- synthesises a single-entry creaseLines from crease_span_pct when the new
-- column is empty AND crease_span_pct is non-null). No data migration here.
--
-- All columns nullable / default-empty so existing certs continue to score
-- identically (no creases = no penalty; legacy crease_span_pct fallback still
-- applies via the synth on read).
--
-- STAGING ONLY (Neon branch ep-purple-voice-abfez796). Do NOT run against prod
-- until Phase 3 bundles the band-table change with re-grade + reprint (spec §2
-- prod-sequencing constraint).
--
-- Idempotent (IF NOT EXISTS + DROP+ADD CHECK). Additive only — no drops, no
-- data rewrites.
--
-- Usage:
--   psql "$MINTVAULT_DATABASE_URL" -f migrations/add-mvgs-v2-crease-lines.sql

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS crease_lines jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Range / shape guard. Drop+readd for idempotency regardless of PostgreSQL
-- version's CREATE-IF-NOT-EXISTS support on constraints.
ALTER TABLE certificates
  DROP CONSTRAINT IF EXISTS certificates_crease_lines_array;
ALTER TABLE certificates
  ADD CONSTRAINT certificates_crease_lines_array
    CHECK (jsonb_typeof(crease_lines) = 'array');
