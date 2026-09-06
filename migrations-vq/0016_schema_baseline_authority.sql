-- VQ control evidence and exact runtime authority. Historical SQL remains immutable.
-- This file records no historical execution: the receipt is populated only by the
-- explicit, verified historical-baseline operation. Fresh execution leaves it empty.
DO $prerequisite$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mintvault_app') THEN
    RAISE EXCEPTION 'VQ0016 requires main runtime role authority first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mintvault_app' AND
      (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR rolinherit))
     OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname='mintvault_app'))
     OR EXISTS (SELECT 1 FROM pg_class WHERE relowner=(SELECT oid FROM pg_roles WHERE rolname='mintvault_app'))
     OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner=(SELECT oid FROM pg_roles WHERE rolname='mintvault_app'))
     OR EXISTS (SELECT 1 FROM pg_database WHERE datdba=(SELECT oid FROM pg_roles WHERE rolname='mintvault_app'))
     OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner=(SELECT oid FROM pg_roles WHERE rolname='mintvault_app')) THEN
    RAISE EXCEPTION 'VQ0016 requires the restricted non-owning main runtime role';
  END IF;
  IF to_regclass('drizzle.vq_schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'VQ0016 requires the canonical VQ execution journal';
  END IF;
END
$prerequisite$;

CREATE TABLE drizzle.vq_schema_baselines (
  baseline_id text PRIMARY KEY CHECK (baseline_id = 'vq-0000-0015-v1'),
  evidence_kind text NOT NULL CHECK (evidence_kind = 'observed_schema-v1'),
  source_sha256 text NOT NULL CHECK (source_sha256 = 'd92f083e1f119dc89724e08e6b36143256be627ba533be414146414c963aa90a'),
  schema_sha256 text NOT NULL CHECK (schema_sha256 = '9aeaa1c206ffd26372274b4e223a609b801e459e89282a77a41a2d6d8b82cf52'),
  observed_at timestamptz NOT NULL DEFAULT now(),
  observed_by text NOT NULL DEFAULT current_user
);

REVOKE CREATE ON SCHEMA drizzle FROM PUBLIC, mintvault_app;
GRANT USAGE ON SCHEMA drizzle TO mintvault_app;
REVOKE ALL PRIVILEGES ON TABLE drizzle.vq_schema_migrations, drizzle.vq_schema_baselines FROM PUBLIC, mintvault_app;
GRANT SELECT ON TABLE drizzle.vq_schema_migrations, drizzle.vq_schema_baselines TO mintvault_app;
REVOKE ALL PRIVILEGES ON SEQUENCE drizzle.vq_schema_migrations_id_seq FROM PUBLIC, mintvault_app;

DO $authority$
DECLARE
  append_only constant text[] := ARRAY[
    'vq_artwork_revision_events', 'vq_card_revisions', 'vq_character_revisions'
  ];
  mutable constant text[] := ARRAY[
    'vq_ai_generations', 'vq_artwork_candidates', 'vq_artwork_revisions',
    'vq_asset_library', 'vq_cards', 'vq_characters', 'vq_config', 'vq_elements',
    'vq_export_jobs', 'vq_families', 'vq_family_rules', 'vq_feature_flags',
    'vq_game_config', 'vq_generation_requests', 'vq_pack_config', 'vq_packaging_items',
    'vq_print_exports', 'vq_production_stages', 'vq_qa_checks', 'vq_release_state',
    'vq_releases', 'vq_set_settings', 'vq_sets'
  ];
  relation_name text;
  sequence_name text;
  columns_list text;
BEGIN
  FOREACH relation_name IN ARRAY append_only || mutable LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NULL THEN
      RAISE EXCEPTION 'VQ0016 missing required business relation: %', relation_name;
    END IF;
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, mintvault_app', relation_name);
    SELECT string_agg(format('%I',a.attname), ',') INTO columns_list FROM pg_attribute a
      WHERE a.attrelid=to_regclass(format('public.%I',relation_name)) AND a.attnum>0 AND NOT a.attisdropped;
    EXECUTE format('REVOKE ALL PRIVILEGES (%s) ON TABLE public.%I FROM PUBLIC, mintvault_app', columns_list, relation_name);
    EXECUTE format('GRANT SELECT, INSERT ON TABLE public.%I TO mintvault_app', relation_name);
    IF relation_name = ANY(mutable) THEN
      EXECUTE format('GRANT UPDATE ON TABLE public.%I TO mintvault_app', relation_name);
    END IF;
  END LOOP;
  FOR sequence_name IN
    SELECT DISTINCT seq.relname
      FROM pg_class seq JOIN pg_namespace sn ON sn.oid=seq.relnamespace
      JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=seq.oid
        AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')
      JOIN pg_class owner_table ON owner_table.oid=d.refobjid
      JOIN pg_namespace tn ON tn.oid=owner_table.relnamespace
     WHERE sn.nspname='public' AND tn.nspname='public' AND seq.relkind='S'
       AND owner_table.relname=ANY(append_only || mutable)
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM PUBLIC, mintvault_app', sequence_name);
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO mintvault_app', sequence_name);
  END LOOP;
END
$authority$;
