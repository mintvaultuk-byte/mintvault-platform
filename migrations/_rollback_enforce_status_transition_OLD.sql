-- ROLLBACK ARTIFACT — original public.enforce_status_transition() captured
-- from the staging DB (ep-purple-voice-abfez796) BEFORE the
-- fix-status-transition-trigger.sql migration ran.
--
-- Same definition was confirmed byte-identical on prod
-- (ep-wispy-morning-ab6f4o08) during the read-only investigation.
--
-- This is the EXACT function body to restore if the new state machine
-- needs to be reverted. Re-run this whole file with psql against the
-- target DB; the existing trigger trg_submission_status keeps pointing
-- at this function name, so CREATE OR REPLACE restores behaviour in
-- place — no DROP TRIGGER / CREATE TRIGGER required.
--
-- Captured: 2026-06-05 via fly ssh console --app mintvault-v2.

CREATE OR REPLACE FUNCTION public.enforce_status_transition()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
        DECLARE
          transitions jsonb := '{"draft":["paid"],"paid":["received"],"received":["imaging"],"imaging":["grading"],"grading":["senior_review","encapsulation"],"senior_review":["encapsulation","grading"],"encapsulation":["qa"],"qa":["shipped"],"shipped":["closed"],"closed":[]}'::jsonb;
          allowed jsonb;
          bypass text;
        BEGIN
          IF OLD.status = NEW.status THEN
            RETURN NEW;
          END IF;

          BEGIN
            bypass := current_setting('mintvault.admin_bypass', true);
          EXCEPTION WHEN OTHERS THEN
            bypass := '';
          END;

          IF bypass = 'true' THEN
            RETURN NEW;
          END IF;

          allowed := transitions->OLD.status;
          IF allowed IS NULL THEN
            RAISE EXCEPTION 'Invalid current status: %', OLD.status;
          END IF;

          IF NOT allowed @> to_jsonb(NEW.status) THEN
            RAISE EXCEPTION 'Invalid transition: % → %. Allowed: %', OLD.status, NEW.status, allowed;
          END IF;

          RETURN NEW;
        END;
        $function$;
