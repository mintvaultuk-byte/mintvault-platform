-- 0116 — NFC physical-lock integrity
--
-- `nfc_locked=true` is a claim about irreversible physical state. Once made,
-- the binding fields must not be cleared, overwritten, or reset by any runtime
-- path. The application may continue recording scans and verification times.

DO $guard$
BEGIN
  IF to_regclass('public.certificates') IS NULL THEN
    RAISE EXCEPTION '0116 requires public.certificates';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM unnest(ARRAY[
        'nfc_uid', 'nfc_enabled', 'nfc_chip_type', 'nfc_url', 'nfc_locked',
        'nfc_written_at', 'nfc_written_by', 'nfc_locked_at'
      ]) AS required(column_name)
     WHERE NOT EXISTS (
       SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema='public'
          AND c.table_name='certificates'
          AND c.column_name=required.column_name
     )
  ) THEN
    RAISE EXCEPTION '0116 requires the complete certificates NFC binding schema';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.nfc_locked_binding_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  lock_transition boolean := (TG_OP = 'INSERT');
BEGIN
  IF TG_OP = 'UPDATE' THEN
    lock_transition := OLD.nfc_locked IS DISTINCT FROM TRUE;
  END IF;

  -- A lock claim is only coherent for a fully written and identified tag.
  IF NEW.nfc_locked IS TRUE AND lock_transition THEN
    IF NEW.nfc_uid IS NULL OR btrim(NEW.nfc_uid) = ''
       OR NEW.nfc_enabled IS DISTINCT FROM TRUE
       OR NEW.nfc_url IS NULL OR btrim(NEW.nfc_url) = ''
       OR NEW.nfc_written_at IS NULL
       OR NEW.nfc_locked_at IS NULL THEN
      RAISE EXCEPTION 'an NFC lock claim requires a complete written tag binding'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- A physical read-only tag cannot be reprogrammed. Preserve the complete
  -- binding snapshot while still allowing scan counters/verification telemetry.
  IF TG_OP = 'UPDATE' AND OLD.nfc_locked IS TRUE AND (
       NEW.nfc_uid        IS DISTINCT FROM OLD.nfc_uid
    OR NEW.nfc_enabled    IS DISTINCT FROM OLD.nfc_enabled
    OR NEW.nfc_chip_type  IS DISTINCT FROM OLD.nfc_chip_type
    OR NEW.nfc_url        IS DISTINCT FROM OLD.nfc_url
    OR NEW.nfc_locked     IS DISTINCT FROM OLD.nfc_locked
    OR NEW.nfc_written_at IS DISTINCT FROM OLD.nfc_written_at
    OR NEW.nfc_written_by IS DISTINCT FROM OLD.nfc_written_by
    OR NEW.nfc_locked_at  IS DISTINCT FROM OLD.nfc_locked_at
  ) THEN
    RAISE EXCEPTION 'a physically locked NFC binding is permanent and cannot be changed'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_nfc_locked_binding_immutable ON public.certificates;
CREATE TRIGGER trg_nfc_locked_binding_immutable
  BEFORE INSERT OR UPDATE ON public.certificates
  FOR EACH ROW EXECUTE FUNCTION public.nfc_locked_binding_is_immutable();
ALTER TABLE public.certificates ENABLE ALWAYS TRIGGER trg_nfc_locked_binding_immutable;

COMMENT ON TRIGGER trg_nfc_locked_binding_immutable ON public.certificates IS
  'A true physical-lock claim requires a complete written tag and makes its NFC binding permanent.';
