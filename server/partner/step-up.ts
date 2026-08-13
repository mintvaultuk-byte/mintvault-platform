/**
 * AG-3 — RECENT-AUTHENTICATION STEP-UP.
 *
 * THE PROBLEM. Until now the only re-authentication in the partner system was verifyPassword(),
 * wired exclusively into the four MFA credential routes. Everything else rode a plain session:
 * buying Grading Credits, changing a colleague's role, inviting or removing staff, revoking
 * sessions. A session left open on an unattended shop-floor browser was therefore enough to spend
 * the shop's money or promote an account, and the only things in the way were a typed-confirm
 * dialog and a mandatory reason — both UI, neither authority.
 *
 * THE SHAPE OF THE FIX. One question, asked only where it is worth asking: has the human at this
 * session proved recently that they are who the session says they are? Proof is the account
 * password PLUS the current second factor when one is enrolled — the same standard the MFA routes
 * already demand, reused rather than reinvented.
 *
 * WHAT IS DELIBERATELY *NOT* PROTECTED, AND WHY. Scanning. NEW capture and FIX capture are the
 * high-frequency path and a shift must stay fast — asking an operator to re-enter a password
 * between cards would be unusable, and the shop would work around it by never logging out, which
 * is strictly worse than the risk it was meant to close. Those paths already carry two independent
 * proofs on every request: an approved station's Ed25519 signature AND an MFA-passed operator
 * session. Step-up is reserved for actions that are rare, expensive and hard to undo.
 *
 * WHY THE STAMP IS READ SEPARATELY FROM THE SESSION PRINCIPAL. `resolvePartnerSession` goes through
 * the SECURITY DEFINER function `partner_session_lookup`, whose return shape is fixed by migration.
 * Widening it would mean changing a definer function every request pays for, to carry a field that
 * matters on a handful of rare routes. So the stamp is read on demand, only by the routes that
 * require it.
 */
import type { Request, Response, NextFunction } from "express";
import { partnerAdminQuery } from "./db";

/**
 * How long a proof lasts.
 *
 * Fifteen minutes is long enough to complete a task that spans several screens — buy credits, then
 * adjust who can spend them — and short enough that a browser abandoned at the counter is not still
 * authorised when the next person sits down. It is deliberately much shorter than the 30-minute
 * idle timeout: an idle session is merely stale, a stepped-up one is actively privileged.
 */
export const STEP_UP_WINDOW_MINUTES = 15;

/** Stable code so the client can tell "prove yourself again" apart from "you may never do this". */
export const STEP_UP_REQUIRED_CODE = "step_up_required";

/**
 * Record that this session has just re-proved its human.
 *
 * Written by the step-up route ONLY, after both factors have been checked. Nothing else in the
 * codebase writes this column — a caller that could stamp it without verifying would make the whole
 * mechanism decorative.
 */
export async function recordStepUp(sessionId: string): Promise<void> {
  await partnerAdminQuery(`UPDATE partner_sessions SET last_step_up_at = now() WHERE id = $1 AND revoked_at IS NULL`, [
    sessionId,
  ]);
}

/**
 * Has this session proved itself within the window?
 *
 * FAILS CLOSED on every uncertainty: a NULL stamp (never stepped up, including every session that
 * predates the column), a revoked session, or a session id that no longer resolves all return
 * false. The SQL asks the DATABASE whether the stamp is recent rather than comparing clocks in the
 * application, so a skewed app-server clock cannot widen the window.
 */
export async function hasRecentStepUp(sessionId: string, windowMinutes = STEP_UP_WINDOW_MINUTES): Promise<boolean> {
  const { rows } = await partnerAdminQuery<{ fresh: boolean }>(
    `SELECT (last_step_up_at IS NOT NULL
             AND last_step_up_at > now() - ($2 || ' minutes')::interval) AS fresh
       FROM partner_sessions
      WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, String(windowMinutes)]
  );
  return rows[0]?.fresh === true;
}

/**
 * Gate a high-risk action on a recent proof.
 *
 * Returns 403 with `step_up_required` — a distinct, actionable code. It is deliberately NOT 401:
 * the session is perfectly valid and the user must not be logged out, they simply have to
 * re-confirm. Answering 401 would make browsers and clients discard a good session and would turn
 * a confirmation prompt into an unexpected sign-out mid-task.
 *
 * Placed AFTER the capability guards on every route, so a user who may never perform the action is
 * told that plainly rather than being asked for a password it would not have helped them supply.
 */
export function requireRecentAuth(windowMinutes = STEP_UP_WINDOW_MINUTES) {
  return async function recentAuthGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
    const principal = req.partner;
    if (!principal) {
      res.status(401).json({ error: { code: "unauthorised", message: "Authentication required." } });
      return;
    }
    try {
      if (await hasRecentStepUp(principal.sessionId, windowMinutes)) {
        next();
        return;
      }
    } catch (err) {
      // A failure to CONFIRM the proof is not a proof. Fail closed and say so.
      // eslint-disable-next-line no-console
      console.error("[partner step-up] verification failed:", (err as Error).message);
      res.status(403).json({
        error: { code: STEP_UP_REQUIRED_CODE, message: "Confirm your password to continue." },
      });
      return;
    }
    res.status(403).json({
      error: {
        code: STEP_UP_REQUIRED_CODE,
        message: "Confirm your password to continue.",
        windowMinutes,
      },
    });
  };
}
