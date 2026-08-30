-- 0122 — Durable object-write intent and reconciliation authority
-- SCOPE: APPLICATION
--
-- PostgreSQL and object stores cannot share one transaction. This migration
-- records the immutable object manifest before network I/O, permits publication
-- only after byte/hash verification, and gives a leased reconciler enough
-- durable state to adopt ambiguous writes without guessing or deleting evidence.

DO $guard$
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL OR NOT EXISTS (
    SELECT 1
      FROM public.schema_migrations
     WHERE filename='0121_main_runtime_role_authority.sql'
       AND status='applied'
       AND completed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0122 requires applied migration 0121_main_runtime_role_authority.sql';
  END IF;
  IF to_regclass('public.partner_organisations') IS NULL
     OR to_regclass('public.submissions') IS NULL
     OR to_regclass('public.certificates') IS NULL
     OR to_regprocedure('public.partner_current_tenant()') IS NULL THEN
    RAISE EXCEPTION '0122 requires Partner tenant authority, core submissions, and certificates';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mintvault_app')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='partner_runtime') THEN
    RAISE EXCEPTION '0122 requires mintvault_app and partner_runtime roles';
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS public.object_write_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES public.partner_organisations(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL
    CONSTRAINT chk_object_write_operation_idempotency_key
    CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  operation_kind text NOT NULL
    CONSTRAINT chk_object_write_operation_kind
    CHECK (operation_kind ~ '^[A-Z][A-Z0-9_]{2,79}$'),
  aggregate_type text NOT NULL
    CONSTRAINT chk_object_write_operation_aggregate_type
    CHECK (aggregate_type ~ '^[a-z][a-z0-9_]{1,79}$'),
  aggregate_id text,
  actor_id text,
  state text NOT NULL DEFAULT 'PREPARED'
    CONSTRAINT chk_object_write_operation_state
    CHECK (state IN (
      'PREPARED','UPLOADING','VERIFIED','COMMITTED',
      'ABANDONED','RECONCILIATION_REQUIRED'
    )),
  manifest_sha256 character(64) NOT NULL
    CONSTRAINT chk_object_write_operation_manifest_sha256
    CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  expected_state jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT chk_object_write_operation_expected_state
    CHECK (jsonb_typeof(expected_state)='object'),
  intent_payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT chk_object_write_operation_intent_payload
    CHECK (jsonb_typeof(intent_payload)='object'),
  result_payload jsonb
    CONSTRAINT chk_object_write_operation_result_payload
    CHECK (result_payload IS NULL OR jsonb_typeof(result_payload)='object'),
  attempt_count integer NOT NULL DEFAULT 0
    CONSTRAINT chk_object_write_operation_attempt_count
    CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  last_error_detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  committed_at timestamptz,
  abandoned_at timestamptz,
  CONSTRAINT chk_object_write_operation_lease CHECK (
    (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
    OR
    (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT chk_object_write_operation_verified CHECK (
    state <> 'VERIFIED' OR verified_at IS NOT NULL
  ),
  CONSTRAINT chk_object_write_operation_committed CHECK (
    state <> 'COMMITTED'
    OR (committed_at IS NOT NULL AND result_payload IS NOT NULL)
  ),
  CONSTRAINT chk_object_write_operation_abandoned CHECK (
    state <> 'ABANDONED' OR abandoned_at IS NOT NULL
  )
);

CREATE TABLE IF NOT EXISTS public.object_write_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL
    CONSTRAINT fk_object_write_item_operation
    REFERENCES public.object_write_operations(id) ON DELETE RESTRICT,
  store text NOT NULL
    CONSTRAINT chk_object_write_item_store CHECK (store IN ('R2','B2')),
  logical_slot text NOT NULL
    CONSTRAINT chk_object_write_item_logical_slot
    CHECK (length(logical_slot) BETWEEN 1 AND 120),
  object_key text NOT NULL
    CONSTRAINT chk_object_write_item_object_key
    CHECK (length(object_key) BETWEEN 1 AND 1024),
  prior_object_key text,
  content_sha256 character(64) NOT NULL
    CONSTRAINT chk_object_write_item_content_sha256
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  byte_length bigint NOT NULL
    CONSTRAINT chk_object_write_item_byte_length CHECK (byte_length > 0),
  content_type text NOT NULL,
  object_class text NOT NULL
    CONSTRAINT chk_object_write_item_class
    CHECK (object_class IN (
      'CANONICAL','DERIVATIVE','STAGING','PRINT',
      'CACHE','EPHEMERAL','ARCHIVE'
    )),
  write_policy text NOT NULL DEFAULT 'CREATE_ONLY'
    CONSTRAINT chk_object_write_item_policy
    CHECK (write_policy IN ('CREATE_ONLY','VERIFY_OR_CREATE_LOCKED')),
  retention_days integer
    CONSTRAINT chk_object_write_item_retention_days
    CHECK (
      (store='R2' AND retention_days IS NULL)
      OR (store='B2' AND retention_days >= 1)
    ),
  minimum_retain_until timestamptz
    CONSTRAINT chk_object_write_item_minimum_retention
    CHECK (
      (store='R2' AND minimum_retain_until IS NULL)
      OR (store='B2' AND minimum_retain_until IS NOT NULL)
    ),
  required boolean NOT NULL DEFAULT true,
  verification_state text NOT NULL DEFAULT 'PENDING'
    CONSTRAINT chk_object_write_item_verification_state
    CHECK (verification_state IN ('PENDING','VERIFIED','QUARANTINED')),
  write_disposition text NOT NULL DEFAULT 'PENDING'
    CONSTRAINT chk_object_write_item_disposition
    CHECK (write_disposition IN ('PENDING','CREATED','ADOPTED','AMBIGUOUS')),
  observed_sha256 character(64)
    CONSTRAINT chk_object_write_item_observed_sha256
    CHECK (observed_sha256 IS NULL OR observed_sha256 ~ '^[0-9a-f]{64}$'),
  observed_byte_length bigint
    CONSTRAINT chk_object_write_item_observed_byte_length
    CHECK (observed_byte_length IS NULL OR observed_byte_length > 0),
  observed_version_id text,
  missing_observed_at timestamptz,
  verified_at timestamptz,
  cleanup_state text NOT NULL DEFAULT 'NONE'
    CONSTRAINT chk_object_write_item_cleanup_state
    CHECK (cleanup_state IN ('NONE','PENDING','CLEANED')),
  delete_after timestamptz,
  cleanup_attempt_count integer NOT NULL DEFAULT 0
    CONSTRAINT chk_object_write_item_cleanup_attempt_count
    CHECK (cleanup_attempt_count >= 0),
  cleanup_claimed_at timestamptz,
  cleaned_at timestamptz,
  object_lock_mode text,
  object_lock_retain_until timestamptz,
  last_error_detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_object_write_item_slot UNIQUE (operation_id, store, logical_slot),
  CONSTRAINT chk_object_write_item_verified CHECK (
    verification_state <> 'VERIFIED'
    OR (
      observed_sha256=content_sha256
      AND observed_byte_length=byte_length
      AND (store='R2' OR observed_version_id IS NOT NULL)
      AND verified_at IS NOT NULL
    )
  ),
  CONSTRAINT chk_object_write_item_cleaned CHECK (
    cleanup_state <> 'CLEANED' OR cleaned_at IS NOT NULL
  )
);

-- Certificate rows prepared by CERTIFICATE_CREATE_IMAGES keep a permanent,
-- unique link to the immutable operation that owns their initial image
-- publication. The operation is inserted before the global MV allocator is
-- touched, so the allocator UPDATE and certificate INSERT can remain the last
-- two statements in that transaction without inventing a second reservation
-- table or exposing a partially active certificate.
ALTER TABLE public.certificates
  ADD COLUMN IF NOT EXISTS object_write_operation_id uuid;

DO $certificate_operation_link$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.certificates'::regclass
       AND conname='fk_certificates_object_write_operation'
  ) THEN
    ALTER TABLE public.certificates
      ADD CONSTRAINT fk_certificates_object_write_operation
      FOREIGN KEY (object_write_operation_id)
      REFERENCES public.object_write_operations(id)
      ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid='public.certificates'::regclass
       AND attname='object_write_operation_id'
       AND atttypid='uuid'::regtype
       AND attnum > 0
       AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION '0122: incompatible certificates.object_write_operation_id';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid='public.certificates'::regclass
       AND c.conname='fk_certificates_object_write_operation'
       AND c.contype='f'
       AND c.confrelid='public.object_write_operations'::regclass
       AND c.confdeltype='r'
  ) THEN
    RAISE EXCEPTION '0122: incompatible fk_certificates_object_write_operation constraint';
  END IF;
END
$certificate_operation_link$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_certificates_object_write_operation
  ON public.certificates (object_write_operation_id)
  WHERE object_write_operation_id IS NOT NULL;

DO $certificate_operation_index$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class idx ON idx.oid=i.indexrelid
     WHERE idx.oid=to_regclass('public.uq_certificates_object_write_operation')
       AND i.indrelid='public.certificates'::regclass
       AND i.indisunique AND i.indisvalid
       AND pg_get_indexdef(i.indexrelid) LIKE '%(object_write_operation_id)%'
       AND pg_get_expr(i.indpred,i.indrelid)='(object_write_operation_id IS NOT NULL)'
  ) THEN
    RAISE EXCEPTION '0122: incompatible uq_certificates_object_write_operation index';
  END IF;
END
$certificate_operation_index$;

ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS on_receipt_photo_objects jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS on_receipt_photo_revision bigint NOT NULL DEFAULT 0;

DO $receipt_shape$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid='public.submissions'::regclass
       AND conname='chk_submissions_receipt_photo_objects_array'
  ) THEN
    ALTER TABLE public.submissions
      ADD CONSTRAINT chk_submissions_receipt_photo_objects_array
      CHECK (jsonb_typeof(on_receipt_photo_objects)='array');
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid='public.submissions'::regclass
       AND attname='on_receipt_photo_objects'
       AND atttypid='jsonb'::regtype
       AND attnotnull
       AND attnum > 0
       AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION '0122: incompatible submissions.on_receipt_photo_objects';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_attribute
     WHERE attrelid='public.submissions'::regclass
       AND attname='on_receipt_photo_revision'
       AND atttypid='bigint'::regtype
       AND attnotnull
       AND attnum > 0
       AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION '0122: incompatible submissions.on_receipt_photo_revision';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.submissions'::regclass
       AND conname='chk_submissions_receipt_photo_revision'
  ) THEN
    ALTER TABLE public.submissions
      ADD CONSTRAINT chk_submissions_receipt_photo_revision
      CHECK (on_receipt_photo_revision >= 0);
  END IF;
END
$receipt_shape$;

DO $shape$
DECLARE
  missing_or_incompatible text;
  relation_name text;
BEGIN
  IF to_regclass('public.object_write_operations') IS NULL
     OR to_regclass('public.object_write_items') IS NULL THEN
    RAISE EXCEPTION '0122: object write tables are missing';
  END IF;

  SELECT string_agg(required.name || ':' || COALESCE(format_type(a.atttypid,a.atttypmod),'<missing>'), ', ')
    INTO missing_or_incompatible
    FROM (VALUES
      ('id','uuid',true), ('tenant_id','uuid',false), ('idempotency_key','text',true),
      ('operation_kind','text',true), ('aggregate_type','text',true), ('aggregate_id','text',false),
      ('actor_id','text',false), ('state','text',true), ('manifest_sha256','character(64)',true),
      ('expected_state','jsonb',true), ('intent_payload','jsonb',true), ('result_payload','jsonb',false),
      ('attempt_count','integer',true), ('next_attempt_at','timestamp with time zone',true),
      ('lease_owner','text',false), ('lease_token','uuid',false),
      ('lease_expires_at','timestamp with time zone',false), ('last_error_code','text',false),
      ('last_error_detail','text',false), ('created_at','timestamp with time zone',true),
      ('updated_at','timestamp with time zone',true), ('verified_at','timestamp with time zone',false),
      ('committed_at','timestamp with time zone',false), ('abandoned_at','timestamp with time zone',false)
    ) AS required(name, expected_type, required_not_null)
    LEFT JOIN pg_attribute a
      ON a.attrelid='public.object_write_operations'::regclass
     AND a.attname=required.name AND a.attnum > 0 AND NOT a.attisdropped
   WHERE format_type(a.atttypid,a.atttypmod) IS DISTINCT FROM required.expected_type
      OR (required.required_not_null AND a.attnotnull IS DISTINCT FROM true);
  IF missing_or_incompatible IS NOT NULL THEN
    RAISE EXCEPTION '0122: incompatible object_write_operations columns: %', missing_or_incompatible;
  END IF;

  SELECT string_agg(required.name || ':' || COALESCE(format_type(a.atttypid,a.atttypmod),'<missing>'), ', ')
    INTO missing_or_incompatible
    FROM (VALUES
      ('id','uuid',true), ('operation_id','uuid',true), ('store','text',true),
      ('logical_slot','text',true), ('object_key','text',true), ('prior_object_key','text',false),
      ('content_sha256','character(64)',true), ('byte_length','bigint',true),
      ('content_type','text',true), ('object_class','text',true), ('write_policy','text',true),
      ('retention_days','integer',false),
      ('minimum_retain_until','timestamp with time zone',false),
      ('required','boolean',true), ('verification_state','text',true),
      ('write_disposition','text',true),
      ('observed_sha256','character(64)',false), ('observed_byte_length','bigint',false),
      ('observed_version_id','text',false),
      ('missing_observed_at','timestamp with time zone',false),
      ('verified_at','timestamp with time zone',false), ('cleanup_state','text',true),
      ('delete_after','timestamp with time zone',false), ('cleanup_attempt_count','integer',true),
      ('cleanup_claimed_at','timestamp with time zone',false), ('cleaned_at','timestamp with time zone',false),
      ('object_lock_mode','text',false), ('object_lock_retain_until','timestamp with time zone',false),
      ('last_error_detail','text',false), ('created_at','timestamp with time zone',true),
      ('updated_at','timestamp with time zone',true)
    ) AS required(name, expected_type, required_not_null)
    LEFT JOIN pg_attribute a
      ON a.attrelid='public.object_write_items'::regclass
     AND a.attname=required.name AND a.attnum > 0 AND NOT a.attisdropped
   WHERE format_type(a.atttypid,a.atttypmod) IS DISTINCT FROM required.expected_type
      OR (required.required_not_null AND a.attnotnull IS DISTINCT FROM true);
  IF missing_or_incompatible IS NOT NULL THEN
    RAISE EXCEPTION '0122: incompatible object_write_items columns: %', missing_or_incompatible;
  END IF;

  FOREACH relation_name IN ARRAY ARRAY['object_write_operations','object_write_items'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid=to_regclass('public.' || relation_name)
         AND contype='p' AND convalidated
    ) THEN
      RAISE EXCEPTION '0122: % primary key is missing', relation_name;
    END IF;
  END LOOP;
END
$shape$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_object_write_operation_idempotency
  ON public.object_write_operations (
    COALESCE(tenant_id,'00000000-0000-0000-0000-000000000000'::uuid),
    idempotency_key
  );
CREATE INDEX IF NOT EXISTS idx_object_write_operation_aggregate
  ON public.object_write_operations (aggregate_type, aggregate_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_object_write_operation_due
  ON public.object_write_operations (next_attempt_at, created_at, id)
  WHERE state IN ('PREPARED','UPLOADING','VERIFIED','RECONCILIATION_REQUIRED');
CREATE INDEX IF NOT EXISTS idx_object_write_operation_lease
  ON public.object_write_operations (lease_expires_at, id)
  WHERE lease_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_object_write_items_operation
  ON public.object_write_items (operation_id, required, logical_slot);
CREATE INDEX IF NOT EXISTS idx_object_write_items_key
  ON public.object_write_items (store, object_key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_object_write_items_store_key
  ON public.object_write_items (store, object_key);
CREATE INDEX IF NOT EXISTS idx_object_write_items_cleanup
  ON public.object_write_items (delete_after, id)
  WHERE cleanup_state='PENDING';

DO $index_and_check_shape$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid='public.uq_object_write_operation_idempotency'::regclass
       AND i.indrelid='public.object_write_operations'::regclass
       AND i.indisvalid AND i.indisready AND i.indisunique
       AND i.indnkeyatts=2 AND i.indnatts=2
       AND pg_get_indexdef(i.indexrelid,1,true)=
           'COALESCE(tenant_id, ''00000000-0000-0000-0000-000000000000''::uuid)'
       AND pg_get_indexdef(i.indexrelid,2,true)='idempotency_key'
  ) THEN
    RAISE EXCEPTION '0122: incompatible uq_object_write_operation_idempotency index';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indexrelid='public.uq_object_write_items_store_key'::regclass
       AND i.indrelid='public.object_write_items'::regclass
       AND i.indisvalid AND i.indisready AND i.indisunique
       AND i.indnkeyatts=2 AND i.indnatts=2 AND i.indexprs IS NULL
       AND pg_get_indexdef(i.indexrelid,1,true)='store'
       AND pg_get_indexdef(i.indexrelid,2,true)='object_key'
  ) THEN
    RAISE EXCEPTION '0122: incompatible uq_object_write_items_store_key index';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid='public.object_write_items'::regclass
       AND c.conname='chk_object_write_item_verified'
       AND c.contype='c' AND c.convalidated
       AND position('observed_sha256 = content_sha256' IN pg_get_constraintdef(c.oid)) > 0
       AND position('observed_byte_length = byte_length' IN pg_get_constraintdef(c.oid)) > 0
       AND position('observed_version_id IS NOT NULL' IN pg_get_constraintdef(c.oid)) > 0
       AND position('verified_at IS NOT NULL' IN pg_get_constraintdef(c.oid)) > 0
  ) THEN
    RAISE EXCEPTION '0122: incompatible chk_object_write_item_verified constraint';
  END IF;
END
$index_and_check_shape$;

CREATE OR REPLACE FUNCTION public.object_write_operation_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog, public
AS $fn$
DECLARE
  legal_transition boolean;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.state <> 'PREPARED'
       OR NEW.lease_owner IS NOT NULL
       OR NEW.lease_token IS NOT NULL
       OR NEW.lease_expires_at IS NOT NULL
       OR NEW.result_payload IS NOT NULL
       OR NEW.attempt_count <> 0
       OR NEW.last_error_code IS NOT NULL
       OR NEW.last_error_detail IS NOT NULL
       OR NEW.verified_at IS NOT NULL
       OR NEW.committed_at IS NOT NULL
       OR NEW.abandoned_at IS NOT NULL THEN
      RAISE EXCEPTION 'object write operations must begin in a pristine PREPARED state'
        USING ERRCODE='23514';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;

  IF OLD.state IN ('COMMITTED','ABANDONED') THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'terminal object write operations are immutable'
        USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;

  IF ROW(NEW.id,NEW.tenant_id,NEW.idempotency_key,NEW.operation_kind,
         NEW.aggregate_type,NEW.aggregate_id,NEW.actor_id,NEW.manifest_sha256,
         NEW.expected_state,NEW.intent_payload,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.tenant_id,OLD.idempotency_key,OLD.operation_kind,
         OLD.aggregate_type,OLD.aggregate_id,OLD.actor_id,OLD.manifest_sha256,
         OLD.expected_state,OLD.intent_payload,OLD.created_at) THEN
    RAISE EXCEPTION 'object write operation intent is immutable'
      USING ERRCODE='23514';
  END IF;
  IF NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION 'object write attempt count cannot decrease'
      USING ERRCODE='23514';
  END IF;
  IF NEW.result_payload IS DISTINCT FROM OLD.result_payload
     AND NOT (OLD.state='VERIFIED' AND NEW.state='COMMITTED' AND NEW.result_payload IS NOT NULL) THEN
    RAISE EXCEPTION 'object write result is owned by the COMMITTED transition'
      USING ERRCODE='23514';
  END IF;
  IF NEW.committed_at IS DISTINCT FROM OLD.committed_at
     OR NEW.abandoned_at IS DISTINCT FROM OLD.abandoned_at
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
    RAISE EXCEPTION 'object write lifecycle timestamps are trigger-owned'
      USING ERRCODE='23514';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    legal_transition :=
      (OLD.state='PREPARED' AND NEW.state IN ('UPLOADING','ABANDONED','RECONCILIATION_REQUIRED'))
      OR (OLD.state='UPLOADING' AND NEW.state IN ('VERIFIED','ABANDONED','RECONCILIATION_REQUIRED'))
      OR (OLD.state='VERIFIED' AND NEW.state IN ('COMMITTED','ABANDONED','RECONCILIATION_REQUIRED'))
      OR (OLD.state='RECONCILIATION_REQUIRED' AND NEW.state IN ('UPLOADING','VERIFIED','ABANDONED'));
    IF NOT legal_transition THEN
      RAISE EXCEPTION 'illegal object write transition % -> %', OLD.state, NEW.state
        USING ERRCODE='23514';
    END IF;
  END IF;

  IF NEW.state='VERIFIED' AND OLD.state IS DISTINCT FROM 'VERIFIED' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.object_write_items item
       WHERE item.operation_id=OLD.id AND item.required
    ) OR EXISTS (
      SELECT 1 FROM public.object_write_items item
       WHERE item.operation_id=OLD.id
         AND item.required
         AND item.verification_state <> 'VERIFIED'
    ) THEN
      RAISE EXCEPTION 'required object write items are not verified'
        USING ERRCODE='23514';
    END IF;
    NEW.verified_at := COALESCE(OLD.verified_at,now());
  END IF;

  IF NEW.state='COMMITTED' AND OLD.state IS DISTINCT FROM 'COMMITTED' THEN
    IF NEW.result_payload IS NULL OR EXISTS (
      SELECT 1 FROM public.object_write_items item
       WHERE item.operation_id=OLD.id
         AND item.required
         AND item.verification_state <> 'VERIFIED'
    ) THEN
      RAISE EXCEPTION 'object write cannot commit before required verification and result'
        USING ERRCODE='23514';
    END IF;
    NEW.committed_at := now();
    NEW.lease_owner := NULL;
    NEW.lease_token := NULL;
    NEW.lease_expires_at := NULL;
  ELSIF NEW.state='ABANDONED' AND OLD.state IS DISTINCT FROM 'ABANDONED' THEN
    NEW.abandoned_at := now();
    NEW.lease_owner := NULL;
    NEW.lease_token := NULL;
    NEW.lease_expires_at := NULL;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION public.object_write_item_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog, public
AS $fn$
DECLARE
  parent_state text;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT state INTO parent_state
      FROM public.object_write_operations
     WHERE id=NEW.operation_id
     FOR UPDATE;
  ELSE
    SELECT state INTO parent_state
      FROM public.object_write_operations
     WHERE id=NEW.operation_id;
  END IF;
  IF parent_state IS NULL THEN
    RAISE EXCEPTION 'object write item requires an operation'
      USING ERRCODE='23503';
  END IF;

  IF TG_OP='INSERT' THEN
    IF parent_state <> 'PREPARED' THEN
      RAISE EXCEPTION 'object write manifest is already sealed'
        USING ERRCODE='23514';
    END IF;
    IF NEW.verification_state <> 'PENDING'
       OR NEW.write_disposition <> 'PENDING'
       OR NEW.observed_sha256 IS NOT NULL
       OR NEW.observed_byte_length IS NOT NULL
       OR NEW.observed_version_id IS NOT NULL
       OR NEW.missing_observed_at IS NOT NULL
       OR NEW.verified_at IS NOT NULL
       OR NEW.cleanup_state <> 'NONE'
       OR NEW.delete_after IS NOT NULL
       OR NEW.cleanup_attempt_count <> 0
       OR NEW.cleanup_claimed_at IS NOT NULL
       OR NEW.cleaned_at IS NOT NULL
       OR NEW.object_lock_mode IS NOT NULL
       OR NEW.object_lock_retain_until IS NOT NULL
       OR NEW.last_error_detail IS NOT NULL THEN
      RAISE EXCEPTION 'object write items must begin in a pristine pending state'
        USING ERRCODE='23514';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;

  IF ROW(NEW.id,NEW.operation_id,NEW.store,NEW.logical_slot,NEW.object_key,
         NEW.prior_object_key,NEW.content_sha256,NEW.byte_length,NEW.content_type,
         NEW.object_class,NEW.write_policy,NEW.retention_days,NEW.minimum_retain_until,
         NEW.required,NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id,OLD.operation_id,OLD.store,OLD.logical_slot,OLD.object_key,
         OLD.prior_object_key,OLD.content_sha256,OLD.byte_length,OLD.content_type,
         OLD.object_class,OLD.write_policy,OLD.retention_days,OLD.minimum_retain_until,
         OLD.required,OLD.created_at) THEN
    RAISE EXCEPTION 'object write item manifest is immutable'
      USING ERRCODE='23514';
  END IF;
  IF NEW.cleanup_attempt_count < OLD.cleanup_attempt_count THEN
    RAISE EXCEPTION 'object cleanup attempt count cannot decrease'
      USING ERRCODE='23514';
  END IF;
  IF OLD.verification_state='VERIFIED' AND NEW.verification_state <> 'VERIFIED' THEN
    RAISE EXCEPTION 'verified object write item cannot regress'
      USING ERRCODE='23514';
  END IF;
  IF OLD.verification_state='VERIFIED'
     AND ROW(NEW.observed_sha256,NEW.observed_byte_length,NEW.observed_version_id,NEW.verified_at,
             NEW.object_lock_mode,NEW.object_lock_retain_until)
         IS DISTINCT FROM
         ROW(OLD.observed_sha256,OLD.observed_byte_length,OLD.observed_version_id,OLD.verified_at,
             OLD.object_lock_mode,OLD.object_lock_retain_until) THEN
    RAISE EXCEPTION 'verified object observations are immutable'
      USING ERRCODE='23514';
  END IF;
  IF NEW.verification_state='VERIFIED' AND OLD.verification_state <> 'VERIFIED' THEN
    NEW.verified_at := now();
  ELSIF NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
    RAISE EXCEPTION 'object verification timestamp is trigger-owned'
      USING ERRCODE='23514';
  END IF;
  IF OLD.write_disposition <> 'PENDING'
     AND NEW.write_disposition IS DISTINCT FROM OLD.write_disposition THEN
    RAISE EXCEPTION 'object write disposition is immutable once observed'
      USING ERRCODE='23514';
  END IF;
  IF NEW.verification_state='VERIFIED' AND NEW.write_disposition='PENDING' THEN
    RAISE EXCEPTION 'verified object write item requires an observed write disposition'
      USING ERRCODE='23514';
  END IF;
  IF OLD.verification_state='QUARANTINED'
     AND NEW.verification_state='PENDING'
     AND parent_state <> 'RECONCILIATION_REQUIRED' THEN
    RAISE EXCEPTION 'quarantined object requires reconciliation authority'
      USING ERRCODE='23514';
  END IF;
  IF OLD.cleanup_state='CLEANED' AND NEW.cleanup_state <> 'CLEANED' THEN
    RAISE EXCEPTION 'cleaned object write item cannot regress'
      USING ERRCODE='23514';
  END IF;
  IF NEW.cleanup_state IS DISTINCT FROM OLD.cleanup_state
     AND NOT (
       (OLD.cleanup_state='NONE' AND NEW.cleanup_state='PENDING')
       OR (OLD.cleanup_state='PENDING' AND NEW.cleanup_state='CLEANED')
     ) THEN
    RAISE EXCEPTION 'illegal object cleanup transition % -> %', OLD.cleanup_state, NEW.cleanup_state
      USING ERRCODE='23514';
  END IF;
  IF NEW.cleanup_state='PENDING'
     AND (
       parent_state <> 'ABANDONED'
       OR NEW.store <> 'R2'
       OR NEW.write_disposition <> 'CREATED'
       OR NEW.delete_after IS NULL
     ) THEN
    RAISE EXCEPTION 'only R2 objects proven created by an abandoned operation may enter cleanup'
      USING ERRCODE='23514';
  END IF;
  IF NEW.cleanup_state='CLEANED' THEN
    IF parent_state <> 'ABANDONED' OR NEW.store <> 'R2' OR NEW.write_disposition <> 'CREATED' THEN
      RAISE EXCEPTION 'only R2 objects proven created by an abandoned operation may be cleaned'
        USING ERRCODE='23514';
    END IF;
    NEW.cleaned_at := now();
  ELSIF NEW.cleaned_at IS DISTINCT FROM OLD.cleaned_at THEN
    RAISE EXCEPTION 'object cleanup timestamp is trigger-owned'
      USING ERRCODE='23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$fn$;

REVOKE ALL ON FUNCTION public.object_write_operation_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.object_write_item_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_object_write_operation_guard ON public.object_write_operations;
CREATE TRIGGER trg_object_write_operation_guard
  BEFORE INSERT OR UPDATE ON public.object_write_operations
  FOR EACH ROW EXECUTE FUNCTION public.object_write_operation_guard();
ALTER TABLE public.object_write_operations
  ENABLE ALWAYS TRIGGER trg_object_write_operation_guard;

DROP TRIGGER IF EXISTS trg_object_write_item_guard ON public.object_write_items;
CREATE TRIGGER trg_object_write_item_guard
  BEFORE INSERT OR UPDATE ON public.object_write_items
  FOR EACH ROW EXECUTE FUNCTION public.object_write_item_guard();
ALTER TABLE public.object_write_items
  ENABLE ALWAYS TRIGGER trg_object_write_item_guard;

ALTER TABLE public.object_write_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.object_write_operations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.object_write_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.object_write_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS object_write_operations_main ON public.object_write_operations;
CREATE POLICY object_write_operations_main
  ON public.object_write_operations TO mintvault_app
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS object_write_operations_partner ON public.object_write_operations;
CREATE POLICY object_write_operations_partner
  ON public.object_write_operations TO partner_runtime
  USING (tenant_id=public.partner_current_tenant())
  WITH CHECK (tenant_id=public.partner_current_tenant());

DROP POLICY IF EXISTS object_write_items_main ON public.object_write_items;
CREATE POLICY object_write_items_main
  ON public.object_write_items TO mintvault_app
  USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS object_write_items_partner ON public.object_write_items;
CREATE POLICY object_write_items_partner
  ON public.object_write_items TO partner_runtime
  USING (EXISTS (
    SELECT 1 FROM public.object_write_operations operation
     WHERE operation.id=object_write_items.operation_id
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.object_write_operations operation
     WHERE operation.id=object_write_items.operation_id
  ));

REVOKE ALL ON public.object_write_operations, public.object_write_items FROM PUBLIC;
REVOKE ALL ON public.object_write_operations, public.object_write_items FROM mintvault_app, partner_runtime;
GRANT SELECT, INSERT, UPDATE
  ON public.object_write_operations, public.object_write_items
  TO mintvault_app, partner_runtime;

COMMENT ON TABLE public.object_write_operations IS
  'Durable immutable intent and state machine for object-store writes whose PostgreSQL publication is reconciled.';
COMMENT ON TABLE public.object_write_items IS
  'Immutable expected object manifest plus observed verification and safe abandoned-R2 cleanup state.';
