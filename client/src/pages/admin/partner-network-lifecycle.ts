import { PARTNER_READINESS_DIMENSION_ORDER as DIMENSION_ORDER } from "@shared/partner-readiness";
import type {
  PartnerNextAction,
  PartnerOperationalReadiness,
  PartnerReadinessCode,
  ReadinessDimensionKey,
} from "@shared/partner-readiness";

/**
 * Presentation only: this translates the already-decided readiness payload into the operator's
 * next workspace destination. It deliberately does not decide readiness, calculate a score, or
 * turn an UNKNOWN into a pass.
 *
 * IT NO LONGER RANKS BLOCKERS. It used to find the first non-PASS dimension by walking
 * `Object.keys(readiness.dimensions)` — JavaScript insertion order, which matched the authority's
 * real fix-first order only by coincidence, and would have diverged silently the first time a
 * dimension was added anywhere but the end of the object literal. It also could never surface the
 * onboarding test card, because the test card deliberately lives outside `dimensions`. Both are now
 * the server's job: `readiness.nextAction` is the single answer and this file only decides where
 * that answer's link points.
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
  staff: "Staff setup",
  location: "Location setup",
  delivery: "Delivery address",
  operationsContact: "Operations contact",
  station: "Station setup",
  scanner: "Station setup",
  credits: "Credits setup",
};

const LABEL: Record<ReadinessDimensionKey, string> = {
  organisation: "Organisation",
  owner: "Staff",
  staff: "Operator access",
  location: "Location",
  delivery: "Delivery address",
  operationsContact: "Operations contact",
  station: "Station",
  scanner: "Scanner health",
  credits: "Credits",
};

const DESTINATION: Record<ReadinessDimensionKey, { suffix: string; label: string }> = {
  organisation: { suffix: "", label: "Review organisation" },
  owner: { suffix: "/staff", label: "Open Staff" },
  staff: { suffix: "/staff", label: "Open Staff" },
  location: { suffix: "/locations", label: "Open Locations" },
  delivery: { suffix: "/onboarding?step=location", label: "Edit delivery address" },
  operationsContact: { suffix: "/onboarding?step=contact", label: "Edit operations contact" },
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

  /*
   * Ordered by the canonical priority, and defensive about absence: the server always emits all
   * nine dimensions, but this is presentation code reading a network payload, and a truncated or
   * older payload should degrade to "not shown" rather than throw inside a render.
   */
  const dimensions = DIMENSION_ORDER.flatMap((key) => {
    const dimension = readiness.dimensions?.[key];
    return dimension ? [[key, dimension] as const] : [];
  });
  const completed = dimensions.filter(([, dimension]) => dimension.status === "PASS").map(([key]) => LABEL[key]);
  const blockers = dimensions
    .filter(([, dimension]) => dimension.status !== "PASS")
    .map(([key, dimension]) => `${LABEL[key]} — ${dimension.message}`);

  const next = readiness.nextAction;
  if (next.state === "READY") return { currentStage: "Ready to grade", completed, blockers: [], nextAction: null };

  return {
    currentStage: next.source === "testCard" ? "Onboarding test card" : next.source ? STAGE[next.source] : next.title,
    completed,
    blockers,
    nextAction: {
      // The server owns the wording; this file owns only where the link goes.
      label: next.action?.label ?? next.title,
      href: nextActionHref(partnerId, next),
    },
  };
}

/**
 * Where the server's next action lives in the Super Admin product.
 *
 * The server deliberately does not ship Super Admin hrefs — its `ReadinessAction.href` is written
 * for the Partner Portal, and a link is a property of the surface rendering it, not of the verdict.
 * So the destination is chosen here, keyed on the server's own `source` and reason code, and
 * nothing about WHICH blocker was selected is re-decided.
 */
export function nextActionHref(partnerId: string, next: PartnerNextAction): string {
  // Portal, login and emergency-stop are programme controls, not a Partner profile detail.
  if (PROGRAMME_SETTINGS_CODES.has(next.code)) return "/admin/partners/settings";
  // The onboarding wizard owns the test card, exactly as it owns inline station approval.
  if (next.source === "testCard" || next.source === null) return `/admin/partners/${partnerId}/onboarding`;
  return `/admin/partners/${partnerId}${DESTINATION[next.source].suffix}`;
}
