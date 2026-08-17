/**
 * THE PLACEMENT-APPROVAL RULE, as a pure function.
 *
 * A GREEN placement preview is a claim about where a physical card is lying at one moment, for one
 * side of one card. This decides whether that claim may still authorise a 1200-DPI evidence capture.
 *
 * Deliberately pure and deliberately separate from the watcher: the whole safety argument for the
 * per-side gate rests on this predicate, and a rule buried in a class with a scanner, a filesystem
 * and a server client attached is a rule that gets tested by hand, once, and then trusted forever.
 *
 * THE FOUR CONDITIONS ARE ALL REQUIRED, and none of them can be upgraded into another:
 *
 *   1. an approval exists at all
 *   2. it is GREEN
 *   3. it names THIS session, THIS side and THIS certificate
 *   4. it is inside its time-to-live
 *
 * Condition 3 is what makes "a FRONT preview never authorises BACK" true. Condition 4 is the
 * backstop for a card nudged between the preview and the press. The approval is also CONSUMED by the
 * capture that uses it, which is enforced by the caller, not here.
 */

/** Millimetres of drift are cheap; ninety seconds of staleness is the practical limit. */
const PLACEMENT_APPROVAL_TTL_MS = 90_000;

const GREEN = "GREEN";

/**
 * @param {object|null} approval  the standing approval, or null
 * @param {{sessionId:string, side:string, certId:string}} target  the side actually awaiting Scan
 * @param {number} nowMs
 * @param {number} [ttlMs]
 * @returns {{ok:true}|{ok:false, code:string, error:string}}
 */
function matchPlacementApproval(approval, target, nowMs, ttlMs = PLACEMENT_APPROVAL_TTL_MS) {
  if (!approval) {
    return { ok: false, code: "no_approval", error: "Take a placement Preview before scanning this side" };
  }
  if (approval.state !== GREEN) {
    return {
      ok: false,
      code: "not_green",
      error: approval.message || "PLACE THE WHOLE CARD INSIDE THE RED BOX",
    };
  }
  if (!target || approval.sessionId !== target.sessionId) {
    return { ok: false, code: "wrong_session", error: "Take a placement Preview for this card before scanning" };
  }
  if (approval.side !== target.side) {
    // The FRONT-cannot-authorise-BACK case, stated as its own outcome so it is visible in logs.
    return {
      ok: false,
      code: "wrong_side",
      error: `Take a placement Preview for ${target.certId} ${target.side} before scanning`,
    };
  }
  if (approval.certId !== target.certId) {
    return { ok: false, code: "wrong_card", error: `Take a placement Preview for ${target.certId} before scanning` };
  }
  const age = nowMs - Number(approval.approvedAtMs || 0);
  if (!Number.isFinite(age) || age < 0 || age > ttlMs) {
    return {
      ok: false,
      code: "expired",
      error: "That placement Preview has expired — take a fresh Preview before scanning",
    };
  }
  return { ok: true };
}

module.exports = { PLACEMENT_APPROVAL_TTL_MS, matchPlacementApproval };
