-- 0091 — snapshot the authoritative capture window onto each capture session.
--
-- WHY. Evidence validation took its acquisition rectangle from the STATION-SUPPLIED provenance of
-- the upload. That was survivable only while every station used the same hard-coded 100 x 130 mm
-- window anchored at the platen origin: the server pinned the SIZE against a constant, and the 4 mm
-- margin verdict depends on size alone, so a lying client could not move the evidence floor.
--
-- The capture window is now MOVABLE per station. A declared ORIGIN therefore becomes a number in the
-- immutable evidence record that nothing verifies, and validating merely that it lands somewhere on
-- the platen is not authority — it would accept 20,20 from a station calibrated to 60,40.
--
-- These two columns make the server the authority. When a side is ARMED, the station's current VALID
-- calibration is resolved and its `acquisition_region` is copied here. Evidence validation then uses
-- THIS row, never the upload's provenance, which is reduced to something that must merely AGREE.
--
-- SNAPSHOT, NOT A LOOKUP, so calibration history is immutable for work already in flight: a capture
-- is judged against the geometry it was armed under, and a recalibration applies to later sessions
-- instead of silently re-interpreting a scan that has already physically happened.
--
-- ADDITIVE AND NULLABLE. Nothing is dropped, nothing is rewritten, and no existing row changes value.
-- Sessions armed before this migration carry NULL and are REFUSED at upload with an instruction to
-- re-arm — deliberately, because "we do not know which rectangle that station used" and "assume the
-- standard one" are different statements and only the first is true.

ALTER TABLE scanner_capture_sessions
  ADD COLUMN IF NOT EXISTS calibration_id uuid,
  ADD COLUMN IF NOT EXISTS acquisition_region jsonb;

-- No FK to partner_station_calibrations on purpose. The snapshot must survive its source row being
-- superseded or removed; an ON DELETE RESTRICT here would make a recalibration fail because an old
-- capture still points at the previous one, and a cascade would erase evidence provenance.
COMMENT ON COLUMN scanner_capture_sessions.calibration_id IS
  'Station calibration this session was armed under. Provenance only; deliberately not a foreign key so history survives recalibration.';
COMMENT ON COLUMN scanner_capture_sessions.acquisition_region IS
  'Server-owned authoritative capture window {x,y,width,height} in millimetres, snapshotted at arm time. Evidence validation uses this, never client provenance.';
