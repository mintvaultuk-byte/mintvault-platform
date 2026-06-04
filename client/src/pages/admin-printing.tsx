import { useState, useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { apiRequest } from "@/lib/queryClient";
import type { CertificateRecord } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  Loader2,
  PrinterCheck,
  FileDown,
  CheckSquare,
  Square,
  RefreshCw,
  LayoutGrid,
  BookOpen,
  Search,
  X,
  Printer,
  Eye,
  EyeOff,
  Pencil,
  PlusCircle,
  AlertCircle,
  Clock,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import AdminCertBrowser from "./admin-cert-browser";

// Guillotine PDF — 5 certs per sheet, full A4, slab pair + claim insert per row.
// PRINT_BATCH_MAX is defined inside SheetPrintingPanel (kept close to its
// only consumer); we expose the same number here for "select first N" UI.
// Mirrors server/print-batch.ts MAX_CERTS_PER_BATCH (currently 5).
const MAX_CERTS_PER_BATCH = 5;

type CertForPrinting = CertificateRecord & { lastPrintedAt: string | null };
type FilterMode = "all" | "unprinted" | "printed";
type SheetSummary = {
  sheetRef: string;
  total: number;
  printed: boolean;
  queuedAt: string;
  printedAt: string | null;
};

function gradeDisplay(cert: CertificateRecord): string {
  if (!cert.gradeOverall) return "—";
  const n = parseFloat(cert.gradeOverall);
  return isNaN(n) ? cert.gradeOverall : String(n);
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });
}

// ── Edit Label Modal ──────────────────────────────────────────────────────────
function EditLabelModal({
  certId,
  cert,
  onClose,
}: {
  certId: string;
  cert: CertificateRecord | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: existing, isLoading } = useQuery<{
    cardNameOverride?: string | null;
    setOverride?: string | null;
    variantOverride?: string | null;
    languageOverride?: string | null;
    yearOverride?: string | null;
  } | null>({
    queryKey: ["/api/admin/printing/override", certId],
    queryFn: () => apiRequest("GET", `/api/admin/printing/override/${certId}`).then((r) => r.json()),
  });

  const form = useForm<{ cardName: string; setName: string; variant: string; language: string; year: string }>({
    values: {
      cardName: existing?.cardNameOverride ?? cert?.cardName ?? "",
      setName: existing?.setOverride ?? cert?.setName ?? "",
      variant: existing?.variantOverride ?? cert?.variant ?? "",
      language: existing?.languageOverride ?? cert?.language ?? "",
      year: existing?.yearOverride ?? cert?.year ?? "",
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (data: {
      cardName: string;
      setName: string;
      variant: string;
      language: string;
      year: string;
    }) => {
      const res = await apiRequest("POST", `/api/admin/printing/override/${certId}`, {
        cardNameOverride: data.cardName || null,
        setOverride: data.setName || null,
        variantOverride: data.variant || null,
        languageOverride: data.language || null,
        yearOverride: data.year || null,
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
    },
    onSuccess: () => {
      toast({ title: "Label data updated", description: `${certId} overrides saved` });
      qc.invalidateQueries({ queryKey: ["/api/admin/printing/override", certId] });
      onClose();
    },
    onError: (err: any) => toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent
        className="bg-[var(--admin-panel)] border-[var(--admin-line)] text-[var(--admin-ink)] max-w-md"
        data-testid="edit-label-modal"
      >
        <DialogHeader>
          <DialogTitle className="text-[var(--admin-gold-hi)] flex items-center gap-2">
            <Pencil className="h-4 w-4" /> Edit Label Data — {certId}
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-[var(--admin-gold)]" />
          </div>
        ) : (
          <form onSubmit={form.handleSubmit((d) => saveMutation.mutate(d))} className="space-y-4">
            <div className="rounded-md bg-[var(--admin-panel2)] border border-[var(--admin-line)] p-3 text-[11px] text-[var(--admin-gold-hi)] flex gap-2">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              Label display only — grade, cert number, QR code and schema are not changed.
            </div>

            {[
              { id: "cardName", label: "Card Name" },
              { id: "setName", label: "Set Name" },
              { id: "variant", label: "Variant" },
              { id: "language", label: "Language" },
              { id: "year", label: "Year" },
            ].map(({ id, label }) => (
              <div key={id} className="space-y-1">
                <Label htmlFor={`edit-${id}`} className="text-xs text-[var(--admin-ink-dim)]">
                  {label}
                </Label>
                <Input
                  id={`edit-${id}`}
                  {...form.register(id as any)}
                  className="h-8 text-sm bg-[var(--admin-bg2)] border-[var(--admin-line-hard)] text-[var(--admin-ink)]"
                  data-testid={`input-edit-${id}`}
                />
              </div>
            ))}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={onClose}
                className="text-[var(--admin-ink-faint)] hover:text-[var(--admin-ink)]"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={saveMutation.isPending}
                className="bg-[var(--admin-gold)] hover:bg-[var(--admin-gold-hi)] text-[#1c1607] font-bold"
                data-testid="btn-save-label-edit"
              >
                {saveMutation.isPending ? (
                  <>
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" /> Saving…
                  </>
                ) : (
                  "Save Label Data"
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Reprint Reason Modal — admin override for claimed certs ─────────────────
// v525 — when /api/admin/print-batch rejects with 409 because one or more
// selected certs are claimed, this modal collects the reason and re-submits
// to /api/admin/print-batch/reprint. Reason 10-500 chars, recorded to
// audit_log per cert.
function ReprintReasonModal({
  claimedCertIds,
  allCertIds,
  onCancel,
  onSubmit,
  submitting,
}: {
  claimedCertIds: string[];
  allCertIds: string[];
  onCancel: () => void;
  onSubmit: (reason: string) => void;
  submitting: boolean;
}) {
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();
  const valid = trimmed.length >= 10 && trimmed.length <= 500;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        className="bg-[var(--admin-panel)] border-[var(--admin-line)] text-[var(--admin-ink)] max-w-md"
        data-testid="reprint-reason-modal"
      >
        <DialogHeader>
          <DialogTitle className="text-[var(--admin-gold-hi)] flex items-center gap-2">
            <AlertCircle className="h-4 w-4" /> Reprint claimed cert(s)
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md bg-[var(--admin-panel2)] border border-[var(--admin-line)] p-3 text-[11px] text-[var(--admin-gold-hi)] flex gap-2">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold mb-1">
                {claimedCertIds.length} of {allCertIds.length} selected cert(s) already claimed:
              </p>
              <p className="text-[10px] break-all" style={{ fontFamily: "var(--admin-mono)" }}>
                {claimedCertIds.join(", ")}
              </p>
              <p className="mt-2">
                Reprinting a claimed cert is recorded to audit_log with the reason below. Use only for damaged-in-post,
                lost, or bad-cut reprints.
              </p>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="reprint-reason" className="text-xs text-[var(--admin-ink-dim)]">
              Reason (10-500 chars) <span className="text-[var(--admin-red)]">*</span>
            </Label>
            <textarea
              id="reprint-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              maxLength={500}
              placeholder="e.g. Lost in post — Royal Mail reported as undeliverable, replacement requested by customer"
              className="w-full px-3 py-2 text-sm bg-[var(--admin-bg2)] border border-[var(--admin-line-hard)] rounded-md text-[var(--admin-ink)] placeholder:text-[var(--admin-ink-faint)] focus:outline-none focus:border-[var(--admin-gold)] resize-none"
              data-testid="input-reprint-reason"
            />
            <p className="text-[10px] text-[var(--admin-ink-faint)]">
              {trimmed.length} / 500 chars{" "}
              {trimmed.length < 10 && trimmed.length > 0 ? `(${10 - trimmed.length} more required)` : ""}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            className="text-[var(--admin-ink-faint)] hover:text-[var(--admin-ink)]"
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!valid || submitting}
            onClick={() => onSubmit(trimmed)}
            className="text-white font-bold"
            style={{
              background: "color-mix(in srgb, var(--admin-green) 28%, transparent)",
              borderColor: "color-mix(in srgb, var(--admin-green) 45%, transparent)",
            }}
            data-testid="btn-submit-reprint-reason"
          >
            {submitting ? (
              <>
                <Loader2 className="h-3 w-3 mr-1 animate-spin" /> Reprinting…
              </>
            ) : (
              "Reprint with reason"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Certificate Row ───────────────────────────────────────────────────────────
function CertRow({
  cert,
  selected,
  onToggle,
  onReprint,
  onEditLabel,
  reprintPending,
}: {
  cert: CertForPrinting;
  selected: boolean;
  onToggle: () => void;
  onReprint: (certId: string) => void;
  onEditLabel: (certId: string, cert: CertificateRecord) => void;
  reprintPending: boolean;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const imgUrl = `/api/admin/certificates/label/${cert.certId}/front.png`;

  return (
    <div
      className={`rounded-lg border transition-colors ${
        selected
          ? "border-[var(--admin-gold)]/70 bg-[var(--admin-panel2)]"
          : "border-[var(--admin-line)] hover:border-[var(--admin-line-hard)]"
      }`}
      data-testid={`queue-row-${cert.certId}`}
    >
      {/* Main row */}
      <div className="flex items-center gap-3 p-2">
        {/* Checkbox */}
        <div
          className="shrink-0 text-[var(--admin-gold)] cursor-pointer"
          onClick={onToggle}
          data-testid={`checkbox-${cert.certId}`}
        >
          {selected ? (
            <CheckSquare className="h-4 w-4" />
          ) : (
            <Square className="h-4 w-4 text-[var(--admin-ink-faint)]" />
          )}
        </div>

        {/* Thumbnail */}
        <img
          src={imgUrl}
          alt={`Label ${cert.certId}`}
          className="h-8 w-28 object-cover rounded border border-[var(--admin-line)] shrink-0 cursor-pointer"
          onClick={onToggle}
          loading="lazy"
          data-testid={`thumb-${cert.certId}`}
        />

        {/* Info — clicks toggle checkbox */}
        <div className="flex-1 min-w-0 cursor-pointer" onClick={onToggle}>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className="text-xs text-[var(--admin-gold-hi)]"
              style={{ fontFamily: "var(--admin-mono)" }}
              data-testid={`certid-${cert.certId}`}
            >
              {cert.certId}
            </span>
            <Badge
              variant="outline"
              className="text-[10px] px-1 py-0 text-[var(--admin-ink-dim)] border-[var(--admin-line)]"
            >
              {gradeDisplay(cert)}
            </Badge>
            {cert.lastPrintedAt && (
              <Badge
                variant="outline"
                className="text-[10px] px-1 py-0 text-[var(--admin-green)] border-[color-mix(in_srgb,var(--admin-green)_45%,transparent)]"
                data-testid={`badge-printed-${cert.certId}`}
              >
                Printed
              </Badge>
            )}
          </div>
          <p className="text-xs text-[var(--admin-ink-dim)] truncate leading-tight">{cert.cardName}</p>
          {cert.lastPrintedAt && (
            <p className="text-[10px] text-[var(--admin-ink-faint)]">Last printed {fmtDate(cert.lastPrintedAt)}</p>
          )}
        </div>

        {/* Action buttons — inline on right, never wrap */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Secondary actions: icon-only to save space */}
          <Button
            size="sm"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              setShowPreview((v) => !v);
            }}
            className="h-7 w-7 p-0 text-[var(--admin-ink-faint)] hover:text-[var(--admin-gold-hi)]"
            data-testid={`btn-preview-${cert.certId}`}
            title="Preview label"
          >
            {showPreview ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </Button>

          <Button
            size="sm"
            variant="ghost"
            disabled={reprintPending}
            onClick={(e) => {
              e.stopPropagation();
              onReprint(cert.certId);
            }}
            className="h-7 w-7 p-0 text-[var(--admin-ink-faint)] hover:text-[var(--admin-gold-hi)]"
            data-testid={`btn-reprint-${cert.certId}`}
            title="Reprint label"
          >
            {reprintPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />}
          </Button>

          <Button
            size="sm"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              onEditLabel(cert.certId, cert);
            }}
            className="h-7 w-7 p-0 text-[var(--admin-ink-faint)] hover:text-[var(--admin-gold-hi)]"
            data-testid={`btn-edit-label-${cert.certId}`}
            title="Edit label display data"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>

          {/* Separator */}
          <div className="h-4 w-px bg-[var(--admin-line)] mx-0.5" />

          {/* Certificate PDF download */}
          <a
            href={`/api/admin/certificates/${cert.certId}/certificate-document`}
            onClick={(e) => e.stopPropagation()}
            download={`MintVault-Certificate-${cert.certId}.pdf`}
            className="inline-flex items-center gap-1 h-7 px-2 text-[10px] text-[var(--admin-ink-faint)] hover:text-[var(--admin-gold-hi)] rounded-md hover:bg-[var(--admin-panel2)] transition-colors whitespace-nowrap"
            data-testid={`btn-cert-doc-${cert.certId}`}
            title="Download Certificate PDF"
          >
            <FileDown className="h-3 w-3 shrink-0" />
            Cert
          </a>

          {/* Claim Insert — most important, gold-highlighted */}
          <a
            href={`/api/admin/certificates/${cert.certId}/claim-insert`}
            onClick={(e) => e.stopPropagation()}
            download={`MintVault-ClaimInsert-${cert.certId}.pdf`}
            className="inline-flex items-center gap-1 h-7 px-2.5 text-[10px] font-bold text-[#1c1607] rounded-md transition-colors whitespace-nowrap"
            style={{ background: "var(--admin-gold-grad)" }}
            data-testid={`btn-claim-insert-${cert.certId}`}
            title="Download Claim Insert PDF"
          >
            <FileDown className="h-3 w-3 shrink-0" />
            Claim Insert
          </a>

          {/* Add to sheet */}
          <Button
            size="sm"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className={`h-7 px-2 text-[10px] gap-1 whitespace-nowrap ${
              selected
                ? "text-[var(--admin-gold-hi)] hover:text-[var(--admin-gold)]"
                : "text-[var(--admin-green)] hover:text-[var(--admin-green)]"
            }`}
            data-testid={`btn-add-to-sheet-${cert.certId}`}
            title={selected ? "Remove from sheet" : "Add to sheet"}
          >
            <PlusCircle className="h-3 w-3 shrink-0" />
            <span className="hidden sm:inline">{selected ? "Remove" : "Sheet"}</span>
          </Button>
        </div>
      </div>

      {/* Inline label preview */}
      {showPreview && (
        <div className="px-2 pb-2">
          <div className="rounded overflow-hidden border border-[var(--admin-line)] max-w-xs">
            <img
              src={imgUrl}
              alt={`${cert.certId} front label preview`}
              className="w-full object-contain"
              data-testid={`preview-img-${cert.certId}`}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Latest Sheet section ──────────────────────────────────────────────────────
function LatestSheetSection({
  onReprintSheet,
  generating,
  onDownloadPng,
  downloadingPng,
}: {
  onReprintSheet: (certIds: string[]) => Promise<void>;
  generating: boolean;
  onDownloadPng: (url: string, filename: string) => Promise<void>;
  downloadingPng: boolean;
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reprintingRef, setReprintingRef] = useState<string | null>(null);

  const { data: sheets = [], isLoading } = useQuery<SheetSummary[]>({
    queryKey: ["/api/admin/printing/sheets"],
  });

  const latest = sheets[0] ?? null;
  const older = sheets.slice(1);

  const { data: detailItems = [], isLoading: detailLoading } = useQuery<
    { certId: string; cert: CertificateRecord | null }[]
  >({
    queryKey: ["/api/admin/printing/sheets", latest?.sheetRef],
    enabled: !!latest && detailOpen,
  });

  const handleReprint = async (sheetRef: string) => {
    setReprintingRef(sheetRef);
    try {
      const res = await apiRequest("GET", `/api/admin/printing/sheets/${encodeURIComponent(sheetRef)}`);
      const items: { certId: string }[] = await res.json();
      const ids = items.map((i) => i.certId).filter(Boolean);
      if (ids.length) await onReprintSheet(ids);
    } finally {
      setReprintingRef(null);
    }
  };

  const sheetLabel = (ref: string) => {
    const n = parseInt(ref.replace("SHEET-", ""), 10);
    return isNaN(n) ? ref : new Date(n).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--admin-ink-faint)] py-2">
        <Loader2 className="h-3 w-3 animate-spin" /> Loading latest sheet…
      </div>
    );
  }

  if (!latest) return null;

  const isPending = reprintingRef === latest.sheetRef || generating;
  // Newer sheets are stored as `print_batch_{batchId}` — strip the prefix to
  // recover the batchId for the PNG endpoint. Legacy `SHEET-{timestamp}` refs
  // don't have a corresponding R2 artefact; the PNG button is hidden for them.
  const latestBatchId = latest.sheetRef.startsWith("print_batch_") ? latest.sheetRef.replace("print_batch_", "") : null;

  return (
    <div className="space-y-1" data-testid="latest-sheet-section">
      {/* Latest Sheet card */}
      <div className="rounded-lg border border-[var(--admin-line)] overflow-hidden">
        {/* Clickable header row */}
        <button
          className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-[var(--admin-panel2)] hover:bg-[var(--admin-panel3)] transition-colors text-left"
          onClick={() => setDetailOpen((v) => !v)}
          data-testid="btn-toggle-latest-detail"
        >
          <div className="flex items-center gap-3 min-w-0">
            {latest.printed ? (
              <CheckCircle2 className="h-4 w-4 text-[var(--admin-green)] shrink-0" />
            ) : (
              <Clock className="h-4 w-4 text-[var(--admin-gold)] shrink-0" />
            )}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[var(--admin-ink)]">
                Latest Sheet
                <span className="ml-2 text-xs font-normal text-[var(--admin-ink-faint)]">
                  {sheetLabel(latest.sheetRef)}
                </span>
              </p>
              <p className="text-[11px] text-[var(--admin-ink-faint)] mt-0.5">
                {latest.total} cert{latest.total !== 1 ? "s" : ""}
                {" · "}
                {latest.printed ? `Printed ${fmtDate(latest.printedAt)}` : "Not yet marked printed"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {latestBatchId && (
              <Button
                size="sm"
                variant="outline"
                disabled={downloadingPng}
                onClick={(e) => {
                  e.stopPropagation();
                  onDownloadPng(`/api/admin/print-batch/${latestBatchId}/png`, `mintvault-batch-${latestBatchId}.png`);
                }}
                className="h-7 text-[10px] px-2 border-[var(--admin-gold)]/60 text-[var(--admin-gold-hi)] hover:bg-[var(--admin-gold)]/10"
                data-testid="btn-download-latest-png"
              >
                {downloadingPng ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin mr-1" /> PNG…
                  </>
                ) : (
                  <>
                    <FileDown className="h-3 w-3 mr-1" /> PNG
                  </>
                )}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={isPending}
              onClick={(e) => {
                e.stopPropagation();
                handleReprint(latest.sheetRef);
              }}
              className="h-7 text-[10px] px-2 border-[color-mix(in_srgb,var(--admin-gold)_40%,transparent)] text-[var(--admin-gold-hi)] hover:bg-[var(--admin-panel2)]"
              data-testid="btn-reprint-latest-sheet"
            >
              {reprintingRef === latest.sheetRef ? (
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
              ) : (
                <Printer className="h-3 w-3 mr-1" />
              )}
              Reprint Sheet
            </Button>
            {detailOpen ? (
              <ChevronUp className="h-4 w-4 text-[var(--admin-ink-faint)]" />
            ) : (
              <ChevronDown className="h-4 w-4 text-[var(--admin-ink-faint)]" />
            )}
          </div>
        </button>

        {/* Expanded cert list */}
        {detailOpen && (
          <div className="border-t border-[var(--admin-line)] p-3 space-y-1 max-h-64 overflow-y-auto">
            {detailLoading ? (
              <div className="flex justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin text-[var(--admin-gold)]" />
              </div>
            ) : detailItems.length === 0 ? (
              <p className="text-xs text-[var(--admin-ink-faint)] text-center py-2">No certificates on this sheet.</p>
            ) : (
              detailItems.map((item) => (
                <div
                  key={item.certId}
                  className="flex items-center gap-3 px-2 py-1.5 rounded text-xs text-[var(--admin-ink-dim)] bg-[var(--admin-bg2)]"
                  data-testid={`latest-detail-cert-${item.certId}`}
                >
                  <span
                    className="text-[var(--admin-gold-hi)] shrink-0 w-14"
                    style={{ fontFamily: "var(--admin-mono)" }}
                  >
                    {item.certId}
                  </span>
                  <span className="truncate">{item.cert?.cardName ?? "—"}</span>
                  <span className="ml-auto text-[var(--admin-ink-faint)] shrink-0">
                    {item.cert?.gradeOverall ?? "—"}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* View Full History link */}
      {older.length > 0 && (
        <div>
          <button
            className="text-[11px] text-[var(--admin-ink-faint)] hover:text-[var(--admin-ink-dim)] transition-colors pl-1"
            onClick={() => setHistoryOpen((v) => !v)}
            data-testid="btn-view-full-history"
          >
            {historyOpen ? "Hide history" : `View all ${sheets.length} sheets`}
          </button>

          {historyOpen && (
            <div className="mt-1.5 rounded-lg border border-[var(--admin-line)] divide-y divide-[var(--admin-line)] overflow-hidden">
              {sheets.map((sheet, idx) => (
                <div
                  key={sheet.sheetRef}
                  className="flex items-center justify-between gap-3 px-3 py-2 bg-[var(--admin-bg2)] text-[11px] text-[var(--admin-ink-faint)]"
                  data-testid={`full-history-row-${sheet.sheetRef}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {sheet.printed ? (
                      <CheckCircle2 className="h-3 w-3 text-[var(--admin-green)] shrink-0" />
                    ) : (
                      <Clock className="h-3 w-3 text-[var(--admin-gold)] shrink-0" />
                    )}
                    <span>{sheetLabel(sheet.sheetRef)}</span>
                    <span className="text-[var(--admin-ink-faint)]">
                      · {sheet.total} cert{sheet.total !== 1 ? "s" : ""}
                    </span>
                    {idx === 0 && (
                      <Badge
                        variant="outline"
                        className="text-[9px] border-[color-mix(in_srgb,var(--admin-gold)_40%,transparent)] text-[var(--admin-gold-hi)] py-0 px-1 ml-1"
                      >
                        latest
                      </Badge>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={reprintingRef === sheet.sheetRef || generating}
                    onClick={() => handleReprint(sheet.sheetRef)}
                    className="h-6 text-[10px] px-2 text-[var(--admin-ink-faint)] hover:text-[var(--admin-gold-hi)]"
                    data-testid={`btn-reprint-history-${sheet.sheetRef}`}
                  >
                    <Printer className="h-3 w-3 mr-1" />
                    Reprint
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main tab wrapper ──────────────────────────────────────────────────────────
export default function AdminPrinting() {
  const [tab, setTab] = useState<"sheet" | "browser">("sheet");

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6" data-testid="admin-printing-root">
      <div className="flex items-center gap-1 border-b border-[var(--admin-line)] pb-0">
        <button
          onClick={() => setTab("sheet")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-t transition-colors border-b-2 ${
            tab === "sheet"
              ? "border-[var(--admin-gold)] text-[var(--admin-gold-hi)]"
              : "border-transparent text-[var(--admin-ink-faint)] hover:text-[var(--admin-ink-dim)]"
          }`}
          data-testid="tab-sheet-printing"
        >
          <LayoutGrid className="h-4 w-4" /> Sheet Printing
        </button>
        <button
          onClick={() => setTab("browser")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-t transition-colors border-b-2 ${
            tab === "browser"
              ? "border-[var(--admin-gold)] text-[var(--admin-gold-hi)]"
              : "border-transparent text-[var(--admin-ink-faint)] hover:text-[var(--admin-ink-dim)]"
          }`}
          data-testid="tab-cert-browser"
        >
          <BookOpen className="h-4 w-4" /> Certificate Browser
        </button>
      </div>

      {tab === "sheet" ? <SheetPrintingPanel /> : <AdminCertBrowser />}
    </div>
  );
}

// ── Sheet Printing Panel ──────────────────────────────────────────────────────
function SheetPrintingPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingSheetRef, setPending] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [search, setSearch] = useState("");
  const [reprintingId, setReprintingId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<{ certId: string; cert: CertificateRecord } | null>(null);

  // v525 — reprint-with-reason modal state. Populated when /api/admin/print-batch
  // returns 409 (some selected certs already claimed). Submitting the reason
  // posts to /api/admin/print-batch/reprint instead.
  const [reprintModal, setReprintModal] = useState<{
    claimedCertIds: string[];
    allCertIds: string[];
  } | null>(null);
  const [reprintSubmitting, setReprintSubmitting] = useState(false);

  const {
    data: allCerts = [],
    isLoading: certsLoading,
    refetch: refetchCerts,
  } = useQuery<CertForPrinting[]>({ queryKey: ["/api/admin/printing/queue"] });

  const visibleCerts = useMemo(() => {
    let list = allCerts;
    if (filterMode === "printed") list = list.filter((c) => c.lastPrintedAt !== null);
    if (filterMode === "unprinted") list = list.filter((c) => c.lastPrintedAt === null);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((c) => c.certId.toLowerCase().includes(q) || (c.cardName?.toLowerCase() ?? "").includes(q));
    }
    return list;
  }, [allCerts, filterMode, search]);

  const countAll = allCerts.length;
  const countPrinted = allCerts.filter((c) => c.lastPrintedAt !== null).length;
  const countUnprinted = allCerts.filter((c) => c.lastPrintedAt === null).length;

  const toggle = useCallback((certId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(certId)) next.delete(certId);
      else next.add(certId);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (visibleCerts.every((c) => selected.has(c.certId))) {
      setSelected((prev) => {
        const n = new Set(prev);
        visibleCerts.forEach((c) => n.delete(c.certId));
        return n;
      });
    } else {
      setSelected((prev) => {
        const n = new Set(prev);
        visibleCerts.forEach((c) => n.add(c.certId));
        return n;
      });
    }
  }, [visibleCerts, selected]);

  const selectFirstBatch = useCallback(
    () => setSelected(new Set(visibleCerts.slice(0, MAX_CERTS_PER_BATCH).map((c) => c.certId))),
    [visibleCerts]
  );
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const invalidate = useCallback(() => {
    refetchCerts();
    qc.invalidateQueries({ queryKey: ["/api/admin/printing/queue"] });
    qc.invalidateQueries({ queryKey: ["/api/admin/printing/sheets"] });
  }, [refetchCerts, qc]);

  // v525 — shared helper for saving the 3-file batch output. PDF + PNG are
  // streamed from R2 via the server endpoints (no expiring blob URLs); SVG
  // still arrives as base64 in the POST response and uses a blob URL.
  // All three filenames share the batchId so the operator can pair them.
  const saveBatchFiles = useCallback((data: { pdfUrl: string; svg: string; pngUrl: string; batchId: string }) => {
    const decode = (b64: string, mime: string) => {
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      return new Blob([buf], { type: mime });
    };
    const saveBlob = (blob: Blob, filename: string) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    };
    const saveServerUrl = (url: string, filename: string) => {
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
    saveBlob(decode(data.svg, "image/svg+xml"), `mintvault-batch-${data.batchId}.svg`);
    // PNG is intentionally NOT auto-downloaded here — Chrome's multi-download
    // gate silently blocks the 2nd/3rd file from a single gesture. Reprint
    // flows (this helper's only callers) skip the PNG; the primary Generate
    // Batch flow downloads its PNG inline.
    // ?download=1 flips the PDF endpoint to Content-Disposition: attachment
    // so this drops it to Downloads rather than opening inline in a tab.
    saveServerUrl(`${data.pdfUrl}?download=1`, `mintvault-batch-${data.batchId}.pdf`);
  }, []);

  // v525 — single-cert reprint routes through the same /api/admin/print-batch
  // endpoint as multi-cert batches. Produces a 1-row sheet (front + claim
  // insert) with cut SVG + Cricut PNG. Eliminates the third parallel reprint
  // path that produced a legacy 72×22mm PDF with no insert and no cut SVG.
  //
  // If the cert is already claimed, the endpoint returns 409 with the
  // claimedCertIds list; we open the ReprintReasonModal which then submits
  // to /api/admin/print-batch/reprint with the operator's reason.
  const handleReprint = useCallback(
    async (certId: string) => {
      setReprintingId(certId);
      try {
        const res = await apiRequest("POST", "/api/admin/print-batch", { certIds: [certId] });
        const data = (await res.json()) as { pdfUrl: string; svg: string; pngUrl: string; batchId: string };
        saveBatchFiles(data);
        toast({ title: "Single-cert reprint generated", description: `${certId} — batch ${data.batchId.slice(0, 8)}` });
        invalidate();
      } catch (err: any) {
        if (err?.status === 409 && err?.body?.code === "CLAIMED_CERTS_PRESENT") {
          setReprintModal({
            claimedCertIds: err.body.claimedCertIds || [certId],
            allCertIds: [certId],
          });
        } else {
          toast({ title: "Reprint failed", description: err.message, variant: "destructive" });
        }
      } finally {
        setReprintingId(null);
      }
    },
    [toast, invalidate, saveBatchFiles]
  );

  // Download claim insert sheet
  const [downloadingInserts, setDownloadingInserts] = useState(false);
  const downloadClaimInserts = useCallback(
    async (certIds: string[]) => {
      setDownloadingInserts(true);
      try {
        const res = await apiRequest("POST", "/api/admin/claim-insert-sheet", { certIds });
        if (!res.ok) {
          const { error } = await res.json().catch(() => ({ error: "Failed" }));
          throw new Error(error);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `claim-inserts-${new Date().toISOString().split("T")[0]}.pdf`;
        a.click();
        URL.revokeObjectURL(url);
        toast({
          title: "Claim inserts downloaded",
          description: `${certIds.length} insert${certIds.length !== 1 ? "s" : ""} generated`,
        });
      } catch (err: any) {
        toast({ title: "Claim inserts failed", description: err.message, variant: "destructive" });
      } finally {
        setDownloadingInserts(false);
      }
    },
    [toast]
  );

  // LatestSheetSection's "reprint sheet" button hits this. If any cert in
  // the historical sheet has since been claimed, 409 surfaces the modal.
  const reprintFromHistory = useCallback(
    async (certIds: string[]) => {
      try {
        const res = await apiRequest("POST", "/api/admin/print-batch", { certIds });
        const data = (await res.json()) as { pdfUrl: string; svg: string; pngUrl: string; batchId: string };
        saveBatchFiles(data);
        toast({
          title: "Sheet reprinted",
          description: `${certIds.length} cert${certIds.length !== 1 ? "s" : ""} — batch ${data.batchId.slice(0, 8)}`,
        });
        invalidate();
      } catch (err: any) {
        if (err?.status === 409 && err?.body?.code === "CLAIMED_CERTS_PRESENT") {
          setReprintModal({
            claimedCertIds: err.body.claimedCertIds || [],
            allCertIds: certIds,
          });
        } else {
          toast({ title: "Reprint failed", description: err.message, variant: "destructive" });
        }
      }
    },
    [toast, invalidate, saveBatchFiles]
  );

  // v525 — single-sheet print-and-cut batch (front + claim insert per row,
  // up to 4 cards per sheet). Returns a JSON envelope with PDF / SVG / PNG
  // as base64 blobs; saveBatchFiles drops all three to Downloads with a
  // shared batchId in the filename.
  const PRINT_BATCH_MAX = MAX_CERTS_PER_BATCH; // single source of truth (line 40)
  const [downloadingBatch, setDownloadingBatch] = useState(false);
  // Loading state for the Latest Sheet row's PNG button (re-downloading
  // a historical batch). The primary Generate Batch flow auto-downloads
  // its PNG inline, so it doesn't go through this helper.
  // Streams the bytes through fetch → Blob → anchor so we can show progress
  // and surface real errors (404, 500) via toast instead of a silent failure.
  const [downloadingPng, setDownloadingPng] = useState(false);
  const handleDownloadPng = useCallback(
    async (url: string, filename: string) => {
      if (!url) return;
      setDownloadingPng(true);
      try {
        const res = await fetch(url, { credentials: "same-origin" });
        if (!res.ok) {
          const detail = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          throw new Error(detail.error || `HTTP ${res.status}`);
        }
        const blob = await res.blob();
        const objUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objUrl);
      } catch (err: any) {
        toast({ title: "PNG download failed", description: err.message, variant: "destructive" });
      } finally {
        setDownloadingPng(false);
      }
    },
    [toast]
  );
  const downloadPrintBatch = useCallback(
    async (certIds: string[]) => {
      // Single-click flow:
      //   1. SYNCHRONOUSLY open the PDF tab inside the user gesture so Chrome
      //      doesn't block it post-await. Holds a "Generating…" placeholder
      //      until the POST returns; then redirects to the real PDF URL.
      //   2. POST /api/admin/print-batch
      //   3. Trigger PNG anchor download (Cricut — the critical artefact).
      //   4. Point the placeholder tab at the PDF URL. If the tab was blocked
      //      anyway (popup-blocker disabled the open()), the toast surfaces a
      //      clickable fallback link so the PDF stays reachable.
      // The PNG anchor click does not consume the user gesture and works on
      // a hidden <a download> via the standard append/click/remove dance.
      setDownloadingBatch(true);
      // Synchronous window.open INSIDE the click gesture — must run before any
      // await. Held open with a tiny placeholder so the operator sees progress
      // and the gesture-protected handle is preserved across the POST.
      const pdfWindow = window.open("", "_blank");
      if (pdfWindow) {
        try {
          pdfWindow.document.write(
            "<title>Generating print sheet…</title>" +
              '<body style="font-family:system-ui,sans-serif;background:#0f0f12;color:#d4af37;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">' +
              "Generating print sheet…" +
              "</body>"
          );
        } catch {
          /* ignore: some browsers throw on document.write into about:blank */
        }
      }
      try {
        const res = await apiRequest("POST", "/api/admin/print-batch", { certIds });
        const data = (await res.json()) as {
          pdfUrl: string;
          svg: string;
          pngUrl: string;
          batchId: string;
          certIds: string[];
          mintedFor?: string[];
          isRecentDuplicate?: boolean;
        };

        // PNG download — hidden <a download> appended/clicked/removed. Anchor
        // click is not gated by the post-await popup rule (it's a navigation
        // intent, not a popup). PNG endpoint serves Content-Disposition:
        // attachment so the browser saves rather than navigates.
        {
          const a = document.createElement("a");
          a.href = data.pngUrl;
          a.download = `mintvault-batch-${data.batchId}.png`;
          document.body.appendChild(a);
          a.click();
          a.remove();
        }

        // PDF — drop the placeholder tab onto the real URL. If the popup
        // open was hard-blocked, surface the URL as a clickable link in the
        // toast so the operator can still get to it.
        if (pdfWindow) {
          pdfWindow.location.href = data.pdfUrl;
        } else {
          toast({
            title: "Popup blocked — PNG downloaded",
            description: (
              <span>
                Allow popups for this site, or{" "}
                <a
                  href={data.pdfUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "#D4AF37", textDecoration: "underline" }}
                >
                  open print sheet
                </a>{" "}
                manually.
              </span>
            ),
            variant: "destructive",
          });
        }

        const mintedCount = data.mintedFor?.length ?? 0;
        const idempotentNote = data.isRecentDuplicate ? " (idempotent re-run)" : "";
        const mintedNote =
          mintedCount > 0 ? ` — codes generated for ${mintedCount} cert${mintedCount !== 1 ? "s" : ""}` : "";
        toast({
          title: "Batch generated",
          description: `PNG downloading, PDF opening in new tab${mintedNote}${idempotentNote}.`,
        });
        invalidate();
      } catch (err: any) {
        // POST failed — close the placeholder so no dead "Generating…" tab
        // is left behind.
        if (pdfWindow) {
          try {
            pdfWindow.close();
          } catch {
            /* ignore */
          }
        }
        if (err?.status === 409 && err?.body?.code === "CLAIMED_CERTS_PRESENT") {
          setReprintModal({
            claimedCertIds: err.body.claimedCertIds || [],
            allCertIds: certIds,
          });
        } else {
          toast({ title: "Batch failed", description: err.message || String(err), variant: "destructive" });
        }
      } finally {
        setDownloadingBatch(false);
      }
    },
    [toast, invalidate]
  );

  // v525 — submitted from the ReprintReasonModal. Reposts the original
  // selection to /api/admin/print-batch/reprint with the operator's reason.
  const submitReprintWithReason = useCallback(
    async (reason: string) => {
      if (!reprintModal) return;
      const certIds = reprintModal.allCertIds;
      setReprintSubmitting(true);
      try {
        const res = await apiRequest("POST", "/api/admin/print-batch/reprint", { certIds, reason });
        const data = (await res.json()) as { pdfUrl: string; svg: string; pngUrl: string; batchId: string };
        saveBatchFiles(data);
        toast({
          title: "Reprint with reason recorded",
          description: `${certIds.length} cert${certIds.length !== 1 ? "s" : ""} — batch ${data.batchId.slice(0, 8)}`,
        });
        setReprintModal(null);
        invalidate();
      } catch (err: any) {
        toast({ title: "Reprint failed", description: err.message, variant: "destructive" });
      } finally {
        setReprintSubmitting(false);
      }
    },
    [reprintModal, toast, invalidate, saveBatchFiles]
  );

  // Mark printed
  const markPrintedMutation = useMutation({
    mutationFn: (sheetRef: string) => apiRequest("POST", "/api/admin/printing/mark-printed", { sheetRef }),
    onSuccess: () => {
      toast({ title: "Sheet marked as printed" });
      setPending(null);
      invalidate();
    },
    onError: () => toast({ title: "Failed to mark as printed", variant: "destructive" }),
  });

  const allVisible = visibleCerts.length > 0 && visibleCerts.every((c) => selected.has(c.certId));

  return (
    <div className="space-y-5" data-testid="admin-printing">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-[var(--admin-gold-hi)] tracking-wide flex items-center gap-2">
            <LayoutGrid className="h-5 w-5" /> Label Sheet Printing
          </h2>
          <p className="text-xs text-[var(--admin-ink-faint)] mt-0.5">
            A4 · {MAX_CERTS_PER_BATCH} certs per sheet · 70 × 20 mm slab label + claim insert · guillotine-cut
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => refetchCerts()}
          className="text-[var(--admin-ink-faint)] hover:text-[var(--admin-gold-hi)]"
          data-testid="btn-refresh-printing"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1 border-b border-[var(--admin-line)]">
        {(["all", "unprinted", "printed"] as FilterMode[]).map((mode) => {
          const label = mode === "all" ? "All" : mode === "unprinted" ? "Unprinted" : "Printed";
          const count = mode === "all" ? countAll : mode === "unprinted" ? countUnprinted : countPrinted;
          return (
            <button
              key={mode}
              onClick={() => setFilterMode(mode)}
              data-testid={`filter-${mode}`}
              className={`flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-t transition-colors border-b-2 ${
                filterMode === mode
                  ? "border-[var(--admin-gold)] text-[var(--admin-gold-hi)]"
                  : "border-transparent text-[var(--admin-ink-faint)] hover:text-[var(--admin-ink-dim)]"
              }`}
            >
              {label}
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                  filterMode === mode
                    ? "bg-[var(--admin-panel2)] text-[var(--admin-gold-hi)]"
                    : "bg-[var(--admin-panel3)] text-[var(--admin-ink-faint)]"
                }`}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Search + toolbar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--admin-ink-faint)] pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by cert ID or card name…"
            className="pl-8 pr-8 h-8 text-xs bg-[var(--admin-bg2)] border-[var(--admin-line-hard)] text-[var(--admin-ink)] placeholder-[var(--admin-ink-faint)]"
            data-testid="input-search-certs"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--admin-ink-faint)] hover:text-[var(--admin-ink-dim)]"
              data-testid="btn-clear-search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <span className="text-xs text-[var(--admin-ink-faint)]">
            {visibleCerts.length} cert{visibleCerts.length !== 1 ? "s" : ""}
            {search || filterMode !== "all" ? " (filtered)" : ""}
          </span>
          {selected.size > 0 && (
            <button
              onClick={clearSelection}
              className="text-[11px] text-[var(--admin-ink-faint)] hover:text-[var(--admin-ink-dim)] transition-colors"
              data-testid="btn-clear-selection"
            >
              Clear ({selected.size})
            </button>
          )}
          {visibleCerts.length > 0 && (
            <button
              onClick={toggleAll}
              className="text-[11px] text-[var(--admin-gold)]/70 hover:text-[var(--admin-gold-hi)] transition-colors"
              data-testid="btn-toggle-all"
            >
              {allVisible ? "Deselect all" : "Select all"}
            </button>
          )}
          {visibleCerts.length > MAX_CERTS_PER_BATCH && (
            <button
              onClick={selectFirstBatch}
              className="text-[11px] text-[var(--admin-gold)]/70 hover:text-[var(--admin-gold-hi)] transition-colors"
              data-testid="btn-select-first-batch"
            >
              First {MAX_CERTS_PER_BATCH}
            </button>
          )}
        </div>
      </div>

      {/* Certificate list — full width */}
      {certsLoading ? (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="h-5 w-5 animate-spin text-[var(--admin-gold)]" />
        </div>
      ) : visibleCerts.length === 0 ? (
        <div className="rounded-lg border border-[var(--admin-line)] p-10 text-center text-[var(--admin-ink-faint)] text-sm">
          {search || filterMode !== "all" ? "No certificates match your filter." : "No certificates found."}
        </div>
      ) : (
        <div className="space-y-1.5 max-h-[600px] overflow-y-auto pr-1">
          {visibleCerts.map((cert) => (
            <CertRow
              key={cert.certId}
              cert={cert}
              selected={selected.has(cert.certId)}
              onToggle={() => toggle(cert.certId)}
              onReprint={handleReprint}
              onEditLabel={(id, c) => setEditTarget({ certId: id, cert: c })}
              reprintPending={reprintingId === cert.certId}
            />
          ))}
        </div>
      )}

      {/* Generate buttons — v525 consolidates onto Print Batch (PDF+SVG+PNG). */}
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button
          onClick={() => downloadClaimInserts(Array.from(selected))}
          disabled={selected.size === 0 || downloadingInserts}
          data-testid="btn-claim-inserts"
          variant="outline"
          className="border-[var(--admin-gold)]/60 text-[var(--admin-gold-hi)] hover:bg-[var(--admin-gold)]/10 font-medium"
        >
          {downloadingInserts ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Generating…
            </>
          ) : (
            <>
              <FileDown className="h-4 w-4 mr-2" /> Claim Inserts ({selected.size})
            </>
          )}
        </Button>
        <Button
          onClick={() => downloadPrintBatch(Array.from(selected))}
          disabled={selected.size === 0 || selected.size > PRINT_BATCH_MAX || downloadingBatch}
          data-testid="btn-print-batch"
          title={
            selected.size === 0
              ? `Select up to ${PRINT_BATCH_MAX} unclaimed certs`
              : selected.size > PRINT_BATCH_MAX
                ? `Maximum ${PRINT_BATCH_MAX} certs per batch`
                : "Generates a batch, downloads the Cricut PNG, and opens the print dialog for the PDF"
          }
          className="text-white font-bold"
          style={{
            background: "color-mix(in srgb, var(--admin-green) 28%, transparent)",
            borderColor: "color-mix(in srgb, var(--admin-green) 45%, transparent)",
          }}
        >
          {downloadingBatch ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Generating…
            </>
          ) : (
            <>
              <FileDown className="h-4 w-4 mr-2" /> Generate Batch ({selected.size} / {PRINT_BATCH_MAX})
            </>
          )}
        </Button>
        {selected.size > PRINT_BATCH_MAX && (
          <span className="text-xs text-[var(--admin-red)]" data-testid="text-over-limit">
            Max {PRINT_BATCH_MAX} — deselect {selected.size - PRINT_BATCH_MAX}
          </span>
        )}
      </div>

      {/* Post-generate mark-printed prompt */}
      {pendingSheetRef && (
        <div className="rounded-md border border-[color-mix(in_srgb,var(--admin-gold)_40%,transparent)] bg-[var(--admin-panel2)] p-3 flex items-center justify-between gap-4">
          <p className="text-xs text-[var(--admin-gold-hi)]">
            <strong>PDF downloaded.</strong> Print the sheet, then confirm it was printed.
          </p>
          <Button
            size="sm"
            onClick={() => markPrintedMutation.mutate(pendingSheetRef)}
            disabled={markPrintedMutation.isPending}
            data-testid="btn-mark-printed-inline"
            className="text-white text-xs shrink-0"
            style={{
              background: "color-mix(in srgb, var(--admin-green) 28%, transparent)",
              borderColor: "color-mix(in srgb, var(--admin-green) 45%, transparent)",
            }}
          >
            {markPrintedMutation.isPending ? (
              <>
                <Loader2 className="h-3 w-3 mr-1 animate-spin" /> Marking…
              </>
            ) : (
              <>
                <PrinterCheck className="h-3 w-3 mr-1" /> Mark Sheet Printed
              </>
            )}
          </Button>
        </div>
      )}

      {/* Latest Sheet — reprint flows through /api/admin/print-batch. */}
      <LatestSheetSection
        onReprintSheet={reprintFromHistory}
        generating={downloadingBatch}
        onDownloadPng={handleDownloadPng}
        downloadingPng={downloadingPng}
      />

      {/* Reprint with reason modal */}
      {reprintModal && (
        <ReprintReasonModal
          claimedCertIds={reprintModal.claimedCertIds}
          allCertIds={reprintModal.allCertIds}
          onCancel={() => setReprintModal(null)}
          onSubmit={submitReprintWithReason}
          submitting={reprintSubmitting}
        />
      )}

      {/* Edit label modal */}
      {editTarget && (
        <EditLabelModal certId={editTarget.certId} cert={editTarget.cert} onClose={() => setEditTarget(null)} />
      )}
    </div>
  );
}
