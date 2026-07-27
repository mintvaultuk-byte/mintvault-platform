/**
 * Certificate Tools drawer — Ownership + NFC, moved OUT of the grading scroll.
 *
 * These are fulfilment / admin tasks (often done by different staff, after
 * grading), so they no longer sit beneath the grading stages. This drawer
 * simply RE-PARENTS the existing OwnershipSection and NfcSection components —
 * their logic, endpoints and controls are unchanged. Both tabs stay mounted
 * (visibility toggled) so entered values are retained while the drawer is open.
 * Nothing here saves or mutates grading state.
 */
import { useEffect, useState } from "react";
import type { CertificateRecord } from "@shared/schema";
import OwnershipSection from "@/components/ownership-section";
import NfcSection from "@/components/nfc-section";
import { X, UserCheck, Wifi } from "lucide-react";

/** Tiny status summary shown beside the launcher button. */
export function certificateToolsStatus(cert: CertificateRecord | null) {
  const claimed = !!cert && !!cert.ownershipStatus && cert.ownershipStatus !== "unclaimed";
  const linked = !!cert && !!cert.nfcUid;
  return {
    ownership: claimed ? "Claimed" : "Unclaimed",
    nfc: linked ? "Linked" : "Not linked",
  };
}

/**
 * Compact Certificate Tools launcher — a single shared utility-button
 * primitive so every caller renders the SAME small pill (never a large
 * isolated top-right control) beside the certificate breadcrumb/title.
 * Function/behaviour unchanged: opens the drawer above; status text only.
 */
export function CertificateToolsButton({ cert, onOpen }: { cert: CertificateRecord; onOpen: () => void }) {
  const s = certificateToolsStatus(cert);
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="button-certificate-tools"
      className="flex items-center gap-1.5 rounded-lg border border-[var(--admin-gold)]/30 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[var(--admin-gold)]/90 hover:bg-[var(--admin-gold)]/10 transition-colors"
      title="Ownership + NFC (done after grading)"
    >
      Certificate Tools
      <span className="text-[8px] font-normal normal-case text-[var(--admin-ink-faint)]">
        {s.ownership} · {s.nfc}
      </span>
    </button>
  );
}

export function CertificateToolsDrawer({
  cert,
  open,
  onClose,
  onUpdated,
}: {
  cert: CertificateRecord;
  open: boolean;
  onClose: () => void;
  onUpdated: (updated: CertificateRecord) => void;
}) {
  const [tab, setTab] = useState<"ownership" | "nfc">("ownership");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const TabButton = ({ id, icon, label }: { id: "ownership" | "nfc"; icon: React.ReactNode; label: string }) => (
    <button
      type="button"
      onClick={() => setTab(id)}
      data-testid={`cert-tools-tab-${id}`}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-t-lg text-xs font-bold uppercase tracking-wider transition-colors ${
        tab === id ? "bg-[var(--admin-panel)] text-[var(--admin-gold)] border border-b-0 border-[var(--admin-line)]" : "text-[var(--admin-ink-faint)] hover:text-[var(--admin-gold)]"
      }`}
    >
      {icon} {label}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" role="dialog" aria-modal="true" aria-label="Certificate tools" data-testid="cert-tools-drawer">
      {/* Click-outside closes; inner panel stops propagation. */}
      <button type="button" aria-label="Close" className="absolute inset-0 cursor-default" onClick={onClose} />
      <div className="relative z-10 flex h-full w-full max-w-xl flex-col border-l border-[var(--admin-line)] bg-[var(--admin-bg)] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[var(--admin-line)] px-4 py-3">
          <div>
            <h2 className="text-sm font-bold uppercase tracking-wider text-[var(--admin-gold)]">Certificate Tools</h2>
            <p className="text-[10px] text-[var(--admin-ink-faint)]">{cert.certId} — ownership + NFC (done after grading)</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close certificate tools" title="Close (Esc)" className="flex h-7 w-7 items-center justify-center rounded text-[var(--admin-ink-faint)] hover:text-[var(--admin-gold)]">
            <X size={16} />
          </button>
        </div>

        <div className="flex gap-1 border-b border-[var(--admin-line)] px-3 pt-2">
          <TabButton id="ownership" icon={<UserCheck size={13} />} label="Ownership" />
          <TabButton id="nfc" icon={<Wifi size={13} />} label="NFC" />
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <div className={tab === "ownership" ? "" : "hidden"} data-testid="cert-tools-ownership">
            <p className="mb-2 text-[11px] text-[var(--admin-ink-dim)]">Create or assign the customer ownership record.</p>
            <OwnershipSection cert={cert} />
          </div>
          <div className={tab === "nfc" ? "" : "hidden"} data-testid="cert-tools-nfc">
            <p className="mb-2 text-[11px] text-[var(--admin-ink-dim)]">Link and manage the physical NFC tag inside the slab.</p>
            <NfcSection cert={cert} onUpdated={onUpdated} />
          </div>
        </div>
      </div>
    </div>
  );
}
