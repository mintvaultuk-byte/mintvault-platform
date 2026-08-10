-- 0048_partner_location_snapshot_search_path.sql
-- SECURITY REPAIR — A8-F2 (HIGH). pg_temp shadowing of the submission location snapshot.
--
-- WHAT WAS WRONG. 0044_partner_submission_lifecycle_and_location_snapshot.sql:131-157 creates
-- partner_submissions_capture_location_snapshot() with NO `SET search_path`, and its body reads
-- `FROM partner_locations l` UNQUALIFIED. Every session controls its own search_path, and pg_temp
-- is searched ahead of public by default, so any role that can CREATE TEMP TABLE — which every
-- partner runtime role can, it is a default PUBLIC privilege on the database — can do:
--
--     CREATE TEMP TABLE partner_locations (id uuid, tenant_id uuid, name text);
--     INSERT INTO partner_locations VALUES (<victim location>, <own tenant>, 'FORGED ORIGIN');
--     INSERT INTO partner_submissions (...);           -- ordinary insert, no special privilege
--
-- and the trigger resolves the name from the attacker's temp table. Reproduced on a disposable
-- PostgreSQL 17 cluster: location_name_snapshot came back as 'FORGED ORIGIN — Tenant B Shop'. The
-- `AND l.tenant_id = NEW.tenant_id` guard does not help — it is evaluated against the temp table.
--
-- The function is SECURITY INVOKER, so this is NOT privilege escalation. It is a provenance /
-- integrity defeat of the exact snapshot 0044's own header says exists so that submission origin
-- cannot disagree with the certificate's ENABLE ALWAYS origin snapshot. Nothing detects it:
-- server/partner/definer-guard.ts covers SECURITY DEFINER functions only.
--
-- 0006_partner_definer_role.sql documents this precise attack and pins search_path on every definer
-- function it creates. 0044 did not carry the convention forward to its INVOKER trigger.
--
-- THE FIX. CREATE OR REPLACE the function with `SET search_path = public, pg_temp` (pg_temp LAST,
-- the house convention — it must be present so temp objects stay reachable for legitimate use, but
-- it must be searched last so it can never shadow a public table) and additionally schema-qualify
-- the read as `public.partner_locations`. Either one alone closes the attack; both together mean the
-- table reference is correct even if a future edit removes the SET clause.
--
-- The body is otherwise byte-for-byte 0044's. CREATE OR REPLACE preserves
-- trg_partner_submissions_location_snapshot, so no trigger is dropped and no window exists in which
-- partner_submissions inserts run unguarded.
--
-- 0044 itself is NOT edited. It is already applied; its checksum ratchet stays intact.

-- --------------------------------------------------------------------------------------------
-- PRE-FLIGHT. ADDED 2026-08-07, alongside the same block in 0047.
--
-- HONEST SCOPE, because a pre-flight that overstates its own load-bearingness is the sibling of
-- the defect it is here to prevent. The search_path pin below closes THIS file's attack against
-- every role, superuser included — pg_temp shadowing is a name-resolution defeat, not a privilege
-- one — so unlike 0047 this check is NOT what makes 0048's repair real.
--
-- It is here because 0048 is one of the two files that write the submission provenance chain, and
-- the integrity claim that chain rests on ("submission origin cannot disagree with the
-- certificate's origin snapshot") is void if the portal role ignores every tenant policy: a
-- BYPASSRLS partner_runtime could resolve, and then insert against, another tenant's location
-- outright, with no temp table required. Journalling this file as the repair for A8-F2 while that
-- is true would certify an integrity guarantee the database does not provide. 0052 asserts the
-- same two attributes on the same role for the same reason. Fail loudly instead.
-- --------------------------------------------------------------------------------------------
DO $$
DECLARE
  is_super  boolean;
  is_bypass boolean;
BEGIN
  SELECT rolsuper, rolbypassrls INTO is_super, is_bypass
    FROM pg_roles WHERE rolname = 'partner_runtime';

  IF is_super IS NULL THEN
    RAISE EXCEPTION '0048: role partner_runtime does not exist; 0001 must be applied first';
  END IF;
  IF is_super OR is_bypass THEN
    RAISE EXCEPTION
      '0048: partner_runtime is SUPERUSER or BYPASSRLS (super=%, bypass=%). Every tenant policy on '
      'partner_locations and partner_submissions would be unenforceable against the portal role, so '
      'the location-snapshot provenance this file repairs would still be forgeable without any '
      'pg_temp trick. Fix the role before claiming this is integrity.', is_super, is_bypass;
  END IF;

  IF to_regclass('public.partner_submissions') IS NULL THEN
    RAISE EXCEPTION '0048: table public.partner_submissions is missing; 0007/0044 must be applied first';
  END IF;
  IF to_regclass('public.partner_locations') IS NULL THEN
    RAISE EXCEPTION '0048: table public.partner_locations is missing; 0001 must be applied first';
  END IF;
END$$;

CREATE OR REPLACE FUNCTION partner_submissions_capture_location_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  location_name text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.location_name_snapshot IS NULL THEN
      SELECT l.name INTO location_name
        FROM public.partner_locations l
       WHERE l.id = NEW.location_id
         AND l.tenant_id = NEW.tenant_id;
      IF location_name IS NULL THEN
        RAISE EXCEPTION 'partner_submissions.location_name_snapshot could not resolve location % for tenant %',
          NEW.location_id, NEW.tenant_id;
      END IF;
      NEW.location_name_snapshot := location_name;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.location_name_snapshot IS DISTINCT FROM NEW.location_name_snapshot THEN
    RAISE EXCEPTION 'partner_submissions.location_name_snapshot is immutable after insert';
  END IF;
  RETURN NEW;
END$$;

-- Self-proving assertions: the search_path pin is present with pg_temp last, the body no longer
-- contains an unqualified read, and the trigger survived CREATE OR REPLACE.
DO $$
DECLARE
  cfg  text[];
  body text;
  ntrg integer;
BEGIN
  SELECT p.proconfig, p.prosrc
    INTO cfg, body
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'partner_submissions_capture_location_snapshot';

  IF body IS NULL THEN
    RAISE EXCEPTION '0048: partner_submissions_capture_location_snapshot() does not exist';
  END IF;
  IF cfg IS NULL OR NOT (cfg @> ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION '0048: search_path is not pinned to "public, pg_temp" (proconfig = %)', cfg;
  END IF;
  IF body ~* 'from\s+partner_locations' THEN
    RAISE EXCEPTION '0048: an unqualified partner_locations read survives in the function body';
  END IF;
  IF body !~* 'from\s+public\.partner_locations' THEN
    RAISE EXCEPTION '0048: the schema-qualified partner_locations read is missing';
  END IF;

  SELECT count(*) INTO ntrg
    FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgname = 'trg_partner_submissions_location_snapshot'
     AND tgrelid = 'public.partner_submissions'::regclass;
  IF ntrg <> 1 THEN
    RAISE EXCEPTION '0048: expected trg_partner_submissions_location_snapshot on partner_submissions, found %', ntrg;
  END IF;
END$$;
