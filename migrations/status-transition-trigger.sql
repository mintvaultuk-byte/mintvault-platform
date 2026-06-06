-- Submissions status-transition trigger — DEFINITIVE source.
--
-- HISTORY
-- The trigger trg_submission_status was originally hand-applied directly
-- to staging + prod (not under source control). migrations/fix-status-
-- transition-trigger.sql later replaced the function body to match the
-- app's live state vocabulary. THIS file is the first single source-of-
-- truth covering BOTH the function and the trigger attachment, with the
-- step-back-aware transition map.
--
-- DESIGN
-- - Transitions map allows the forward ladder PLUS one-step-back hops:
--     received  →  in_grading            ←       (no backward — floor)
--     in_grading ↔ ready_to_return
--     ready_to_return ↔ shipped
--     shipped ↔ completed
--   No arbitrary backward jumps (e.g. shipped → received is rejected).
-- - draft → paid → received and new → received remain for the
--   bootstrap path (markSubmissionAsPaid uses admin_bypass anyway).
-- - The mintvault.admin_bypass='true' escape clause is preserved
--   verbatim — used in storage.ts markSubmissionAsPaid to step around
--   the uppercase-'DRAFT' seed case. NEVER use bypass for normal status
--   moves; the step-back endpoint goes through the regular UPDATE path.
-- - OLD.status / NEW.status are lower()-cased before lookup so legacy
--   uppercase rows (e.g. 'DRAFT') still resolve.
--
-- IDEMPOTENT — CREATE OR REPLACE on both function and trigger, safe to
-- re-run. Brings the trigger under repo control without disturbing the
-- existing attachment.
--
-- Roll-out:
--   STAGING ONLY in this pass: psql "$STAGING" -f migrations/status-transition-trigger.sql
--   Prod applied separately (host-guarded) after staging approval.
--
-- Rollback (revert to the forward-only map):
--   migrations/_rollback_enforce_status_transition_OLD.sql (forward
--   ladder, no step-back) is the prior body — re-run that file to
--   restore the forward-only behaviour. Trigger attachment doesn't need
--   touching either way.

CREATE OR REPLACE FUNCTION public.enforce_status_transition()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
        DECLARE
          transitions jsonb := '{"draft":["paid"],"new":["received"],"paid":["received"],"received":["in_grading"],"in_grading":["ready_to_return","received"],"ready_to_return":["shipped","in_grading"],"shipped":["completed","ready_to_return"],"completed":["shipped"]}'::jsonb;
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

-- Trigger attachment. CREATE OR REPLACE TRIGGER is Postgres 14+ (Neon
-- supports it). Idempotent — re-running this migration just rebinds the
-- trigger to the same function.
CREATE OR REPLACE TRIGGER trg_submission_status
  BEFORE UPDATE OF status ON public.submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_status_transition();
