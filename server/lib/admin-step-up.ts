/**
 * AG-3b — RECENT-AUTHENTICATION STEP-UP FOR SUPER ADMIN ACTIONS.
 *
 * THE GAP. AG-3 gave partner sessions a step-up stamp, but the most destructive actions in the
 * whole system are not partner actions at all — approving or revoking a station, suspending a
 * partner organisation, resetting somebody's MFA, initiating a password reset, granting Grading
 * Credits, taking emergency control. Those run as Super Admin, on the ADMIN session, which
 * `partner_sessions.last_step_up_at` cannot reach. They were protected by `requireSuperAdmin`, a
 * typed-confirmation dialog and a mandatory reason — real controls, but none of them is proof that
 * the person at the keyboard is still the person who logged in.
 *
 * NO SECOND ARCHITECTURE. This reuses the admin session that already exists. The stamp is written
 * into `req.session`, which express-session persists to the `session` table through
 * connect-pg-simple — so it is SHARED SERVER STATE, not process memory. Both Fly Machines read and
 * write the same row, and a rolling deploy does not discard it. That is invariant I19, and it is
 * why the stamp deliberately does NOT live in a module-level Map.
 *
 * WHY THE TIMESTAMP COMES FROM POSTGRESQL. The stamp is taken as `SELECT now()` and its freshness
 * is evaluated by PostgreSQL as well, exactly as the partner step-up does. Two app servers with
 * drifting clocks must not disagree about whether a proof is still valid, and an app clock running
 * fast would silently widen the window.
 *
 * WHAT IS DELIBERATELY NOT GUARDED. Read-only admin navigation — listing partners, viewing a
 * dashboard, reading an audit trail. Step-up on reads would train an administrator to type their
 * password reflexively many times an hour, which destroys the signal it exists to create. Ordinary
 * grading and QA work is likewise untouched: existing policy governs that, and this is not the
 * place to change it.
 */
import type { Request, Response, NextFunction } from "express";
import { pool } from "../db";

/**
 * How long an admin proof lasts.
 *
 * Ten minutes, deliberately tighter than the partner window's fifteen. A Super Admin action is
 * cross-tenant and frequently irreversible — a revoked station, a suspended shop, a granted credit —
 * so the window is sized for "complete the task you just proved yourself for", not for a working
 * session.
 */
export const ADMIN_STEP_UP_WINDOW_MINUTES = 10;

/** Stable, actionable code. The client re-prompts; it must not sign the administrator out. */
export const ADMIN_STEP_UP_REQUIRED_CODE = "admin_step_up_required";

/** Session key. Declared in the express-session module augmentation in server/auth.ts. */
type StepUpSession = { adminStepUpAt?: string | undefined; isAdmin?: boolean };

/**
 * Take the proof timestamp from the DATABASE, never from the app clock.
 *
 * Returned as an ISO string so it survives express-session's JSON serialisation intact.
 */
export async function currentDatabaseTime(): Promise<string> {
  const { rows } = await pool.query<{ now: string }>("SELECT now() AS now");
  return new Date(rows[0].now).toISOString();
}

/**
 * Record that this admin session has just re-proved its human.
 *
 * Written ONLY by the step-up route, after both admin factors have been checked. `session.save()`
 * is awaited explicitly: express-session writes on response end, and a high-risk request issued
 * immediately afterwards could otherwise race the store and read a session without the stamp —
 * which would fail closed, but would look to the administrator like the password they just typed
 * did nothing.
 */
export async function recordAdminStepUp(req: Request): Promise<void> {
  const session = req.session as unknown as StepUpSession;
  session.adminStepUpAt = await currentDatabaseTime();
  await new Promise<void>((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Clear the proof.
 *
 * Called when the administrator signs out, and worth calling on any privilege change. A stamp that
 * outlived its session would be a stamp that could be inherited.
 */
export function clearAdminStepUp(req: Request): void {
  const session = req.session as unknown as StepUpSession | undefined;
  if (session) session.adminStepUpAt = undefined;
}

/**
 * Is this admin session's proof still fresh?
 *
 * FAILS CLOSED on every uncertainty: no session, no stamp (which is every session that existed
 * before this shipped), an unparseable stamp, or a database error. Freshness is decided by
 * PostgreSQL so that two machines cannot disagree.
 */
export async function hasRecentAdminStepUp(
  req: Request,
  windowMinutes = ADMIN_STEP_UP_WINDOW_MINUTES
): Promise<boolean> {
  const session = req.session as unknown as StepUpSession | undefined;
  const stamp = session?.adminStepUpAt;
  if (!stamp || typeof stamp !== "string") return false;
  const parsed = new Date(stamp);
  if (Number.isNaN(parsed.getTime())) return false;

  const { rows } = await pool.query<{ fresh: boolean }>(
    `SELECT ($1::timestamptz > now() - ($2 || ' minutes')::interval
             AND $1::timestamptz <= now() + interval '1 minute') AS fresh`,
    [parsed.toISOString(), String(windowMinutes)]
  );
  // The upper bound matters: a stamp in the FUTURE is not a fresh proof, it is a tampered or
  // clock-skewed one, and treating it as valid would make the window unbounded.
  return rows[0]?.fresh === true;
}

/**
 * Gate a destructive Super Admin action on a recent proof.
 *
 * ALWAYS placed AFTER `requireSuperAdmin`. An administrator who is not a Super Admin must be told
 * that plainly rather than asked for a password that would not have helped them, and a request with
 * no admin session at all must 401 rather than being invited to step up.
 *
 * Answers 403, never 401: the session is valid and must survive. A 401 would make the console
 * discard a good session and turn a confirmation prompt into an unexpected sign-out mid-task.
 */
export function requireAdminStepUp(windowMinutes = ADMIN_STEP_UP_WINDOW_MINUTES) {
  return async function adminStepUpGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
    const session = req.session as unknown as StepUpSession | undefined;
    if (!session?.isAdmin) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    try {
      if (await hasRecentAdminStepUp(req, windowMinutes)) {
        next();
        return;
      }
    } catch (err) {
      // Failure to CONFIRM a proof is not a proof.
      // eslint-disable-next-line no-console
      console.error("[admin step-up] verification failed:", (err as Error).message);
    }
    res.status(403).json({
      error: "Confirm your admin password and PIN to continue.",
      code: ADMIN_STEP_UP_REQUIRED_CODE,
      windowMinutes,
    });
  };
}
