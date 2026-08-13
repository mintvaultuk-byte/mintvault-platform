-- 0075 — one active Partner scanner target per station
--
-- A physical station must never receive two active card targets at once. The
-- target lifecycle is authoritative in scanner_capture_sessions, so this is a
-- database invariant rather than an application-memory lock. Existing rows
-- are intentionally not changed: if a target environment already has two
-- active sessions for one station, this migration fails closed and requires a
-- documented reconciliation before it can be applied.
--
-- This file is source-only until an owner-authorised, just-in-time migration
-- journal inventory approves it for a specific environment.

SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX IF NOT EXISTS uq_scanner_capture_one_active_station
  ON scanner_capture_sessions (station_id)
  WHERE station_id IS NOT NULL
    AND state IN ('armed', 'claimed', 'capturing');
