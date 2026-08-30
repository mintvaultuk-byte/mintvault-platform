-- 0119 — canonical connect-pg-simple session store
--
-- The application deliberately configures createTableIfMissing=false. Session
-- schema is therefore migration authority, never a runtime boot side effect.
-- Existing production installs already carry this table out-of-band; this
-- migration preserves compatible rows and fails if an incompatible namesake
-- would otherwise make readiness false-green.
--
-- ROLLBACK / CONTAINMENT: application rollback is non-destructive; the table
-- remains compatible with connect-pg-simple. Dropping it logs out every user and
-- is an owner-approved destructive operation, not an automated rollback.

CREATE TABLE IF NOT EXISTS public.session (
  sid varchar NOT NULL,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL,
  CONSTRAINT session_pkey PRIMARY KEY (sid)
);

DO $shape$
DECLARE
  total_columns integer;
  valid_columns integer;
  sid_attribute smallint;
BEGIN
  SELECT COUNT(*)::integer
    INTO total_columns
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'session';
  SELECT COUNT(*)::integer
    INTO valid_columns
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'session'
     AND is_nullable = 'NO'
     AND (
       (column_name = 'sid' AND data_type = 'character varying')
       OR (column_name = 'sess' AND data_type = 'json')
       OR (column_name = 'expire' AND data_type = 'timestamp without time zone' AND datetime_precision = 6)
     );
  IF total_columns <> 3 OR valid_columns <> 3 THEN
    RAISE EXCEPTION '0119 found an incompatible public.session column contract';
  END IF;

  SELECT attnum
    INTO sid_attribute
    FROM pg_attribute
   WHERE attrelid = 'public.session'::regclass
     AND attname = 'sid'
     AND NOT attisdropped;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.session'::regclass
       AND contype = 'p'
       AND conkey = ARRAY[sid_attribute]::smallint[]
  ) THEN
    RAISE EXCEPTION '0119 requires public.session primary key (sid)';
  END IF;
END
$shape$;

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON public.session (expire);

DO $index_shape$
DECLARE
  expire_attribute smallint;
BEGIN
  SELECT attnum
    INTO expire_attribute
    FROM pg_attribute
   WHERE attrelid = 'public.session'::regclass
     AND attname = 'expire'
     AND NOT attisdropped;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
     WHERE i.indrelid = 'public.session'::regclass
       AND idx.relname = 'IDX_session_expire'
       AND i.indisvalid
       AND i.indisready
       AND i.indpred IS NULL
       AND i.indexprs IS NULL
       AND i.indnatts = 1
       AND i.indnkeyatts = 1
       AND expire_attribute = ANY(i.indkey)
  ) THEN
    RAISE EXCEPTION '0119 found an incompatible IDX_session_expire';
  END IF;
END
$index_shape$;

REVOKE ALL ON TABLE public.session FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mintvault_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.session TO mintvault_app;
  END IF;
END
$grants$;

COMMENT ON TABLE public.session IS
  'Canonical connect-pg-simple session store. Schema authority: migration 0119; runtime auto-create is disabled.';
