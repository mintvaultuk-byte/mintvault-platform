import { useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import GrowthCommandPage from "@/pages/admin/growth";

/**
 * DEV-ONLY local visual acceptance route for Growth Command.
 *
 * It mounts the shipping page, not a copy of its overview. Before that page can
 * request a session or intelligence, the fixture replaces fetch and responds to
 * the exact local API contracts it uses. Unknown /api paths are blocked, rather
 * than passed through, so this harness can never reach a database, provider, or
 * production authority. App.tsx only imports this module inside an
 * import.meta.env.DEV branch, which Vite removes from production builds.
 *
 * The values are deterministic display fixtures for local visual acceptance.
 * They do not claim to be live, production, or provider-derived telemetry.
 */

const FIXTURE_UPDATED = "2026-08-21T10:15:00.000Z";

function metric(value: number | string | undefined, unit: string, status: "GREEN" | "AMBER" | "UNKNOWN" = "GREEN") {
  return {
    state: value === undefined ? "NOT_INSTRUMENTED" : "REAL",
    status,
    ...(value === undefined ? {} : { value, unit }),
    source: "Local visual fixture",
    ...(value === undefined ? { reason: "Local fixture intentionally leaves this authority unconnected." } : {}),
    lastUpdated: FIXTURE_UPDATED,
  };
}

const series = (base: number, spread: number) => [
  base - spread,
  base,
  base + spread / 2,
  base - spread / 3,
  base + spread,
  base + spread / 3,
];

/**
 * Keys mirror the server's own GrowthTrafficClass identifiers so the harness
 * exercises the same classification the production console does, rather than a
 * parallel vocabulary that would let a classification bug pass unseen.
 */
function route(
  key: string,
  label: string,
  requestCount: number,
  p95LatencyMs: number,
  status: "GREEN" | "AMBER" | "RED" = "GREEN",
  confidence: "SUFFICIENT" | "LOW_SAMPLE" | "INSUFFICIENT_DATA" = "SUFFICIENT"
) {
  return {
    key,
    label,
    trafficClass: key,
    requestCount,
    p50LatencyMs: Math.round(p95LatencyMs * 0.52),
    p95LatencyMs,
    p99LatencyMs: Math.round(p95LatencyMs * 1.45),
    averageLatencyMs: Math.round(p95LatencyMs * 0.58),
    maxLatencyMs: Math.round(p95LatencyMs * 1.8),
    fiveXCount: 0,
    errorRatePercent: 0,
    trendP95LatencyMs: series(p95LatencyMs, 22),
    confidence,
    status,
  };
}

function intelligence(period: string) {
  // Reproduces the owner-reported production shape for visual acceptance: a fast
  // customer surface alongside a slow internal console. The console must not
  // colour the customer band. These are fixture values, never shipped defaults.
  const trafficClasses = [
    route("PUBLIC_CUSTOMER", "Public customer", 214, 64),
    route("SUBMISSION_CHECKOUT", "Submission / checkout", 48, 128),
    route("VERIFY_CERTIFICATE", "Verify / certificate", 96, 71),
    route("PARTNER", "Partner", 31, 143),
    route("SCANNER", "Scanner", 12, 96, "GREEN", "LOW_SAMPLE"),
    route("SUPER_ADMIN", "Super Admin", 26, 318, "AMBER"),
    route("GROWTH_COMMAND", "Growth Command", 42, 2448, "RED"),
    route("AI_MODEL", "AI / model", 5, 880, "AMBER", "LOW_SAMPLE"),
    route("HEALTH_INTERNAL", "Health / internal", 180, 9),
  ];
  const paid = { state: "MEASURED" as const, value: 12 };
  const metricSet = {
    paidSubmissions: paid,
    paidCards: { state: "MEASURED" as const, value: 46 },
    revenuePence: { state: "MEASURED" as const, value: 124800 },
    averageCardsPerPaidOrder: { state: "MEASURED" as const, value: 3.8 },
    unattributedPaidSubmissions: { state: "MEASURED" as const, value: 1 },
  };
  const scoreboard = {
    period: { kind: "MONTHLY", timezone: "Europe/London", start: "2026-08-01T00:00:00.000Z", end: "2026-08-31T23:59:59.999Z", progressPercent: 67.7 },
    targetAuthority: { state: "READY", mutationAuthority: "SUPER_ADMIN_ONLY", mcpMutationEnabled: false },
    metrics: [
      ["PAID_CARDS", "Paid cards", "COUNT", 46, 90],
      ["REVENUE_GBP", "Revenue", "GBP_PENCE", 124800, 250000],
      ["PARTNER_APPLICATIONS", "Partner applications", "COUNT", 12, 20],
      ["QUALIFIED_PARTNERS", "Qualified partners", "COUNT", 5, 10],
      ["GENUINE_REVIEWS", "Genuine reviews", "COUNT", 0, 12],
    ].map(([key, label, unit, actual, target]) => ({
      key,
      label,
      unit,
      actual: { state: "REAL", value: actual },
      target: { state: "SET", value: target, authority: "SUPER_ADMIN", lastSetAt: FIXTURE_UPDATED },
      status: key === "GENUINE_REVIEWS" ? "AMBER" : "GREEN",
      statusLabel: key === "GENUINE_REVIEWS" ? "ATTENTION" : "ON_TRACK",
      actualProgressPercent: (Number(actual) / Number(target)) * 100,
      expectedProgressPercent: 67.7,
      paceRatio: Number(actual) / Number(target),
      explanation: "Deterministic local visual fixture.",
    })),
    insights: [{ id: "fixture-scoreboard", kind: "ON_TRACK", metric: "PAID_CARDS", message: "Local fixture only: no target mutation leaves this browser." }],
    definition: "Local fixture mirrors the scoreboard shape for visual acceptance only.",
    lastUpdated: FIXTURE_UPDATED,
  };
  return {
    period,
    summary: {
      period,
      paid: metricSet,
      sourcePerformance: [
        { category: "DIRECT", paidSubmissions: 5, paidCards: 19, revenuePence: 52300, partnerApplications: 2 },
        { category: "OUTREACH", paidSubmissions: 4, paidCards: 16, revenuePence: 41200, partnerApplications: 7 },
        { category: "ORGANIC_SEARCH", paidSubmissions: 2, paidCards: 8, revenuePence: 21300, partnerApplications: 2 },
        { category: "REFERRAL", paidSubmissions: 1, paidCards: 3, revenuePence: 10000, partnerApplications: 1 },
      ],
      campaignPerformance: [
        { category: "OUTREACH", campaign: "medway_cataclysm", paidSubmissions: 3, paidCards: 12, revenuePence: 31800, partnerApplications: 5 },
        { category: "OUTREACH", campaign: "kent_card_shops", paidSubmissions: 1, paidCards: 4, revenuePence: 9400, partnerApplications: 2 },
        { category: "ORGANIC_SEARCH", campaign: "grading_guide", paidSubmissions: 2, paidCards: 8, revenuePence: 21300, partnerApplications: 0 },
      ],
      partnerApplications: { total: paid, new: { state: "MEASURED", value: 3 }, contacted: { state: "MEASURED", value: 4 }, qualified: { state: "MEASURED", value: 5 }, notAFit: { state: "MEASURED", value: 0 }, onboarding: { state: "MEASURED", value: 1 } },
      activePartners: { state: "MEASURED", value: 5 },
      partnerCardsPerPartner: { state: "NOT_INSTRUMENTED", reason: "Local fixture" },
      partnerRevenue: { state: "NOT_INSTRUMENTED", reason: "Local fixture" },
      repeatCustomerRate: { state: "NOT_INSTRUMENTED", reason: "Local fixture" },
      historical: { state: "NOT_INSTRUMENTED", reason: "Local fixture has no history." },
    },
    partnerPipeline: { total: paid, new: { state: "MEASURED", value: 3 }, contacted: { state: "MEASURED", value: 4 }, qualified: { state: "MEASURED", value: 5 }, notAFit: { state: "MEASURED", value: 0 }, onboarding: { state: "MEASURED", value: 1 } },
    livePulse: {
      submissionStarts: metric(18, "count"), checkoutStarts: metric(15, "count"), paidSubmissions: metric(12, "count"), paidCards: metric(46, "count"), revenuePence: metric(124800, "pence"), partnerApplications: metric(3, "count"), requestsPerMinute: metric(6.6, "requests/min"), requestsLastHour: metric(95, "requests"),
      revenueVelocity: { window: "60m", minimumPaidSample: 3, paidSubmissionsPerHour: metric(12, "submissions/h"), paidCardsPerHour: metric(46, "cards/h"), revenuePencePerHour: metric(124800, "pence/h"), comparison: metric("LOCAL ONLY", ""), definition: "Local fixture", lastUpdated: FIXTURE_UPDATED }, lastUpdated: FIXTURE_UPDATED,
    },
    siteHealth: {
      site: metric("Operational", "", "GREEN"), cpu: metric(6.7, "%"), memory: metric(16.6, "%"), requestRate: metric(6.6, "req/min"), p95Latency: metric(241, "ms"), fiveXErrorRate: metric(0, "%"), database: metric("Available", ""), databasePressure: metric(37.5, "%"), databaseLatency: metric(10, "ms"), flyMachines: metric("2 / 2 healthy", ""), payments: metric("Healthy", ""), email: metric("Not connected", "", "UNKNOWN"), partnerApi: metric("Healthy", ""), scannerApi: metric("Healthy", ""), lastUpdated: FIXTURE_UPDATED,
    },
    performanceDiagnostics: { scope: "CURRENT_APPLICATION_PROCESS", machineRef: "local-visual-fixture", window: "60m", minimumLatencySample: 10, minimumP99Sample: 20, trafficClasses, topSlowRoutes: [...trafficClasses].sort((a, b) => b.p95LatencyMs - a.p95LatencyMs), dependencies: [], lastUpdated: FIXTURE_UPDATED, complete: true },
    performanceInsight: { status: "AMBER", title: "Latency under observation", detail: "Local fixture presents a bounded p95 trend for visual inspection.", recommendation: "No infrastructure action is available from this screen." },
    capacity: { status: "GREEN", label: "HEADROOM", recommendation: "No capacity change is available.", evidence: ["Local fixture"], thresholdModel: "Local fixture", automaticScalingEnabled: false },
    infrastructure: {
      overallStatus: "GREEN", control: { currentMode: "MANUAL", currentAuthority: "MONITOR_DETECT_RECOMMEND", mutationEnabled: false, automaticScalingEnabled: false, futureMode: "GUARDED_AUTO_REQUIRES_SEPARATE_APPROVAL", futureModeAvailable: false, safetyBoundary: "No provider mutation is present in the local fixture." },
      fly: { connection: metric("Local fixture", ""), overallStatus: "GREEN", expectedMachineFields: [], machines: [
        { machineRef: "fixture-a1", status: "GREEN", region: "LHR", cpu: metric(6.7, "%"), memory: metric(16.4, "%"), requestRate: metric(7, "req/min"), requestCount: metric(61, "requests"), p95Latency: metric(149, "ms"), fiveXErrorRate: metric(0, "%"), deployedVersion: metric("local-fixture", ""), deployedSha: metric("local-only", "") },
        { machineRef: "fixture-b2", status: "AMBER", region: "LHR", cpu: metric(6.2, "%"), memory: metric(16.6, "%"), requestRate: metric(16, "req/min"), requestCount: metric(34, "requests"), p95Latency: metric(700, "ms", "AMBER"), fiveXErrorRate: metric(0, "%"), deployedVersion: metric("local-fixture", ""), deployedSha: metric("local-only", "") },
      ] },
      neon: { availability: metric("Available", ""), connectionPressure: metric("3 / 8", "connections"), latency: metric(10, "ms"), compute: metric(undefined, "", "UNKNOWN"), storage: metric(undefined, "", "UNKNOWN"), pointInTimeRecovery: metric(undefined, "", "UNKNOWN"), mutationEnabled: false },
      costs: { period: "MONTH_TO_DATE", providers: ["Fly", "Neon", "R2", "Resend"].map((provider) => ({ provider, state: "NOT_CONNECTED", status: "UNKNOWN", period: "MONTH_TO_DATE", sourceCurrency: null, reason: "Local fixture has no billing authority.", lastUpdated: FIXTURE_UPDATED })), trend: metric(undefined, ""), normalisedTotalGBP: metric(undefined, ""), costPerPaidCardGBP: metric(undefined, ""), costPerPaidOrderGBP: metric(undefined, ""), currencyPolicy: "No local cost estimate." },
      budget: { state: "NOT_CONFIGURED", status: "UNKNOWN", monthlyBudgetPence: null, automaticShutdownEnabled: false, automaticSpendEnabled: false, reason: "Local fixture has no budget authority." }, lastUpdated: FIXTURE_UPDATED,
    },
    campaignReadiness: { status: "GREEN", label: "READY", recommendation: "Visual fixture only; no campaign action exists.", evidence: ["Local fixture"], advisoryOnly: true, definition: "Local fixture" },
    incident: { status: "CLEAR", severity: null, priorityKey: null, title: "No local fixture incident", detail: "", recommendation: "" },
    revenueVelocity: { window: "60m", minimumPaidSample: 3, paidSubmissionsPerHour: metric(12, "submissions/h"), paidCardsPerHour: metric(46, "cards/h"), revenuePencePerHour: metric(124800, "pence/h"), comparison: metric("LOCAL ONLY", ""), definition: "Local fixture", lastUpdated: FIXTURE_UPDATED },
    seo: { searchConsole: metric(undefined, "", "UNKNOWN"), impressions: metric(undefined, "", "UNKNOWN"), clicks: metric(undefined, "", "UNKNOWN"), ctr: metric(undefined, "", "UNKNOWN"), averagePosition: metric(undefined, "", "UNKNOWN"), trend: metric(undefined, "", "UNKNOWN"), topQueries: metric(undefined, "", "UNKNOWN"), topPages: metric(undefined, "", "UNKNOWN"), technical: { sitemap: metric("Available", ""), robots: metric("Available", ""), indexabilityPolicy: metric("Not connected", "", "UNKNOWN") }, lastUpdated: FIXTURE_UPDATED },
    conversion: { stages: [
      { key: "submission_started", label: "Submission starts", metric: metric(18, "count") },
      { key: "checkout_started", label: "Checkout starts", metric: metric(15, "count") },
      { key: "paid", label: "Paid submissions", metric: metric(12, "count") },
      { key: "paid_cards", label: "Paid cards", metric: metric(46, "count") },
    ], submissionToCheckout: metric(83.3, "%"), checkoutToPaid: metric(80, "%"), submissionToPaid: metric(66.7, "%"), cardsPerPaidOrder: metric(3.8, "cards"), dropOff: metric(33.3, "%"), comparison: metric("Local fixture", ""), definition: "Local fixture" },
    scoreboard, insights: [
      { id: "local-green", priority: "INFO", title: "Local visual fixture", detail: "Synthetic data is confined to this DEV-only browser route.", recommendation: "Do not treat this as production evidence.", trace: { ruleId: "LOCAL_VISUAL", window: "none", result: "fixture" } },
      { id: "local-latency", priority: "ACTION", title: "Latency under observation", detail: "One fixture machine has elevated p95 samples.", recommendation: "Inspect real telemetry before action.", trace: { ruleId: "LOCAL_VISUAL", window: "60m", result: "fixture" } },
    ], freshness: "CURRENT", generatedAt: FIXTURE_UPDATED,
  };
}

function localResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function createGrowthVisualFetchFixture() {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url, window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) return fetch(input, init);
    if (url.pathname === "/api/admin/session") return localResponse({ authenticated: true, isSuperAdmin: true });
    if (url.pathname === "/api/admin/db-info") return localResponse({ env: "development", neon_host: "local-fixture", db_name: "visual-only", card_master_active_count: 0, card_sets_active_count: 0, certificates_count: 0, command_centre_available: false });
    if (url.pathname === "/api/super-admin/growth/intelligence") return localResponse(intelligence(url.searchParams.get("period") ?? "30d"));
    if (url.pathname === "/api/super-admin/growth/scoreboard/targets" && request.method === "PUT") return localResponse({ update: { changed: false, changedMetrics: [] }, scoreboard: intelligence("30d").scoreboard });
    if (url.pathname === "/api/super-admin/growth/reviews") return localResponse({ period: url.searchParams.get("period") ?? "30d", configuration: { state: "NOT_CONFIGURED", reason: "Local fixture: no sending provider." }, eligible: 0, scheduled: 0, sent: 0, deliveryFailed: 0, deliveryUncertain: 0, suppressed: 0, cancelled: 0, clicked: 0, publicReviews: { state: "NOT_CONNECTED", reason: "Local fixture: no public review authority." }, definition: "Local fixture", lastUpdated: FIXTURE_UPDATED });
    if (url.pathname === "/api/super-admin/growth/leads") return localResponse({ leads: [] });
    if (url.pathname === "/api/super-admin/growth/link-options") return localResponse({ targets: [{ value: "partner", label: "Partner" }, { value: "collector", label: "Collector" }], sources: ["outreach"], mediums: ["email"], campaigns: ["local_fixture"], contents: [] });
    if (url.pathname === "/api/super-admin/growth/links" && request.method === "POST") return localResponse({ url: "http://local-fixture.invalid/tracked-link" });
    return localResponse({ error: `DEV growth visual fixture blocks ${request.method} ${url.pathname}` }, 418);
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        queryFn: async ({ queryKey }) => {
          const response = await fetch(String(queryKey[0]), { credentials: "include" });
          if (!response.ok) throw new Error(`Local fixture request failed: ${response.status}`);
          return response.json();
        },
      },
      mutations: { retry: false },
    },
  });
}

export default function DevGrowthCommandVisualHarness() {
  const queryClient = useMemo(makeQueryClient, []);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const originalFetch = window.fetch;
    const originalPushState = window.history.pushState;
    window.fetch = createGrowthVisualFetchFixture();
    // The shipping page deliberately navigates its tabs to /admin/growth. Keep
    // that interaction inside this DEV-only fixture route while preserving the
    // query string the real page selected; production history is untouched.
    window.history.pushState = (state, title, url) => {
      const next = typeof url === "string" && url.startsWith("/admin/growth")
        ? `/dev/growth-command-visual${url.slice("/admin/growth".length)}`
        : url;
      return originalPushState.call(window.history, state, title, next);
    };
    setReady(true);
    return () => {
      window.fetch = originalFetch;
      window.history.pushState = originalPushState;
    };
  }, []);
  if (!ready) return null;
  return (
    <QueryClientProvider client={queryClient}>
      <p className="border-b border-amber-300/35 bg-black/90 px-2 py-1 text-center text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-200">
        DEV only · synthetic local fixture · API egress blocked
      </p>
      <GrowthCommandPage />
    </QueryClientProvider>
  );
}
