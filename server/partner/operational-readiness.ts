/** Server-authoritative Partner operational readiness (P5). */
import { appVersionSatisfies } from "./station-service";
import { STATION_STALE_MINUTES } from "./dashboard-operations-service";
import type {
  PartnerOperationalReadiness,
  PartnerReadinessCode,
  ReadinessAction,
  ReadinessDimension,
  ReadinessDimensionKey,
  ReadinessStatus,
} from "@shared/partner-readiness";

export interface PartnerReadinessFacts {
  orgStatus: string;
  /** null when the feature-flag authority itself could not be read. */
  portalEnabled: boolean | null;
  loginFlagEnabled: boolean | null;
  emergencyStop: boolean | null;
  /** The owner/primary user, or null when the partner has no user at all (a legacy record). */
  owner: {
    userStatus: string;
    passwordConfigured: boolean;
    invitationValid: boolean;
    mfaRequired: boolean;
    mfaConfigured: boolean;
  } | null;
  locationEligible: boolean;
  /** Main-location delivery address admitted by the same authority Supplies reads. */
  deliveryAddressReady: boolean;
  /** ACTIVE PRIMARY operations contact with a valid operational email. */
  operationsContactReady: boolean;
  /** null when partner_stations is absent from this database — unknown, not "no station". */
  station: {
    enrolledCount: number;
    approvedActiveCount: number;
    pendingApprovalCount: number;
    /** The approved+ACTIVE station backing the scanner dimension; null when none qualifies. */
    active: {
      scannerConnected: boolean;
      lastSeenAt: string | null;
      calibrationStatus: string;
      /**
       * The calibration record backing a VALID status, and the Scanner profile revision.
       * station-service's capture-eligibility filter requires BOTH to be non-null, so readiness
       * must too — otherwise readiness could report a shop ready while the capture authority
       * silently refused to list its station, which is precisely the kind of disagreement between
       * two authorities that P5 exists to end.
       *
       * `undefined` means the column does not exist on this database (current_profile_revision_id
       * arrives in migration 0091), which is not the same as null and is not the shop's problem.
       */
      currentCalibrationId: string | null;
      currentProfileRevisionId: string | null | undefined;
      appVersion: string | null;
      minimumSupportedVersion: string | null;
    } | null;
  } | null;
  /**
   * STAFF who can actually operate a Scanner.
   *
   * `locationScopedWithoutLocation` counts ACTIVE users holding a LOCATION-SCOPED role that has no
   * `partner_user_locations` assignment. Such an operator carries every scanning capability and
   * still resolves to ZERO eligible locations, so the Scanner offers nothing to enrol against —
   * observed on staging 2026-08-21, where it cost an onboarding session. It is a BLOCKED state, not
   * a warning: nothing downstream can succeed until it is assigned.
   *
   * Org-wide roles (OWNER/MANAGER/FINANCE_VIEWER) are deliberately NOT counted — they are eligible
   * at every ACTIVE location by design and must keep that semantic.
   *
   * null when the role/assignment authority could not be consulted — UNKNOWN, never PASS.
   */
  staff: {
    scanCapableCount: number;
    locationScopedWithoutLocation: number;
  } | null;
  /**
   * Ledger-derived usable credit balance. `"NO_WALLET"` is a real, actionable state (a legacy
   * partner never provisioned one); null means the wallet authority could not be consulted.
   */
  credits: number | "NO_WALLET" | null;
  /** now(), injected so staleness assertions are deterministic in tests. */
  nowMs: number;
}

const pass = (code: PartnerReadinessCode, message: string): ReadinessDimension => ({
  status: "PASS",
  code,
  message,
  actions: [],
});
const dim = (
  status: ReadinessStatus,
  code: PartnerReadinessCode,
  message: string,
  actions: ReadinessAction[] = []
): ReadinessDimension => ({ status, code, message, actions });

/** Order matters: the first non-PASS dimension becomes the overall verdict — the thing to fix first. */
const DIMENSION_ORDER: ReadinessDimensionKey[] = [
  "organisation",
  "location",
  "delivery",
  "operationsContact",
  "owner",
  "staff",
  "station",
  "scanner",
  "credits",
];

/**
 * Decide whether a Partner can start a NEW grading job right now, and if not, what single condition
 * to fix first.
 *
 * Pure and total: every branch returns a dimension, and there is no path on which an error, a null
 * or a missing row yields PASS. `ready` is true only when every dimension is PASS, so a single
 * UNKNOWN is sufficient to withhold READY — which is the intended behaviour, not a limitation.
 */
export function derivePartnerOperationalReadiness(facts: PartnerReadinessFacts): PartnerOperationalReadiness {
  const dimensions: Record<ReadinessDimensionKey, ReadinessDimension> = {
    organisation: deriveOrganisation(facts),
    location: deriveLocation(facts),
    delivery: deriveDeliveryAddress(facts),
    operationsContact: deriveOperationsContact(facts),
    owner: deriveOwner(facts),
    staff: deriveStaff(facts),
    station: deriveStation(facts),
    scanner: deriveScanner(facts),
    credits: deriveCredits(facts),
  };

  const firstProblem = DIMENSION_ORDER.map((k) => [k, dimensions[k]] as const).find(([, d]) => d.status !== "PASS");
  const ready = firstProblem === undefined;
  const overall = ready
    ? { ready: true, code: "READY" as const, message: "This shop can grade a card now." }
    : { ready: false, code: firstProblem[1].code, message: firstProblem[1].message };

  const actions = DIMENSION_ORDER.flatMap((key) =>
    dimensions[key].status === "PASS"
      ? []
      : dimensions[key].actions.map((a) => ({ ...a, dimension: key, code: dimensions[key].code }))
  );
  return { overall, dimensions, actions };
}

function deriveOrganisation(f: PartnerReadinessFacts): ReadinessDimension {
  if (f.orgStatus === "REVOKED") {
    return dim("BLOCKED", "PARTNER_REVOKED", "This partner has been revoked and cannot grade.");
  }
  if (f.orgStatus === "SUSPENDED") {
    return dim("BLOCKED", "PARTNER_SUSPENDED", "This partner is suspended. Grading is paused until it is reactivated.", [
      { audience: "SUPER_ADMIN", label: "Review partner status" },
    ]);
  }
  /*
   * FLAG READS FAIL CLOSED TO UNKNOWN, NOT TO "FINE". resolveGlobalFlag() returns false when it
   * cannot read the flag table, which is the right answer for a gate that must stay shut but the
   * wrong one for emergency stop, where false reads as "nothing is stopped". Readiness therefore
   * tracks whether the flags were READABLE at all and reports UNKNOWN when they were not, rather
   * than inferring calm from silence.
   */
  if (f.portalEnabled === null || f.loginFlagEnabled === null || f.emergencyStop === null) {
    return dim(
      "UNKNOWN",
      "CONFIGURATION_UNAVAILABLE",
      "Partner platform settings could not be read, so readiness cannot be confirmed."
    );
  }
  if (f.emergencyStop) {
    return dim("BLOCKED", "EMERGENCY_STOP", "MintVault has paused all partner activity. Grading is unavailable.");
  }
  if (!f.portalEnabled) {
    return dim("BLOCKED", "PORTAL_DISABLED", "The partner portal is switched off, so this shop cannot work.");
  }
  if (!f.loginFlagEnabled) {
    return dim("BLOCKED", "LOGIN_DISABLED", "Partner sign-in is switched off, so this shop cannot work.");
  }
  if (f.orgStatus !== "ACTIVE") {
    return dim("PENDING", "PARTNER_SUSPENDED", `This partner is ${String(f.orgStatus).toLowerCase()} and not yet live.`, [
      { audience: "SUPER_ADMIN", label: "Activate this partner" },
    ]);
  }
  return pass("READY", "This partner is active and the portal is open.");
}

function deriveOwner(f: PartnerReadinessFacts): ReadinessDimension {
  if (!f.owner) {
    return dim("BLOCKED", "OWNER_SETUP_REQUIRED", "This shop has no owner account yet.", [
      { audience: "SUPER_ADMIN", label: "Invite the shop owner" },
    ]);
  }
  const o = f.owner;
  if (o.userStatus === "REVOKED" || o.userStatus === "SUSPENDED") {
    return dim("BLOCKED", "USER_SUSPENDED", `The owner account is ${o.userStatus.toLowerCase()}.`, [
      { audience: "SUPER_ADMIN", label: "Review the owner account" },
    ]);
  }
  if (!o.passwordConfigured) {
    return o.invitationValid
      ? dim("PENDING", "AWAITING_PASSWORD_SETUP", "The owner has been invited and still needs to set their password.", [
          { audience: "SUPER_ADMIN", label: "Resend the invitation" },
        ])
      : dim(
          "BLOCKED",
          "INVITATION_EXPIRED",
          "The owner's invitation is no longer valid, so they cannot set a password. Send a new one.",
          [{ audience: "SUPER_ADMIN", label: "Send a new invitation" }]
        );
  }
  // mfa_required false means MFA is genuinely not a prerequisite here — it must not block.
  if (o.mfaRequired && !o.mfaConfigured) {
    return dim("BLOCKED", "AWAITING_MFA_SETUP", "The owner still needs to set up two-step sign-in.", [
      { audience: "PARTNER", label: "Set up two-step sign-in", href: "/partner/security" },
      { audience: "SUPER_ADMIN", label: "Review the owner's security setup" },
    ]);
  }
  return pass("READY", "The owner account is set up and can sign in.");
}

function deriveLocation(f: PartnerReadinessFacts): ReadinessDimension {
  return f.locationEligible
    ? pass("READY", "An active shop location is set up.")
    : dim("BLOCKED", "LOCATION_REQUIRED", "This shop has no active location the owner can work from.", [
        { audience: "SUPER_ADMIN", label: "Add or activate a location" },
      ]);
}

function deriveDeliveryAddress(f: PartnerReadinessFacts): ReadinessDimension {
  return f.deliveryAddressReady
    ? pass("READY", "The Main location has a complete delivery address.")
    : dim(
        "BLOCKED",
        "DELIVERY_ADDRESS_REQUIRED",
        "The Main location needs address line 1, town/city, postcode and country.",
        [
          { audience: "PARTNER", label: "Edit delivery address", href: "/partner/onboarding" },
          { audience: "SUPER_ADMIN", label: "Edit Main location address" },
        ]
      );
}

function deriveOperationsContact(f: PartnerReadinessFacts): ReadinessDimension {
  return f.operationsContactReady
    ? pass("READY", "An active primary operations contact with a valid email is set up.")
    : dim(
        "BLOCKED",
        "OPERATIONS_CONTACT_REQUIRED",
        "This shop needs an active primary operations contact with a valid email.",
        [
          { audience: "PARTNER", label: "Add or edit operations contact", href: "/partner/onboarding" },
          { audience: "SUPER_ADMIN", label: "Add or edit operations contact" },
        ]
      );
}

function deriveStation(f: PartnerReadinessFacts): ReadinessDimension {
  if (f.station === null) {
    return dim(
      "UNKNOWN",
      "STATION_UNAVAILABLE",
      "Scanner station records are unavailable, so readiness cannot be confirmed."
    );
  }
  const s = f.station;
  if (s.approvedActiveCount > 0) return pass("READY", "An approved Scanner station is set up.");
  if (s.pendingApprovalCount > 0) {
    // No approval button for the Partner: approving is MintVault's decision, and there is currently
    // no Super Admin station-approval screen to deep-link to either, so neither action carries href.
    return dim("PENDING", "STATION_APPROVAL_PENDING", "A Scanner station is registered and waiting for MintVault to approve it.", [
      { audience: "PARTNER", label: "Waiting for MintVault approval" },
      { audience: "SUPER_ADMIN", label: "Approve the registered station" },
    ]);
  }
  if (s.enrolledCount > 0) {
    return dim("BLOCKED", "STATION_SETUP_REQUIRED", "This shop's Scanner station is not active. It must be re-registered.", [
      { audience: "PARTNER", label: "Register this Mac in MintVault Scanner" },
    ]);
  }
  return dim("BLOCKED", "STATION_SETUP_REQUIRED", "No Scanner station is registered, so cards cannot be captured.", [
    { audience: "PARTNER", label: "Register this Mac in MintVault Scanner" },
  ]);
}

function deriveScanner(f: PartnerReadinessFacts): ReadinessDimension {
  if (f.station === null) {
    return dim("UNKNOWN", "CONFIGURATION_UNAVAILABLE", "Scanner health is unavailable, so readiness cannot be confirmed.");
  }
  const active = f.station.active;
  /*
   * Scanner health is only meaningful once a station qualifies; until then the station dimension
   * already carries the blocker and this one must not invent a second, confusing one.
   *
   * The two are kept consistent at the SOURCE: approvedActiveCount counts only stations on an ACTIVE
   * location, exactly like the health row's own join. Counting them differently produced a state
   * where the station dimension said "approved" while the health row was absent, and this branch
   * then told an operator to wait for an approval that had already happened.
   */
  if (!active) {
    return dim("PENDING", "STATION_SETUP_REQUIRED", "Scanner health will be checked once a station is approved.");
  }
  if (!active.scannerConnected) {
    return dim("BLOCKED", "SCANNER_OFFLINE", "The Scanner is not connected to this Mac.", [
      { audience: "PARTNER", label: "Reconnect the Scanner and open MintVault Scanner" },
    ]);
  }
  /*
   * STALENESS uses the SAME five-minute policy the shop's own operations console uses
   * (STATION_STALE_MINUTES). Reusing it rather than choosing a number here is the point: two
   * different thresholds would let the dashboard call a station online while readiness called it
   * offline, which is the class of contradiction this package exists to end.
   */
  if (!active.lastSeenAt) {
    return dim("UNKNOWN", "CONFIGURATION_UNAVAILABLE", "This Mac has not checked in yet, so the Scanner cannot be confirmed as ready.");
  }
  const seenMs = new Date(active.lastSeenAt).getTime();
  if (!Number.isFinite(seenMs)) {
    return dim("UNKNOWN", "CONFIGURATION_UNAVAILABLE", "The Scanner's last check-in could not be read.");
  }
  if (f.nowMs - seenMs > STATION_STALE_MINUTES * 60 * 1000) {
    return dim("BLOCKED", "SCANNER_OFFLINE", "This Mac has not checked in recently, so it looks offline.", [
      { audience: "PARTNER", label: "Open MintVault Scanner on the shop Mac" },
    ]);
  }
  /*
   * CALIBRATION matches the capture authority's own eligibility test, not just the status text.
   * station-service admits a station for capture only when calibration_status is VALID AND
   * current_calibration_id AND current_profile_revision_id are all present. Checking the status
   * alone would let readiness report a shop ready whose station the capture path would refuse to
   * list — one authority saying yes while the other says no, which is the whole failure mode P5
   * removes. `undefined` (column absent on this database) is not a missing value and is skipped.
   */
  const calibrationIncomplete =
    active.calibrationStatus !== "VALID" ||
    !active.currentCalibrationId ||
    active.currentProfileRevisionId === null;
  // A missing column is an unsupported schema capability, not proof that the
  // scanner can capture. It must withhold readiness rather than treating an
  // absent profile revision as a pass.
  if (active.currentProfileRevisionId === undefined) {
    return dim(
      "UNKNOWN",
      "CONFIGURATION_UNAVAILABLE",
      "The Scanner profile revision could not be confirmed, so readiness cannot be confirmed."
    );
  }
  if (calibrationIncomplete) {
    const wording =
      active.calibrationStatus === "EXPIRED"
        ? "The Scanner's colour calibration has expired and must be redone."
        : "The Scanner needs to be calibrated before it can capture cards.";
    return dim("BLOCKED", "CALIBRATION_REQUIRED", wording, [
      { audience: "PARTNER", label: "Run calibration in MintVault Scanner" },
    ]);
  }
  /*
   * VERSION uses the canonical appVersionSatisfies, unchanged. Its established rule is that a NULL
   * minimum means "no requirement set" and therefore satisfied — the same answer
   * resolveActiveStationByCode gives when admitting a station. Treating a null minimum as UNKNOWN
   * here would make readiness refuse a station the rest of the platform accepts, i.e. would create
   * the second divergent authority this package removes.
   *
   * The genuinely undecidable case is narrower and is separated out: a minimum IS set but the
   * installed version is missing or unparseable. "Update required" would be a claim we cannot
   * support, so that reports UNKNOWN. Either way it is not READY, so the two differ only in honesty.
   */
  const minimum = active.minimumSupportedVersion;
  if (minimum && !appVersionSatisfies(active.appVersion, minimum)) {
    return active.appVersion
      ? dim("BLOCKED", "SCANNER_UPDATE_REQUIRED", "MintVault Scanner is out of date on this Mac and must be updated.", [
          { audience: "PARTNER", label: "Update MintVault Scanner" },
        ])
      : dim(
          "UNKNOWN",
          "CONFIGURATION_UNAVAILABLE",
          "The MintVault Scanner version on this Mac could not be confirmed."
        );
  }
  return pass("READY", "The Scanner is connected, calibrated and up to date.");
}

function deriveCredits(f: PartnerReadinessFacts): ReadinessDimension {
  const buy: ReadinessAction[] = [
    { audience: "PARTNER", label: "Buy Grading Credits", href: "/partner/billing" },
    { audience: "SUPER_ADMIN", label: "Add credits for this shop" },
  ];
  if (f.credits === null) {
    return dim("UNKNOWN", "CONFIGURATION_UNAVAILABLE", "The credit balance could not be read, so readiness cannot be confirmed.");
  }
  if (f.credits === "NO_WALLET") {
    return dim("BLOCKED", "CREDITS_REQUIRED", "This shop has no credit account yet, so grading cannot start.", buy);
  }
  // Zero is the case the old checklist hid entirely: a shop with no credits cannot start a NEW job,
  // so it can never be READY however complete the rest of its setup looks.
  if (!(f.credits > 0)) {
    return dim("BLOCKED", "CREDITS_REQUIRED", "This shop has no Grading Credits left, so grading cannot start.", buy);
  }
  return pass("READY", "This shop has Grading Credits available.");
}

/**
 * STAFF — is there an operator who can actually run a Scanner at this shop?
 *
 * Two distinct failures, deliberately separated because the fix differs:
 *   STAFF_OPERATOR_REQUIRED            nobody scan-capable exists yet -> create one.
 *   STAFF_LOCATION_ASSIGNMENT_REQUIRED one exists but is location-scoped with no location -> assign.
 *
 * The second is the silent one. The user looks correct in every list, holds every scanning
 * capability, and still sees "No active authorised location is available for this account" at the
 * Scanner, because listPermittedStationLocations intersects location-scoped users with their
 * explicit assignments. Readiness now states that condition instead of leaving it to be discovered
 * at the glass.
 */
function deriveStaff(f: PartnerReadinessFacts): ReadinessDimension {
  // `== null` deliberately covers undefined too: an omitted fact is "not established", and this
  // contract must never resolve an unasked question to PASS.
  if (f.staff == null) {
    return dim("UNKNOWN", "CONFIGURATION_UNAVAILABLE", "MintVault could not confirm this shop's operators.");
  }
  if (f.staff.locationScopedWithoutLocation > 0) {
    return dim(
      "BLOCKED",
      "STAFF_LOCATION_ASSIGNMENT_REQUIRED",
      f.staff.locationScopedWithoutLocation === 1
        ? "An operator has no authorised location, so their Scanner cannot be set up."
        : `${f.staff.locationScopedWithoutLocation} operators have no authorised location, so their Scanners cannot be set up.`,
      [{ audience: "SUPER_ADMIN", label: "Assign an authorised location" }]
    );
  }
  if (f.staff.scanCapableCount < 1) {
    return dim("BLOCKED", "STAFF_OPERATOR_REQUIRED", "This shop has no operator who can scan cards.", [
      { audience: "SUPER_ADMIN", label: "Add an operator" },
    ]);
  }
  return pass("READY", "This shop has an operator who can scan cards.");
}
