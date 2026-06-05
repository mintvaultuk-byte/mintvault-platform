-- Replace the body of public.enforce_status_transition() in place.
--
-- The trigger (trg_submission_status) is unchanged — it keeps pointing at
-- this function name, so CREATE OR REPLACE swaps the body atomically and
-- the wiring stays intact. No DROP TRIGGER, no recreate. Re-runnable.
--
-- Rationale: the previous body used a stale state machine
-- (imaging/grading/senior_review/encapsulation/qa/closed) that no app
-- code references. It blocked every transition past "received", which
-- is why staging and prod both had zero submissions past that state.
-- Captured in migrations/_rollback_enforce_status_transition_OLD.sql
-- for restore.
--
-- New transitions match shared/schema.ts SUBMISSION_STATUS_TRANSITIONS:
--   new             -> received
--   paid            -> received
--   received        -> in_grading
--   in_grading      -> ready_to_return
--   ready_to_return -> shipped
--   shipped         -> completed
-- Plus draft -> paid for markSubmissionAsPaid (storage.ts:514) which
-- handles the uppercase-DRAFT seed case.
--
-- OLD.status / NEW.status are lower()-cased before the map lookup so
-- "DRAFT" and "draft" both resolve. The OLD.status=NEW.status no-op
-- short-circuit and the mintvault.admin_bypass='true' escape clause
-- are preserved BYTE-FOR-BYTE — only the transitions JSON changed and
-- the case-fold was added.
--
-- STAGING ONLY for this pass (ep-purple-voice-abfez796).

CREATE OR REPLACE FUNCTION public.enforce_status_transition()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
        DECLARE
          transitions jsonb := '{"draft":["paid"],"new":["received"],"paid":["received"],"received":["in_grading"],"in_grading":["ready_to_return"],"ready_to_return":["shipped"],"shipped":["completed"],"completed":[]}'::jsonb;
          allowed jsonb;
          bypass text;
          old_lc text;
          new_lc text;
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

          old_lc := lower(OLD.status);
          new_lc := lower(NEW.status);

          allowed := transitions->old_lc;
          IF allowed IS NULL THEN
            RAISE EXCEPTION 'Invalid current status: %', OLD.status;
          END IF;

          IF NOT allowed @> to_jsonb(new_lc) THEN
            RAISE EXCEPTION 'Invalid transition: % → %. Allowed: %', OLD.status, NEW.status, allowed;
          END IF;

          RETURN NEW;
        END;
        $function$;
