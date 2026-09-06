-- 0120 — Durable customer authentication and ownership notifications
--
-- Security-sensitive links and ownership transitions must never depend on an
-- inline provider call. Encrypted payloads are inserted in the same database
-- transaction as the state/token mutation; a leased worker delivers them with
-- a stable provider idempotency key. Ambiguous delivery is never retried after
-- the provider idempotency window without explicit reconciliation.

CREATE TABLE IF NOT EXISTS public.customer_notification_outbox (
  id bigserial PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  template_version integer NOT NULL DEFAULT 1 CHECK (template_version > 0),
  encrypted_payload text NOT NULL,
  encryption_key_version integer NOT NULL DEFAULT 1 CHECK (encryption_key_version > 0),
  payload_fingerprint text NOT NULL CHECK (payload_fingerprint ~ '^v[1-9][0-9]*:[0-9a-f]{64}$'),
  provider_idempotency_key text NOT NULL UNIQUE,
  expires_at timestamptz,

  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PROCESSING','FAILED','SENT','EXPIRED','RECONCILIATION_REQUIRED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 20),
  next_attempt_at timestamptz DEFAULT now(),
  claim_token text,
  claim_expires_at timestamptz,
  uncertain_delivery_at timestamptz,
  provider_message_id text,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_customer_notification_claim CHECK (
    (status = 'PROCESSING' AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
    OR
    (status <> 'PROCESSING' AND claim_token IS NULL AND claim_expires_at IS NULL)
  ),
  CONSTRAINT chk_customer_notification_terminal CHECK (
    (status = 'SENT' AND delivered_at IS NOT NULL AND provider_message_id IS NOT NULL AND next_attempt_at IS NULL)
    OR (status IN ('EXPIRED','RECONCILIATION_REQUIRED') AND next_attempt_at IS NULL)
    OR status IN ('PENDING','PROCESSING','FAILED')
  )
);

DO $shape$
DECLARE
  incompatible_columns text;
  definitions text;
BEGIN
  SELECT string_agg(required.name || ':' || COALESCE(format_type(a.atttypid, a.atttypmod), '<missing>'), ', ')
    INTO incompatible_columns
    FROM (VALUES
      ('id','bigint',true), ('event_key','text',true), ('kind','text',true),
      ('aggregate_type','text',true), ('aggregate_id','text',true),
      ('template_version','integer',true), ('encrypted_payload','text',true),
      ('encryption_key_version','integer',true), ('payload_fingerprint','text',true),
      ('provider_idempotency_key','text',true),
      ('expires_at','timestamp with time zone',false), ('status','text',true),
      ('attempt_count','integer',true), ('next_attempt_at','timestamp with time zone',false),
      ('claim_token','text',false), ('claim_expires_at','timestamp with time zone',false),
      ('uncertain_delivery_at','timestamp with time zone',false), ('provider_message_id','text',false),
      ('delivered_at','timestamp with time zone',false), ('last_error','text',false),
      ('created_at','timestamp with time zone',true), ('updated_at','timestamp with time zone',true)
    ) AS required(name, expected_type, required_not_null)
    LEFT JOIN pg_attribute a
      ON a.attrelid = to_regclass('public.customer_notification_outbox')
     AND a.attname = required.name AND a.attnum > 0 AND NOT a.attisdropped
   WHERE format_type(a.atttypid, a.atttypmod) IS DISTINCT FROM required.expected_type
      OR (required.required_not_null AND a.attnotnull IS DISTINCT FROM true);
  IF incompatible_columns IS NOT NULL THEN
    RAISE EXCEPTION '0120: incompatible customer notification columns: %', incompatible_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid=to_regclass('public.customer_notification_outbox')
       AND c.contype='p' AND c.convalidated
       AND pg_get_constraintdef(c.oid)='PRIMARY KEY (id)'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid=to_regclass('public.customer_notification_outbox')
       AND c.contype='u' AND c.convalidated
       AND pg_get_constraintdef(c.oid)='UNIQUE (event_key)'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid=to_regclass('public.customer_notification_outbox')
       AND c.contype='u' AND c.convalidated
       AND pg_get_constraintdef(c.oid)='UNIQUE (provider_idempotency_key)'
  ) THEN
    RAISE EXCEPTION '0120: incompatible customer notification key constraints';
  END IF;

  SELECT string_agg(pg_get_constraintdef(c.oid), ' ')
    INTO definitions
    FROM pg_constraint c
   WHERE c.conrelid=to_regclass('public.customer_notification_outbox')
     AND c.contype='c' AND c.convalidated;
  IF definitions IS NULL
     OR position('PENDING' IN definitions)=0
     OR position('PROCESSING' IN definitions)=0
     OR position('FAILED' IN definitions)=0
     OR position('SENT' IN definitions)=0
     OR position('EXPIRED' IN definitions)=0
     OR position('RECONCILIATION_REQUIRED' IN definitions)=0
     OR position('claim_token IS NOT NULL' IN definitions)=0
     OR position('delivered_at IS NOT NULL' IN definitions)=0
     OR position('payload_fingerprint' IN definitions)=0
     OR position('attempt_count' IN definitions)=0 THEN
    RAISE EXCEPTION '0120: incompatible customer notification check constraints';
  END IF;
END
$shape$;

DO $defaults$
DECLARE
  bad_defaults text;
BEGIN
  SELECT string_agg(required.name || ':' || COALESCE(pg_get_expr(a.adbin,a.adrelid),'<missing>'), ', ')
    INTO bad_defaults
    FROM (VALUES
      ('id','nextval(''customer_notification_outbox_id_seq''::regclass)'),
      ('template_version','1'), ('encryption_key_version','1'), ('status','''PENDING''::text'),
      ('attempt_count','0'), ('next_attempt_at','now()'), ('created_at','now()'), ('updated_at','now()')
    ) AS required(name, expected)
    LEFT JOIN pg_attribute col
      ON col.attrelid=to_regclass('public.customer_notification_outbox')
     AND col.attname=required.name AND col.attnum > 0 AND NOT col.attisdropped
    LEFT JOIN pg_attrdef a ON a.adrelid=col.attrelid AND a.adnum=col.attnum
   WHERE pg_get_expr(a.adbin,a.adrelid) IS DISTINCT FROM required.expected;
  IF bad_defaults IS NOT NULL THEN
    RAISE EXCEPTION '0120: incompatible customer notification defaults: %', bad_defaults;
  END IF;
  IF pg_get_serial_sequence('public.customer_notification_outbox','id')
       IS DISTINCT FROM 'public.customer_notification_outbox_id_seq' THEN
    RAISE EXCEPTION '0120: customer notification id sequence is not public-qualified authority';
  END IF;
END
$defaults$;

CREATE INDEX IF NOT EXISTS idx_customer_notification_outbox_due
  ON public.customer_notification_outbox (next_attempt_at, id)
  WHERE status IN ('PENDING','FAILED','PROCESSING');

CREATE INDEX IF NOT EXISTS idx_customer_notification_outbox_aggregate
  ON public.customer_notification_outbox (aggregate_type, aggregate_id, id);

DO $indexes$
DECLARE
  due_definition text;
  aggregate_definition text;
BEGIN
  SELECT pg_get_indexdef(i.indexrelid) INTO due_definition
    FROM pg_index i
   WHERE i.indexrelid=to_regclass('public.idx_customer_notification_outbox_due')
     AND i.indrelid=to_regclass('public.customer_notification_outbox')
     AND i.indisvalid AND i.indisready AND i.indnkeyatts=2 AND i.indnatts=2 AND i.indexprs IS NULL
     AND pg_get_indexdef(i.indexrelid,1,true)='next_attempt_at'
     AND pg_get_indexdef(i.indexrelid,2,true)='id';
  SELECT pg_get_indexdef(i.indexrelid) INTO aggregate_definition
    FROM pg_index i
   WHERE i.indexrelid=to_regclass('public.idx_customer_notification_outbox_aggregate')
     AND i.indrelid=to_regclass('public.customer_notification_outbox')
     AND i.indisvalid AND i.indisready AND i.indnkeyatts=3 AND i.indnatts=3 AND i.indexprs IS NULL
     AND pg_get_indexdef(i.indexrelid,1,true)='aggregate_type'
     AND pg_get_indexdef(i.indexrelid,2,true)='aggregate_id'
     AND pg_get_indexdef(i.indexrelid,3,true)='id';
  IF due_definition IS NULL
     OR position('PENDING' IN due_definition)=0 OR position('FAILED' IN due_definition)=0
     OR position('PROCESSING' IN due_definition)=0 OR aggregate_definition IS NULL THEN
    RAISE EXCEPTION '0120: incompatible customer notification indexes';
  END IF;
END
$indexes$;

COMMENT ON TABLE public.customer_notification_outbox IS
  'Encrypted, leased, provider-idempotent delivery authority for customer auth and ownership notifications.';

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mintvault_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.customer_notification_outbox TO mintvault_app;
    GRANT USAGE, SELECT ON SEQUENCE public.customer_notification_outbox_id_seq TO mintvault_app;
  END IF;
END
$grants$;
