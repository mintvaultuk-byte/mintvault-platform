-- 0064_public_slab_image_projection.sql
-- Take anonymous slab-image traffic off the privileged MintVault connection.
--
-- ============================================================================================
-- THE DEFECT THIS CLOSES (BLOCKER B2)
-- ============================================================================================
-- `GET /api/public/slab-image/:certNumber/:kind` (server/routes.ts) is UNAUTHENTICATED and is the
-- image source for the public slab showcase, the public certificate page and — since 0058 — every
-- card tile on a public partner shop profile. It resolves the certificate with
--
--     storage.getCertificateByCertId(certNumber)      -- Drizzle, main pool: SELECT *
--     db.execute(sql`SELECT grading_front_display, ... FROM certificates WHERE id = ...`)
--
-- Both run on the MAIN MintVault pool: the owner connection, BYPASSRLS, unbounded (no acquire
-- timeout, no statement timeout), and shared with every Super Admin operation in the product.
-- Three consequences, all live:
--
--   1. PRIVILEGE. An anonymous request executes `SELECT *` on `certificates` — every private
--      note, every authenticity verdict, every customer linkage — and what confines it to two
--      image keys is a hand-written property access in TypeScript.
--   2. CAPACITY. Anonymous image load consumes privileged pool slots. A crawler on the showcase
--      is a Super Admin outage. 0061 built a bounded, separate public pool for exactly this
--      reason and this route never joined it.
--   3. BLAST RADIUS. The main pool has no statement_timeout, so one slow scan holds a privileged
--      connection for as long as PostgreSQL will let it.
--
-- 0061 already closed the two *shop-profile* queries this way. This migration finishes the job
-- for the one anonymous route that was left behind.
--
-- ============================================================================================
-- WHY A PROJECTION AND NOT A GRANT
-- ============================================================================================
-- The obvious repair — grant partner_public_reader SELECT on `certificates` — is explicitly the
-- thing being refused. It would hand the anonymous identity the whole table, including columns
-- the product exists to keep private, and leave the boundary in application code again.
--
-- Instead the boundary is the VIEW DEFINITION, exactly as in 0061: owner-checked (not
-- security_invoker, which would require the base-table grant we are avoiding), with every
-- publication gate written INTO the definition so a future caller that forgets a conjunct cannot
-- widen what anonymous traffic can see. The reader gets SELECT on this view and on nothing else.
--
-- WHAT IT EXPOSES, AND WHY EACH COLUMN IS THERE
--   certificate_number   the lookup key; already public (it is the URL the visitor typed)
--   scan_object_key      the storage key of the front scan the proxy is about to stream, already
--                        resolved by the same precedence the route used. Never leaves the server:
--                        the route fetches the object and streams the bytes.
--   has_scan             so the route can distinguish "not eligible" from "eligible, no image"
--                        WITHOUT a second query and WITHOUT inferring it from a NULL key.
--
-- WHAT IT DELIBERATELY DOES NOT EXPOSE: the numeric id, grade, sub-grades, private_notes,
-- auth_status, auth_notes, stolen/ownership status, customer or submission linkage, origin
-- tenant, every other image variant, and every timestamp. A slab-image request needs a key and
-- a yes/no. It gets a key and a yes/no.
--
-- ============================================================================================
-- THE GATE, AND WHY IT IS THE SAME ONE
-- ============================================================================================
--   deleted_at IS NULL         not deleted
--   status = 'active'          not void, not revoked  (the only non-active states this column takes)
--   grade IS NOT NULL          a grade exists
--   grade_approved_at NOT NULL PUBLISHED — HQ has approved it
--
-- Identical to `partner_public_card_projection` (0061) and to the gate the route currently
-- applies in TypeScript, so this is a re-platforming, NOT a change of visibility. It is
-- deliberately NOT restricted to origin_type='PARTNER': this route serves the whole public slab
-- showcase, which is overwhelmingly HQ-originated, and narrowing it here would silently blank the
-- home page.
--
-- Note what the four conjuncts together mean for the pre-approval leak closed earlier on this
-- branch: a partner-graded card that has a grade but is still awaiting HQ review has
-- grade_approved_at IS NULL, so it is absent from this view and the route 404s — the gate is now
-- enforced by the DATABASE rather than by an `if` a future edit can drop.
--
-- ============================================================================================
-- ALSO CLOSED HERE (the H9 defect class, second instance)
-- ============================================================================================
-- `grading_front_display` is written by four call sites (server/routes.ts:7658, 7860, 10046 and
-- server/scan-ingest-service.ts:758) and read by the route this migration re-platforms — and it
-- is created by NO migration and NO boot-time DDL. It exists on staging and production only
-- because someone ran `drizzle-kit push` against them. A fresh database built from the migration
-- chain does not have it, so the view below would not compile there.
--
-- `grading_front_cropped` is the same defect one step milder: boot-time DDL only
-- (server/routes.ts:5099), no migration.
--
-- Both are created here, additively, so the estate a migration chain produces matches the estate
-- that actually exists. Neither is dropped by the rollback for grading_front_cropped's boot-DDL
-- reason — see rollback-0064.
--
-- ============================================================================================
-- LOCKS AND QUIET WINDOW
-- ============================================================================================
-- The two ALTERs are catalog-only (nullable TEXT, no DEFAULT) — no table rewrite. They take
-- ACCESS EXCLUSIVE on `certificates` for the catalog update only, bounded by the runner's
-- lock_timeout. On staging and production both columns already exist, so both ALTERs are no-ops
-- that still take (and instantly release) the lock. CREATE VIEW takes no lock on the base table
-- beyond ACCESS SHARE.
--
-- Additive only. Drops nothing, rewrites no applied migration.

-- --------------------------------------------------------------------------------------------
-- 1. The columns the view depends on
-- --------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.certificates') IS NULL THEN
    RAISE NOTICE '0064: certificates is absent (partner-only fixture) — slab image projection not installed';
    RETURN;
  END IF;
  EXECUTE 'ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grading_front_cropped text';
  EXECUTE 'ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grading_front_display text';
END$$;

-- --------------------------------------------------------------------------------------------
-- 2. The projection
-- --------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.certificates') IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='certificates' AND column_name='front_image_path') THEN
    RAISE NOTICE '0064: certificates stub lacks front_image_path — slab image projection not installed';
    RETURN;
  END IF;

  EXECUTE $v$
    CREATE OR REPLACE VIEW public_slab_image_projection AS
    SELECT
      certificate_number,
      -- SAME PRECEDENCE the route already used: the display derivative first (what the showcase
      -- is meant to show), then the crop, then the original upload. Resolved in the database so
      -- the ordering cannot drift between the two places that need it.
      COALESCE(grading_front_display, grading_front_cropped, front_image_path) AS scan_object_key,
      (COALESCE(grading_front_display, grading_front_cropped, front_image_path) IS NOT NULL) AS has_scan
    FROM certificates
    WHERE deleted_at IS NULL
      AND status = 'active'
      AND grade IS NOT NULL
      AND grade_approved_at IS NOT NULL
  $v$;

  EXECUTE 'REVOKE ALL PRIVILEGES ON public_slab_image_projection FROM PUBLIC';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_public_reader') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public_slab_image_projection FROM partner_public_reader';
    EXECUTE 'GRANT SELECT ON public_slab_image_projection TO partner_public_reader';
  END IF;
END$$;

COMMENT ON VIEW public_slab_image_projection IS
  'Anonymous slab-image proxy lookup. The ONLY certificates access the public reader identity has. Carries the publication gate (not deleted, active, graded, HQ-approved) in its own definition; exposes a certificate number, one resolved storage key and a boolean, and nothing else.';

-- --------------------------------------------------------------------------------------------
-- 3. Completeness assertions
-- --------------------------------------------------------------------------------------------
DO $$
DECLARE
  viewdef text;
  forbidden text[] := ARRAY[
    'private_notes','auth_status','auth_notes','stolen_status','ownership_status',
    'customer_email','owner_email','submission_id','origin_partner_id','origin_location_id',
    'centering_score','corners_score','edges_score','surface_score'
  ];
  c text;
BEGIN
  IF to_regclass('public.public_slab_image_projection') IS NULL THEN
    -- Only tolerable where the base table (or its image columns) is absent — a partner-only
    -- fixture. On a real estate this is a hard failure, matched to the creation guard above so
    -- it can never degrade into "asserted nothing".
    IF to_regclass('public.certificates') IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='certificates' AND column_name='front_image_path') THEN
      RAISE EXCEPTION '0064 completeness assertion failed: public_slab_image_projection was not created on a certificates table that supports it.';
    END IF;
    RETURN;
  END IF;

  SELECT pg_get_viewdef('public.public_slab_image_projection'::regclass, true) INTO viewdef;

  -- Every publication gate must be present. A view that lost one of these would publish
  -- unapproved or voided card scans to anonymous callers.
  IF viewdef NOT LIKE '%deleted_at IS NULL%' THEN
    RAISE EXCEPTION '0064: the slab image projection lost its deleted_at gate';
  END IF;
  IF viewdef NOT LIKE '%grade_approved_at IS NOT NULL%' THEN
    RAISE EXCEPTION '0064: the slab image projection lost its HQ-approval gate';
  END IF;
  IF viewdef NOT LIKE '%status%active%' THEN
    RAISE EXCEPTION '0064: the slab image projection lost its active-status gate';
  END IF;
  IF viewdef NOT LIKE '%grade IS NOT NULL%' THEN
    RAISE EXCEPTION '0064: the slab image projection lost its graded gate';
  END IF;

  -- Nothing private may appear in the definition at all.
  FOREACH c IN ARRAY forbidden LOOP
    IF viewdef LIKE '%' || c || '%' THEN
      RAISE EXCEPTION '0064: the slab image projection references the private column %', c;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'partner_public_reader') THEN
    IF NOT has_table_privilege('partner_public_reader', 'public.public_slab_image_projection', 'SELECT') THEN
      RAISE EXCEPTION '0064: partner_public_reader cannot read the slab image projection it is the only consumer of';
    END IF;
    -- The whole point. If this ever becomes false the projection was pointless.
    IF has_table_privilege('partner_public_reader', 'public.certificates', 'SELECT') THEN
      RAISE EXCEPTION '0064: partner_public_reader has direct SELECT on certificates — the projection is being bypassed';
    END IF;
    FOREACH c IN ARRAY ARRAY['INSERT','UPDATE','DELETE'] LOOP
      IF has_table_privilege('partner_public_reader', 'public.public_slab_image_projection', c) THEN
        RAISE EXCEPTION '0064: partner_public_reader holds % on the slab image projection', c;
      END IF;
    END LOOP;
  END IF;

  -- PUBLIC must hold nothing: `GRANT ... TO PUBLIC` anywhere upstream would make the REVOKE above
  -- the only thing standing between an unauthenticated database identity and this view.
  IF has_table_privilege('public', 'public.public_slab_image_projection', 'SELECT') THEN
    RAISE EXCEPTION '0064: PUBLIC can read the slab image projection';
  END IF;
END$$;
