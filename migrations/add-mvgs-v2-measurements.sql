-- MVGS v2 Phase 2 — measurement-based defect inputs (docs/MVGS-v2-spec.md §3-§4).
--
-- Adds:
--   • whitening_lines    jsonb default '[]'  — Array<{side: "front"|"back",
--                                              edge: "top"|"right"|"bottom"|"left",
--                                              coveragePct: 0..100}>.
--                                              Operator draws lines along card
--                                              edges in the grading workstation;
--                                              engine reads coverage → §3 ladder.
--   • crease_span_pct    numeric(4,1)        — Crease length as % of card axis
--                                              (0–100). NULL = no crease drawn.
--                                              Engine reads → §4 crease ladder
--                                              (cap 4.5 / 4 / 3.5 / 3).
--   • wrinkle_severity   text                — One of: "tiny_back" / "longer_back"
--                                              / "small_front" / "multiple_front".
--                                              NULL = no wrinkle. Engine maps to
--                                              §4 wrinkle ceiling (6.5 / 6 / 5.5 / 5).
--   • tear_severity      text                — One of: "minor" / "significant" /
--                                              "major". "major" routes to existing
--                                              non-numeric NO outcome. NULL = none.
--
-- Precedence (handled in shared/mvgs-input-builder.ts): when a measurement is
-- supplied, it OVERRIDES the legacy has_crease/has_tear booleans on
-- surface_values. The boolean is only the fallback when the measurement is null.
-- Engine code at shared/mvgs-scoring.ts is UNCHANGED — the input builder does
-- the translation upstream so the engine sees a single authoritative input.
--
-- All columns nullable / default-empty so existing certs continue to score
-- identically (no measurements = no penalty; legacy boolean fallback still
-- applies via the input builder).
--
-- STAGING ONLY. Run against the staging Neon branch
-- (ep-purple-voice-abfez796). Do NOT run against prod until Phase 3
-- bundles the band-table change with the re-grade + reprint (spec §2
-- prod sequencing constraint).
--
-- Idempotent (IF NOT EXISTS + drop-and-readd CHECK constraints). Additive
-- only — no drops, no data rewrites.
--
-- Usage:
--   psql "$MINTVAULT_DATABASE_URL" -f migrations/add-mvgs-v2-measurements.sql

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS whitening_lines jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS crease_span_pct numeric(4, 1);

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS wrinkle_severity text;

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS tear_severity text;

-- Range / enum constraints. Drop + re-add so the migration is fully
-- idempotent regardless of PostgreSQL version's CREATE-IF-NOT-EXISTS
-- support on constraints.

ALTER TABLE certificates
  DROP CONSTRAINT IF EXISTS certificates_crease_span_pct_range;
ALTER TABLE certificates
  ADD CONSTRAINT certificates_crease_span_pct_range
    CHECK (crease_span_pct IS NULL OR (crease_span_pct >= 0 AND crease_span_pct <= 100));

ALTER TABLE certificates
  DROP CONSTRAINT IF EXISTS certificates_wrinkle_severity_enum;
ALTER TABLE certificates
  ADD CONSTRAINT certificates_wrinkle_severity_enum
    CHECK (wrinkle_severity IS NULL OR wrinkle_severity IN ('tiny_back', 'longer_back', 'small_front', 'multiple_front'));

ALTER TABLE certificates
  DROP CONSTRAINT IF EXISTS certificates_tear_severity_enum;
ALTER TABLE certificates
  ADD CONSTRAINT certificates_tear_severity_enum
    CHECK (tear_severity IS NULL OR tear_severity IN ('minor', 'significant', 'major'));

-- Index — small selectivity (most certs have neither measurement). Useful
-- when surfacing "certs with a measured ceiling" in admin reports.
CREATE INDEX IF NOT EXISTS idx_certificates_mvgs_v2_ceiling
  ON certificates (crease_span_pct, wrinkle_severity, tear_severity)
  WHERE crease_span_pct IS NOT NULL OR wrinkle_severity IS NOT NULL OR tear_severity IS NOT NULL;
