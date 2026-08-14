/**
 * Pure, fail-closed classification for the Scanner's live human + station
 * authority. Network and Keychain access stay in Electron main; this module
 * keeps every operator-facing state and physical-action gate deterministic.
 */

const CAPTURE_PERMISSION = "partner.cards.scan";
const ENROL_PERMISSION = "partner.stations.enrol";

function permissions(body) {
  return new Set(Array.isArray(body?.permissions) ? body.permissions.filter((value) => typeof value === "string") : []);
}

function sessionStage(result) {
  if (!result || result.transportError) {
    return { stage: "offline", error: "MintVault is offline. New physical operations are paused." };
  }
  if (!result.ok) {
    if (result.status === 503) {
      return { stage: "degraded", error: "MintVault station authority is temporarily unavailable." };
    }
    return { stage: "sign_in", clearSession: result.status === 401 };
  }
  if (!result.body?.mfaPassed) {
    return {
      stage: result.body?.mfaEnrolmentRequired ? "mfa_enrolment_required" : "mfa",
      error: result.body?.mfaEnrolmentRequired
        ? "Set up MFA in the MintVault Partner dashboard, then sign in here again."
        : undefined,
    };
  }
  return { stage: "authenticated", permissions: permissions(result.body) };
}

function requiredCapabilityStage(session, { enrolled }) {
  if (!session || session.stage !== "authenticated") return session;
  const required = enrolled ? CAPTURE_PERMISSION : ENROL_PERMISSION;
  if (!session.permissions.has(required)) {
    return {
      stage: "no_partner_access",
      error: enrolled
        ? "This account is not authorised to operate a MintVault Scanner."
        : "This account cannot request enrolment for a new station.",
    };
  }
  return session;
}

function stationStage(status) {
  const value = String(status || "").toUpperCase();
  switch (value) {
    case "ACTIVE":
      return { stage: "active" };
    case "PENDING":
      return { stage: "pending" };
    case "REJECTED":
      return { stage: "rejected", terminalIdentity: true };
    case "CANCELLED":
      return { stage: "cancelled", terminalIdentity: true };
    case "EXPIRED":
      return { stage: "expired", terminalIdentity: true };
    case "SUSPENDED":
      return { stage: "suspended" };
    case "REVOKED":
      return { stage: "revoked" };
    default:
      return { stage: "degraded", error: "MintVault returned an unknown station state." };
  }
}

function operationalDenial(setup) {
  if (setup?.stage === "active") return null;
  const stage = String(setup?.stage || "degraded");
  const defaults = {
    sign_in: "Sign in and complete MFA before starting a physical operation.",
    mfa: "Complete MFA before starting a physical operation.",
    mfa_enrolment_required: "Set up MFA before starting a physical operation.",
    offline: "MintVault is offline. New physical operations are paused; queued evidence remains safe.",
    update_required: "Update MintVault Scanner before starting a physical operation.",
    scanner_disconnected: "Connect the Canon LiDE 400 before starting a physical operation.",
    replay_state_desync: "Station replay recovery is required before starting a physical operation.",
  };
  return {
    ok: false,
    code: stage,
    error: setup?.error || defaults[stage] || "This human and station are not currently authorised for physical work.",
  };
}

function withLocalSession(setup, canSignOut) {
  return { ...setup, canSignOut: canSignOut === true };
}

module.exports = Object.freeze({
  CAPTURE_PERMISSION,
  ENROL_PERMISSION,
  sessionStage,
  requiredCapabilityStage,
  stationStage,
  operationalDenial,
  withLocalSession,
});
