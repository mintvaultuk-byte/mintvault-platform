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

  const form = useForm({
    values: {
      cardName: existing?.cardNameOverride ?? cert?.cardName ?? "",
      setName:  existing?.setOverride      ?? cert?.setName  ?? "",
      variant:  existing?.variantOverride  ?? cert?.variant  ?? "",
      language: existing?.languageOverride ?? cert?.language ?? "",
      year:     existing?.yearOverride     ?? cert?.year     ?? "",
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (data: ReturnType<typeof form.getValues>) => {
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
        className="bg-gray-950 border-gray-800 text-gray-100 max-w-md"
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
            <div className="rounded-md bg-yellow-900/20 border border-yellow-700/30 p-3 text-[11px] text-yellow-300 flex gap-2">
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
                <Label htmlFor={`edit-${id}`} className="text-xs text-gray-400">
                  {label}
                </Label>
                <Input
                  id={`edit-${id}`}
                  {...form.register(id as any)}
                  className="h-8 text-sm bg-gray-900 border-gray-700 text-gray-100"
                  data-testid={`input-edit-${id}`}
                />
              </div>
            ))}

            <DialogFooter>
              <Button
                type="button" variant="ghost" onClick={onClose}
                className="text-gray-500"
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
          ? "border-yellow-500/70 bg-yellow-900/20"
          : "border-gray-800 hover:border-gray-700"
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
            : <Square className="h-4 w-4 text-gray-600" />}
        </div>

        {/* Thumbnail */}
        <img
          src={imgUrl}
          alt={`Label ${cert.certId}`}
          className="h-8 w-28 object-cover rounded border border-gray-700 shrink-0 cursor-pointer"
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
            <Badge variant="outline" className="text-[10px] px-1 py-0 text-gray-400 border-gray-700">
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
          <p className="text-xs text-gray-400 truncate leading-tight">{cert.cardName}</p>
          {cert.lastPrintedAt && (
            <p className="text-[10px] text-gray-600">
              Last printed {fmtDate(cert.lastPrintedAt)}
            </p>
          )}
        </div>

        {/* Action buttons — inline on right, never wrap */}
        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="sm" variant="ghost"
            onClick={(e) => { e.stopPropagation(); setShowPreview((v) => !v); }}
            className="h-7 px-2 text-[10px] text-gray-500 hover:text-yellow-400 gap-1"
            data-testid={`btn-preview-${cert.certId}`}
            title="Preview label"
          >
            {showPreview
              ? <EyeOff className="h-3 w-3" />
              : <Eye className="h-3 w-3" />}
            <span className="hidden sm:inline">Preview</span>
          </Button>

          <Button
            size="sm" variant="ghost"
            disabled={reprintPending}
            onClick={(e) => { e.stopPropagation(); onReprint(cert.certId); }}
            className="h-7 px-2 text-[10px] text-gray-500 hover:text-yellow-400 gap-1"
            data-testid={`btn-reprint-${cert.certId}`}
            title="Reprint single label"
          >
            {reprintPending
              ? <Loader2 className="h-3 w-3 animate-spin" />
              : <Printer className="h-3 w-3" />}
            <span className="hidden sm:inline">Reprint</span>
          </Button>

          <Button
            size="sm" variant="ghost"
            onClick={(e) => { e.stopPropagation(); onEditLabel(cert.certId, cert); }}
            className="h-7 px-2 text-[10px] text-gray-500 hover:text-yellow-400 gap-1"
            data-testid={`btn-edit-label-${cert.certId}`}
            title="Edit label display data"
          >
            <Pencil className="h-3 w-3" />
            <span className="hidden sm:inline">Edit Label</span>
          </Button>

          <Button
            size="sm" variant="ghost"
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            className={`h-7 px-2 text-[10px] gap-1 ${
              selected
                ? "text-yellow-400 hover:text-yellow-300"
                : "text-emerald-500 hover:text-emerald-400"
            }`}
            data-testid={`btn-add-to-sheet-${cert.certId}`}
            title={selected ? "Remove from sheet" : "Add to sheet"}
          >
            <PlusCircle className="h-3 w-3" />
            <span className="hidden sm:inline">{selected ? "Remove" : "Add to Sheet"}</span>
          </Button>
        </div>
      </div>

      {/* Inline label preview */}
      {showPreview && (
        <div className="px-2 pb-2">
          <div className="rounded overflow-hidden border border-gray-700 max-w-xs">
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
      <div className="flex items-center gap-2 text-xs text-gray-600 py-2">
        <Loader2 className="h-3 w-3 animate-spin" /> Loading latest sheet…
      </div>
    );
  }

  if (!latest) return null;

  const isPending = reprintingRef === latest.sheetRef || generating;

  return (
    <div className="space-y-1" data-testid="latest-sheet-section">
      {/* Latest Sheet card */}
      <div className="rounded-lg border border-gray-800 overflow-hidden">
        {/* Clickable header row */}
        <button
          className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-gray-900/50 hover:bg-gray-900 transition-colors text-left"
          onClick={() => setDetailOpen((v) => !v)}
          data-testid="btn-toggle-latest-detail"
        >
          <div className="flex items-center gap-3 min-w-0">
            {latest.printed
              ? <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
              : <Clock className="h-4 w-4 text-yellow-500 shrink-0" />}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-200">
                Latest Sheet
                <span className="ml-2 text-xs font-normal text-gray-500">
                  {sheetLabel(latest.sheetRef)}
                </span>
              </p>
              <p className="text-[11px] text-gray-500 mt-0.5">
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
              className="h-7 text-[10px] px-2 border-yellow-700/40 text-yellow-400 hover:bg-yellow-900/30"
              data-testid="btn-reprint-latest-sheet"
            >
              {reprintingRef === latest.sheetRef
                ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
                : <Printer className="h-3 w-3 mr-1" />}
              Reprint Sheet
            </Button>
            {detailOpen
              ? <ChevronUp className="h-4 w-4 text-gray-500" />
              : <ChevronDown className="h-4 w-4 text-gray-500" />}
          </div>
        </button>

        {/* Expanded cert list */}
        {detailOpen && (
          <div className="border-t border-gray-800 p-3 space-y-1 max-h-64 overflow-y-auto">
            {detailLoading ? (
              <div className="flex justify-center py-4">
                <Loader2 className="h-4 w-4 animate-spin text-yellow-500" />
              </div>
            ) : detailItems.length === 0 ? (
              <p className="text-xs text-gray-600 text-center py-2">No certificates on this sheet.</p>
            ) : (
              detailItems.map((item) => (
                <div
                  key={item.certId}
                  className="flex items-center gap-3 px-2 py-1.5 rounded text-xs text-gray-400 bg-gray-900/30"
                  data-testid={`latest-detail-cert-${item.certId}`}
                >
                  <span className="font-mono text-yellow-600 shrink-0 w-14">{item.certId}</span>
                  <span className="truncate">{item.cert?.cardName ?? "—"}</span>
                  <span className="ml-auto text-gray-600 shrink-0">{item.cert?.gradeOverall ?? "—"}</span>
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
            className="text-[11px] text-gray-600 hover:text-gray-400 transition-colors pl-1"
            onClick={() => setHistoryOpen((v) => !v)}
            data-testid="btn-view-full-history"
          >
            {historyOpen ? "Hide history" : `View all ${sheets.length} sheets`}
          </button>

          {historyOpen && (
            <div className="mt-1.5 rounded-lg border border-gray-800 divide-y divide-gray-800 overflow-hidden">
              {sheets.map((sheet, idx) => (
                <div
                  key={sheet.sheetRef}
                  className="flex items-center justify-between gap-3 px-3 py-2 bg-gray-900/20 text-[11px] text-gray-500"
                  data-testid={`full-history-row-${sheet.sheetRef}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {sheet.printed
                      ? <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
                      : <Clock className="h-3 w-3 text-yellow-600 shrink-0" />}
                    <span>{sheetLabel(sheet.sheetRef)}</span>
                    <span className="text-gray-700">· {sheet.total} cert{sheet.total !== 1 ? "s" : ""}</span>
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
                    className="h-6 text-[10px] px-2 text-gray-500 hover:text-yellow-400"
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
      <div className="flex items-center gap-1 border-b border-gray-800 pb-0">
        <button
          onClick={() => setTab("sheet")}
          className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-t transition-colors border-b-2 ${
            tab === "sheet"
              ? "border-yellow-500 text-yellow-400"
              : "border-transparent text-gray-500 hover:text-gray-300"
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
              : "border-transparent text-gray-500 hover:text-gray-300"
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
          <p className="text-xs text-gray-500 mt-0.5">
            A4 · 10 certs per sheet · 70 × 20 mm labels · Brother ScanNCut CM300
          </p>
        </div>
        <Button
          size="sm" variant="ghost"
          onClick={() => refetchCerts()}
          className="text-gray-500 hover:text-yellow-400"
          data-testid="btn-refresh-printing"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1 border-b border-gray-800">
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
                  : "border-transparent text-gray-500 hover:text-gray-300"
              }`}
            >
              {label}
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                filterMode === mode ? "bg-yellow-900/40 text-yellow-400" : "bg-gray-800 text-gray-500"
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
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-500 pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by cert ID or card name…"
            className="pl-8 pr-8 h-8 text-xs bg-gray-900 border-gray-700 text-gray-200 placeholder-gray-600"
            data-testid="input-search-certs"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
              data-testid="btn-clear-search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <span className="text-xs text-gray-500">
            {visibleCerts.length} cert{visibleCerts.length !== 1 ? "s" : ""}
            {search || filterMode !== "all" ? " (filtered)" : ""}
          </span>
          {selected.size > 0 && (
            <button
              onClick={clearSelection}
              className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
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
        <div className="rounded-lg border border-gray-800 p-10 text-center text-gray-600 text-sm">
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
        {selected.size > CERTS_PER_SHEET && (
          <span className="text-xs text-red-400" data-testid="text-over-limit">
            Max {CERTS_PER_SHEET} — deselect {selected.size - CERTS_PER_SHEET}
          </span>
        )}
      </div>

      {/* Post-generate mark-printed prompt */}
      {pendingSheetRef && (
        <div className="rounded-md border border-yellow-700/40 bg-yellow-900/20 p-3 flex items-center justify-between gap-4">
          <p className="text-xs text-yellow-300">
            <strong>PDF downloaded.</strong> Print the sheet, then confirm it was printed.
          </p>
          <Button
            size="sm"
            onClick={() => markPrintedMutation.mutate(pendingSheetRef)}
            disabled={markPrintedMutation.isPending}
            data-testid="btn-mark-printed-inline"
            className="bg-emerald-700 hover:bg-emerald-600 text-white text-xs shrink-0"
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
