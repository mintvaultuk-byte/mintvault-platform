import { useState, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { CertificateRecord, LabelOverride } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Loader2, Eye, Printer, Pencil, CheckCircle2, Clock, X, RefreshCw, Search, RotateCcw, Shield,
} from "lucide-react";

type BrowserCert = CertificateRecord & { isPrinted: boolean; reprintCount: number };

function gradeDisplay(cert: CertificateRecord): string {
  if (!cert.gradeOverall) return "—";
  const n = parseFloat(cert.gradeOverall);
  return isNaN(n) ? cert.gradeOverall : String(n);
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// ── Edit Label Data Modal ────────────────────────────────────────────────────
function EditModal({
  cert,
  onClose,
}: {
  cert: BrowserCert;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: existingOverride } = useQuery<LabelOverride | null>({
    queryKey: ["/api/admin/printing/override", cert.certId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/printing/override/${cert.certId}`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
  });

  const [form, setForm] = useState({
    cardNameOverride: cert.cardName ?? "",
    setOverride:      cert.setName  ?? "",
    variantOverride:  cert.variant  ?? "",
    languageOverride: cert.language ?? "",
    yearOverride:     cert.year     ?? "",
  });

  useEffect(() => {
    if (existingOverride) {
      setForm({
        cardNameOverride: existingOverride.cardNameOverride ?? cert.cardName ?? "",
        setOverride:      existingOverride.setOverride      ?? cert.setName  ?? "",
        variantOverride:  existingOverride.variantOverride  ?? cert.variant  ?? "",
        languageOverride: existingOverride.languageOverride ?? cert.language ?? "",
        yearOverride:     existingOverride.yearOverride     ?? cert.year     ?? "",
      });
    }
  }, [existingOverride]);

  const saveMutation = useMutation({
    mutationFn: (data: typeof form) =>
      apiRequest("POST", `/api/admin/printing/override/${cert.certId}`, data),
    onSuccess: () => {
      toast({ title: "Label data saved" });
      qc.invalidateQueries({ queryKey: ["/api/admin/printing/browser"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/printing/override", cert.certId] });
      onClose();
    },
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });

  const clearMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", `/api/admin/printing/override/${cert.certId}`),
    onSuccess: () => {
      toast({ title: "Overrides cleared — label reverted to original data" });
      qc.invalidateQueries({ queryKey: ["/api/admin/printing/browser"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/printing/override", cert.certId] });
      onClose();
    },
    onError: () => toast({ title: "Clear failed", variant: "destructive" }),
  });

  const field = (
    id: keyof typeof form,
    label: string,
    placeholder?: string
  ) => (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs text-gray-400">{label}</Label>
      <Input
        id={id}
        value={form[id]}
        onChange={(e) => setForm((f) => ({ ...f, [id]: e.target.value }))}
        placeholder={placeholder || label}
        className="bg-black border-gray-700 text-gray-100 text-sm h-8"
        data-testid={`input-override-${id}`}
      />
    </div>
  );

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="bg-gray-950 border-gray-800 text-gray-100 max-w-md">
        <DialogHeader>
          <DialogTitle className="text-yellow-400 flex items-center gap-2">
            <Pencil className="h-4 w-4" /> Edit Label Display Data
          </DialogTitle>
          <p className="text-xs text-gray-500 mt-1">
            <span className="font-mono text-yellow-500/80">{cert.certId}</span> · Grade{" "}
            <span className="text-white">{gradeDisplay(cert)}</span> — locked, not editable
          </p>
        </DialogHeader>

        <div className="space-y-3 py-1">
          {field("cardNameOverride", "Card Name")}
          {field("setOverride", "Set Name")}
          {field("variantOverride", "Variant")}
          {field("languageOverride", "Language", "e.g. Japanese")}
          {field("yearOverride", "Year", "e.g. 1999")}
          <p className="text-[11px] text-gray-600">
            Grade, certificate number, and QR code are locked — changes here only affect the printed label display.
          </p>
        </div>

        <DialogFooter className="gap-2 flex-wrap">
          {existingOverride && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => clearMutation.mutate()}
              disabled={clearMutation.isPending}
              className="text-red-400 hover:text-red-300 text-xs"
              data-testid="btn-clear-override"
            >
              {clearMutation.isPending
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <><RotateCcw className="h-3 w-3 mr-1" /> Revert to original</>}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={onClose}
            className="border-gray-700 text-gray-400 text-xs"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => saveMutation.mutate(form)}
            disabled={saveMutation.isPending}
            className="bg-yellow-600 hover:bg-yellow-500 text-black font-bold text-xs"
            data-testid="btn-save-override"
          >
            {saveMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Label Preview Modal ───────────────────────────────────────────────────────
function PreviewModal({ cert, onClose }: { cert: BrowserCert; onClose: () => void }) {
  const frontUrl = `/api/admin/certificates/label/${cert.certId}/front.png`;
  const backUrl  = `/api/admin/certificates/label/${cert.certId}/back.png`;
  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="bg-gray-950 border-gray-800 text-gray-100 max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-yellow-400 text-sm">
            Label Preview — <span className="font-mono">{cert.certId}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <p className="text-[11px] text-gray-500 mb-1 uppercase tracking-wider">Front</p>
            <img
              src={frontUrl}
              alt="Front label"
              className="w-full rounded border border-gray-800"
              data-testid={`preview-front-${cert.certId}`}
            />
          </div>
          <div>
            <p className="text-[11px] text-gray-500 mb-1 uppercase tracking-wider">Back</p>
            <img
              src={backUrl}
              alt="Back label"
              className="w-full rounded border border-gray-800"
              data-testid={`preview-back-${cert.certId}`}
            />
          </div>
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onClose} className="border-gray-700 text-gray-400 text-xs">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Certificate Browser Row ──────────────────────────────────────────────────
function BrowserRow({
  cert,
  onPreview,
  onReprint,
  onEdit,
  reprintPending,
}: {
  cert: BrowserCert;
  onPreview: () => void;
  onReprint: () => void;
  onEdit: () => void;
  reprintPending: boolean;
}) {
  return (
    <div
      className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] items-center gap-3 px-3 py-2 rounded-lg border border-gray-800 hover:border-gray-700 transition-colors text-sm"
      data-testid={`browser-row-${cert.certId}`}
    >
      {/* Printed status */}
      <div className="shrink-0">
        {cert.isPrinted
          ? <CheckCircle2 className="h-4 w-4 text-emerald-400" />
          : <Clock className="h-4 w-4 text-yellow-500/60" />}
      </div>

      {/* Cert info */}
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-xs text-yellow-400" data-testid={`certid-browser-${cert.certId}`}>
            {cert.certId}
          </span>
          <Badge variant="outline" className="text-[10px] px-1 py-0 border-yellow-700/40 text-yellow-500">
            {gradeDisplay(cert)}
          </Badge>
          {cert.reprintCount > 0 && (
            <Badge variant="outline" className="text-[10px] px-1 py-0 border-blue-700/40 text-blue-400">
              ×{cert.reprintCount} reprint{cert.reprintCount !== 1 ? "s" : ""}
            </Badge>
          )}
          {(cert as any).ownershipStatus === "claimed" ? (
            <Badge variant="outline" className="text-[10px] px-1 py-0 border-[#D4AF37]/40 text-[#D4AF37] flex items-center gap-0.5" data-testid={`badge-ownership-browser-${cert.certId}`}>
              <Shield className="h-2.5 w-2.5" /> claimed
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px] px-1 py-0 border-gray-700 text-gray-600" data-testid={`badge-ownership-browser-${cert.certId}`}>
              unclaimed
            </Badge>
          )}
        </div>
        <p className="text-xs text-gray-400 truncate" data-testid={`cardname-browser-${cert.certId}`}>
          {cert.cardName ?? "—"}
          {cert.setName ? <span className="text-gray-600"> · {cert.setName}</span> : null}
        </p>
        <p className="text-[10px] text-gray-600">{fmtDate(cert.createdAt)}</p>
      </div>

      {/* Actions */}
      <button
        onClick={onPreview}
        className="text-gray-500 hover:text-yellow-400 transition-colors p-1 rounded"
        title="Preview label"
        data-testid={`btn-preview-${cert.certId}`}
      >
        <Eye className="h-4 w-4" />
      </button>
      <button
        onClick={onReprint}
        disabled={reprintPending}
        className="text-gray-500 hover:text-blue-400 transition-colors p-1 rounded disabled:opacity-40"
        title="Reprint label"
        data-testid={`btn-reprint-${cert.certId}`}
      >
        {reprintPending
          ? <Loader2 className="h-4 w-4 animate-spin" />
          : <Printer className="h-4 w-4" />}
      </button>
      <button
        onClick={onEdit}
        className="text-gray-500 hover:text-yellow-400 transition-colors p-1 rounded"
        title="Edit label display data"
        data-testid={`btn-edit-${cert.certId}`}
      >
        <Pencil className="h-4 w-4" />
      </button>
    </div>
  );
}

// ── Main Export ───────────────────────────────────────────────────────────────
export default function AdminCertBrowser() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [previewCert, setPreviewCert] = useState<BrowserCert | null>(null);
  const [editCert, setEditCert] = useState<BrowserCert | null>(null);
  const [reprintingId, setReprintingId] = useState<string | null>(null);

  const { data: certs = [], isLoading, refetch } = useQuery<BrowserCert[]>({
    queryKey: ["/api/admin/printing/browser"],
  });

  const handleReprint = useCallback(async (cert: BrowserCert) => {
    setReprintingId(cert.certId);
    try {
      const res = await fetch(`/api/admin/printing/reprint/${cert.certId}?side=both`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Reprint failed");
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `${cert.certId}-reprint.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Reprint generated", description: cert.certId });
      qc.invalidateQueries({ queryKey: ["/api/admin/printing/browser"] });
    } catch {
      toast({ title: "Reprint failed", variant: "destructive" });
    } finally {
      setReprintingId(null);
    }
  }, [toast, qc]);

  const filtered = certs.filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      c.certId.toLowerCase().includes(q) ||
      (c.cardName ?? "").toLowerCase().includes(q) ||
      (c.setName  ?? "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-4" data-testid="admin-cert-browser">
      {/* Header row */}
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-500" />
          <Input
            placeholder="Search cert ID, card name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 bg-black border-gray-700 text-gray-100 text-sm h-8"
            data-testid="input-browser-search"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px] text-gray-500 border-gray-700">
            {filtered.length} of {certs.length}
          </Badge>
          <button
            onClick={() => refetch()}
            className="text-gray-500 hover:text-yellow-400 transition-colors p-1 rounded"
            data-testid="btn-browser-refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-[11px] text-gray-600">
        <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-emerald-400" /> Printed</span>
        <span className="flex items-center gap-1"><Clock className="h-3 w-3 text-yellow-500/60" /> Not yet printed</span>
        <span className="ml-auto flex items-center gap-3">
          <span className="flex items-center gap-1"><Eye className="h-3 w-3" /> Preview</span>
          <span className="flex items-center gap-1"><Printer className="h-3 w-3" /> Reprint PDF</span>
          <span className="flex items-center gap-1"><Pencil className="h-3 w-3" /> Edit display data</span>
        </span>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="h-5 w-5 animate-spin text-yellow-500" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-gray-800 p-8 text-center text-gray-600 text-sm">
          {search ? "No certificates match your search." : "No certificates found."}
        </div>
      ) : (
        <div className="space-y-1.5 max-h-[600px] overflow-y-auto pr-1">
          {filtered.map((cert) => (
            <BrowserRow
              key={cert.certId}
              cert={cert}
              onPreview={() => setPreviewCert(cert)}
              onReprint={() => handleReprint(cert)}
              onEdit={() => setEditCert(cert)}
              reprintPending={reprintingId === cert.certId}
            />
          ))}
        </div>
      )}

      {/* Modals */}
      {previewCert && (
        <PreviewModal cert={previewCert} onClose={() => setPreviewCert(null)} />
      )}
      {editCert && (
        <EditModal cert={editCert} onClose={() => setEditCert(null)} />
      )}
    </div>
  );
}
