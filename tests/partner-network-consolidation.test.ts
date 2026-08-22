/**
 * PARTNER NETWORK CONSOLIDATION — the information architecture, pinned.
 *
 * WHAT WENT WRONG, AND WHAT THIS PREVENTS COMING BACK.
 *
 * A consolidated Partner Network was built, tested, and then shipped behind
 * `VITE_PARTNER_NETWORK_CONSOLIDATION`, which was compiled `false`. So the new surfaces existed and
 * were unreachable, while six navigation links collapsed onto two legacy pages: Overview and
 * Partners resolved to the SAME url, and Settings opened the partner list. The network's shop table
 * was built by three separate components, the summary rendered twice on one page, and alerts
 * rendered twice. That flag was the mechanism of the duplication, not merely a rollout detail.
 *
 * These assertions are deliberately about STRUCTURE — which surface owns which job — because that
 * is what regressed. Behavioural authority (station approval, credits, deletion, onboarding) is
 * covered by its own suites and must not be re-implemented here.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  activePipeline,
  alertDestination,
  isBottleneck,
  needsAttention,
  LOW_CREDIT_THRESHOLD,
} from "../client/src/pages/admin/partner-network-attention";
import type { PartnerNetworkOverview, PartnerTableRow } from "@shared/partner-dashboard";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
const app = read("client/src/App.tsx");
const shell = read("client/src/components/admin/admin-shell.tsx");
const overview = read("client/src/pages/admin/partner-network-overview.tsx");
const shops = read("client/src/pages/admin/partner-network-shops.tsx");
const settings = read("client/src/pages/admin/partner-management.tsx");
const detail = read("client/src/pages/admin/partner-management-detail.tsx");

// ---------------------------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------------------------
describe("primary navigation is four destinations", () => {
  it("offers exactly Overview, Shops, Supplies and Settings", () => {
    const block = shell.slice(
      shell.indexOf("export const PARTNER_NAV"),
      shell.indexOf("] as const;", shell.indexOf("export const PARTNER_NAV"))
    );
    const labels = [...block.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
    expect(labels).toEqual(["Overview", "Shops", "Supplies", "Settings"]);
    const hrefs = [...block.matchAll(/href: "([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([
      "/admin/partners",
      "/admin/partners/shops",
      "/admin/partners/supplies",
      "/admin/partners/settings",
    ]);
  });

  it("no longer offers Stations or Infrastructure as everyday destinations", () => {
    const nav = shell.slice(shell.indexOf('aria-label="Partner Network"'), shell.indexOf("</nav>"));
    expect(nav).not.toContain(">Stations<");
    expect(nav).not.toContain(">Infrastructure<");
    // ...and the two links that used to collapse onto one url are gone with them.
    expect(nav).not.toContain(">Partners<");
    expect(nav).not.toContain("Supplies Orders");
  });

  it("has no consolidation feature flag left to ship in the off position", () => {
    expect(shell).not.toContain('import.meta.env.VITE_PARTNER_NETWORK_CONSOLIDATION === "true"');
    expect(app).not.toContain('import.meta.env.VITE_PARTNER_NETWORK_CONSOLIDATION === "true"');
    expect(shell).toContain('const PARTNER_NETWORK_HOME = "/admin/partners";');
  });
});

// ---------------------------------------------------------------------------------------------
// Routes and redirects
// ---------------------------------------------------------------------------------------------
describe("every old Partner url still resolves", () => {
  const redirects: Array<[string, string]> = [
    ["/admin/partners/directory", "/admin/partners/shops"],
    ["/admin/partners/stations", "/admin/partners/settings/stations"],
    ["/admin/partners/infrastructure", "/admin/partners/settings/infrastructure"],
    ["/admin/partners/dashboard", "/admin/partners"],
    ["/admin/partner-network/partners", "/admin/partners/shops"],
    ["/admin/partner-network", "/admin/partners/settings/infrastructure"],
  ];

  for (const [from, to] of redirects) {
    it(`${from} → ${to}`, () => {
      const at = app.indexOf(`path="${from}"`);
      expect(at).toBeGreaterThan(-1);
      // The canonical target is declared on the redirect wrapper inside this route's own block.
      expect(app.slice(at, at + 400)).toContain(`canonical="${to}"`);
    });
  }

  it("keeps the literal Partner routes above the :partnerId route so a word is never read as an id", () => {
    const param = app.indexOf('path="/admin/partners/:partnerId"');
    expect(param).toBeGreaterThan(-1);
    for (const literal of ["shops", "supplies", "settings", "directory", "stations", "infrastructure", "dashboard"]) {
      const at = app.indexOf(`path="/admin/partners/${literal}"`);
      expect({ literal, before: at > -1 && at < param }).toEqual({ literal, before: true });
    }
  });

  it("routes the two advanced consoles under Settings without deleting them", () => {
    expect(app).toContain('path="/admin/partners/settings/stations"');
    expect(app).toContain('path="/admin/partners/settings/infrastructure"');
    expect(settings).toContain('href="/admin/partners/settings/stations"');
    expect(settings).toContain('href="/admin/partners/settings/infrastructure"');
  });
});

// ---------------------------------------------------------------------------------------------
// One list, one owner
// ---------------------------------------------------------------------------------------------
describe("the shop list is built exactly once", () => {
  it("Shops owns the table; Overview links to it instead of repeating it", () => {
    expect(shops).toContain('data-testid="pn-shops-table"');
    expect(overview).not.toContain("<table");
    expect(overview).toContain('data-testid="pn-overview-open-shops"');
    expect(overview).toContain('href="/admin/partners/shops"');
  });

  it("Settings does not render a second shop directory", () => {
    // The page keeps its directory code for the retained legacy screen, but the canonical Settings
    // path must not render it — that panel is what made Settings look like the Partners list.
    expect(settings).toContain('const isCanonicalSettings = pathname === "/admin/partners/settings";');
    expect(settings).toContain("const showDirectory = showLegacyFleetControls || !isCanonicalSettings;");
  });

  it("keeps the shop workspace complete, with the Scanner named as operators name it", () => {
    const block = detail.slice(detail.indexOf("const WORKSPACE_TABS"), detail.indexOf("type WorkspaceTab"));
    for (const key of [
      "overview",
      "onboarding",
      "cards",
      "staff",
      "locations",
      "stations",
      "credits",
      "activity",
      "security",
    ]) {
      expect(block).toContain(`"${key}"`);
    }
    // Label renamed; the ROUTE KEY is deliberately unchanged so deep links keep resolving.
    expect(detail).toContain('stations: "Scanner"');
    expect(app).toContain('path="/admin/partners/:partnerId/stations"');
  });
});

// ---------------------------------------------------------------------------------------------
// Small IA refinements
// ---------------------------------------------------------------------------------------------
describe("the everyday actions are where they are reached for", () => {
  it("offers Onboard a shop from Overview as well as Shops, through the one wizard", () => {
    expect(overview).toContain('data-testid="pn-overview-onboard"');
    expect(overview).toContain('href="/admin/partners/onboarding"');
    expect(shops).toContain('data-testid="pn-shops-onboard"');
    expect(shops).toContain('href="/admin/partners/onboarding"');
  });

  it("shows Locations on Shops using a value the bounded projection already carries", () => {
    expect(shops).toContain("<th>Locations</th>");
    expect(shops).toContain("shop.activeLocations === 0");
    // No second query was introduced to render it — still exactly ONE call site (the import of
    // `useQuery` is not a query, which is why this matches the call form rather than the name).
    expect(shops.match(/useQuery</g) ?? []).toHaveLength(1);
  });

  it("groups the wallet backfill as infrequent maintenance rather than everyday work", () => {
    expect(settings).toContain("Maintenance — Wallets / Credits");
  });

  it("points a destructive action at the audit surface that already exists", () => {
    expect(detail).toContain('data-testid="pm-delete-audit-link"');
    // The per-shop Audit tab, not a new network-wide audit page.
    expect(detail).toContain("/security");
  });
});

// ---------------------------------------------------------------------------------------------
// Needs Attention — the judgement on the Overview screen
// ---------------------------------------------------------------------------------------------
function shop(overrides: Partial<PartnerTableRow> = {}): PartnerTableRow {
  return {
    partnerId: "shop-1",
    publicRef: "ref-1",
    shopName: "Aardvark Cards",
    tradingName: null,
    status: "ACTIVE",
    onboardingStage: "Onboarded",
    qualityRating: { available: false, reason: "NO_DATA_SOURCE", detail: "n/a" },
    riskStatus: { level: "none", reasons: [] },
    availableCredits: 50,
    reservedCredits: 0,
    activeSubmissions: 0,
    cardsInPipeline: 0,
    openCorrections: 0,
    approvedDevices: { available: false, reason: "NO_DATA_SOURCE", detail: "n/a" },
    activeStaff: 2,
    activeLocations: 1,
    stationAttention: 0,
    stationsPendingApproval: 0,
    lastActivityAt: null,
    alertCount: 0,
    ...overrides,
  };
}

function payload(rows: PartnerTableRow[], alerts: PartnerNetworkOverview["alerts"] = []): PartnerNetworkOverview {
  return {
    summary: {
      shops: { total: rows.length, active: rows.length, suspended: 0, onboarding: 0, revoked: 0 },
      staff: { total: 0, active: 0, activeGraders: { available: false, reason: "NO_DATA_SOURCE", detail: "n/a" } },
      work: {
        inProgress: 0,
        byState: {},
        bottlenecks: 0,
        submissionsByStatus: {},
        completedToday: { available: false, reason: "NO_DATA_SOURCE", detail: "n/a" },
        completedThisMonth: { available: false, reason: "NO_DATA_SOURCE", detail: "n/a" },
      },
      corrections: { openEscalations: 0, manualReview: 0, reconciliationRequired: 0 },
      security: { openAlerts: 0, bySeverity: {} },
      credits: {
        totalAvailable: { available: true, value: 0 },
        totalReserved: { available: true, value: 0 },
        consumedThisMonth: { available: false, reason: "NO_DATA_SOURCE", detail: "n/a" },
      },
      unavailable: [],
      generatedAt: "2026-08-22T00:00:00.000Z",
    },
    partners: { rows, page: 1, pageSize: 25, total: rows.length, totalPages: 1 },
    alerts,
    generatedAt: "2026-08-22T00:00:00.000Z",
  };
}

describe("needs attention", () => {
  it("is empty when every shop is healthy, so the screen can say so plainly", () => {
    expect(needsAttention(payload([shop()]))).toEqual([]);
    expect(overview).toContain("ALL SHOPS OPERATING NORMALLY");
  });

  it("raises a Scanner waiting for approval, and sends the operator to the inline approval", () => {
    const [item] = needsAttention(payload([shop({ stationsPendingApproval: 1 })]));
    expect(item.severity).toBe("critical");
    expect(item.message).toBe("A Scanner is waiting for approval.");
    expect(item.actionLabel).toBe("Approve Scanner");
    // The onboarding wizard is the surface that already owns inline station approval.
    expect(item.href).toBe("/admin/partners/shop-1/onboarding");
  });

  it("does not report the same Mac twice as both pending and unhealthy", () => {
    // stationAttention counts pending stations too; only the surplus is a health problem.
    const items = needsAttention(payload([shop({ stationsPendingApproval: 1, stationAttention: 1 })]));
    expect(items.map((i) => i.actionLabel)).toEqual(["Approve Scanner"]);
  });

  it("separates no credits from low credits, and refuses to guess when the wallet is unreadable", () => {
    expect(needsAttention(payload([shop({ availableCredits: 0 })]))[0]).toMatchObject({
      severity: "critical",
      actionLabel: "Open credits",
    });
    expect(needsAttention(payload([shop({ availableCredits: LOW_CREDIT_THRESHOLD - 1 })]))[0]).toMatchObject({
      severity: "warning",
    });
    // null is "we could not read the wallet", which must never render as "no credits".
    expect(needsAttention(payload([shop({ availableCredits: null })]))).toEqual([]);
  });

  it("flags a shop with no active location, because nothing downstream can be set up", () => {
    const items = needsAttention(payload([shop({ activeLocations: 0 })]));
    expect(items[0]).toMatchObject({ severity: "critical", actionLabel: "Fix location" });
  });

  it("merges the server's own alerts and never lists one shop's problem twice", () => {
    const alerts = [
      {
        id: "credit-1",
        partnerId: "shop-1",
        partnerName: "Aardvark Cards",
        severity: "high" as const,
        kind: "credits_low",
        reason: "Credits are low.",
        recommendedAction: "Top up",
        detectedAt: null,
      },
    ];
    // The derived low-credit item targets the SAME shop and destination as the server alert.
    const items = needsAttention(payload([shop({ availableCredits: 1 })], alerts));
    expect(items.filter((i) => i.href === "/admin/partners/shop-1/credits")).toHaveLength(1);
    // First writer wins: the server's own wording is kept.
    expect(items[0].message).toBe("Credits are low.");
  });

  it("orders most-blocking first and stays stable between refreshes", () => {
    const rows = [
      shop({ partnerId: "b", shopName: "Beta", status: "PENDING" }),
      shop({ partnerId: "a", shopName: "Alpha", availableCredits: 0 }),
      shop({ partnerId: "c", shopName: "Gamma", stationAttention: 1 }),
    ];
    const items = needsAttention(payload(rows));
    expect(items.map((i) => i.severity)).toEqual(["critical", "warning", "info"]);
    expect(needsAttention(payload(rows))).toEqual(items);
  });

  it("routes each alert class to the surface that can resolve it", () => {
    expect(alertDestination({ id: "sec-1", partnerId: "p" })).toBe("/admin/partners/p/security");
    expect(alertDestination({ id: "credit-1", partnerId: "p" })).toBe("/admin/partners/p/credits");
    expect(alertDestination({ id: "lock-1", partnerId: "p" })).toBe("/admin/partners/p/staff");
    expect(alertDestination({ id: "org-1", partnerId: "p" })).toBe("/admin/partners/p/onboarding");
    // Escalations are network-wide, so they go to the console that now lives under Settings.
    expect(alertDestination({ id: "esc-1", partnerId: "p" })).toBe("/admin/partners/settings/infrastructure");
  });
});

// ---------------------------------------------------------------------------------------------
// The zero-only pipeline
// ---------------------------------------------------------------------------------------------
describe("the operational pipeline collapses when nothing is happening", () => {
  it("returns nothing when every state is zero", () => {
    expect(activePipeline({ queued: 0, claimed: 0, validating: 0, ready_for_import: 0, importing: 0 })).toEqual([]);
    expect(activePipeline(undefined)).toEqual([]);
  });

  it("shows only the states with work, busiest first", () => {
    expect(activePipeline({ queued: 2, claimed: 0, manual_review: 5 })).toEqual([
      { state: "manual_review", count: 5 },
      { state: "queued", count: 2 },
    ]);
  });

  it("still marks the states that mean work is stuck behind a human", () => {
    expect(["manual_review", "reconciliation_required", "failed"].map(isBottleneck)).toEqual([true, true, true]);
    expect(isBottleneck("queued")).toBe(false);
  });

  it("renders the pipeline panel only when it has rows", () => {
    // The band of QUEUED 0 / CLAIMED 0 / VALIDATING 0 … is what this replaces.
    expect(overview).toContain("{pipeline.length > 0 && (");
  });
});

// ---------------------------------------------------------------------------------------------
// No second authority
// ---------------------------------------------------------------------------------------------
describe("consolidation moved surfaces, not authority", () => {
  it("Overview and Shops both read the one bounded projection and nothing else", () => {
    for (const page of [overview, shops]) {
      expect(page).toContain('"/api/super-admin/partner-dashboard"');
      expect(page).not.toContain("/api/super-admin/partner-management");
      expect(page).not.toContain("/api/super-admin/fleet");
    }
  });

  it("neither page can mutate anything", () => {
    for (const page of [overview, shops]) {
      expect(page).not.toContain('apiRequest("POST"');
      expect(page).not.toContain('apiRequest("PATCH"');
      expect(page).not.toContain('apiRequest("DELETE"');
      expect(page).not.toContain("runAdminProtected");
    }
  });
});
