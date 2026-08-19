import type {
  PartnerOperationalReadiness,
  PartnerReadinessCode,
  ReadinessDimensionKey,
} from "@shared/partner-readiness";

/**
 * Presentation only: this translates the already-decided readiness payload into the operator's
 * next workspace destination. It deliberately does not decide readiness, calculate a score, or
 * turn an UNKNOWN into a pass.
 */
export interface PartnerLifecycleSummary {
  currentStage: string;
  completed: string[];
  blockers: string[];
  nextAction: { label: string; href: string } | null;
}

const STAGE: Record<ReadinessDimensionKey, string> = {
  organisation: "Organisation details",
  owner: "Staff setup",
  location: "Location setup",
  station: "Station setup",
  scanner: "Station setup",
  credits: "Credits setup",
};

const LABEL: Record<ReadinessDimensionKey, string> = {
  organisation: "Organisation",
  owner: "Staff",
  location: "Location",
  station: "Station",
  scanner: "Scanner health",
  credits: "Credits",
};

const DESTINATION: Record<ReadinessDimensionKey, { suffix: string; label: string }> = {
  organisation: { suffix: "", label: "Review organisation" },
  owner: { suffix: "/staff", label: "Open Staff" },
  location: { suffix: "/locations", label: "Open Locations" },
  station: { suffix: "/stations", label: "Open Stations" },
  scanner: { suffix: "/stations", label: "Open Stations" },
  credits: { suffix: "/credits", label: "Open Credits" },
};

const PROGRAMME_SETTINGS_CODES = new Set<PartnerReadinessCode>(["PORTAL_DISABLED", "LOGIN_DISABLED", "EMERGENCY_STOP"]);

export function partnerLifecycleSummary(
  partnerId: string,
  readiness: PartnerOperationalReadiness | undefined
): PartnerLifecycleSummary | null {
  if (!readiness) return null;

  const dimensions = (Object.keys(readiness.dimensions) as ReadinessDimensionKey[]).map(
    (key) => [key, readiness.dimensions[key]] as const
  );
  const current = dimensions.find(([, dimension]) => dimension.status !== "PASS");
  const completed = dimensions.filter(([, dimension]) => dimension.status === "PASS").map(([key]) => LABEL[key]);
  const blockers = dimensions
    .filter(([, dimension]) => dimension.status !== "PASS")
    .map(([key, dimension]) => `${LABEL[key]} — ${dimension.message}`);

  if (!current) return { currentStage: "Ready to grade", completed, blockers: [], nextAction: null };

  const [key, dimension] = current;
  // Portal, login and emergency-stop are programme controls, not a Partner profile detail.
  // Keep this routing decision keyed to the server-owned reason code so an organisation that is
  // merely pending still goes to its overview while a global control goes to canonical Settings.
  if (PROGRAMME_SETTINGS_CODES.has(dimension.code)) {
    return {
      currentStage: STAGE[key],
      completed,
      blockers,
      nextAction: { label: "Open Settings", href: "/admin/partners/settings" },
    };
  }

  const destination = DESTINATION[key];
  return {
    currentStage: STAGE[key],
    completed,
    blockers,
    nextAction: {
      label: destination.label,
      href: `/admin/partners/${partnerId}${destination.suffix}`,
    },
  };
}
