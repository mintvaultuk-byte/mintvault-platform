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
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Loader2, PrinterCheck, FileDown, CheckSquare, Square, RefreshCw,
  LayoutGrid, BookOpen, Search, X, Printer, Eye, EyeOff, Pencil,
  PlusCircle, AlertCircle, Clock, CheckCircle2, ChevronDown, ChevronUp,
} from "lucide-react";
import AdminCertBrowser from "./admin-cert-browser";

const CERTS_PER_SHEET = 10;

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
  certId, cert, onClose,
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
      setName:  existing?.setOverride      ?? cert?.setName  ?? "",
      variant:  existing?.variantOverride  ?? cert?.variant  ?? "",
      language: existing?.languageOverride ?? cert?.language ?? "",
      year:     existing?.yearOverride     ?? cert?.year     ?? "",
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (data: { cardName: string; setName: string; variant: string; language: string; year: string }) => {
      const res = await apiRequest("POST", `/api/admin/printing/override/${certId}`, {
        cardNameOverride: data.cardName || null,
        setOverride:      data.setName  || null,
        variantOverride:  data.variant  || null,
        languageOverride: data.language || null,
        yearOverride:     data.year     || null,
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
    },
    onSuccess: () => {
      toast({ title: "Label data updated", description: `${certId} overrides saved` });
      qc.invalidateQueries({ queryKey: ["/api/admin/printing/override", certId] });
      onClose();
    },
    onError: (err: any) =>
      toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent
        className="bg-white border-[#E8E4DC] text-[#1A1A1A] max-w-md"
        data-testid="edit-label-modal"
      >
        <DialogHeader>
          <DialogTitle className="text-yellow-400 flex items-center gap-2">
            <Pencil className="h-4 w-4" /> Edit Label Data — {certId}
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-yellow-500" />
          </div>
        ) : (
          <form
            onSubmit={form.handleSubmit((d) => saveMutation.mutate(d))}
            className="space-y-4"
          >
            <div className="rounded-md bg-[#FFF9E6] border border-yellow-700/30 p-3 text-[11px] text-yellow-300 flex gap-2">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              Label display only — grade, cert number, QR code and schema are not changed.
            </div>

            {[
              { id: "cardName", label: "Card Name" },
              { id: "setName",  label: "Set Name" },
              { id: "variant",  label: "Variant" },
              { id: "language", label: "Language" },
              { id: "year",     label: "Year" },
            ].map(({ id, label }) => (
              <div key={id} className="space-y-1">
                <Label htmlFor={`edit-${id}`} className="text-xs text-[#666666]">
                  {label}
                </Label>
                <Input
                  id={`edit-${id}`}
                  {...form.register(id as any)}
                  className="h-8 text-sm bg-[#FAFAF8] border-[#E8E4DC] text-[#1A1A1A]"
                  data-testid={`input-edit-${id}`}
                />
              </div>
            ))}

            <DialogFooter>
              <Button
                type="button" variant="ghost" onClick={onClose}
                className="text-[#999999]"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={saveMutation.isPending}
                className="bg-yellow-600 hover:bg-yellow-500 text-black font-bold"
                data-testid="btn-save-label-edit"
              >
                {saveMutation.isPending
                  ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Saving…</>
                  : "Save Label Data"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Certificate Row ───────────────────────────────────────────────────────────
function CertRow({
  cert, selected, onToggle, onReprint, onEditLabel, reprintPending,
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
          ? "border-yellow-500/70 bg-[#FFF9E6]"
          : "border-[#E8E4DC] hover:border-[#E8E4DC]"
      }`}
      data-testid={`queue-row-${cert.certId}`}
    >
      {/* Main row */}
      <div className="flex items-center gap-3 p-2">
        {/* Checkbox */}
        <div
          className="shrink-0 text-yellow-500 cursor-pointer"
          onClick={onToggle}
          data-testid={`checkbox-${cert.certId}`}
        >
          {selected
            ? <CheckSquare className="h-4 w-4" />
            : <Square className="h-4 w-4 text-[#999999]" />}
        </div>

        {/* Thumbnail */}
        <img
          src={imgUrl}
          alt={`Label ${cert.certId}`}
          className="h-8 w-28 object-cover rounded border border-[#E8E4DC] shrink-0 cursor-pointer"
          onClick={onToggle}
          loading="lazy"
          data-testid={`thumb-${cert.certId}`}
        />

        {/* Info — clicks toggle checkbox */}
        <div className="flex-1 min-w-0 cursor-pointer" onClick={onToggle}>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-mono text-xs text-yellow-400" data-testid={`certid-${cert.certId}`}>
              {cert.certId}
            </span>
            <Badge variant="outline" className="text-[10px] px-1 py-0 text-[#666666] border-[#E8E4DC]">
              {gradeDisplay(cert)}
            </Badge>
            {cert.lastPrintedAt && (
              <Badge
                variant="outline"
                className="text-[10px] px-1 py-0 text-emerald-400 border-emerald-700/50"
                data-testid={`badge-printed-${cert.certId}`}
              >
                Printed
              </Badge>
            )}
          </div>
          <p className="text-xs text-[#666666] truncate leading-tight">{cert.cardName}</p>
          {cert.lastPrintedAt && (
            <p className="text-[10px] text-[#999999]">
              Last printed {fmtDate(cert.lastPrintedAt)}
            </p>
          )}
        </div>

        {/* Action buttons — inline on right, never wrap */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Secondary actions: icon-only to save space */}
          <Button
            size="sm" variant="ghost"
            onClick={(e) => { e.stopPropagation(); setShowPreview((v) => !v); }}
            className="h-7 w-7 p-0 text-[#999999] hover:text-yellow-400"
            data-testid={`btn-preview-${cert.certId}`}
            title="Preview label"
          >
            {showPreview ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </Button>

          <Button
            size="sm" variant="ghost"
            disabled={reprintPending}
            onClick={(e) => { e.stopPropagation(); onReprint(cert.certId); }}
            className="h-7 w-7 p-0 text-[#999999] hover:text-yellow-400"
            data-testid={`btn-reprint-${cert.certId}`}
            title="Reprint label"
          >
            {reprintPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5" />}
          </Button>

          <Button
            size="sm" variant="ghost"
            onClick={(e) => { e.stopPropagation(); onEditLabel(cert.certId, cert); }}
            className="h-7 w-7 p-0 text-[#999999] hover:text-yellow-400"
            data-testid={`btn-edit-label-${cert.certId}`}
            title="Edit label display data"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>

          {/* Separator */}
          <div className="h-4 w-px bg-[#E8E4DC] mx-0.5" />

          {/* Certificate PDF download */}
          <a
            href={`/api/admin/certificates/${cert.certId}/certificate-document`}
            onClick={(e) => e.stopPropagation()}
            download={`MintVault-Certificate-${cert.certId}.pdf`}
            className="inline-flex items-center gap-1 h-7 px-2 text-[10px] text-[#999999] hover:text-yellow-400 rounded-md hover:bg-[#FFF9E6] transition-colors whitespace-nowrap"
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
            className="inline-flex items-center gap-1 h-7 px-2.5 text-[10px] font-bold text-[#1A1400] bg-[#D4AF37] hover:bg-[#B8960C] rounded-md transition-colors whitespace-nowrap"
            data-testid={`btn-claim-insert-${cert.certId}`}
            title="Download Claim Insert PDF"
          >
            <FileDown className="h-3 w-3 shrink-0" />
            Claim Insert
          </a>

          {/* Add to sheet */}
          <Button
            size="sm" variant="ghost"
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            className={`h-7 px-2 text-[10px] gap-1 whitespace-nowrap ${
              selected
                ? "text-yellow-400 hover:text-yellow-300"
                : "text-emerald-500 hover:text-emerald-400"
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
          <div className="rounded overflow-hidden border border-[#E8E4DC] max-w-xs">
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
}: {
  onReprintSheet: (certIds: string[]) => Promise<void>;
  generating: boolean;
}) {
  const [detailOpen, setDetailOpen]     = useState(false);
  const [historyOpen, setHistoryOpen]   = useState(false);
  const [reprintingRef, setReprintingRef] = useState<string | null>(null);

  const { data: sheets = [], isLoading } = useQuery<SheetSummary[]>({
    queryKey: ["/api/admin/printing/sheets"],
  });

  const latest  = sheets[0] ?? null;
  const older   = sheets.slice(1);

  const { data: detailItems = [], isLoading: detailLoading } = useQuery<{ certId: string; cert: CertificateRecord | null }[]>({
    queryKey: ["/api/admin/printing/sheets", latest?.sheetRef],
    enabled: !!latest && detailOpen,
  });

  const handleReprint = async (sheetRef: string) => {
    setReprintingRef(sheetRef);
    try {
      const res   = await apiRequest("GET", `/api/admin/printing/sheets/${encodeURIComponent(sheetRef)}`);
      const items: { certId: string }[] = await res.json();
      const ids   = items.map((i) => i.certId).filter(Boolean);
      if (ids.length) await onReprintSheet(ids);
    } finally {
      setReprintingRef(null);
    }
  };

  const sheetLabel = (ref: string) => {
    const n = parseInt(ref.replace("SHEET-", ""), 10);
    return isNaN(n)
      ? ref
      : new Date(n).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-[#999999] py-2">
        <Loader2 className="h-3 w-3 animate-spin" /> Loading latest sheet…
      </div>
    );
  }

  if (!latest) return null;

  const isPending = reprintingRef === latest.sheetRef || generating;

  return (
    <div className="space-y-1" data-testid="latest-sheet-section">
      {/* Latest Sheet card */}
      <div className="rounded-lg border border-[#E8E4DC] overflow-hidden">
        {/* Clickable header row */}
        <button
          className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-[#F5F3EF] hover:bg-[#FAFAF8] transition-colors text-left"
          onClick={() => setDetailOpen((v) => !v)}
          data-testid="btn-toggle-latest-detail"
        >
          <div className="flex items-center gap-3 min-w-0">
            {latest.printed
              ? <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
              : <Clock className="h-4 w-4 text-yellow-500 shrink-0" />}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[#1A1A1A]">
                Latest Sheet
                <span className="ml-2 text-xs font-normal text-[#999999]">
                  {sheetLabel(latest.sheetRef)}
                </span>
              </p>
              <p className="text-[11px] text-[#999999] mt-0.5">
                {latest.total} cert{latest.total !== 1 ? "s" : ""}
                {" · "}
                {latest.printed
                  ? `Printed ${fmtDate(latest.printedAt)}`
                  : "Not yet marked printed"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant="outline"
              disabled={isPending}
              onClick={(e) => { e.stopPropagation(); handleReprint(latest.sheetRef); }}
              className="h-7 text-[10px] px-2 border-yellow-700/40 text-yellow-400 hover:bg-[#FFF9E6]"
              data-testid="btn-reprint-latest-sheet"
            >
              {reprintingRef === latest.sheetRef
                ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
                : <Printer className="h-3 w-3 mr-1" />}
              Reprint Sheet
            </Button>
            {detailOpen
              ? <ChevronUp className="h-4 w-4 text-[#999999]" />
              : <ChevronDown className="h-4 w-4 text-[#999999]" />}
          </div>
        </button>

        {/* Expanded cert list */}
        {detailOpen && (
          <div className="border-t border-[#E8E4DC] p-3 space-y-1 max-h-64 overflow-y-auto">
            {detailLoading ? (
              <div className="flex justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin text-yellow-500" />
              </div>
            ) : detailItems.length === 0 ? (
              <p className="text-xs text-[#999999] text-center py-2">No certificates on this sheet.</p>
            ) : (
              detailItems.map((item) => (
                <div
                  key={item.certId}
                  className="flex items-center gap-3 px-2 py-1.5 rounded text-xs text-[#666666] bg-gray-50"
                  data-testid={`latest-detail-cert-${item.certId}`}
                >
                  <span className="font-mono text-yellow-600 shrink-0 w-14">{item.certId}</span>
                  <span className="truncate">{item.cert?.cardName ?? "—"}</span>
                  <span className="ml-auto text-[#999999] shrink-0">{item.cert?.gradeOverall ?? "—"}</span>
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
            className="text-[11px] text-[#999999] hover:text-[#666666] transition-colors pl-1"
            onClick={() => setHistoryOpen((v) => !v)}
            data-testid="btn-view-full-history"
          >
            {historyOpen ? "Hide history" : `View all ${sheets.length} sheets`}
          </button>

          {historyOpen && (
            <div className="mt-1.5 rounded-lg border border-[#E8E4DC] divide-y divide-[#E8E4DC] overflow-hidden">
              {sheets.map((sheet, idx) => (
                <div
                  key={sheet.sheetRef}
                  className="flex items-center justify-between gap-3 px-3 py-2 bg-gray-50 text-[11px] text-[#999999]"
                  data-testid={`full-history-row-${sheet.sheetRef}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {sheet.printed
                      ? <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
                      : <Clock className="h-3 w-3 text-yellow-600 shrink-0" />}
                    <span>{sheetLabel(sheet.sheetRef)}</span>
                    <span className="text-[#AAAAAA]">· {sheet.total} cert{sheet.total !== 1 ? "s" : ""}</span>
                    {idx === 0 && (
                      <Badge variant="outline" className="text-[9px] border-yellow-700/40 text-yellow-600 py-0 px-1 ml-1">
                        latest
                      </Badge>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={reprintingRef === sheet.sheetRef || generating}
                    onClick={() => handleReprint(sheet.sheetRef)}
                    className="h-6 text-[10px] px-2 text-[#999999] hover:text-yellow-400"
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
      <div className="flex items-center gap-1 border-b border-[#E8E4DC] pb-0">
        <button
          onClick={() => setTab("sheet")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-t transition-colors border-b-2 ${
            tab === "sheet"
              ? "border-yellow-500 text-yellow-400"
              : "border-transparent text-[#999999] hover:text-[#666666]"
          }`}
          data-testid="tab-sheet-printing"
        >
          <LayoutGrid className="h-4 w-4" /> Sheet Printing
        </button>
        <button
          onClick={() => setTab("browser")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-t transition-colors border-b-2 ${
            tab === "browser"
              ? "border-yellow-500 text-yellow-400"
              : "border-transparent text-[#999999] hover:text-[#666666]"
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

  const [selected, setSelected]         = useState<Set<string>>(new Set());
  const [pendingSheetRef, setPending]   = useState<string | null>(null);
  const [filterMode, setFilterMode]     = useState<FilterMode>("all");
  const [search, setSearch]             = useState("");
  const [reprintingId, setReprintingId] = useState<string | null>(null);
  const [generating, setGenerating]     = useState(false);
  const [editTarget, setEditTarget]     = useState<{ certId: string; cert: CertificateRecord } | null>(null);

  const { data: allCerts = [], isLoading: certsLoading, refetch: refetchCerts } =
    useQuery<CertForPrinting[]>({ queryKey: ["/api/admin/printing/queue"] });

  const visibleCerts = useMemo(() => {
    let list = allCerts;
    if (filterMode === "printed")   list = list.filter((c) => c.lastPrintedAt !== null);
    if (filterMode === "unprinted") list = list.filter((c) => c.lastPrintedAt === null);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (c) =>
          c.certId.toLowerCase().includes(q) ||
          (c.cardName?.toLowerCase() ?? "").includes(q),
      );
    }
    return list;
  }, [allCerts, filterMode, search]);

  const countAll       = allCerts.length;
  const countPrinted   = allCerts.filter((c) => c.lastPrintedAt !== null).length;
  const countUnprinted = allCerts.filter((c) => c.lastPrintedAt === null).length;

  const toggle = useCallback((certId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(certId)) next.delete(certId); else next.add(certId);
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

  const selectFirst13  = useCallback(
    () => setSelected(new Set(visibleCerts.slice(0, CERTS_PER_SHEET).map((c) => c.certId))),
    [visibleCerts],
  );
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const invalidate = useCallback(() => {
    refetchCerts();
    qc.invalidateQueries({ queryKey: ["/api/admin/printing/queue"] });
    qc.invalidateQueries({ queryKey: ["/api/admin/printing/sheets"] });
  }, [refetchCerts, qc]);

  // Retry-aware sheet POST — silent retry for transient 429s
  const sheetRequest = useCallback(async (certIds: string[], maxRetries = 3): Promise<Response> => {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, 400 * attempt));
      }
      try {
        const res = await apiRequest("POST", "/api/admin/printing/generate-sheet", { certIds });
        if (res.status === 429) {
          lastErr = new Error("Rate limit — retrying…");
          continue;
        }
        return res;
      } catch (e: any) {
        lastErr = e;
      }
    }
    throw lastErr ?? new Error("Failed after retries");
  }, []);

  // Generate / reprint sheet
  const generateSheet = useCallback(async (certIds: string[]) => {
    setGenerating(true);
    try {
      const res = await sheetRequest(certIds);
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(error);
      }
      const sheetRef = res.headers.get("X-Sheet-Ref") || `SHEET-${Date.now()}`;
      setPending(sheetRef);
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `mintvault-labels-${sheetRef}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      toast({
        title:       "Label sheet generated",
        description: `${certIds.length} cert${certIds.length !== 1 ? "s" : ""} — ${sheetRef}`,
      });
      setSelected(new Set());
      invalidate();
    } catch (err: any) {
      toast({ title: "Sheet generation failed", description: err.message, variant: "destructive" });
    } finally {
      setGenerating(false);
    }
  }, [toast, invalidate, sheetRequest]);

  // Reprint single
  const handleReprint = useCallback(async (certId: string) => {
    setReprintingId(certId);
    try {
      const res = await sheetRequest([certId]);
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(error);
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `mintvault-single-${certId}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Single label generated", description: certId });
      invalidate();
    } catch (err: any) {
      toast({ title: "Reprint failed", description: err.message, variant: "destructive" });
    } finally {
      setReprintingId(null);
    }
  }, [toast, invalidate, sheetRequest]);

  // Download claim insert sheet
  const [downloadingInserts, setDownloadingInserts] = useState(false);
  const downloadClaimInserts = useCallback(async (certIds: string[]) => {
    setDownloadingInserts(true);
    try {
      const res = await apiRequest("POST", "/api/admin/claim-insert-sheet", { certIds });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(error);
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `claim-inserts-${new Date().toISOString().split("T")[0]}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Claim inserts downloaded", description: `${certIds.length} insert${certIds.length !== 1 ? "s" : ""} generated` });
    } catch (err: any) {
      toast({ title: "Claim inserts failed", description: err.message, variant: "destructive" });
    } finally {
      setDownloadingInserts(false);
    }
  }, [toast]);

  // Download SVG cut guide — matches print sheet positions exactly
  const [downloadingCut, setDownloadingCut] = useState(false);
  const downloadCutGuide = useCallback(async (certIds: string[]) => {
    setDownloadingCut(true);
    try {
      const res = await apiRequest("POST", "/api/admin/printing/generate-cut-sheet", { certIds });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(error);
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `mintvault-cut-guide-${certIds.length}row.svg`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Cut guide downloaded", description: `${certIds.length} row(s) — import SVG into CM300, use Direct Cut` });
    } catch (err: any) {
      toast({ title: "Cut guide failed", description: err.message, variant: "destructive" });
    } finally {
      setDownloadingCut(false);
    }
  }, [toast]);

  // v419 — single-sheet print-and-cut batch (front + back + insert per row,
  // up to 5 cards per sheet). Returns a JSON envelope with PDF and SVG as
  // base64 blobs; we save both files in one click.
  const PRINT_BATCH_MAX = 5;
  const [downloadingBatch, setDownloadingBatch] = useState(false);
  const downloadPrintBatch = useCallback(async (certIds: string[]) => {
    // CRITICAL: open the print window IMMEDIATELY, synchronously, while
    // we are still inside the click's user-gesture stack. Chrome/Safari
    // only honour window.print() if the window was opened during a
    // gesture; the v421 iframe approach broke that because the await on
    // the API call elapsed before print() ran, so Chrome silently
    // no-op'd and the PDF just landed in Downloads.
    const printWindow = window.open("", "mintvault-print-batch", "width=900,height=1200");
    if (printWindow) {
      printWindow.document.write(`
        <!DOCTYPE html>
        <html><head><title>Preparing print…</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; color:#666; background:#fafafa; }
        </style></head>
        <body>Preparing print batch…</body></html>
      `);
    } else {
      toast({
        title: "Popup blocked",
        description: "Allow popups for this site to print directly. Falling back to PDF download.",
        variant: "destructive",
      });
    }

    setDownloadingBatch(true);
    try {
      const res = await apiRequest("POST", "/api/admin/print-batch", { certIds });
      if (!res.ok) {
        printWindow?.close();
        const { error } = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(error);
      }
      const data = await res.json() as { pdf: string; svg: string; batchId: string; certIds: string[]; mintedFor?: string[] };

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
        a.click();
        URL.revokeObjectURL(url);
      };

      // SVG always downloads — it goes to the ScanNCut over USB.
      const svgBlob = decode(data.svg, "image/svg+xml");
      saveBlob(svgBlob, `mintvault-batch-${data.batchId}.svg`);

      const pdfBlob = decode(data.pdf, "application/pdf");
      const pdfUrl = URL.createObjectURL(pdfBlob);

      if (printWindow && !printWindow.closed) {
        // Navigate the pre-opened window to the PDF and arm print().
        // replace() avoids polluting back-history with the placeholder.
        printWindow.location.replace(pdfUrl);

        let printed = false;
        const tryPrint = () => {
          if (printed || printWindow.closed) return;
          printed = true;
          try {
            printWindow.focus();
            printWindow.print();
          } catch (err) {
            console.warn("[print-batch] print() threw, falling back to download:", err);
            saveBlob(pdfBlob, `mintvault-batch-${data.batchId}.pdf`);
          }
        };
        // Two-stage arming: Chrome's PDF viewer doesn't always fire
        // onload reliably for blob URLs, so we also force after 1.5s.
        printWindow.onload = tryPrint;
        setTimeout(tryPrint, 1500);

        // Long delay before revoking — print dialog may sit open for a
        // while before the bytes are fully consumed.
        setTimeout(() => URL.revokeObjectURL(pdfUrl), 60_000);
      } else {
        // No print window (popup blocked or user closed it during the
        // API call) — same UX as v420: drop the PDF in Downloads.
        saveBlob(pdfBlob, `mintvault-batch-${data.batchId}.pdf`);
        URL.revokeObjectURL(pdfUrl);
      }

      const mintedCount = data.mintedFor?.length ?? 0;
      const description = printWindow && !printWindow.closed
        ? (mintedCount > 0
            ? `Codes generated for ${mintedCount} cert${mintedCount !== 1 ? "s" : ""} — pick Epson in print dialog`
            : "Pick Epson in print dialog. SVG downloaded for ScanNCut.")
        : (mintedCount > 0
            ? `Codes generated for ${mintedCount} cert${mintedCount !== 1 ? "s" : ""} — PDF + SVG downloaded`
            : "PDF + SVG downloaded.");
      toast({ title: "Print batch ready", description });
    } catch (err: any) {
      printWindow?.close();
      toast({ title: "Print batch failed", description: err.message || String(err), variant: "destructive" });
    } finally {
      setDownloadingBatch(false);
    }
  }, [toast]);

  // Mark printed
  const markPrintedMutation = useMutation({
    mutationFn: (sheetRef: string) =>
      apiRequest("POST", "/api/admin/printing/mark-printed", { sheetRef }),
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
          <h2 className="text-lg font-bold text-yellow-400 tracking-wide flex items-center gap-2">
            <LayoutGrid className="h-5 w-5" /> Label Sheet Printing
          </h2>
          <p className="text-xs text-[#999999] mt-0.5">
            A4 · 9 certs per sheet · 72 × 22 mm labels · Brother ScanNCut CM300
          </p>
        </div>
        <Button
          size="sm" variant="ghost"
          onClick={() => refetchCerts()}
          className="text-[#999999] hover:text-yellow-400"
          data-testid="btn-refresh-printing"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1 border-b border-[#E8E4DC]">
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
                  ? "border-yellow-500 text-yellow-400"
                  : "border-transparent text-[#999999] hover:text-[#666666]"
              }`}
            >
              {label}
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                filterMode === mode ? "bg-[#FFF9E6] text-yellow-400" : "bg-[#E8E4DC] text-[#999999]"
              }`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Search + toolbar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#999999] pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by cert ID or card name…"
            className="pl-8 pr-8 h-8 text-xs bg-[#FAFAF8] border-[#E8E4DC] text-[#1A1A1A] placeholder-[#AAAAAA]"
            data-testid="input-search-certs"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#999999] hover:text-[#666666]"
              data-testid="btn-clear-search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <span className="text-xs text-[#999999]">
            {visibleCerts.length} cert{visibleCerts.length !== 1 ? "s" : ""}
            {search || filterMode !== "all" ? " (filtered)" : ""}
          </span>
          {selected.size > 0 && (
            <button
              onClick={clearSelection}
              className="text-[11px] text-[#999999] hover:text-[#666666] transition-colors"
              data-testid="btn-clear-selection"
            >
              Clear ({selected.size})
            </button>
          )}
          {visibleCerts.length > 0 && (
            <button
              onClick={toggleAll}
              className="text-[11px] text-yellow-500/70 hover:text-yellow-400 transition-colors"
              data-testid="btn-toggle-all"
            >
              {allVisible ? "Deselect all" : "Select all"}
            </button>
          )}
          {visibleCerts.length > CERTS_PER_SHEET && (
            <button
              onClick={selectFirst13}
              className="text-[11px] text-yellow-500/70 hover:text-yellow-400 transition-colors"
              data-testid="btn-select-13"
            >
              First 13
            </button>
          )}
        </div>
      </div>

      {/* Certificate list — full width */}
      {certsLoading ? (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="h-5 w-5 animate-spin text-yellow-500" />
        </div>
      ) : visibleCerts.length === 0 ? (
        <div className="rounded-lg border border-[#E8E4DC] p-10 text-center text-[#999999] text-sm">
          {search || filterMode !== "all"
            ? "No certificates match your filter."
            : "No certificates found."}
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

      {/* Generate buttons */}
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button
          onClick={() => generateSheet(Array.from(selected))}
          disabled={selected.size === 0 || generating}
          data-testid="btn-generate-sheet"
          className="bg-yellow-600 hover:bg-yellow-500 text-black font-bold"
        >
          {generating
            ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Generating…</>
            : <><FileDown className="h-4 w-4 mr-2" /> Print Sheet ({selected.size} / {CERTS_PER_SHEET})</>}
        </Button>
        <Button
          onClick={() => downloadCutGuide(Array.from(selected))}
          disabled={selected.size === 0 || downloadingCut}
          data-testid="btn-cut-guide"
          variant="outline"
          className="border-red-700/60 text-red-400 hover:bg-red-900/20 hover:text-red-300 font-medium"
        >
          {downloadingCut
            ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Generating…</>
            : <><FileDown className="h-4 w-4 mr-2" /> Cut Guide SVG ({selected.size})</>}
        </Button>
        <Button
          onClick={() => downloadClaimInserts(Array.from(selected))}
          disabled={selected.size === 0 || downloadingInserts}
          data-testid="btn-claim-inserts"
          variant="outline"
          className="border-[#D4AF37]/60 text-[#D4AF37] hover:bg-[#D4AF37]/10 font-medium"
        >
          {downloadingInserts
            ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Generating…</>
            : <><FileDown className="h-4 w-4 mr-2" /> Claim Inserts ({selected.size})</>}
        </Button>
        {/* v419 — combined batch: 1-5 cards/sheet with front + back + insert
            laid out + matching cut SVG. One ScanNCut pass cuts everything. */}
        <Button
          onClick={() => downloadPrintBatch(Array.from(selected))}
          disabled={selected.size === 0 || selected.size > PRINT_BATCH_MAX || downloadingBatch}
          data-testid="btn-print-batch"
          title={
            selected.size === 0
              ? `Select up to ${PRINT_BATCH_MAX} unclaimed certs`
              : selected.size > PRINT_BATCH_MAX
                ? `Maximum ${PRINT_BATCH_MAX} certs per batch`
                : "Print PDF to your printer + download SVG cut guide for ScanNCut CM300"
          }
          className="bg-emerald-700 hover:bg-emerald-600 text-white font-bold"
        >
          {downloadingBatch
            ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Generating…</>
            : <><FileDown className="h-4 w-4 mr-2" /> Print Batch CM300 ({selected.size} / {PRINT_BATCH_MAX})</>}
        </Button>
        {selected.size > CERTS_PER_SHEET && (
          <span className="text-xs text-red-400" data-testid="text-over-limit">
            Max {CERTS_PER_SHEET} — deselect {selected.size - CERTS_PER_SHEET}
          </span>
        )}
      </div>

      {/* Post-generate mark-printed prompt */}
      {pendingSheetRef && (
        <div className="rounded-md border border-yellow-700/40 bg-[#FFF9E6] p-3 flex items-center justify-between gap-4">
          <p className="text-xs text-yellow-300">
            <strong>PDF downloaded.</strong> Print the sheet, then confirm it was printed.
          </p>
          <Button
            size="sm"
            onClick={() => markPrintedMutation.mutate(pendingSheetRef)}
            disabled={markPrintedMutation.isPending}
            data-testid="btn-mark-printed-inline"
            className="bg-emerald-700 hover:bg-emerald-600 text-[#1A1A1A] text-xs shrink-0"
          >
            {markPrintedMutation.isPending
              ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Marking…</>
              : <><PrinterCheck className="h-3 w-3 mr-1" /> Mark Sheet Printed</>}
          </Button>
        </div>
      )}

      {/* Latest Sheet */}
      <LatestSheetSection
        onReprintSheet={generateSheet}
        generating={generating}
      />

      {/* Edit label modal */}
      {editTarget && (
        <EditLabelModal
          certId={editTarget.certId}
          cert={editTarget.cert}
          onClose={() => setEditTarget(null)}
        />
      )}
    </div>
  );
}
