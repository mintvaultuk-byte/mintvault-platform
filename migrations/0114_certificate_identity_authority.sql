-- 0114 — Certificate identity and allocator authority
--
-- Certificate numbers are permanent physical-card identities. They must never be
-- rewritten by application boot code, and the global allocator must never move
-- backwards, lose its singleton row, or be truncated. This migration establishes
-- those invariants in PostgreSQL, where every application writer is subject to them.
--
-- Existing certificate_number values are deliberately preserved byte-for-byte.
-- Both historical padded values (MV-0000000042) and current values (MV42) remain
-- valid identities. Presentation normalisation belongs at read boundaries; it is
-- not permission to mutate an issued identity.

DO $guard$
BEGIN
  IF to_regclass('public.certificates') IS NULL THEN
    RAISE EXCEPTION '0114 requires public.certificates; apply the core schema first';
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS public.cert_counter (
  id          integer PRIMARY KEY DEFAULT 1,
  last_issued bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Converge the historical boot-created shape without replacing the table or row.
ALTER TABLE public.cert_counter ADD COLUMN IF NOT EXISTS last_issued bigint;
ALTER TABLE public.cert_counter ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE public.cert_counter ALTER COLUMN last_issued TYPE bigint USING last_issued::bigint;
UPDATE public.cert_counter SET last_issued = 0 WHERE last_issued IS NULL;
UPDATE public.cert_counter SET updated_at = now() WHERE updated_at IS NULL;
ALTER TABLE public.cert_counter ALTER COLUMN last_issued SET DEFAULT 0;
ALTER TABLE public.cert_counter ALTER COLUMN last_issued SET NOT NULL;
ALTER TABLE public.cert_counter ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE public.cert_counter ALTER COLUMN updated_at SET NOT NULL;

-- Refuse to guess if an unexpected allocator row exists. Silently deleting it
-- would conceal lineage corruption and could permit a duplicate physical number.
DO $singleton_guard$
BEGIN
  IF EXISTS (SELECT 1 FROM public.cert_counter WHERE id <> 1) THEN
    RAISE EXCEPTION '0114 found non-singleton cert_counter rows; manual reconciliation is required';
  END IF;
END
$singleton_guard$;

-- A database that had certificates but relied on boot DDL may have no counter row.
-- Seed (or advance) the counter above the greatest issued numeric MV identity so
-- the next allocation cannot collide. No certificate identity is rewritten.
INSERT INTO public.cert_counter (id, last_issued, updated_at)
SELECT 1,
       COALESCE(MAX(
         CASE
           WHEN certificate_number ~* '^MV-?[0-9]+$'
             THEN regexp_replace(certificate_number, '^MV-?', '', 'i')::bigint
           ELSE NULL
         END
       ), 0),
       now()
  FROM public.certificates
ON CONFLICT (id) DO UPDATE
      SET last_issued = GREATEST(public.cert_counter.last_issued, EXCLUDED.last_issued),
          updated_at = CASE
            WHEN EXCLUDED.last_issued > public.cert_counter.last_issued THEN now()
            ELSE public.cert_counter.updated_at
          END;

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.cert_counter'::regclass
       AND conname = 'cert_counter_singleton_id'
  ) THEN
    ALTER TABLE public.cert_counter
      ADD CONSTRAINT cert_counter_singleton_id CHECK (id = 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.cert_counter'::regclass
       AND conname = 'cert_counter_nonnegative'
  ) THEN
    ALTER TABLE public.cert_counter
      ADD CONSTRAINT cert_counter_nonnegative CHECK (last_issued >= 0);
  END IF;
END
$constraints$;

CREATE OR REPLACE FUNCTION public.cert_counter_identity_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cert_counter singleton row cannot be deleted' USING ERRCODE = '23514';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'cert_counter singleton id cannot be changed' USING ERRCODE = '23514';
  END IF;

  IF NEW.last_issued < OLD.last_issued THEN
    RAISE EXCEPTION 'cert_counter cannot move backwards (% -> %)', OLD.last_issued, NEW.last_issued
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_cert_counter_identity_guard ON public.cert_counter;
CREATE TRIGGER trg_cert_counter_identity_guard
  BEFORE UPDATE OR DELETE ON public.cert_counter
  FOR EACH ROW EXECUTE FUNCTION public.cert_counter_identity_guard();
ALTER TABLE public.cert_counter ENABLE ALWAYS TRIGGER trg_cert_counter_identity_guard;

CREATE OR REPLACE FUNCTION public.cert_counter_refuse_truncate() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'cert_counter cannot be truncated' USING ERRCODE = '23514';
END
$fn$;

DROP TRIGGER IF EXISTS trg_cert_counter_refuse_truncate ON public.cert_counter;
CREATE TRIGGER trg_cert_counter_refuse_truncate
  BEFORE TRUNCATE ON public.cert_counter
  FOR EACH STATEMENT EXECUTE FUNCTION public.cert_counter_refuse_truncate();
ALTER TABLE public.cert_counter ENABLE ALWAYS TRIGGER trg_cert_counter_refuse_truncate;

CREATE OR REPLACE FUNCTION public.certificate_number_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.certificate_number IS DISTINCT FROM OLD.certificate_number THEN
    RAISE EXCEPTION 'certificate number % is a permanent identity and cannot be changed', OLD.certificate_number
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_certificate_number_immutable ON public.certificates;
CREATE TRIGGER trg_certificate_number_immutable
  BEFORE UPDATE OF certificate_number ON public.certificates
  FOR EACH ROW EXECUTE FUNCTION public.certificate_number_is_immutable();
ALTER TABLE public.certificates ENABLE ALWAYS TRIGGER trg_certificate_number_immutable;

COMMENT ON TABLE public.cert_counter IS
  'Singleton, monotonic allocator for permanent MintVault certificate identities. Managed by numbered migrations only.';
COMMENT ON TRIGGER trg_certificate_number_immutable ON public.certificates IS
  'Issued certificate_number values are permanent physical-card identities and cannot be rewritten.';
