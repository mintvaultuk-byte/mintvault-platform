-- 0094 — scanner physical-release boundary for SFAP-015
--
-- A station may hold only one PHYSICAL Canon target at a time, but a side whose
-- local TIFF has been durably accepted and bound to a server-minted staging
-- upload task must not block the operator from flipping the SAME card to BACK
-- while the FRONT bytes/finalisation continue in the background.
--
-- `physical_released=false` means the row still occupies the glass. `true`
-- means the row still owns its certificate side and upload retries, but no
-- longer occupies the physical scanner.
--
-- This intentionally replaces the 0075 station unique index. It drops no table,
-- column or data, but the migration runner's destructive-SQL linter still treats
-- DROP INDEX as owner-approval-required. Apply only through the normal
-- owner-authorised migration path for the target environment.

SET LOCAL lock_timeout = '5s';

ALTER TABLE scanner_capture_sessions
  ADD COLUMN IF NOT EXISTS physical_released BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS uq_scanner_capture_one_active_station_physical
  ON scanner_capture_sessions (station_id)
  WHERE station_id IS NOT NULL
    AND physical_released = false
    AND state IN ('armed', 'claimed', 'capturing');

DROP INDEX IF EXISTS uq_scanner_capture_one_active_station;

ALTER INDEX IF EXISTS uq_scanner_capture_one_active_station_physical
  RENAME TO uq_scanner_capture_one_active_station;

CREATE INDEX IF NOT EXISTS idx_scanner_capture_released_station_certificate
  ON scanner_capture_sessions (station_id, certificate_id, state)
  WHERE physical_released = true
    AND state IN ('claimed', 'capturing');

CREATE INDEX IF NOT EXISTS idx_scanner_capture_expiry_physical
  ON scanner_capture_sessions (expires_at, id)
  WHERE physical_released = false
    AND state IN ('armed', 'claimed');
