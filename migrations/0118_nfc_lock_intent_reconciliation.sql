-- 0118 — durable NFC physical-lock intent and reconciliation
--
-- Web NFC cannot atomically commit a physical makeReadOnly operation with the
-- database.  Freeze the exact binding before touching the chip, then require a
-- token-bound confirmation (or an explicitly audited operator recovery).  A
-- lost/ambiguous client remains visibly pending and cannot be rebound/cleared.

DO $guard$
BEGIN
  IF to_regclass('public.certificates') IS NULL THEN
    RAISE EXCEPTION '0118 requires public.certificates';
  END IF;
END
$guard$;

ALTER TABLE public.certificates
  ADD COLUMN IF NOT EXISTS nfc_lock_pending_token_hash text,
  ADD COLUMN IF NOT EXISTS nfc_lock_pending_uid text,
  ADD COLUMN IF NOT EXISTS nfc_lock_pending_method text,
  ADD COLUMN IF NOT EXISTS nfc_lock_pending_at timestamptz,
  ADD COLUMN IF NOT EXISTS nfc_lock_pending_by text;

DO $columns$
DECLARE
  incompatible_columns text;
BEGIN
  SELECT string_agg(required.name || ':' || COALESCE(format_type(a.atttypid, a.atttypmod), '<missing>'), ', ')
    INTO incompatible_columns
    FROM (VALUES
      ('nfc_lock_pending_token_hash','text'),
      ('nfc_lock_pending_uid','text'),
      ('nfc_lock_pending_method','text'),
      ('nfc_lock_pending_at','timestamp with time zone'),
      ('nfc_lock_pending_by','text')
    ) AS required(name, expected_type)
    LEFT JOIN pg_attribute a
      ON a.attrelid = 'public.certificates'::regclass
     AND a.attname = required.name AND a.attnum > 0 AND NOT a.attisdropped
   WHERE format_type(a.atttypid, a.atttypmod) IS DISTINCT FROM required.expected_type;
  IF incompatible_columns IS NOT NULL THEN
    RAISE EXCEPTION '0118: incompatible NFC lock-intent columns: %', incompatible_columns;
  END IF;
END
$columns$;

DO $constraint$
DECLARE
  definition text;
  validated boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.certificates'::regclass
      AND c.conname = 'chk_certificates_nfc_lock_pending_complete'
  ) THEN
    ALTER TABLE public.certificates
      ADD CONSTRAINT chk_certificates_nfc_lock_pending_complete CHECK (
        (
          nfc_lock_pending_token_hash IS NULL
          AND nfc_lock_pending_uid IS NULL
          AND nfc_lock_pending_method IS NULL
          AND nfc_lock_pending_at IS NULL
          AND nfc_lock_pending_by IS NULL
        ) OR (
          nfc_lock_pending_token_hash ~ '^[0-9a-f]{64}$'
          AND nfc_lock_pending_uid IS NOT NULL AND btrim(nfc_lock_pending_uid) <> ''
          AND nfc_lock_pending_method = 'web_nfc_make_read_only'
          AND nfc_lock_pending_at IS NOT NULL
          AND nfc_lock_pending_by IS NOT NULL AND btrim(nfc_lock_pending_by) <> ''
          AND nfc_locked IS DISTINCT FROM TRUE
          AND nfc_locked_at IS NULL
          AND lower(btrim(nfc_lock_pending_uid)) = lower(btrim(nfc_uid))
        )
      );
  END IF;

  SELECT pg_get_constraintdef(c.oid), c.convalidated
    INTO definition, validated
    FROM pg_constraint c
   WHERE c.conrelid = 'public.certificates'::regclass
     AND c.conname = 'chk_certificates_nfc_lock_pending_complete'
     AND c.contype = 'c';
  IF definition IS NULL OR validated IS DISTINCT FROM TRUE
     OR position('nfc_lock_pending_token_hash' IN definition) = 0
     OR position('web_nfc_make_read_only' IN definition) = 0
     OR position('nfc_locked_at IS NULL' IN definition) = 0
     OR position('lower(btrim(nfc_lock_pending_uid))' IN definition) = 0 THEN
    RAISE EXCEPTION '0118: incompatible chk_certificates_nfc_lock_pending_complete constraint';
  END IF;
END
$constraint$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_certificates_nfc_lock_pending_token_hash
  ON public.certificates (nfc_lock_pending_token_hash)
  WHERE nfc_lock_pending_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_certificates_nfc_lock_pending_at
  ON public.certificates (nfc_lock_pending_at)
  WHERE nfc_lock_pending_token_hash IS NOT NULL;

DO $indexes$
DECLARE
  token_definition text;
  due_definition text;
  token_unique boolean;
  token_valid boolean;
  due_valid boolean;
BEGIN
  SELECT pg_get_indexdef(i.indexrelid), i.indisunique, i.indisvalid AND i.indisready
    INTO token_definition, token_unique, token_valid
    FROM pg_index i
   WHERE i.indexrelid = 'public.uq_certificates_nfc_lock_pending_token_hash'::regclass
     AND i.indrelid = 'public.certificates'::regclass
     AND i.indnkeyatts = 1 AND i.indnatts = 1 AND i.indexprs IS NULL;
  SELECT pg_get_indexdef(i.indexrelid), i.indisvalid AND i.indisready
    INTO due_definition, due_valid
    FROM pg_index i
   WHERE i.indexrelid = 'public.ix_certificates_nfc_lock_pending_at'::regclass
     AND i.indrelid = 'public.certificates'::regclass
     AND i.indnkeyatts = 1 AND i.indnatts = 1 AND i.indexprs IS NULL;
  IF token_unique IS DISTINCT FROM TRUE OR token_valid IS DISTINCT FROM TRUE
     OR pg_get_indexdef('public.uq_certificates_nfc_lock_pending_token_hash'::regclass, 1, true)
          <> 'nfc_lock_pending_token_hash'
     OR position('WHERE (nfc_lock_pending_token_hash IS NOT NULL)' IN token_definition) = 0
     OR due_valid IS DISTINCT FROM TRUE
     OR pg_get_indexdef('public.ix_certificates_nfc_lock_pending_at'::regclass, 1, true)
          <> 'nfc_lock_pending_at'
     OR position('WHERE (nfc_lock_pending_token_hash IS NOT NULL)' IN due_definition) = 0 THEN
    RAISE EXCEPTION '0118: incompatible NFC lock-intent index definition';
  END IF;
END
$indexes$;

CREATE OR REPLACE FUNCTION public.nfc_lock_intent_guards_binding() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  cancel_hash text := current_setting('mintvault.nfc_lock_cancel_token_hash', true);
  confirm_hash text := current_setting('mintvault.nfc_lock_confirm_token_hash', true);
  recovery_authorised boolean := current_setting('mintvault.nfc_lock_operator_recovery', true) = 'true';
  binding_changed boolean;
  pending_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.nfc_locked IS TRUE OR NEW.nfc_lock_pending_token_hash IS NOT NULL THEN
      RAISE EXCEPTION 'an NFC physical lock requires a prior durable intent'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  binding_changed :=
       NEW.nfc_uid        IS DISTINCT FROM OLD.nfc_uid
    OR NEW.nfc_enabled    IS DISTINCT FROM OLD.nfc_enabled
    OR NEW.nfc_chip_type  IS DISTINCT FROM OLD.nfc_chip_type
    OR NEW.nfc_url        IS DISTINCT FROM OLD.nfc_url
    OR NEW.nfc_written_at IS DISTINCT FROM OLD.nfc_written_at
    OR NEW.nfc_written_by IS DISTINCT FROM OLD.nfc_written_by;
  pending_changed :=
       NEW.nfc_lock_pending_token_hash IS DISTINCT FROM OLD.nfc_lock_pending_token_hash
    OR NEW.nfc_lock_pending_uid        IS DISTINCT FROM OLD.nfc_lock_pending_uid
    OR NEW.nfc_lock_pending_method     IS DISTINCT FROM OLD.nfc_lock_pending_method
    OR NEW.nfc_lock_pending_at         IS DISTINCT FROM OLD.nfc_lock_pending_at
    OR NEW.nfc_lock_pending_by         IS DISTINCT FROM OLD.nfc_lock_pending_by;

  IF OLD.nfc_lock_pending_token_hash IS NULL THEN
    -- Direct false->true transitions are no longer truthful: the binding must
    -- first have been frozen before the irreversible device operation.
    IF OLD.nfc_locked IS DISTINCT FROM TRUE AND NEW.nfc_locked IS TRUE THEN
      RAISE EXCEPTION 'an NFC physical lock requires a prior durable intent'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.nfc_lock_pending_token_hash IS NOT NULL AND (
         binding_changed
      OR NEW.nfc_locked IS TRUE
      OR NEW.nfc_locked_at IS DISTINCT FROM OLD.nfc_locked_at
      OR NEW.nfc_uid IS NULL OR btrim(NEW.nfc_uid) = ''
      OR NEW.nfc_enabled IS DISTINCT FROM TRUE
      OR NEW.nfc_url IS NULL OR btrim(NEW.nfc_url) = ''
      OR NEW.nfc_written_at IS NULL
    ) THEN
      RAISE EXCEPTION 'an NFC lock intent requires an unchanged complete binding'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- While intent is pending, ordinary scan/verification telemetry is allowed,
  -- but the physical binding and the intent snapshot are frozen.
  IF NEW.nfc_locked IS DISTINCT FROM TRUE THEN
    IF NOT pending_changed AND NOT binding_changed
       AND NEW.nfc_locked IS NOT DISTINCT FROM OLD.nfc_locked
       AND NEW.nfc_locked_at IS NOT DISTINCT FROM OLD.nfc_locked_at THEN
      RETURN NEW;
    END IF;

    -- Cancellation is token-bound and may only clear the intent.  The caller
    -- must separately write the audited reason in the same transaction.
    IF NEW.nfc_lock_pending_token_hash IS NULL
       AND NOT binding_changed
       AND NEW.nfc_locked IS DISTINCT FROM TRUE
       AND NEW.nfc_locked IS NOT DISTINCT FROM OLD.nfc_locked
       AND NEW.nfc_locked_at IS NOT DISTINCT FROM OLD.nfc_locked_at
       AND cancel_hash = OLD.nfc_lock_pending_token_hash THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'an NFC binding with a pending physical-lock intent is frozen'
      USING ERRCODE = '23514';
  END IF;

  -- Finalization consumes the complete intent snapshot.  A normal completion
  -- proves possession of the raw token (only its SHA-256 hash is stored); an
  -- operator recovery is deliberately separate and audit-required by storage.
  IF OLD.nfc_locked IS TRUE OR binding_changed OR NEW.nfc_locked_at IS NULL
     OR NEW.nfc_lock_pending_token_hash IS NOT NULL
     OR NEW.nfc_lock_pending_uid IS NOT NULL
     OR NEW.nfc_lock_pending_method IS NOT NULL
     OR NEW.nfc_lock_pending_at IS NOT NULL
     OR NEW.nfc_lock_pending_by IS NOT NULL
     OR NOT (confirm_hash = OLD.nfc_lock_pending_token_hash OR recovery_authorised) THEN
    RAISE EXCEPTION 'invalid NFC lock-intent finalization'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$fn$;

DO $trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    WHERE t.tgrelid = 'public.certificates'::regclass
      AND t.tgname = 'trg_nfc_lock_intent_guards_binding'
      AND NOT t.tgisinternal
  ) THEN
    CREATE TRIGGER trg_nfc_lock_intent_guards_binding
      BEFORE INSERT OR UPDATE ON public.certificates
      FOR EACH ROW EXECUTE FUNCTION public.nfc_lock_intent_guards_binding();
  END IF;
END
$trigger$;
ALTER TABLE public.certificates ENABLE ALWAYS TRIGGER trg_nfc_lock_intent_guards_binding;

DO $trigger_shape$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_proc p ON p.oid = t.tgfoid
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE t.tgrelid = 'public.certificates'::regclass
      AND t.tgname = 'trg_nfc_lock_intent_guards_binding'
      AND NOT t.tgisinternal
      AND t.tgenabled = 'A'
      AND p.proname = 'nfc_lock_intent_guards_binding'
      AND n.nspname = 'public'
      AND pg_get_triggerdef(t.oid) LIKE '%BEFORE INSERT OR UPDATE ON public.certificates%'
  ) THEN
    RAISE EXCEPTION '0118: incompatible NFC lock-intent trigger definition';
  END IF;
END
$trigger_shape$;

COMMENT ON TRIGGER trg_nfc_lock_intent_guards_binding ON public.certificates IS
  'Freezes an NFC binding from durable intent through token-bound confirmation or audited recovery.';
