-- 0121 — Main MintVault runtime role authority
--
-- The web process must not connect as the database owner or as any role capable
-- of bypassing database controls.  This migration owns one NOLOGIN group role,
-- an explicit relation/operation allowlist, and the public pre-auth rate-limit
-- relation.  Infrastructure owns the LOGIN and grants it membership in
-- mintvault_app; readiness verifies the connected LOGIN rather than trusting
-- its name.

CREATE TABLE IF NOT EXISTS public.public_rate_limit_buckets (
  bucket_key text PRIMARY KEY,
  hit_count integer NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
  reset_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_public_rate_limit_buckets_reset_at
  ON public.public_rate_limit_buckets (reset_at);

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mintvault_app') THEN
    CREATE ROLE mintvault_app;
  END IF;

  ALTER ROLE mintvault_app
    NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
    NOREPLICATION NOINHERIT;

  IF EXISTS (
    SELECT 1
      FROM pg_auth_members membership
      JOIN pg_roles parent_role ON parent_role.oid = membership.roleid
     WHERE membership.member = (SELECT oid FROM pg_roles WHERE rolname = 'mintvault_app')
  ) THEN
    RAISE EXCEPTION '0121: mintvault_app must not inherit any other database role';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_database WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = 'mintvault_app'))
     OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = (SELECT oid FROM pg_roles WHERE rolname = 'mintvault_app'))
     OR EXISTS (SELECT 1 FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = 'mintvault_app'))
     OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner = (SELECT oid FROM pg_roles WHERE rolname = 'mintvault_app')) THEN
    RAISE EXCEPTION '0121: mintvault_app must not own a database, schema, relation, sequence, or function';
  END IF;
END
$role$;

-- PostgreSQL grants table DML to nobody by default, but historic/manual ACLs
-- are part of the estate this migration converges.  Revoke first, then rebuild
-- only the operation classes below.  PUBLIC never needs relation or sequence
-- authority in an application database.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM mintvault_app;
GRANT USAGE ON SCHEMA public TO mintvault_app;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM mintvault_app;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM mintvault_app;

DO $authority$
DECLARE
  -- Read-only migration metadata and projections.  Views deliberately receive
  -- SELECT only; their base relations remain governed by their own class.
  read_only_relations constant text[] := ARRAY[
    'population_report',
    'public_slab_image_projection',
    'reholder_credits',
    'schema_migrations'
  ];

  -- Audit/history rows that application code appends but never rewrites.
  append_only_tables constant text[] := ARRAY[
    'ai_accuracy_log',
    'ai_override_audit',
    'audit_log',
    'growth_conversion_events',
    'login_attempts',
    'ownership_history',
    'pc_evidence_snapshots',
    'pc_status_events',
    'print_events',
    'review_delivery_attempts',
    'stripe_webhook_events',
    'vault_club_events',
    'vq_artwork_revision_events',
    'vq_card_revisions',
    'vq_character_revisions'
  ];

  -- Normal business state may be created and advanced, but physical/customer
  -- history cannot be hard-deleted by the web credential.
  mutable_tables constant text[] := ARRAY[
    'ai_grade_corrections',
    'ai_predictions',
    'card_identification_corrections',
    'card_identification_requests',
    'card_images',
    'card_master',
    'card_sets',
    'cards',
    'catalogue_items',
    'cert_counter',
    'certificate_image_crops',
    'certificate_image_evidence',
    'certificate_image_masters',
    'certificate_image_workings',
    'certificate_images',
    'certificates',
    'community_posts',
    'contact_inquiries',
    'customer_notification_outbox',
    'custom_variants',
    'ebay_price_cache',
    'estimate_credit_reservations',
    'estimate_credits',
    'estimate_free_uses',
    'grading_payment_fulfilments',
    'grading_records',
    'grading_sessions',
    'growth_commercial_targets',
    'ig_post_queue',
    'ig_settings',
    'label_prints',
    'marketplace_conversations',
    'marketplace_dac7_quarterly',
    'marketplace_disputes',
    'marketplace_listing_images',
    'marketplace_listings',
    'marketplace_messages',
    'marketplace_offers',
    'marketplace_order_events',
    'marketplace_orders',
    'marketplace_reviews',
    'marketplace_shipments',
    'marketplace_watchlist',
    'member_credits',
    'mvgs_interest',
    'partner_applications',
    'pc_blockers',
    'pc_deployments',
    'pc_evidence',
    'pc_nodes',
    'pc_prompts',
    'pc_seed_runs',
    'pc_seed_state',
    'pc_sync_checkpoints',
    'pc_sync_leases',
    'pc_sync_runs',
    'pc_test_runs',
    'pc_work_packages',
    'pending_set_lookups',
    'pin_attempts',
    'pipeline_settings',
    'pokemon_import_runs',
    'pokemon_knowledge_revisions',
    'pokemon_review_queue',
    'pokemon_set_aliases',
    'pokemon_set_knowledge',
    'print_batches',
    'promo_codes',
    'promotions',
    'rarity_mapping_reviews',
    'reel_analytics',
    'reel_card_approvals',
    'reprint_log',
    'review_requests',
    'review_suppressions',
    'scanner_capture_sessions',
    'scanner_evidence_staging',
    'scanner_processing_jobs',
    'service_tiers',
    'set_review_decisions',
    'stolen_reports',
    'submission_acquisition',
    'submission_items',
    'submissions',
    'tcgdex_sets',
    'tier_capacity',
    'tiers',
    'users',
    'value_protection_tiers',
    'vq_ai_generations',
    'vq_artwork_candidates',
    'vq_artwork_revisions',
    'vq_asset_library',
    'vq_cards',
    'vq_characters',
    'vq_config',
    'vq_elements',
    'vq_export_jobs',
    'vq_families',
    'vq_family_rules',
    'vq_feature_flags',
    'vq_game_config',
    'vq_generation_requests',
    'vq_pack_config',
    'vq_packaging_items',
    'vq_print_exports',
    'vq_production_stages',
    'vq_qa_checks',
    'vq_release_state',
    'vq_releases',
    'vq_set_settings',
    'vq_sets',
    'waitlist_signups'
  ];

  -- DELETE is confined to short-lived security state and the four current
  -- administrative replacement/removal paths proven in source.
  deletable_tables constant text[] := ARRAY[
    'account_magic_link_tokens',
    'claim_verifications',
    'customer_magic_link_tokens',
    'custom_sets',
    'email_verification_tokens',
    'feature_overrides',
    'label_overrides',
    'password_reset_tokens',
    'pc_dependencies',
    'pending_switch_nonces',
    'pin_reset_tokens',
    'public_rate_limit_buckets',
    'session',
    'transfer_verifications'
  ];

  -- Known production remnants are preserved but deliberately inaccessible.
  protected_inactive_relations constant text[] := ARRAY[
    'audit_logs',
    'bot_logs',
    'bot_seen',
    'bot_settings',
    'sessions',
    'subscription_reminders',
    'vault_club_consents',
    'vault_club_subscriptions'
  ];

  -- Operational Partner Network data is a separate authority.  The single
  -- prefix exception, partner_applications, is a public acquisition-lead table
  -- created by 0095 and appears in mutable_tables above.
  denied_partner_relations constant text[] := ARRAY[
    'field_welders',
    'partner_audit_events',
    'partner_branding',
    'partner_card_job_op_keys',
    'partner_card_jobs',
    'partner_connector_admin_actions',
    'partner_connector_customer_links',
    'partner_connector_events',
    'partner_connector_import_attempts',
    'partner_connector_imports',
    'partner_connector_records',
    'partner_connector_validation_findings',
    'partner_connector_validation_runs',
    'partner_contacts',
    'partner_credit_accounting_exceptions',
    'partner_credit_availability',
    'partner_credit_checkout_sessions',
    'partner_credit_ledger',
    'partner_credit_packs',
    'partner_credit_reservation_events',
    'partner_credit_reservations',
    'partner_customers',
    'partner_deleted_tombstones',
    'partner_emergency_controls',
    'partner_feature_flags',
    'partner_google_connections',
    'partner_google_credentials',
    'partner_google_location_candidates',
    'partner_google_oauth_states',
    'partner_google_profile_cache',
    'partner_grading_leases',
    'partner_internal_notes',
    'partner_invitations',
    'partner_location_publications',
    'partner_locations',
    'partner_management_audit',
    'partner_mfa_methods',
    'partner_organisations',
    'partner_owner_invariant_tenants',
    'partner_password_reset_tokens',
    'partner_permissions',
    'partner_profiles',
    'partner_public_profiles',
    'partner_rate_limit_buckets',
    'partner_recovery_codes',
    'partner_role_permissions',
    'partner_roles',
    'partner_security_events',
    'partner_service_tiers',
    'partner_sessions',
    'partner_station_calibrations',
    'partner_station_events',
    'partner_stations',
    'partner_submission_cards',
    'partner_submission_credit_holds',
    'partner_submission_events',
    'partner_submission_handoffs',
    'partner_submissions',
    'partner_supplies_order_events',
    'partner_supplies_order_items',
    'partner_supplies_order_notifications',
    'partner_supplies_orders',
    'partner_supply_order_events',
    'partner_supply_order_items',
    'partner_supply_orders',
    'partner_supply_payments',
    'partner_supply_products',
    'partner_supply_refunds',
    'partner_supply_tax_settings',
    'partner_user_locations',
    'partner_user_roles',
    'partner_users',
    'partner_wallet_balances',
    'partner_wallets'
  ];

  known_relations text[];
  duplicates text;
  unexpected text;
  relation_name text;
  orphan_sequence text;
BEGIN
  known_relations := read_only_relations || append_only_tables || mutable_tables || deletable_tables
    || protected_inactive_relations || denied_partner_relations;

  SELECT string_agg(name, ', ' ORDER BY name)
    INTO duplicates
    FROM (
      SELECT name
        FROM unnest(known_relations) AS named(name)
       GROUP BY name
      HAVING count(*) <> 1
    ) repeated;
  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION '0121: duplicate runtime authority classification: %', duplicates;
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO unexpected
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r','p','v','m','f')
     AND NOT c.relname = ANY(known_relations);
  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION '0121: unclassified public relation(s): %', unexpected;
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO unexpected
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'S'
     AND NOT EXISTS (
       SELECT 1
         FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass
          AND d.objid = c.oid
          AND d.refclassid = 'pg_class'::regclass
          AND d.deptype IN ('a','i')
     )
     AND c.relname <> ALL(ARRAY[
       'ai_predictions_id_seq',
       'partner_connector_submission_ref_seq'
     ]::text[]);
  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION '0121: unclassified public orphan sequence(s): %', unexpected;
  END IF;

  FOREACH relation_name IN ARRAY read_only_relations LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO mintvault_app', relation_name);
    END IF;
  END LOOP;

  FOREACH relation_name IN ARRAY append_only_tables LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT, INSERT ON TABLE public.%I TO mintvault_app', relation_name);
    END IF;
  END LOOP;

  FOREACH relation_name IN ARRAY mutable_tables LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO mintvault_app', relation_name);
    END IF;
  END LOOP;

  FOREACH relation_name IN ARRAY deletable_tables LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO mintvault_app', relation_name);
    END IF;
  END LOOP;

  -- Grant only sequences owned by an insert-authorised table.
  FOR orphan_sequence IN
    SELECT DISTINCT seq.relname
      FROM pg_class seq
      JOIN pg_namespace seq_ns ON seq_ns.oid = seq.relnamespace
      JOIN pg_depend d
        ON d.classid = 'pg_class'::regclass
       AND d.objid = seq.oid
       AND d.refclassid = 'pg_class'::regclass
       AND d.deptype IN ('a','i')
      JOIN pg_class owner_table ON owner_table.oid = d.refobjid
     WHERE seq_ns.nspname = 'public'
       AND seq.relkind = 'S'
       AND owner_table.relname = ANY(append_only_tables || mutable_tables || deletable_tables)
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO mintvault_app', orphan_sequence);
  END LOOP;

  IF to_regclass('public.ai_predictions_id_seq') IS NOT NULL THEN
    GRANT USAGE, SELECT ON SEQUENCE public.ai_predictions_id_seq TO mintvault_app;
  END IF;

  -- These are explicit assertions, not just absence-by-convention.  A future
  -- operational partner relation must be added to its own authority migration.
  FOREACH relation_name IN ARRAY denied_partner_relations LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM mintvault_app', relation_name);
    END IF;
  END LOOP;
  IF to_regclass('public.partner_connector_submission_ref_seq') IS NOT NULL THEN
    REVOKE ALL PRIVILEGES ON SEQUENCE public.partner_connector_submission_ref_seq FROM mintvault_app;
  END IF;
END
$authority$;

COMMENT ON ROLE mintvault_app IS
  'NOLOGIN least-privilege group inherited by the MintVault web runtime LOGIN; migration 0121 owns its exact relation authority.';
COMMENT ON TABLE public.public_rate_limit_buckets IS
  'PII-free, namespaced, fleet-wide rate-limit counters for public MintVault routes; never Partner tenant data.';
