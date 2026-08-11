-- Durable, cross-replica derivative queue for immutable scanner evidence.
-- The master is accepted before derivative work; this table makes that work
-- restart-safe and claimable with SKIP LOCKED instead of retaining a FIFO only
-- in one Node process.

CREATE TABLE IF NOT EXISTS scanner_processing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  certificate_id integer NOT NULL REFERENCES certificates(id) ON DELETE RESTRICT,
  station_id uuid REFERENCES partner_stations(id) ON DELETE RESTRICT,
  job_kind text NOT NULL DEFAULT 'scanner_derivatives' CHECK (job_kind = 'scanner_derivatives'),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','retry','complete','failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  rerun_requested boolean NOT NULL DEFAULT false,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- One active request per certificate is enough: a recapture arriving while a
-- worker runs flips rerun_requested, then the worker processes the current
-- immutable evidence pointer once more. This avoids duplicate heavy jobs.
CREATE UNIQUE INDEX IF NOT EXISTS uq_scanner_processing_active_certificate
  ON scanner_processing_jobs (certificate_id, job_kind)
  WHERE state IN ('queued','running','retry');

CREATE INDEX IF NOT EXISTS idx_scanner_processing_claim
  ON scanner_processing_jobs (available_at, created_at, id)
  WHERE state IN ('queued','retry');

CREATE INDEX IF NOT EXISTS idx_scanner_processing_expired_lease
  ON scanner_processing_jobs (lease_until, id)
  WHERE state = 'running';

CREATE INDEX IF NOT EXISTS idx_scanner_processing_station_created
  ON scanner_processing_jobs (station_id, created_at DESC)
  WHERE station_id IS NOT NULL;
