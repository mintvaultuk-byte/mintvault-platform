-- 0099 — GB-04 first-party commercial attribution and paid-event reporting index
--
-- Additive only. Values are controlled campaign tokens; the table deliberately
-- contains no cookie, browser identifier, IP address, referrer or customer PII.

CREATE TABLE IF NOT EXISTS submission_acquisition (
  submission_id integer PRIMARY KEY REFERENCES submissions(id) ON DELETE RESTRICT,
  acquisition_category text NOT NULL,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_content text,
  utm_term text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_submission_acquisition_category CHECK (
    acquisition_category IN ('DIRECT', 'ORGANIC', 'PARTNER_OUTREACH', 'CREATOR', 'REFERRAL', 'SOCIAL', 'EMAIL', 'OTHER')
  )
);

CREATE INDEX IF NOT EXISTS idx_submissions_paid_growth_window
  ON submissions (payment_timestamp DESC)
  WHERE payment_status = 'paid' AND deleted_at IS NULL AND payment_intent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_submission_acquisition_category
  ON submission_acquisition (acquisition_category, utm_campaign);
