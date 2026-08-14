import { useEffect, useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GradingWorkstation, type GradingWorkstationMode } from "@/components/grading-workflow/GradingWorkstation";
import { DEV_CANONICAL_LABEL_PNG_BASE64 } from "./dev-canonical-label-fixtures";

/**
 * DEV-ONLY production-workstation harness.
 *
 * Every row below mounts the real GradingWorkstation and its real GradingPanel.
 * The method/path-exact fetch fixture is installed before they mount, so the
 * viewer, grading hydration, save -> authoritative preview -> Review barrier,
 * review summary and role-specific actions all run without auth or a backend.
 * No `/api/**` request is ever allowed to escape this page.
 */

const SAMPLE_CARD_IMAGE =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="734" height="1024" viewBox="0 0 734 1024">
       <rect width="734" height="1024" rx="28" fill="#111827"/>
       <rect x="34" y="34" width="666" height="956" rx="18" fill="#1f2937" stroke="#D4AF37" stroke-width="4"/>
       <rect x="74" y="120" width="586" height="440" rx="10" fill="#334155"/>
       <text x="367" y="70" text-anchor="middle" font-family="sans-serif" font-size="34" fill="#D4AF37">MINTVAULT FIXTURE</text>
       <text x="367" y="640" text-anchor="middle" font-family="sans-serif" font-size="30" fill="#f8fafc">Charizard · Base Set 4/102</text>
       <text x="367" y="700" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#94a3b8">deterministic dev-only scan</text>
     </svg>`
  );

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

const GRADING_PAYLOAD = {
  centeringFrontLr: "55/45",
  centeringFrontTb: "52/48",
  centeringBackLr: "60/40",
  centeringBackTb: "55/45",
  centeringOuterFront: null,
  centeringInnerFront: null,
  centeringOuterBack: null,
  centeringInnerBack: null,
  centeringMethod: "manual",
  corners: { tl: 9.5, tr: 9.5, bl: 9, br: 9.5 },
  edges: { top: 9.5, right: 9, bottom: 9.5, left: 9.5 },
  surface: {
    front: 9.5,
    back: 9,
    hasPrintLines: false,
    hasHoloScratches: false,
    hasSurfaceScratches: false,
    hasStaining: false,
    hasIndentation: false,
    hasRollerMarks: false,
    hasColorRegistration: false,
    hasCrease: false,
    hasTear: false,
  },
  defects: [],
  authStatus: "genuine",
  authNotes: "",
  gradeExplanation: "Deterministic grading evidence for the canonical workstation harness.",
  privateNotes: "",
  gradeApprovedBy: null,
  gradeApprovedAt: null,
  gradeStrengthScore: null,
  darkBorder: false,
  darkBorderFront: false,
  darkBorderBack: false,
  eyeAppealModifier: 0,
  whiteningLines: [],
  creaseLines: [],
  creaseSpanPct: null,
  wrinkleSeverity: null,
  tearSeverity: null,
  centeringScore: "9.0",
  cornersScore: "9.5",
  edgesScore: "9.5",
  surfaceScore: "9.5",
  grade: "9.5",
  gradeOverall: "9.5",
  // The production grade route returns this server-issued result on both the
  // initial record and every save. The workstation intentionally refuses to
  // render a client-calculated grade, so the harness must model that contract
  // instead of echoing writable grade fields from the request body.
  authoritativeGrade: {
    overall: "9.5",
    gradeType: "numeric",
    label: "MINT 9.5",
    subgrades: { centering: 9, corners: 9.5, edges: 9.5, surface: 9.5 },
    pristine: false,
    score: null,
    deductions: {},
  },
  rarityCode: "rare_holo",
  finishVariant: "holo",
  promoType: "",
  subsetName: "",
  era: "base",
  language: "English",
  serviceTier: "Standard",
  aiDraftGrade: null,
  aiAnalysis: null,
  aiDefectCandidates: [],
};

export type CanonicalHarnessRoleKey = "super-admin" | "staff" | "grader" | "partner" | "admin-review";

export interface CanonicalHarnessRequest {
  sequence: number;
  completionSequence: number | null;
  role: CanonicalHarnessRoleKey | "unknown";
  method: string;
  pathname: string;
  body: unknown;
  operation: CanonicalHarnessOperation;
  outcome: "pending" | "fixture" | "blocked" | "failed" | "stale" | "passthrough";
}

export type CanonicalHarnessOperation =
  | "asset"
  | "catalogue"
  | "images"
  | "grading-load"
  | "save"
  | "preview"
  | "unknown";

export interface CanonicalHarnessFixtureState {
  requests: CanonicalHarnessRequest[];
  savedPayloads: Partial<Record<CanonicalHarnessRoleKey, unknown>>;
  savedRevisions: Partial<Record<CanonicalHarnessRoleKey, number>>;
  records: Record<CanonicalHarnessRoleKey, Record<string, unknown>>;
  delayNext: (operation: CanonicalHarnessOperation, delayMs: number) => void;
  failNext: (operation: CanonicalHarnessOperation, status?: number) => void;
  staleNextPreview: (delayMs?: number) => void;
  snapshot: () => CanonicalHarnessRequest[];
  reset: () => void;
}

const ROLE_BY_BASE: Record<string, CanonicalHarnessRoleKey> = {
  "/api/admin": "super-admin",
  "/api/grader": "grader",
  "/api/partner/grading": "partner",
  "/api/admin/grade-review": "admin-review",
};

const ROLE_BY_CERTIFICATE_ID: Record<number, CanonicalHarnessRoleKey> = {
  101: "super-admin",
  102: "staff",
  103: "grader",
  104: "partner",
  105: "admin-review",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function roleForPath(pathname: string): { role: CanonicalHarnessRoleKey; apiBase: string } | null {
  // Longest-first is important because /api/admin is a prefix of grade-review.
  for (const apiBase of Object.keys(ROLE_BY_BASE).sort((a, b) => b.length - a.length)) {
    if (pathname === apiBase || pathname.startsWith(`${apiBase}/`)) return { role: ROLE_BY_BASE[apiBase], apiBase };
  }
  return null;
}

const PERSISTED_WIRE_TO_GRADING_RECORD: Record<string, string> = {
  overall_grade: "gradeOverall",
  auth_status: "authStatus",
  auth_notes: "authNotes",
  grade_explanation: "gradeExplanation",
  private_notes: "privateNotes",
  card_name: "cardName",
  set_name: "setName",
  card_number_display: "cardNumber",
  year_text: "year",
  rarity_code: "rarityCode",
  finish_variant: "finishVariant",
  promo_type: "promoType",
  grade_centering: "centeringScore",
  grade_corners: "cornersScore",
  grade_edges: "edgesScore",
  grade_surface: "surfaceScore",
  centering_front_lr: "centeringFrontLr",
  centering_front_tb: "centeringFrontTb",
  centering_back_lr: "centeringBackLr",
  centering_back_tb: "centeringBackTb",
  ai_defect_candidates: "aiDefectCandidates",
  dark_border: "darkBorder",
  dark_border_front: "darkBorderFront",
  dark_border_back: "darkBorderBack",
  eye_appeal_modifier: "eyeAppealModifier",
  whitening_lines: "whiteningLines",
  crease_lines: "creaseLines",
  crease_span_pct: "creaseSpanPct",
  wrinkle_severity: "wrinkleSeverity",
  tear_severity: "tearSeverity",
};

function normalisePersistedGradingRecord(persisted: Record<string, unknown>): Record<string, unknown> {
  const normalised: Record<string, unknown> = { ...persisted };
  for (const [wireKey, recordKey] of Object.entries(PERSISTED_WIRE_TO_GRADING_RECORD)) {
    if (Object.prototype.hasOwnProperty.call(persisted, wireKey)) normalised[recordKey] = persisted[wireKey];
  }
  const wireGrade = persisted.overall_grade ?? persisted.grade_overall ?? persisted.gradeOverall ?? persisted.grade;
  if (wireGrade != null) {
    normalised.grade = String(wireGrade);
    normalised.gradeOverall = String(wireGrade);
  }
  return normalised;
}

/** Exported for a focused runtime contract test. */
export function createCanonicalHarnessFetchFixture(originalFetch: typeof fetch): {
  fetch: typeof fetch;
  state: CanonicalHarnessFixtureState;
} {
  const requests: CanonicalHarnessRequest[] = [];
  const savedPayloads: Partial<Record<CanonicalHarnessRoleKey, unknown>> = {};
  const savedRevisions: Partial<Record<CanonicalHarnessRoleKey, number>> = {};
  const roles = Object.values(ROLE_BY_CERTIFICATE_ID);
  const records = Object.fromEntries(
    roles.map((role) => [role, { ...GRADING_PAYLOAD, reviewRevision: 1 }])
  ) as unknown as CanonicalHarnessFixtureState["records"];
  const delays: Partial<Record<CanonicalHarnessOperation, number[]>> = {};
  const failures: Partial<Record<CanonicalHarnessOperation, number[]>> = {};
  let stalePreviewDelay: number | null = null;
  let completionSequence = 0;

  const delayNext = (operation: CanonicalHarnessOperation, delayMs: number) => {
    (delays[operation] ??= []).push(Math.max(0, delayMs));
  };
  const failNext = (operation: CanonicalHarnessOperation, status = 503) => {
    (failures[operation] ??= []).push(status);
  };
  const staleNextPreview = (delayMs = 250) => {
    stalePreviewDelay = Math.max(1, delayMs);
  };
  const snapshot = () => requests.map((request) => ({ ...request, body: structuredClone(request.body) }));

  const reset = () => {
    requests.splice(0);
    for (const key of Object.keys(savedPayloads) as CanonicalHarnessRoleKey[]) delete savedPayloads[key];
    for (const key of Object.keys(savedRevisions) as CanonicalHarnessRoleKey[]) delete savedRevisions[key];
    for (const role of roles) records[role] = { ...GRADING_PAYLOAD, reviewRevision: 1 };
    for (const key of Object.keys(delays) as CanonicalHarnessOperation[]) delete delays[key];
    for (const key of Object.keys(failures) as CanonicalHarnessOperation[]) delete failures[key];
    stalePreviewDelay = null;
    completionSequence = 0;
  };

  const fixtureFetch: typeof fetch = async (input, init) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl, typeof window === "undefined" ? "http://harness.local" : window.location.origin);
    const pathname = url.pathname;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    let body: unknown = null;
    if (init?.body && typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const match = roleForPath(pathname);
    const certificateIdFromPath = Number(pathname.match(/\/certificates\/(\d+)/)?.[1]);
    const certificateIdFromBody = Number((body as { certificateId?: unknown } | null)?.certificateId);
    const certificateRole =
      ROLE_BY_CERTIFICATE_ID[certificateIdFromPath] ?? ROLE_BY_CERTIFICATE_ID[certificateIdFromBody];
    const requestRole =
      match?.apiBase === "/api/grader" && (certificateRole === "staff" || certificateRole === "grader")
        ? certificateRole
        : (match?.role ?? certificateRole ?? "unknown");
    const operation: CanonicalHarnessOperation = !pathname.startsWith("/api/")
      ? "asset"
      : pathname.endsWith("/catalogue/snapshot")
        ? "catalogue"
        : pathname.endsWith("/images") && method === "GET"
          ? "images"
          : pathname.endsWith("/grading") && method === "GET"
            ? "grading-load"
            : pathname.endsWith("/grade") && method === "PUT"
              ? "save"
              : pathname.endsWith("/label/preview") && method === "POST"
                ? "preview"
                : "unknown";
    const request: CanonicalHarnessRequest = {
      sequence: requests.length + 1,
      completionSequence: null,
      role: requestRole,
      method,
      pathname,
      body,
      operation,
      outcome: "pending",
    };
    requests.push(request);
    const finish = (outcome: CanonicalHarnessRequest["outcome"], role = requestRole) => {
      request.role = role;
      request.outcome = outcome;
      request.completionSequence = ++completionSequence;
    };
    let delayMs = delays[operation]?.shift() ?? 0;
    let stale = false;
    if (operation === "preview" && stalePreviewDelay != null) {
      delayMs = stalePreviewDelay;
      stalePreviewDelay = null;
      stale = true;
    }
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const failureStatus = failures[operation]?.shift();
    if (failureStatus != null) {
      finish("failed");
      return json({ error: `Deterministic harness ${operation} failure` }, failureStatus);
    }

    // Vite assets and HMR may pass through. API traffic never does.
    if (!pathname.startsWith("/api/")) {
      finish("passthrough");
      return originalFetch(input, init);
    }
    if (
      method === "GET" &&
      (pathname === "/api/partner/catalogue/snapshot" || pathname === "/api/catalogue/snapshot")
    ) {
      finish("fixture", pathname.startsWith("/api/partner") ? "partner" : requestRole);
      return json({ version: "dev-harness", sets: [], cards: [], rarities: [] });
    }
    if (!match) {
      finish("blocked");
      return json({ error: `No dev harness fixture for ${method} ${pathname}` }, 501);
    }

    const { apiBase } = match;
    const role = requestRole;
    const certificatePrefix = `${apiBase}/certificates/`;
    const certificateSuffix = pathname.startsWith(certificatePrefix) ? pathname.slice(certificatePrefix.length) : "";

    if (method === "GET" && /^\d+\/images$/.test(certificateSuffix)) {
      finish("fixture", role);
      return json({
        urls: {
          front_display: SAMPLE_CARD_IMAGE,
          front_original: SAMPLE_CARD_IMAGE,
          front_cropped: SAMPLE_CARD_IMAGE,
          back_display: SAMPLE_CARD_IMAGE,
          back_original: SAMPLE_CARD_IMAGE,
          back_cropped: SAMPLE_CARD_IMAGE,
        },
        quality: {},
      });
    }
    if (method === "GET" && /^\d+\/grading$/.test(certificateSuffix)) {
      finish("fixture", role);
      return json({ ...records[role], reviewRevision: savedRevisions[role] ?? 1 });
    }
    if (method === "PUT" && /^\d+\/grade$/.test(certificateSuffix)) {
      savedPayloads[role] = body;
      savedRevisions[role] = (savedRevisions[role] ?? 1) + 1;
      const authoritativeGrade = records[role].authoritativeGrade;
      const persisted = body as Record<string, unknown>;
      records[role] = {
        ...records[role],
        ...normalisePersistedGradingRecord(persisted),
        authoritativeGrade,
        reviewRevision: savedRevisions[role],
      };
      finish("fixture", role);
      return json({ ok: true, reviewRevision: savedRevisions[role], authoritativeGrade });
    }
    if (method === "POST" && certificateSuffix === "label/preview") {
      const certificateId = Number((body as { certificateId?: unknown } | null)?.certificateId);
      if (!Number.isInteger(certificateId) || certificateId <= 0) {
        finish("blocked", role);
        return json({ error: "The dev preview fixture requires its assigned certificateId" }, 400);
      }
      if (ROLE_BY_CERTIFICATE_ID[certificateId] !== role) {
        finish("blocked", role);
        return json({ error: "The dev preview fixture rejects cross-role certificate IDs" }, 403);
      }
      const expectedRevision = (body as { expectedRevision?: unknown } | null)?.expectedRevision;
      const authoritativeRevision = savedRevisions[role] ?? 1;
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== authoritativeRevision) {
        finish("blocked", role);
        return json({ code: "STALE_REVIEW", error: "The prepared review revision is stale" }, 409);
      }
      const grade = String(records[role].gradeOverall ?? records[role].grade ?? "").replace(/\.0$/, "");
      const fixtureBase64 = DEV_CANONICAL_LABEL_PNG_BASE64[grade];
      if (!fixtureBase64) {
        finish("blocked", role);
        return json({ error: `No canonical dev label fixture for authoritative grade ${grade}` }, 422);
      }
      finish(stale ? "stale" : "fixture", role);
      return new Response(decodeBase64(fixtureBase64), {
        status: 200,
        headers: {
          "content-type": "image/png",
          "x-mv-harness-grade": grade,
          "x-mv-harness-revision": String(authoritativeRevision),
          "x-mintvault-review-revision": String(authoritativeRevision),
        },
      });
    }
    finish("blocked", role);
    return json({ error: `No dev harness fixture for ${method} ${pathname}` }, 501);
  };

  return {
    fetch: fixtureFetch,
    state: { requests, savedPayloads, savedRevisions, records, delayNext, failNext, staleNextPreview, snapshot, reset },
  };
}

type HarnessWindow = Window &
  typeof globalThis & {
    __mvHarness?: {
      audit: () => CanonicalHarnessRequest[];
      savedPayloads: CanonicalHarnessFixtureState["savedPayloads"];
      savedRevisions: CanonicalHarnessFixtureState["savedRevisions"];
      records: CanonicalHarnessFixtureState["records"];
      reset: () => void;
      delayNext: CanonicalHarnessFixtureState["delayNext"];
      failNext: CanonicalHarnessFixtureState["failNext"];
      staleNextPreview: CanonicalHarnessFixtureState["staleNextPreview"];
      selectStage: (role: CanonicalHarnessRoleKey, stage: "card-details" | "grade" | "review") => boolean;
      inspection: (role: CanonicalHarnessRoleKey) => Record<string, string> | null;
      zoomIn: (role: CanonicalHarnessRoleKey, times?: number) => boolean;
      dragInspection: (
        role: CanonicalHarnessRoleKey,
        movement?: { fromX: number; fromY: number; toX: number; toY: number }
      ) => boolean;
      geometry: () => Record<CanonicalHarnessRoleKey, Record<string, { width: number; height: number }>>;
    };
  };

type HarnessViewportKey = "1280x800" | "1024x768";

const HARNESS_VIEWPORTS: Record<HarnessViewportKey, { width: number; height: number; label: string }> = {
  "1280x800": { width: 1280, height: 800, label: "1280 × 800" },
  "1024x768": { width: 1024, height: 768, label: "1024 × 768" },
};

interface HarnessMode {
  key: CanonicalHarnessRoleKey;
  label: string;
  mode: GradingWorkstationMode;
  apiBase: string;
  certId: number;
  graderMode?: boolean;
  adminReview?: boolean;
}

const MODES: HarnessMode[] = [
  { key: "super-admin", label: "Super Admin (/admin)", mode: "super-admin", apiBase: "/api/admin", certId: 101 },
  { key: "staff", label: "Staff (/staff)", mode: "staff", apiBase: "/api/grader", certId: 102, graderMode: true },
  { key: "grader", label: "Grader (/grader)", mode: "grader", apiBase: "/api/grader", certId: 103, graderMode: true },
  {
    key: "partner",
    label: "Partner (/partner)",
    mode: "partner",
    apiBase: "/api/partner/grading",
    certId: 104,
    graderMode: true,
  },
  {
    key: "admin-review",
    label: "Pending Review (/admin/staff)",
    mode: "admin-review",
    apiBase: "/api/admin/grade-review",
    certId: 105,
    adminReview: true,
  },
];

const gold = "bg-gradient-to-r from-[var(--admin-gold)] to-[var(--admin-gold-deep)] text-[#1A1400]";

function HarnessWorkstation({
  mode,
  viewport,
}: {
  mode: HarnessMode;
  viewport: (typeof HARNESS_VIEWPORTS)[HarnessViewportKey];
}) {
  return (
    <div
      className="mx-auto flex min-h-0 flex-col border border-[var(--admin-line)]"
      data-harness-mode={mode.key}
      data-harness-viewport={`${viewport.width}x${viewport.height}`}
      style={{ height: viewport.height - 72 }}
    >
      <GradingWorkstation
        mode={mode.mode}
        apiBase={mode.apiBase}
        graderMode={mode.graderMode}
        adminReview={mode.adminReview}
        certId={mode.certId}
        certIdStr={`MV-${String(mode.certId).padStart(10, "0")}`}
        cardName="Charizard"
        cardSet="Base Set"
        cardNumber="4/102"
        cardYear="1999"
        cardLanguage="English"
        cardVariant="Rare Holo · Holo"
        cardGame="pokemon"
        existingGrade="9.5"
        pendingAnalysis={null}
        onPendingAnalysisConsumed={() => {}}
        onManualIdentification={() => {}}
        onGradeApproved={() => {}}
        onCertUpdated={async () => {}}
      />
    </div>
  );
}

export default function DevCanonicalWorkstationHarness() {
  const [ready, setReady] = useState(false);
  const [viewportKey, setViewportKey] = useState<HarnessViewportKey>("1280x800");
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            refetchOnWindowFocus: false,
            staleTime: Infinity,
            gcTime: Infinity,
            queryFn: async ({ queryKey }) => {
              const response = await fetch(String(queryKey[0]), { credentials: "include" });
              if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? response.statusText);
              return response.json();
            },
          },
          mutations: { retry: false },
        },
      }),
    []
  );

  useEffect(() => {
    const originalFetch = window.fetch.bind(window);
    const fixture = createCanonicalHarnessFetchFixture(originalFetch);
    const target = window as HarnessWindow;
    window.fetch = fixture.fetch;
    target.__mvHarness = {
      audit: fixture.state.snapshot,
      savedPayloads: fixture.state.savedPayloads,
      savedRevisions: fixture.state.savedRevisions,
      records: fixture.state.records,
      reset: fixture.state.reset,
      delayNext: fixture.state.delayNext,
      failNext: fixture.state.failNext,
      staleNextPreview: fixture.state.staleNextPreview,
      selectStage: (role, stage) => {
        const root = document.querySelector(`[data-harness-mode="${role}"]`);
        const button = root?.querySelector<HTMLButtonElement>(`[data-testid="workflow-stage-${stage}"]`);
        if (!button) return false;
        button.click();
        return true;
      },
      inspection: (role) => {
        const viewport = document.querySelector<HTMLElement>(
          `[data-harness-mode="${role}"] [data-testid="grading-image-viewport"]`
        );
        if (!viewport) return null;
        return {
          side: viewport.dataset.inspectionSide ?? "",
          zoom: viewport.dataset.inspectionZoom ?? "",
          focusX: viewport.dataset.inspectionFocusX ?? "",
          focusY: viewport.dataset.inspectionFocusY ?? "",
          coordinateMode: viewport.dataset.coordinateMode ?? "",
        };
      },
      zoomIn: (role, times = 1) => {
        const root = document.querySelector(`[data-harness-mode="${role}"]`);
        const button = root?.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]');
        if (!button) return false;
        for (let index = 0; index < times; index += 1) button.click();
        return true;
      },
      dragInspection: (role, movement = { fromX: 240, fromY: 300, toX: 300, toY: 340 }) => {
        const viewport = document.querySelector<HTMLElement>(
          `[data-harness-mode="${role}"] [data-testid="grading-image-viewport"]`
        );
        if (!viewport) return false;
        viewport.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, clientX: movement.fromX, clientY: movement.fromY })
        );
        viewport.dispatchEvent(
          new MouseEvent("mousemove", { bubbles: true, clientX: movement.toX, clientY: movement.toY })
        );
        viewport.dispatchEvent(
          new MouseEvent("mouseup", { bubbles: true, clientX: movement.toX, clientY: movement.toY })
        );
        return true;
      },
      geometry: () => {
        const box = (element: Element | null) => {
          const { width, height } = element?.getBoundingClientRect() ?? { width: 0, height: 0 };
          return {
            width: Math.round(width * 1000) / 1000,
            height: Math.round(height * 1000) / 1000,
          };
        };
        const geometry = {} as Record<CanonicalHarnessRoleKey, Record<string, { width: number; height: number }>>;
        for (const { key } of MODES) {
          const root = document.querySelector(`[data-harness-mode="${key}"]`);
          geometry[key] = {
            workspace: box(root?.querySelector('[data-testid="grading-workspace"]') ?? null),
            leftRail: box(root?.querySelector('[data-testid="grading-preview-panel"]') ?? null),
            largeCard: box(root?.querySelector('[data-testid="grading-interactive-card-host"]') ?? null),
            compactPreview: box(root?.querySelector('[data-testid="certificate-preview-image"]') ?? null),
            stageHeader: box(root?.querySelector('[data-testid="workstation-strip"]') ?? null),
            rightPane: box(root?.querySelector('[data-testid="grading-control-panel"]') ?? null),
          };
        }
        return geometry;
      },
    };
    try {
      window.localStorage.setItem("mv.aiIdentify", "0");
    } catch {
      // The harness also accepts the URL without this preference.
    }
    setReady(true);
    return () => {
      window.fetch = originalFetch;
      delete target.__mvHarness;
    };
  }, []);

  if (!ready) return null;
  const viewport = HARNESS_VIEWPORTS[viewportKey];

  return (
    <QueryClientProvider client={queryClient}>
      <div className="admin-root min-h-screen bg-[var(--admin-bg)] p-4 text-[var(--admin-ink)]">
        <div className="mb-3 flex items-center gap-3">
          <h1 className="text-sm font-extrabold text-[var(--admin-gold)]">
            Canonical Grading Workstation — real dev harness
          </h1>
          <button
            data-testid="harness-viewport-1280x800"
            onClick={() => setViewportKey("1280x800")}
            className={`rounded border px-2 py-1 text-xs ${viewportKey === "1280x800" ? gold : "border-[var(--admin-line)]"}`}
          >
            1280 × 800
          </button>
          <button
            data-testid="harness-viewport-1024x768"
            onClick={() => setViewportKey("1024x768")}
            className={`rounded border px-2 py-1 text-xs ${viewportKey === "1024x768" ? gold : "border-[var(--admin-line)]"}`}
          >
            1024 × 768
          </button>
        </div>
        <div
          className="space-y-6"
          data-testid="canonical-harness-viewport"
          data-harness-viewport={`${viewport.width}x${viewport.height}`}
          style={{ width: viewport.width, maxWidth: "100%" }}
        >
          {MODES.map((mode) => (
            <section key={mode.key} data-testid={`canonical-harness-role-${mode.key}`}>
              <div className="mb-1 text-[11px] uppercase tracking-wider text-[var(--admin-ink-faint)]">
                {mode.label}
              </div>
              <HarnessWorkstation mode={mode} viewport={viewport} />
            </section>
          ))}
        </div>
      </div>
    </QueryClientProvider>
  );
}
