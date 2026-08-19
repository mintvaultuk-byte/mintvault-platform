-- 0101 — Growth Completion Night: neutral review lifecycle + conversion events
--
-- Additive only. Review requests reference the canonical submission rather than
-- copying customer PII. Conversion events contain only a submission FK, a
-- controlled event name and server time: no cookie, IP, referrer, email or
-- browser identifier.

CREATE TABLE IF NOT EXISTS review_requests (
  id bigserial PRIMARY KEY,
  submission_id integer NOT NULL REFERENCES submissions(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'ELIGIBLE',
  eligible_at timestamptz NOT NULL,
  scheduled_for timestamptz NOT NULL,
  next_attempt_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  failure_code text,
  click_token_hash text,
  suppress_token_hash text,
  clicked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_review_requests_submission UNIQUE (submission_id),
  CONSTRAINT chk_review_requests_status CHECK (
    status IN ('ELIGIBLE', 'REQUEST_SCHEDULED', 'REQUEST_SENT', 'DELIVERY_FAILED', 'DELIVERY_UNCERTAIN', 'SUPPRESSED', 'CANCELLED')
  ),
  CONSTRAINT chk_review_requests_attempt_count CHECK (attempt_count >= 0 AND attempt_count <= 3),
  CONSTRAINT chk_review_requests_sent_state CHECK (
    (status = 'REQUEST_SENT' AND sent_at IS NOT NULL AND provider_message_id IS NOT NULL)
    OR status <> 'REQUEST_SENT'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_review_requests_click_token_hash
  ON review_requests (click_token_hash) WHERE click_token_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_review_requests_suppress_token_hash
  ON review_requests (suppress_token_hash) WHERE suppress_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_review_requests_due
  ON review_requests (next_attempt_at, id)
  WHERE status IN ('ELIGIBLE', 'REQUEST_SCHEDULED', 'DELIVERY_FAILED');

CREATE TABLE IF NOT EXISTS review_delivery_attempts (
  id bigserial PRIMARY KEY,
  review_request_id bigint NOT NULL REFERENCES review_requests(id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL,
  outcome text NOT NULL,
  provider_message_id text,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_review_delivery_attempt UNIQUE (review_request_id, attempt_number),
  CONSTRAINT chk_review_delivery_attempt_number CHECK (attempt_number BETWEEN 1 AND 3),
  CONSTRAINT chk_review_delivery_outcome CHECK (outcome IN ('SENT', 'FAILED', 'UNCERTAIN'))
);

CREATE TABLE IF NOT EXISTS review_suppressions (
  submission_id integer PRIMARY KEY REFERENCES submissions(id) ON DELETE RESTRICT,
  reason text NOT NULL DEFAULT 'CUSTOMER_REQUEST',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_review_suppression_reason CHECK (reason IN ('CUSTOMER_REQUEST', 'ADMIN', 'INVALID_RECIPIENT'))
);

CREATE TABLE IF NOT EXISTS growth_conversion_events (
  id bigserial PRIMARY KEY,
  submission_id integer NOT NULL REFERENCES submissions(id) ON DELETE RESTRICT,
  event_kind text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_growth_conversion_event UNIQUE (submission_id, event_kind),
  CONSTRAINT chk_growth_conversion_event_kind CHECK (event_kind IN ('SUBMISSION_START', 'CHECKOUT_START'))
);

CREATE INDEX IF NOT EXISTS idx_growth_conversion_events_window
  ON growth_conversion_events (event_kind, occurred_at DESC);
