import { useState, useCallback, useEffect, useRef } from "react";
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
  Loader2, Eye, Printer, Pencil, CheckCircle2, Clock, X, RefreshCw, Search, RotateCcw, Shield, ClipboardList, Instagram, Paperclip, Upload,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";

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
      <Label htmlFor={id} className="text-xs text-[#666666]">{label}</Label>
      <Input
        id={id}
        value={form[id]}
        onChange={(e) => setForm((f) => ({ ...f, [id]: e.target.value }))}
        placeholder={placeholder || label}
        className="bg-white border-[#E8E4DC] text-[#1A1A1A] text-sm h-8"
        data-testid={`input-override-${id}`}
      />
    </div>
  );

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="bg-white border-[#E8E4DC] text-[#1A1A1A] max-w-md">
        <DialogHeader>
          <DialogTitle className="text-yellow-400 flex items-center gap-2">
            <Pencil className="h-4 w-4" /> Edit Label Display Data
          </DialogTitle>
          <p className="text-xs text-[#999999] mt-1">
            <span className="font-mono text-yellow-500/80">{cert.certId}</span> · Grade{" "}
            <span className="text-[#1A1A1A]">{gradeDisplay(cert)}</span> — locked, not editable
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
            className="border-[#E8E4DC] text-[#666666] text-xs"
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

// ── Grading Report Modal ─────────────────────────────────────────────────────
function GradingReportModal({
  cert,
  onClose,
}: {
  cert: BrowserCert;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [form, setForm] = useState({
    centering: "",
    corners:   "",
    edges:     "",
    surface:   "",
    overall:   "",
  });

  const { data: existing, isLoading } = useQuery<{ gradingReport?: Record<string, string> } | null>({
    queryKey: ["/api/admin/printing/browser/cert", cert.certId],
    queryFn: async () => {
      const res = await fetch(`/api/cert/${cert.certId}`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
  });

  useEffect(() => {
    const r = (existing as any)?.gradingReport;
    if (r) {
      setForm({
        centering: r.centering ?? "",
        corners:   r.corners   ?? "",
        edges:     r.edges     ?? "",
        surface:   r.surface   ?? "",
        overall:   r.overall   ?? "",
      });
    }
  }, [existing]);

  const saveMutation = useMutation({
    mutationFn: (data: typeof form) =>
      apiRequest("PATCH", `/api/admin/certificates/${cert.certId}/grading-report`, data),
    onSuccess: () => {
      toast({ title: "Grading report saved" });
      qc.invalidateQueries({ queryKey: ["/api/admin/printing/browser/cert", cert.certId] });
      onClose();
    },
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });

  const field = (id: keyof typeof form, label: string, placeholder: string) => (
    <div className="space-y-1">
      <Label htmlFor={`gr-${id}`} className="text-xs text-[#666666]">{label}</Label>
      <Textarea
        id={`gr-${id}`}
        value={form[id]}
        onChange={(e) => setForm((f) => ({ ...f, [id]: e.target.value }))}
        placeholder={placeholder}
        rows={2}
        className="bg-white border-[#E8E4DC] text-[#1A1A1A] text-sm resize-none"
      />
    </div>
  );

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="bg-white border-[#E8E4DC] text-[#1A1A1A] max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-yellow-400 flex items-center gap-2">
            <ClipboardList className="h-4 w-4" /> Grading Report
          </DialogTitle>
          <p className="text-xs text-[#999999] mt-1">
            <span className="font-mono text-yellow-500/80">{cert.certId}</span> — commentary shown on the public cert page. All fields optional.
          </p>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-[#999999]" />
          </div>
        ) : (
          <div className="space-y-3 py-1">
            {field("centering", "Centering", "e.g. Front centering measured at approximately 55/45 left-right, 50/50 top-bottom")}
            {field("corners",   "Corners",   "e.g. All four corners sharp under 10x magnification. No whitening detected")}
            {field("edges",     "Edges",     "e.g. Clean edges with no visible whitening or chipping")}
            {field("surface",   "Surface",   "e.g. No scratches, print lines, or surface damage detected")}
            {field("overall",   "Overall",   "e.g. Exceptional example — clean presentation across all four categories")}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onClose}
            className="border-[#E8E4DC] text-[#666666] text-xs"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => saveMutation.mutate(form)}
            disabled={saveMutation.isPending || isLoading}
            className="bg-yellow-600 hover:bg-yellow-500 text-black font-bold text-xs"
          >
            {saveMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Save Report"}
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
      <DialogContent className="bg-white border-[#E8E4DC] text-[#1A1A1A] max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-yellow-400 text-sm">
            Label Preview — <span className="font-mono">{cert.certId}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <p className="text-[11px] text-[#999999] mb-1 uppercase tracking-wider">Front</p>
            <img
              src={frontUrl}
              alt="Front label"
              className="w-full rounded border border-[#E8E4DC]"
              data-testid={`preview-front-${cert.certId}`}
            />
          </div>
          <div>
            <p className="text-[11px] text-[#999999] mb-1 uppercase tracking-wider">Back</p>
            <img
              src={backUrl}
              alt="Back label"
              className="w-full rounded border border-[#E8E4DC]"
              data-testid={`preview-back-${cert.certId}`}
            />
          </div>
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onClose} className="border-[#E8E4DC] text-[#666666] text-xs">
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
  onReport,
  onIgPost,
  onAttachImages,
  reprintPending,
}: {
  cert: BrowserCert;
  onPreview: () => void;
  onReprint: () => void;
  onEdit: () => void;
  onReport: () => void;
  onIgPost: () => void;
  onAttachImages: () => void;
  reprintPending: boolean;
}) {
  const missingFront = !((cert as any).frontImagePath);
  const missingBack  = !((cert as any).backImagePath);
  const needsImages  = missingFront || missingBack;
  return (
    <div
      className="grid grid-cols-[auto_1fr_auto_auto_auto_auto_auto_auto] items-center gap-3 px-3 py-2 rounded-lg border border-[#E8E4DC] hover:border-[#D4AF37]/30 transition-colors text-sm"
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
            <Badge variant="outline" className="text-[10px] px-1 py-0 border-[#E8E4DC] text-[#999999]" data-testid={`badge-ownership-browser-${cert.certId}`}>
              unclaimed
            </Badge>
          )}
        </div>
        <p className="text-xs text-[#666666] truncate" data-testid={`cardname-browser-${cert.certId}`}>
          {cert.cardName ?? "—"}
          {cert.setName ? <span className="text-gray-600"> · {cert.setName}</span> : null}
        </p>
        <p className="text-[10px] text-gray-600">{fmtDate(cert.createdAt)}</p>
      </div>

      {/* Actions */}
      <button
        onClick={onPreview}
        className="text-[#999999] hover:text-[#D4AF37] transition-colors p-1 rounded"
        title="Preview label"
        data-testid={`btn-preview-${cert.certId}`}
      >
        <Eye className="h-4 w-4" />
      </button>
      <button
        onClick={onReprint}
        disabled={reprintPending}
        className="text-[#999999] hover:text-blue-400 transition-colors p-1 rounded disabled:opacity-40"
        title="Reprint label"
        data-testid={`btn-reprint-${cert.certId}`}
      >
        {reprintPending
          ? <Loader2 className="h-4 w-4 animate-spin" />
          : <Printer className="h-4 w-4" />}
      </button>
      <button
        onClick={onEdit}
        className="text-[#999999] hover:text-[#D4AF37] transition-colors p-1 rounded"
        title="Edit label display data"
        data-testid={`btn-edit-${cert.certId}`}
      >
        <Pencil className="h-4 w-4" />
      </button>
      <button
        onClick={onReport}
        className="text-[#999999] hover:text-green-400 transition-colors p-1 rounded"
        title="Edit grading report"
        data-testid={`btn-report-${cert.certId}`}
      >
        <ClipboardList className="h-4 w-4" />
      </button>
      <button
        onClick={onIgPost}
        className="text-[#999999] hover:text-pink-400 transition-colors p-1 rounded"
        title="Post to Instagram"
        data-testid={`btn-ig-post-${cert.certId}`}
      >
        <Instagram className="h-4 w-4" />
      </button>
      {needsImages ? (
        <button
          onClick={onAttachImages}
          className="text-amber-500 hover:text-amber-400 transition-colors p-1 rounded"
          title={`Attach images${missingFront && missingBack ? " (front + back missing)" : missingFront ? " (front missing)" : " (back missing)"}`}
          data-testid={`btn-attach-${cert.certId}`}
        >
          <Paperclip className="h-4 w-4" />
        </button>
      ) : (
        <div className="w-4 h-4 p-1" aria-hidden="true" />
      )}
    </div>
  );
}

// ── Post-to-IG modal ─────────────────────────────────────────────────────────
function PostToIgModal({ cert, onClose }: { cert: BrowserCert; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [postType, setPostType] = useState<"auto" | "card_reveal" | "grade_breakdown">("auto");

  const queueM = useMutation({
    mutationFn: async () => {
      // certId here is the numeric PK (cert.id), NOT the MV string (cert.certId).
      const res = await apiRequest("POST", "/api/admin/ig/queue/from-cert", {
        certId:   (cert as any).id,
        postType,
      });
      return res.json();
    },
    onSuccess: (data) => {
      const newId = data?.row?.id;
      qc.invalidateQueries({ queryKey: ["/api/admin/ig/queue"] });
      qc.invalidateQueries({ queryKey: ["/api/admin/ig/settings"] });
      toast({
        title: `Queued — post #${newId}`,
        description: `Click to open /admin/instagram${newId ? ` (post #${newId} highlighted)` : ""}`,
      });
      // Brief delay so the toast is seen before nav.
      setTimeout(() => {
        if (newId) window.location.href = `/admin/instagram?focusId=${newId}`;
        else        window.location.href = "/admin/instagram";
      }, 400);
      onClose();
    },
    onError: (err: any) => {
      toast({ title: "Queue failed", description: err?.message ?? "unknown error", variant: "destructive" });
    },
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md bg-white text-[#1A1A1A] border-[#E8E4DC]" data-testid="ig-post-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Instagram className="h-4 w-4" /> Post to Instagram
          </DialogTitle>
        </DialogHeader>

        {/* Cert summary — confirm right cert before queuing */}
        <div className="bg-[#FAF8F3] border border-[#E8E4DC] rounded p-3 mb-3 text-sm">
          <div className="font-mono text-xs text-yellow-700 mb-1">{cert.certId}</div>
          <div className="font-semibold">{cert.cardName ?? "—"}</div>
          {cert.setName && <div className="text-xs text-[#666666]">{cert.setName}</div>}
          <div className="text-xs text-[#666666] mt-1">
            Grade <span className="font-semibold">{gradeDisplay(cert)}</span> · slabbed {fmtDate(cert.createdAt)}
          </div>
        </div>

        <div className="space-y-2">
          <Label className="text-xs uppercase tracking-wide text-[#666666]">Post type</Label>
          <select
            value={postType}
            onChange={(e) => setPostType(e.target.value as any)}
            className="w-full h-9 px-2 text-sm border border-[#E8E4DC] rounded bg-white"
            data-testid="ig-post-type-select"
          >
            <option value="auto">Auto (grade ≥ 8 → card_reveal, else grade_breakdown)</option>
            <option value="card_reveal">card_reveal</option>
            <option value="grade_breakdown">grade_breakdown</option>
          </select>
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => queueM.mutate()}
            disabled={queueM.isPending}
            data-testid="ig-post-submit"
          >
            {queueM.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Instagram className="w-4 h-4 mr-2" />}
            Queue post
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Attach Images Modal ──────────────────────────────────────────────────────
// Used to attach front/back images to a blank cert (or one missing a side).
// Calls PUT /api/admin/certificates/:id/attach-images, which runs the same
// pipeline as scan-ingest so attached images look identical to native scans.
function AttachImagesModal({ cert, onClose }: { cert: BrowserCert; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [front, setFront] = useState<File | null>(null);
  const [back, setBack] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const frontInputRef = useRef<HTMLInputElement>(null);
  const backInputRef = useRef<HTMLInputElement>(null);

  const certNumericId = (cert as any).id as number;
  const hadFront = !!(cert as any).frontImagePath;
  const hadBack  = !!(cert as any).backImagePath;

  async function submit() {
    if (!front) {
      toast({ title: "Front image required", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append("front", front);
      if (back) fd.append("back", back);
      const res = await fetch(`/api/admin/certificates/${certNumericId}/attach-images`, {
        method: "PUT",
        credentials: "include",
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      toast({
        title: "Images attached",
        description: `${cert.certId} — ${data.aiTriggered ? "AI grading running in background" : "processed"}`,
      });
      qc.invalidateQueries({ queryKey: ["/api/admin/printing/browser"] });
      onClose();
    } catch (e: any) {
      toast({ title: "Attach failed", description: e.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  function FilePicker({ side, file, onPick, alreadyPresent }: {
    side: "front" | "back"; file: File | null; onPick: (f: File | null) => void; alreadyPresent: boolean;
  }) {
    const ref = side === "front" ? frontInputRef : backInputRef;
    return (
      <div className="space-y-1.5">
        <Label className="text-xs uppercase tracking-wide text-[#666666] flex items-center gap-2">
          {side}
          {alreadyPresent && (
            <span className="text-[10px] text-amber-600 normal-case tracking-normal">
              (already has one — uploading will replace)
            </span>
          )}
        </Label>
        <div
          onClick={() => !submitting && ref.current?.click()}
          className={`h-24 rounded border-2 border-dashed cursor-pointer flex flex-col items-center justify-center gap-1 transition-colors
            ${file ? "border-emerald-500/60 bg-emerald-50" : "border-[#D4D0C8] hover:border-[#D4AF37]/60"}
            ${submitting ? "cursor-wait opacity-70" : ""}`}
          data-testid={`attach-drop-${side}`}
        >
          <input
            ref={ref}
            type="file"
            accept=".tif,.tiff,.png,.jpg,.jpeg,image/tiff,image/png,image/jpeg"
            className="sr-only"
            onChange={(e) => onPick(e.target.files?.[0] ?? null)}
          />
          {file ? (
            <>
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              <p className="text-xs text-[#1A1A1A]">{file.name}</p>
              <p className="text-[10px] text-[#666666]">{(file.size / 1024 / 1024).toFixed(2)} MB · click to replace</p>
            </>
          ) : (
            <>
              <Upload className="h-4 w-4 text-[#999999]" />
              <p className="text-xs text-[#666666]">Drop or click — TIFF / PNG / JPEG</p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !submitting) onClose(); }}>
      <DialogContent className="max-w-md bg-white text-[#1A1A1A] border-[#E8E4DC]" data-testid="attach-images-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Paperclip className="h-4 w-4" /> Attach images
          </DialogTitle>
        </DialogHeader>

        <div className="bg-[#FAF8F3] border border-[#E8E4DC] rounded p-3 mb-3 text-sm">
          <div className="font-mono text-xs text-yellow-700 mb-1">{cert.certId}</div>
          <div className="font-semibold">{cert.cardName ?? "—"}</div>
          {cert.setName && <div className="text-xs text-[#666666]">{cert.setName}</div>}
        </div>

        <div className="space-y-3">
          <FilePicker side="front" file={front} onPick={setFront} alreadyPresent={hadFront} />
          <FilePicker side="back"  file={back}  onPick={setBack}  alreadyPresent={hadBack} />
          <p className="text-[11px] text-[#666666]">
            Uploaded files run through the same pipeline as a native scan (deskew, safety pad, mask, 10 px trim, PNG encode).
            AI grading fires in the background once both sides are present.
          </p>
        </div>

        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onClose} disabled={submitting} className="border-[#E8E4DC] text-[#666666] text-xs">
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!front || submitting} data-testid="attach-images-submit">
            {submitting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Paperclip className="w-4 h-4 mr-2" />}
            Attach
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Export ───────────────────────────────────────────────────────────────
export default function AdminCertBrowser() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [previewCert, setPreviewCert] = useState<BrowserCert | null>(null);
  const [editCert, setEditCert] = useState<BrowserCert | null>(null);
  const [reportCert, setReportCert] = useState<BrowserCert | null>(null);
  const [igPostCert, setIgPostCert] = useState<BrowserCert | null>(null);
  const [attachCert, setAttachCert] = useState<BrowserCert | null>(null);
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
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#999999]" />
          <Input
            placeholder="Search cert ID, card name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 bg-white border-[#E8E4DC] text-[#1A1A1A] text-sm h-8"
            data-testid="input-browser-search"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[#999999] hover:text-[#666666]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px] text-[#999999] border-[#E8E4DC]">
            {filtered.length} of {certs.length}
          </Badge>
          <button
            onClick={() => refetch()}
            className="text-[#999999] hover:text-[#D4AF37] transition-colors p-1 rounded"
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
        <div className="rounded-lg border border-[#E8E4DC] p-8 text-center text-[#999999] text-sm">
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
              onReport={() => setReportCert(cert)}
              onIgPost={() => setIgPostCert(cert)}
              onAttachImages={() => setAttachCert(cert)}
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
      {reportCert && (
        <GradingReportModal cert={reportCert} onClose={() => setReportCert(null)} />
      )}
      {igPostCert && (
        <PostToIgModal cert={igPostCert} onClose={() => setIgPostCert(null)} />
      )}
      {attachCert && (
        <AttachImagesModal cert={attachCert} onClose={() => setAttachCert(null)} />
      )}
    </div>
  );
}
