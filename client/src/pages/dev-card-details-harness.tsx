/**
 * Dev-only harness for the consolidated grading workspace (M-5 viewport evidence).
 *
 * Mounts the REAL production `CertificateForm` — the same component /admin
 * renders — with a representative certificate, so the three approved stages can
 * be captured at real viewport sizes without an admin password. The /admin route
 * itself is credential-gated and screenshots must not contain credentials, so
 * this harness is the sanctioned substitute the review allows: "a safe test
 * harness that renders the real production components with representative data".
 *
 * FINAL REVIEW (Grade-stage evidence): the Grade stage now renders the REAL
 * protected `GradingPanel` — the exact component admin-dashboard.tsx passes as
 * `workstationSlot` — instead of a placeholder box, so the Grade stage's own
 * layout (fixed-height shell, left card image, independently scrolling right
 * panel) is genuinely captured rather than assumed.
 *
 * `GradingPanel` is PROTECTED and is NOT modified by this harness — it is only
 * mounted. It issues exactly two read requests on mount
 * (`/certificates/:id/images` and `/certificates/:id/grading`); everything else
 * it does is a mutation behind a user action. `installReadOnlyApiStub()` below
 * answers those two GETs with representative in-memory data and HARD-BLOCKS
 * every non-GET request, so this harness cannot reach a server, cannot
 * authenticate, and cannot persist anything anywhere.
 *
 * DEV ONLY: registered behind `import.meta.env.DEV` in App.tsx, exactly like the
 * existing /dev/canonical-workstation harness, so the route is compiled out of
 * production builds and is not reachable there. (Vite may still emit the lazy
 * chunk itself — see the evidence README.) It contains NO credentials, cookies
 * or secrets, and no real customer data.
 */
import { useEffect, useState } from "react";
import CertificateForm from "@/components/certificate-form";
import GradingPanel from "@/components/grading/grading-panel";
import type { CertificateRecord } from "@shared/schema";

/** Representative, fully-populated certificate — no real customer data. */
const SAMPLE = {
  id: 1,
  certId: "MV-0000000001",
  cardGame: "pokemon",
  cardName: "Charizard",
  setName: "Base Set",
  cardNumber: "4/102",
  year: "1999",
  language: "English",
  rarity: "",
  rarityCode: "rare_holo",
  finishVariant: "holo",
  promoType: "",
  subsetName: "",
  era: "",
  variant: "",
  variantOther: null,
  rarityOther: null,
  collectionCode: null,
  collectionOther: null,
  designations: ["FIRST_EDITION"],
  gradeType: "numeric",
  gradeOverall: "9.5",
  labelType: "gold",
  status: "graded",
  notes: "Sample grader notes for layout capture.",
  structuredVariantVersion: 2,
} as unknown as CertificateRecord;

/** A card-shaped placeholder image, inline so no network fetch is needed. */
const SAMPLE_CARD_IMAGE =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="734" height="1024" viewBox="0 0 734 1024">
       <rect width="734" height="1024" rx="28" fill="#1c1c22"/>
       <rect x="34" y="34" width="666" height="956" rx="18" fill="#2a2a33" stroke="#D4AF37" stroke-width="4"/>
       <rect x="74" y="120" width="586" height="440" rx="10" fill="#3a3a46"/>
       <text x="367" y="70" text-anchor="middle" font-family="sans-serif" font-size="34" fill="#D4AF37">SAMPLE CARD</text>
       <text x="367" y="640" text-anchor="middle" font-family="sans-serif" font-size="30" fill="#cfcfd8">Charizard · Base Set 4/102</text>
       <text x="367" y="700" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#8b8b96">dev harness placeholder — not a real scan</text>
     </svg>`,
  );

/** The representative payload for GET /api/admin/certificates/:id/grading. */
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
  surface: { front: 9.5, back: 9 },
  defects: [],
  authStatus: "genuine",
  authNotes: "",
  gradeExplanation: "Sample explanation for layout capture.",
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
  aiDraftGrade: null,
  aiAnalysis: null,
  aiDefectCandidates: [],
};

/**
 * Answers the two admin GETs the protected workstation makes, and BLOCKS every
 * write. Installed once, for this dev route only. Anything that is not a
 * recognised admin GET falls through to the real fetch (Vite assets, HMR).
 */
function installReadOnlyApiStub(): () => void {
  const original = window.fetch.bind(window);
  const stub: typeof window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

    // HARD SAFETY: this harness must never write anywhere, to any environment.
    if (method !== "GET") {
      // eslint-disable-next-line no-console
      console.warn(`[dev-harness] blocked ${method} ${url} — this harness is read-only.`);
      return new Response(JSON.stringify({ error: "dev harness is read-only" }), { status: 405 });
    }
    if (/\/api\/admin\/certificates\/\d+\/images/.test(url)) {
      // Key names must match what the protected panel actually reads
      // (`front_display` / `front_original` / `front_cropped`, per side), or it
      // renders its no-images upload state instead of the card tool.
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
    if (/\/api\/admin\/certificates\/\d+\/grading/.test(url)) {
      return json(GRADING_PAYLOAD);
    }
    if (url.includes("/api/admin/")) {
      return json({}); // any other admin read → empty, never a live call
    }
    return original(input as RequestInfo, init);
  };
  window.fetch = stub;
  return () => {
    window.fetch = original;
  };
}

export default function DevCardDetailsHarness() {
  const [ready, setReady] = useState(false);

  // Install the read-only stub BEFORE the workstation mounts and issues its reads.
  useEffect(() => {
    const restore = installReadOnlyApiStub();
    setReady(true);
    return restore;
  }, []);

  // Expose a tiny hook so a headless capture run can select a stage by clicking
  // the REAL workflow bar button, rather than this harness faking stage state.
  useEffect(() => {
    const selectStage = (key: string) => {
      const btn = document.querySelector<HTMLButtonElement>(`[data-testid="workflow-stage-${key}"]`);
      if (!btn) return false;
      btn.click();
      return true;
    };
    (window as unknown as { __mvSelectStage?: (k: string) => boolean }).__mvSelectStage = selectStage;

    // `?stage=card-details|grade|review` performs the SAME real button click, so
    // a plain headless screenshot per URL still captures production stage gating
    // (no CDP driving, no new dependency, no harness-owned stage state).
    const wanted = new URLSearchParams(window.location.search).get("stage");
    if (!wanted) return;
    let tries = 0;
    const t = window.setInterval(() => {
      if (selectStage(wanted) || ++tries > 40) window.clearInterval(t);
    }, 50);
    return () => window.clearInterval(t);
  }, [ready]);

  if (!ready) return null;

  return (
    <div className="admin-root min-h-[100dvh] bg-[var(--admin-bg)]">
      <div className="px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-[var(--admin-gold)]">
        Card Details workspace — dev harness (real CertificateForm + real GradingPanel)
      </div>
      <CertificateForm
        certificate={SAMPLE}
        onSuccess={() => {}}
        workstationSlot={
          <GradingPanel
            certId={1}
            certIdStr="MV-0000000001"
            cardName={SAMPLE.cardName || ""}
            cardSet={SAMPLE.setName || ""}
            cardNumber={SAMPLE.cardNumber || ""}
            cardYear={SAMPLE.year || ""}
            cardGame={SAMPLE.cardGame || ""}
            existingGrade={SAMPLE.gradeOverall}
            pendingAnalysis={null}
            onPendingAnalysisConsumed={() => {}}
            onManualIdentification={() => {}}
            onGradeApproved={() => {}}
            onCertUpdated={async () => {}}
          />
        }
      />
    </div>
  );
}
