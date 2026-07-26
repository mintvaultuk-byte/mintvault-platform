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
 * DEV ONLY: registered behind `import.meta.env.DEV` in App.tsx, exactly like the
 * existing /dev/canonical-workstation harness, so it is never bundled for or
 * reachable in production. It contains NO credentials, cookies or secrets.
 *
 * The stage buttons drive the form's OWN workflow bar by clicking it — this
 * harness owns no stage state of its own, so what is captured is genuinely the
 * production gating, not a harness reimplementation of it.
 */
import { useEffect } from "react";
import CertificateForm from "@/components/certificate-form";
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

export default function DevCardDetailsHarness() {
  // Expose a tiny hook so a headless capture run can select a stage by clicking
  // the REAL workflow bar button, rather than this harness faking stage state.
  useEffect(() => {
    (window as unknown as { __mvSelectStage?: (k: string) => boolean }).__mvSelectStage = (key: string) => {
      const btn = document.querySelector<HTMLButtonElement>(`[data-testid="workflow-stage-${key}"]`);
      if (!btn) return false;
      btn.click();
      return true;
    };
  }, []);

  return (
    <div className="admin-root min-h-[100dvh] bg-[var(--admin-bg)]">
      <div className="px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-[var(--admin-gold)]">
        Card Details workspace — dev harness (real CertificateForm)
      </div>
      <CertificateForm
        certificate={SAMPLE}
        onSuccess={() => {}}
        workstationSlot={
          <div
            data-testid="harness-workstation-slot"
            className="flex min-h-[420px] items-center justify-center rounded-lg border border-[var(--admin-gold)]/20 bg-[var(--admin-panel2)] text-[12px] text-[var(--admin-ink-faint)]"
          >
            Protected grading workstation (card tool + defect marking) renders here
          </div>
        }
      />
    </div>
  );
}
