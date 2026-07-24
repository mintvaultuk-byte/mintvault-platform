import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  CanonicalGradingWorkstationShell,
  WORKSTATION_BODY_SCROLL_CLASS,
  WORKSTATION_HEADER_REGION_CLASS,
} from "@/components/grading-workflow/CanonicalGradingWorkstationShell";
import { WorkstationHeaderStrip } from "@/components/grading-workflow/WorkstationHeaderStrip";
import { WorkstationPreviewAside } from "@/components/grading-workflow/WorkstationPreviewAside";
import { RarityVariantPicker } from "@/components/rarity-picker/RarityVariantPicker";

/** DEV emission probe — mounts the picker seeded with a rarity and counts
 *  onChange calls on window.__rarityEmits so a browser check can prove the picker
 *  does NOT emit on mount (no spurious "touched"/wipe) but DOES on interaction. */
function RarityEmissionProbe() {
  (window as unknown as { __rarityEmits: number }).__rarityEmits = 0;
  return (
    <div data-testid="rarity-emission-probe" style={{ maxWidth: 520 }}>
      <RarityVariantPicker
        legacyVariant={null}
        value={{ language: "en", era: null, rarity: "rare_holo", finish: null, promo: null, subset: null }}
        onChange={() => {
          (window as unknown as { __rarityEmits: number }).__rarityEmits += 1;
        }}
      />
    </div>
  );
}

/**
 * DEV-ONLY preview harness for the canonical grading workstation shell.
 *
 * Mounts the REAL CanonicalGradingWorkstationShell + real WorkstationHeaderStrip
 * + real WorkstationPreviewAside with representative mock body content, so the
 * shared outer geometry (fixed viewport height, full width, two-panel columns,
 * internal scrolling, compact Overall Grade, sticky actions) can be inspected at
 * desktop and 13" widths across all role capability modes — WITHOUT auth, a
 * backend, or the protected GradingPanel data layer.
 *
 * It is mounted ONLY behind `import.meta.env.DEV` in App.tsx, so it never exists
 * in a production build. No provider calls, no real data.
 */
const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

type Mode = { key: string; label: string; actions: string[]; readOnly?: boolean };
const MODES: Mode[] = [
  { key: "super-admin", label: "Super Admin (/admin)", actions: ["Approve & Publish", "Certificate tools", "Correction mode"] },
  { key: "admin-review", label: "Admin Review (/admin/staff)", actions: ["Approve", "Return", "Reject"] },
  { key: "staff", label: "Staff (/staff)", actions: ["Save", "Submit for review"] },
  { key: "grader", label: "Grader (/grader)", actions: ["Save", "Submit for review"] },
  { key: "approved", label: "Approved / read-only", actions: [], readOnly: true },
];

const gold = "bg-gradient-to-r from-[var(--admin-gold)] to-[var(--admin-gold-deep)] text-[#1A1400]";
const card = "rounded-lg border border-[var(--admin-line)] bg-[var(--admin-panel2)] p-3";

function MockBody({ mode }: { mode: Mode }) {
  return (
    <div className={WORKSTATION_BODY_SCROLL_CLASS} data-testid="grading-workstation-slot">
      {/* identity summary (compact) */}
      <div className={card} data-canonical-section="identity-fields">
        <div className="text-[9px] uppercase tracking-wider text-[var(--admin-ink-faint)] mb-1">
          Card identity {mode.readOnly ? "· read-only" : "· verify"}
        </div>
        <div className="grid grid-cols-3 gap-x-3 gap-y-2 text-xs text-[var(--admin-ink)]">
          <div>Charizard</div><div>Base Set</div><div>4/102</div>
          <div>1999</div><div>Holo</div><div>Pokémon</div>
        </div>
      </div>
      {/* grade controls + MVGS (two representative tall blocks to force internal scroll) */}
      <div className={card} data-canonical-section="grading-controls">
        <div className="text-[var(--admin-gold)] text-xs font-bold uppercase tracking-widest mb-2">Manual Grading Workstation</div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-[60%_40%]">
          <div className="rounded border border-[var(--admin-line)] bg-[var(--admin-panel)] aspect-[3/4] max-h-[46vh] flex items-center justify-center text-[var(--admin-ink-faint)] text-xs">
            Card image + 8-dot centering tool
          </div>
          <div className="space-y-2">
            {["Centering", "Corners", "Edges", "Surface"].map((s) => (
              <div key={s} className="flex items-center justify-between text-xs text-[var(--admin-ink-dim)] border-b border-[var(--admin-line)] pb-1">
                <span>{s}</span><span className="font-bold text-[var(--admin-ink)]">9.5</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className={card} data-canonical-section="mvgs-score">MVGS sub-grade breakdown · D1 / D2 / D3</div>
      {/* compact Overall Grade — NOT a giant banner */}
      <div className="rounded-lg border border-[var(--admin-gold)]/40 p-3 flex items-center justify-between" data-canonical-section="grade-result">
        <span className="text-[9px] uppercase tracking-widest text-[var(--admin-gold)]/70">Overall Grade</span>
        <span className={`${gold} rounded px-3 py-1 text-lg font-bold`}>9.5</span>
      </div>
      {[...Array(6)].map((_, i) => (
        <div key={i} className={card}>Surface / authentication / notes block {i + 1} (fills height to prove internal scroll)</div>
      ))}
      {/* sticky footer actions */}
      <div className="sticky bottom-0 bg-[var(--admin-panel)] pt-2 pb-1 space-y-2" data-canonical-section="footer-actions">
        {mode.readOnly ? (
          <div className="w-full rounded border border-[var(--admin-green)]/40 bg-[var(--admin-green)]/10 text-[var(--admin-green)] text-xs font-bold uppercase px-4 py-2.5 text-center">
            Approved &amp; Live · read-only
          </div>
        ) : (
          <div className="flex gap-2">
            {mode.actions.map((a, i) => (
              <button key={a} className={`flex-1 text-[11px] font-bold uppercase px-3 py-2 rounded ${i === 0 ? gold : "border border-[var(--admin-line)] text-[var(--admin-ink-dim)]"}`}>
                {a}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function DevCanonicalWorkstationHarness() {
  const [width, setWidth] = useState<"desktop" | "macbook13">("desktop");
  const px = width === "desktop" ? 1440 : 1280; // 13" MacBook ≈ 1280 CSS px
  return (
    <QueryClientProvider client={qc}>
      <div className="admin-root min-h-screen bg-[var(--admin-bg)] text-[var(--admin-ink)] p-4">
        <div className="flex items-center gap-3 mb-3">
          <h1 className="text-[var(--admin-gold)] text-sm font-extrabold">Canonical Grading Workstation — dev harness</h1>
          <button onClick={() => setWidth("desktop")} className={`text-xs px-2 py-1 rounded border ${width === "desktop" ? gold : "border-[var(--admin-line)]"}`}>Desktop 1440</button>
          <button onClick={() => setWidth("macbook13")} className={`text-xs px-2 py-1 rounded border ${width === "macbook13" ? gold : "border-[var(--admin-line)]"}`}>13" 1280</button>
        </div>
        <div className="mb-4 rounded border border-[var(--admin-line)] p-2">
          <div className="text-[11px] uppercase tracking-wider text-[var(--admin-ink-faint)] mb-1">
            Rarity picker emission probe (seeded RARE_HOLO — window.__rarityEmits)
          </div>
          <RarityEmissionProbe />
        </div>
        <div className="space-y-6">
          {MODES.map((mode) => (
            <div key={mode.key}>
              <div className="text-[11px] uppercase tracking-wider text-[var(--admin-ink-faint)] mb-1">{mode.label}</div>
              {/* Bounded flex-column parent (like each route's focused view). The
                  shell FILLS this exactly — the workstation must reach the true
                  bottom with NO black band below it. */}
              <div
                className="mx-auto flex flex-col border border-[var(--admin-line)]"
                style={{ width: px, maxWidth: "100%", height: 640 }}
                data-harness-mode={mode.key}
              >
                <CanonicalGradingWorkstationShell previewAside={<WorkstationPreviewAside certificateId={null} />}>
                  <div className={WORKSTATION_HEADER_REGION_CLASS}>
                    <WorkstationHeaderStrip workflowCurrent={2} workflowMax={3} onStageClick={() => {}} sessionCompleted={0} />
                  </div>
                  <MockBody mode={mode} />
                </CanonicalGradingWorkstationShell>
              </div>
            </div>
          ))}
        </div>
      </div>
    </QueryClientProvider>
  );
}
