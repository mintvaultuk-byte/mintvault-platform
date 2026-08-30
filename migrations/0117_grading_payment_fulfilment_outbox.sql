-- 0117 — Durable grading-payment fulfilment outbox
--
-- A Stripe charge and the submission paid transition are authoritative, but
-- credit/promo/user-link/email work happens after that transition.  Persist the
-- work before marking a submission paid so a process death can be reconciled
-- without charging again or silently abandoning fulfilment.
--
-- ROLLBACK / CONTAINMENT: application rollback is non-destructive; the table may
-- remain unused and preserves evidence. Dropping it is an owner-approved data
-- destruction step and is unsafe while any row is not COMPLETE.

DO $guard$
BEGIN
  IF to_regclass('public.submissions') IS NULL THEN
    RAISE EXCEPTION '0117 requires public.submissions';
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS public.grading_payment_fulfilments (
  submission_id integer PRIMARY KEY REFERENCES public.submissions(id) ON DELETE RESTRICT,
  tracking_number text NOT NULL,
  payment_intent_id text NOT NULL UNIQUE,
  payment_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  amount_pence integer NOT NULL CHECK (amount_pence >= 0),
  currency varchar(3) NOT NULL CHECK (currency = upper(currency) AND currency ~ '^[A-Z]{3}$'),
  paid_at timestamptz NOT NULL,
  confirmation_payload jsonb NOT NULL,
  provider_idempotency_key text NOT NULL UNIQUE,

  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'FAILED', 'COMPLETE', 'RECONCILIATION_REQUIRED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 50),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claim_token text,
  claim_expires_at timestamptz,
  last_error text,

  estimate_completed_at timestamptz,
  credit_completed_at timestamptz,
  promo_completed_at timestamptz,
  user_link_completed_at timestamptz,
  email_completed_at timestamptz,
  provider_message_id text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_grading_payment_fulfilment_claim CHECK (
    (status = 'PROCESSING' AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
    OR
    (status <> 'PROCESSING' AND claim_token IS NULL AND claim_expires_at IS NULL)
  ),
  CONSTRAINT chk_grading_payment_fulfilment_complete CHECK (
    status <> 'COMPLETE'
    OR (
      estimate_completed_at IS NOT NULL
      AND credit_completed_at IS NOT NULL
      AND promo_completed_at IS NOT NULL
      AND user_link_completed_at IS NOT NULL
      AND email_completed_at IS NOT NULL
      AND completed_at IS NOT NULL
    )
  )
);

DO $shape$
DECLARE
  missing_columns text;
  incompatible_columns text;
  incompatible_defaults text;
  foreign_key_definition text;
  foreign_key_relation oid;
  foreign_key_delete "char";
  claim_definition text;
  complete_definition text;
  all_check_definitions text;
BEGIN
  SELECT string_agg(required.name, ', ' ORDER BY required.name)
    INTO missing_columns
    FROM unnest(ARRAY[
      'submission_id','tracking_number','payment_intent_id','payment_metadata',
      'amount_pence','currency','paid_at','confirmation_payload','provider_idempotency_key',
      'status','attempt_count','next_attempt_at','claim_token','claim_expires_at','last_error',
      'estimate_completed_at','credit_completed_at','promo_completed_at','user_link_completed_at',
      'email_completed_at','provider_message_id','completed_at','created_at','updated_at'
    ]) AS required(name)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = 'grading_payment_fulfilments'
        AND c.column_name = required.name
   );
  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION '0117: incompatible public.grading_payment_fulfilments; missing columns: %', missing_columns;
  END IF;

  SELECT string_agg(required.name || ':' || COALESCE(format_type(a.atttypid, a.atttypmod), '<missing>'), ', ')
    INTO incompatible_columns
    FROM (VALUES
      ('submission_id','integer'), ('tracking_number','text'), ('payment_intent_id','text'),
      ('payment_metadata','jsonb'), ('amount_pence','integer'), ('currency','character varying(3)'),
      ('paid_at','timestamp with time zone'), ('confirmation_payload','jsonb'),
      ('provider_idempotency_key','text'), ('status','text'), ('attempt_count','integer'),
      ('next_attempt_at','timestamp with time zone'), ('claim_token','text'),
      ('claim_expires_at','timestamp with time zone'), ('last_error','text'),
      ('estimate_completed_at','timestamp with time zone'), ('credit_completed_at','timestamp with time zone'),
      ('promo_completed_at','timestamp with time zone'), ('user_link_completed_at','timestamp with time zone'),
      ('email_completed_at','timestamp with time zone'), ('provider_message_id','text'),
      ('completed_at','timestamp with time zone'), ('created_at','timestamp with time zone'),
      ('updated_at','timestamp with time zone')
    ) AS required(name, expected_type)
    LEFT JOIN pg_attribute a
      ON a.attrelid = 'public.grading_payment_fulfilments'::regclass
     AND a.attname = required.name AND a.attnum > 0 AND NOT a.attisdropped
   WHERE format_type(a.atttypid, a.atttypmod) IS DISTINCT FROM required.expected_type;
  IF incompatible_columns IS NOT NULL THEN
    RAISE EXCEPTION '0117: incompatible payment fulfilment column types: %', incompatible_columns;
  END IF;

  SELECT string_agg(required.name, ', ' ORDER BY required.name)
    INTO incompatible_defaults
    FROM (VALUES
      ('payment_metadata', '''{}''::jsonb'),
      ('status', '''PENDING''::text'),
      ('attempt_count', '0'),
      ('next_attempt_at', 'now()'),
      ('created_at', 'now()'),
      ('updated_at', 'now()')
    ) AS required(name, expected_default)
    LEFT JOIN pg_attribute a
      ON a.attrelid = 'public.grading_payment_fulfilments'::regclass
     AND a.attname = required.name AND a.attnum > 0 AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE pg_get_expr(d.adbin, d.adrelid) IS DISTINCT FROM required.expected_default;
  IF incompatible_defaults IS NOT NULL THEN
    RAISE EXCEPTION '0117: incompatible payment fulfilment defaults: %', incompatible_defaults;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.grading_payment_fulfilments'::regclass
      AND c.contype = 'p'
      AND pg_get_constraintdef(c.oid) = 'PRIMARY KEY (submission_id)'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.grading_payment_fulfilments'::regclass
      AND c.contype = 'u' AND pg_get_constraintdef(c.oid) = 'UNIQUE (payment_intent_id)'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.grading_payment_fulfilments'::regclass
      AND c.contype = 'u' AND pg_get_constraintdef(c.oid) = 'UNIQUE (provider_idempotency_key)'
  ) THEN
    RAISE EXCEPTION '0117: incompatible payment fulfilment key constraints';
  END IF;

  SELECT pg_get_constraintdef(c.oid), c.confrelid, c.confdeltype
    INTO foreign_key_definition, foreign_key_relation, foreign_key_delete
    FROM pg_constraint c
   WHERE c.conrelid = 'public.grading_payment_fulfilments'::regclass AND c.contype = 'f';
  IF foreign_key_definition IS NULL
     OR position('FOREIGN KEY (submission_id)' IN foreign_key_definition) = 0
     OR foreign_key_relation IS DISTINCT FROM 'public.submissions'::regclass
     OR foreign_key_delete IS DISTINCT FROM 'r' THEN
    RAISE EXCEPTION '0117: payment fulfilment FK must reference public.submissions(id) ON DELETE RESTRICT';
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO claim_definition
    FROM pg_constraint c WHERE c.conrelid = 'public.grading_payment_fulfilments'::regclass
      AND c.conname = 'chk_grading_payment_fulfilment_claim' AND c.contype = 'c' AND c.convalidated;
  SELECT pg_get_constraintdef(c.oid) INTO complete_definition
    FROM pg_constraint c WHERE c.conrelid = 'public.grading_payment_fulfilments'::regclass
      AND c.conname = 'chk_grading_payment_fulfilment_complete' AND c.contype = 'c' AND c.convalidated;
  SELECT string_agg(pg_get_constraintdef(c.oid), ' ') INTO all_check_definitions
    FROM pg_constraint c
   WHERE c.conrelid = 'public.grading_payment_fulfilments'::regclass
     AND c.contype = 'c' AND c.convalidated;
  IF claim_definition IS NULL OR complete_definition IS NULL
     OR position('PROCESSING' IN claim_definition) = 0
     OR position('claim_token IS NOT NULL' IN claim_definition) = 0
     OR position('claim_expires_at IS NOT NULL' IN claim_definition) = 0
     OR position('COMPLETE' IN complete_definition) = 0
     OR position('email_completed_at IS NOT NULL' IN complete_definition) = 0
     OR position('completed_at IS NOT NULL' IN complete_definition) = 0
     OR position('PENDING' IN all_check_definitions) = 0
     OR position('FAILED' IN all_check_definitions) = 0
     OR position('RECONCILIATION_REQUIRED' IN all_check_definitions) = 0
     OR position('attempt_count' IN all_check_definitions) = 0
     OR position('amount_pence' IN all_check_definitions) = 0
     OR position('currency' IN all_check_definitions) = 0 THEN
    RAISE EXCEPTION '0117: incompatible payment fulfilment check constraints';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = 'grading_payment_fulfilments'
       AND c.column_name IN (
         'submission_id','tracking_number','payment_intent_id','payment_metadata','amount_pence','currency',
         'paid_at','confirmation_payload','provider_idempotency_key','status','attempt_count','next_attempt_at',
         'created_at','updated_at'
       ) AND c.is_nullable <> 'NO'
  ) THEN
    RAISE EXCEPTION '0117: required payment fulfilment columns must be NOT NULL';
  END IF;
END
$shape$;

CREATE INDEX IF NOT EXISTS idx_grading_payment_fulfilments_due
  ON public.grading_payment_fulfilments (next_attempt_at, submission_id)
  WHERE status IN ('PENDING', 'FAILED', 'PROCESSING');

DO $index_shape$
DECLARE
  definition text;
  valid boolean;
  ready boolean;
  key_count integer;
  attribute_count integer;
  has_expressions boolean;
BEGIN
  SELECT pg_get_indexdef(i.indexrelid), i.indisvalid, i.indisready,
         i.indnkeyatts, i.indnatts, i.indexprs IS NOT NULL
    INTO definition, valid, ready, key_count, attribute_count, has_expressions
    FROM pg_index i
   WHERE i.indexrelid = 'public.idx_grading_payment_fulfilments_due'::regclass
     AND i.indrelid = 'public.grading_payment_fulfilments'::regclass;
  IF definition IS NULL OR valid IS DISTINCT FROM TRUE OR ready IS DISTINCT FROM TRUE
     OR key_count IS DISTINCT FROM 2 OR attribute_count IS DISTINCT FROM 2
     OR has_expressions IS DISTINCT FROM FALSE
     OR pg_get_indexdef('public.idx_grading_payment_fulfilments_due'::regclass, 1, true) <> 'next_attempt_at'
     OR pg_get_indexdef('public.idx_grading_payment_fulfilments_due'::regclass, 2, true) <> 'submission_id'
     OR position('status' IN definition) = 0
     OR position('PENDING' IN definition) = 0
     OR position('FAILED' IN definition) = 0
     OR position('PROCESSING' IN definition) = 0 THEN
    RAISE EXCEPTION '0117: incompatible idx_grading_payment_fulfilments_due index';
  END IF;
END
$index_shape$;

COMMENT ON TABLE public.grading_payment_fulfilments IS
  'Durable, retryable post-charge grading fulfilment. Created before submissions become paid; COMPLETE requires every effect.';

-- The runtime role only needs bounded queue operations; schema ownership stays
-- with the migration/deployment role. Existing deployment grants are preserved.
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mintvault_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.grading_payment_fulfilments TO mintvault_app;
    IF NOT has_table_privilege('mintvault_app', 'public.grading_payment_fulfilments', 'SELECT')
       OR NOT has_table_privilege('mintvault_app', 'public.grading_payment_fulfilments', 'INSERT')
       OR NOT has_table_privilege('mintvault_app', 'public.grading_payment_fulfilments', 'UPDATE') THEN
      RAISE EXCEPTION '0117: mintvault_app payment fulfilment grants are incomplete';
    END IF;
  END IF;
END
$grants$;
