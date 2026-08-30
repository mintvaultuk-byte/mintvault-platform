/**
 * admin-print-queue.tsx — the Approval → Printing → Printed lifecycle queue.
 *
 * Built with the SAME design-system primitives as the grading queue (Chip filters
 * with counts, admin-cert rows, admin-badge status) so it is visually consistent
 * with the queue operators already know. It reuses the EXISTING print-batch
 * renderer for PDF bytes (via /print-batch + /print-batch/reprint) and the NEW
 * /printing/workflow/* endpoints for lifecycle state, batch records, and audit.
 *
 * Mounts on both admin (/api/admin) and staff (/api/staff/print) via PrintWfBase,
 * mirroring admin-printing.tsx's PrintApiBase pattern.
 */
import { createContext, useContext, useMemo, useState, useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Printer,
  PrinterCheck,
  RefreshCw,
  Loader2,
  Download,
  CheckSquare,
  Square,
  History,
  AlertTriangle,
  X,
  CheckCircle2,
  Image as ImageIcon,
} from "lucide-react";
import Chip from "@/components/admin/chip";
import Badge from "@/components/admin/badge";
import AdminButton, { adminButtonClass } from "@/components/admin/button";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  PRINT_STATE_LABEL,
  PRINT_STATE_BADGE,
  PRINT_QUEUE_FILTERS,
  PRINT_QUEUE_FILTER_LABEL,
  REPRINT_REASON_CATEGORIES,
  REPRINT_REASON_LABEL,
  matchesFilter,
  findDuplicatePrints,
  type PrintQueueFilter,
  type ReprintReasonCategory,
} from "@shared/print-lifecycle";
import type { PrintQueueRow, PrintBatchSummary } from "@shared/schema";

const PRINT_BATCH_MAX = 48;

// API base — "/api/admin" on the admin dashboard, "/api/staff/print" for staff.
const PrintWfBase = createContext<string>("/api/admin");

/** Rewrite an admin artefact URL onto the active base (staff proxy). */
function rebaseUrl(url: string, base: string): string {
  if (base === "/api/admin") return url;
  return url.replace(/^\/api\/admin/, base);
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

interface WorkflowResult {
  applied: string[];
  rejected: { certId: string; code?: string; message?: string }[];
}

function PrintQueuePanel() {
  const base = useContext(PrintWfBase);
  const qc = useQueryClient();
  const { toast } = useToast();

  const [filter, setFilter] = useState<PrintQueueFilter>("needs_printing");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [lastBatchId, setLastBatchId] = useState<string | null>(null);
  const [reprintOpen, setReprintOpen] = useState(false);
  const [auditCertId, setAuditCertId] = useState<string | null>(null);
  const printAttempt = useRef<{ fingerprint: string; key: string } | null>(null);

  const queueKey = useMemo(() => [`${base}/printing/workflow/queue`], [base]);
  const { data, isLoading, refetch } = useQuery<{ rows: PrintQueueRow[] }>({
    queryKey: queueKey,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
    queryFn: async () => {
      const res = await apiRequest("GET", `${base}/printing/workflow/queue`);
      return res.json();
    },
  });
  const rows = data?.rows ?? [];

  const batchesKey = useMemo(() => [`${base}/printing/workflow/batches`], [base]);
  const { data: batchData } = useQuery<{ batches: PrintBatchSummary[] }>({
    queryKey: batchesKey,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
    queryFn: async () => {
      const res = await apiRequest("GET", `${base}/printing/workflow/batches`);
      return res.json();
    },
  });
  const batches = batchData?.batches ?? [];

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: queueKey });
    qc.invalidateQueries({ queryKey: batchesKey });
    refetch();
  }, [qc, queueKey, batchesKey, refetch]);

  // Day boundary (local) for the "Printed Today" filter — computed once per render.
  const dayStart = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, []);

  const counts = useMemo(() => {
    const c: Record<PrintQueueFilter, number> = {
      needs_printing: 0,
      printing: 0,
      printed_today: 0,
      printed: 0,
      reprints: 0,
      completed: 0,
      all: rows.length,
    };
    for (const r of rows) {
      const input = { state: r.state, printedAtMs: r.printedAt ? new Date(r.printedAt).getTime() : null };
      for (const f of PRINT_QUEUE_FILTERS) {
        if (f !== "all" && matchesFilter(input, f, dayStart)) c[f] += 1;
      }
    }
    return c;
  }, [rows, dayStart]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      const input = { state: r.state, printedAtMs: r.printedAt ? new Date(r.printedAt).getTime() : null };
      if (!matchesFilter(input, filter, dayStart)) return false;
      if (!q) return true;
      return (
        r.certId.toLowerCase().includes(q) ||
        (r.cardName ?? "").toLowerCase().includes(q) ||
        (r.customerName ?? "").toLowerCase().includes(q) ||
        (r.trackingNumber ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, filter, search, dayStart]);

  const rowByCert = useMemo(() => new Map(rows.map((r) => [r.certId, r])), [rows]);
  const selectedRows = useMemo(
    () => [...selected].map((id) => rowByCert.get(id)).filter(Boolean) as PrintQueueRow[],
    [selected, rowByCert]
  );
  const duplicatesInSelection = useMemo(
    () => findDuplicatePrints(selectedRows.map((r) => ({ certId: r.certId, state: r.state }))),
    [selectedRows]
  );

  function toggle(certId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(certId)) next.delete(certId);
      else next.add(certId);
      return next;
    });
  }
  function clearSelection() {
    setSelected(new Set());
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  // First-run batch: render via existing endpoint, then persist lifecycle state.
  const printSelected = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      // Duplicate protection: block already-printed certs; route to Reprint.
      const dupes = findDuplicatePrints(ids.map((id) => ({ certId: id, state: rowByCert.get(id)?.state ?? "needs_printing" })));
      if (dupes.length > 0) {
        toast({
          title: "Already printed",
          description: `${dupes.length} selected cert(s) are already printed. Use Reprint (a reason is required).`,
          variant: "destructive",
        });
        return;
      }
      setBusy(true);
      try {
        const fingerprint = [...ids].sort().join(",");
        if (!printAttempt.current || printAttempt.current.fingerprint !== fingerprint) {
          printAttempt.current = { fingerprint, key: crypto.randomUUID() };
        }
        // ONE server-authoritative call: reserve → render → finalise (atomic).
        const res = await apiRequest(
          "POST",
          `${base}/printing/workflow/batch`,
          { certIds: ids },
          { headers: { "Idempotency-Key": printAttempt.current.key } }
        );
        const result = (await res.json()) as {
          batchId: string | null;
          pdfUrl: string | null;
          applied: string[];
          rejected: { certId: string; message?: string }[];
          isDuplicate: boolean;
        };
        if (result.batchId && result.pdfUrl && result.applied.length > 0) {
          setLastBatchId(result.batchId);
          window.open(rebaseUrl(result.pdfUrl, base), "_blank");
        }
        const skipped = result.rejected.length ? ` · ${result.rejected.length} skipped` : "";
        toast({
          title: result.applied.length ? (result.isDuplicate ? "Batch already generated" : "Batch created") : "Nothing batched",
          description: result.applied.length
            ? `${result.applied.length} label(s) ready — mark printed once on paper${skipped}.`
            : result.rejected[0]?.message || "No eligible certificates in selection.",
          variant: result.applied.length ? undefined : "destructive",
        });
        clearSelection();
        printAttempt.current = null;
        invalidate();
      } catch (err: any) {
        toast({ title: "Batch failed", description: err?.message || "Could not create batch.", variant: "destructive" });
      } finally {
        setBusy(false);
      }
    },
    [base, rowByCert, toast, invalidate]
  );

  const printAllReady = useCallback(() => {
    const ready = rows.filter((r) => r.state === "needs_printing").map((r) => r.certId).slice(0, PRINT_BATCH_MAX);
    if (ready.length === 0) {
      toast({ title: "Nothing to print", description: "No certificates are awaiting printing." });
      return;
    }
    printSelected(ready);
  }, [rows, printSelected, toast]);

  const markPrinted = useCallback(
    async (batchId: string) => {
      setBusy(true);
      try {
        const res = await apiRequest("POST", `${base}/printing/workflow/mark-printed`, { batchId });
        const result = (await res.json()) as WorkflowResult;
        toast({ title: "Marked printed", description: `${result.applied.length} cert(s) confirmed printed.` });
        invalidate();
      } catch (err: any) {
        toast({ title: "Failed", description: err?.message || "Could not mark printed.", variant: "destructive" });
      } finally {
        setBusy(false);
      }
    },
    [base, toast, invalidate]
  );

  const completeSelected = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      setBusy(true);
      try {
        const res = await apiRequest("POST", `${base}/printing/workflow/complete`, { certIds: ids });
        const result = (await res.json()) as WorkflowResult;
        toast({
          title: "Completed",
          description: `${result.applied.length} completed${result.rejected.length ? `, ${result.rejected.length} skipped` : ""}.`,
        });
        clearSelection();
        invalidate();
      } catch (err: any) {
        toast({
          title: "Failed",
          description: err?.status === 403 ? "Only an admin can mark Completed." : err?.message || "Could not complete.",
          variant: "destructive",
        });
      } finally {
        setBusy(false);
      }
    },
    [base, toast, invalidate]
  );

  // Reprint = flag the card Reprint Required (reason + who logged permanently).
  // The physical reprint is then produced by selecting it under "Reprints" and
  // hitting Print Selected — the same atomic batch endpoint (server sees the
  // reprint_required state and renders a reprint batch).
  const submitReprint = useCallback(
    async (ids: string[], reason: string, category: ReprintReasonCategory) => {
      if (ids.length === 0) return;
      setBusy(true);
      try {
        const res = await apiRequest("POST", `${base}/printing/workflow/reprint`, {
          certIds: ids,
          reason,
          reasonCategory: category,
        });
        const result = (await res.json()) as WorkflowResult;
        toast({
          title: "Marked for reprint",
          description: `${result.applied.length} card(s) flagged. Open the "Reprints" filter and Print Selected to produce the new label(s).`,
        });
        setReprintOpen(false);
        clearSelection();
        invalidate();
      } catch (err: any) {
        toast({ title: "Reprint failed", description: err?.message || "Could not flag reprint.", variant: "destructive" });
      } finally {
        setBusy(false);
      }
    },
    [base, toast, invalidate]
  );

  const selectedCompletable = selectedRows.filter((r) => r.state === "printed" || r.state === "reprinted");

  return (
    <div className="admin-records" data-testid="print-queue">
      <div className="admin-list-head">
        <h1 className="admin-list-head__t">Ready To Print</h1>
        <AdminButton size="sm" onClick={() => refetch()} title="Refresh">
          <RefreshCw size={13} /> Refresh
        </AdminButton>
      </div>

      {/* Filters — Chip row with counts, matching the grading queue. */}
      <div className="admin-filters">
        <span className="admin-filters__lab">Show</span>
        {PRINT_QUEUE_FILTERS.map((f) => (
          <Chip
            key={f}
            active={filter === f}
            count={counts[f]}
            onClick={() => setFilter(f)}
            testId={`print-filter-${f}`}
          >
            {PRINT_QUEUE_FILTER_LABEL[f]}
          </Chip>
        ))}
        <span className="admin-filters__div" />
        <input
          className="admin-input"
          placeholder="Search cert, card, customer…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="print-search"
        />
      </div>

      {/* Batch action bar */}
      <div className="admin-filters" style={{ gap: 8 }}>
        <AdminButton
          variant="gold"
          size="sm"
          disabled={busy || selected.size === 0}
          onClick={() => printSelected([...selected])}
          data-testid="print-selected"
        >
          {busy ? <Loader2 className="animate-spin" size={13} /> : <Printer size={13} />} Print Selected ({selected.size})
        </AdminButton>
        <AdminButton size="sm" disabled={busy} onClick={printAllReady} data-testid="print-all-ready">
          <Printer size={13} /> Print All Ready ({counts.needs_printing})
        </AdminButton>
        <AdminButton
          size="sm"
          disabled={busy || selected.size === 0}
          onClick={() => setReprintOpen(true)}
          data-testid="open-reprint"
        >
          <RefreshCw size={13} /> Reprint ({selected.size})
        </AdminButton>
        <AdminButton
          size="sm"
          disabled={busy || selectedCompletable.length === 0}
          onClick={() => completeSelected(selectedCompletable.map((r) => r.certId))}
          data-testid="complete-selected"
        >
          <CheckCircle2 size={13} /> Mark Completed ({selectedCompletable.length})
        </AdminButton>
        {lastBatchId && (
          <a
            className={adminButtonClass({ size: "sm" })}
            href={rebaseUrl(`/api/admin/print-batch/${lastBatchId}/pdf?download=1`, base)}
            target="_blank"
            rel="noreferrer"
            data-testid="download-batch-pdf"
          >
            <Download size={13} /> Download Batch PDF
          </a>
        )}
        {lastBatchId && (
          <AdminButton size="sm" disabled={busy} onClick={() => markPrinted(lastBatchId)} data-testid="mark-printed-last">
            <PrinterCheck size={13} /> Mark Printed
          </AdminButton>
        )}
        {selected.size > 0 && (
          <AdminButton size="sm" onClick={clearSelection}>
            Clear
          </AdminButton>
        )}
      </div>

      {duplicatesInSelection.length > 0 && (
        <div className="admin-cmeta" style={{ color: "var(--admin-red)", padding: "6px 2px" }}>
          <AlertTriangle size={12} /> {duplicatesInSelection.length} selected cert(s) are already printed — use Reprint (reason required), not Print Selected.
        </div>
      )}

      {/* Rows */}
      {isLoading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 40 }}>
          <Loader2 className="animate-spin" />
        </div>
      ) : visible.length === 0 ? (
        <div className="admin-cmeta" style={{ padding: 24, textAlign: "center" }}>
          No certificates match this filter.
        </div>
      ) : (
        visible.map((r) => {
          const isSel = selected.has(r.certId);
          return (
            <div className="admin-cert" key={r.certId} data-testid={`print-row-${r.certId}`}>
              <div className="admin-cert__top">
                <button
                  type="button"
                  onClick={() => toggle(r.certId)}
                  title={isSel ? "Deselect" : "Select"}
                  style={{ background: "none", border: "none", cursor: "pointer", color: "var(--admin-ink)", padding: 4 }}
                  data-testid={`select-${r.certId}`}
                >
                  {isSel ? <CheckSquare size={18} /> : <Square size={18} />}
                </button>
                <div className="admin-thumb">
                  {r.labelExists ? <ImageIcon /> : <ImageIcon style={{ opacity: 0.3 }} />}
                </div>
                <div className="admin-cert__info">
                  <div className="admin-cid-row">
                    <span className="admin-cid">{r.certId}</span>
                    <Badge variant={PRINT_STATE_BADGE[r.state]} testId={`print-status-${r.certId}`}>
                      {PRINT_STATE_LABEL[r.state]}
                    </Badge>
                    {r.gradeOverall && <span className="admin-gradechip">{r.gradeOverall}</span>}
                    {r.reprintCount > 0 && (
                      <Badge variant="red" testId={`reprints-${r.certId}`}>
                        {r.reprintCount}× reprint
                      </Badge>
                    )}
                  </div>
                  <div className="admin-cname">{r.cardName ?? "—"}</div>
                  <div className="admin-cmeta">
                    {[r.cardGame, r.setName, r.cardNumber].filter(Boolean).join(" · ") || "—"}
                  </div>
                  <div className="admin-cmeta">
                    Customer: {r.customerName ?? "—"} · Submission: {r.trackingNumber ?? "—"}
                  </div>
                  <div className="admin-cmeta">
                    Approved {fmtDate(r.approvedAt)} by {r.approvedBy ?? "—"} · Printed {fmtDate(r.printedAt)}
                    {r.batchId ? ` · Batch ${r.batchId.slice(0, 8)}` : ""}
                  </div>
                  <div className="admin-cmeta" style={{ display: "flex", gap: 10, opacity: 0.85 }}>
                    <span title="Certificate record exists">{r.certificateExists ? "✓" : "✗"} Cert</span>
                    <span title="Label renderable">{r.labelExists ? "✓" : "✗"} Label</span>
                    <span title="Batch PDF generated">{r.pdfExists ? "✓" : "✗"} PDF</span>
                    <button
                      type="button"
                      onClick={() => setAuditCertId(r.certId)}
                      style={{ background: "none", border: "none", color: "var(--admin-gold-hi)", cursor: "pointer", display: "inline-flex", gap: 3, alignItems: "center" }}
                      data-testid={`audit-${r.certId}`}
                    >
                      <History size={11} /> History
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        })
      )}

      {/* Batches panel */}
      {batches.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div className="admin-list-head">
            <h2 className="admin-list-head__t" style={{ fontSize: 15 }}>
              Print Batches
            </h2>
          </div>
          {batches.slice(0, 25).map((b) => (
            <div className="admin-cert" key={b.batchId} data-testid={`batch-${b.batchId}`}>
              <div className="admin-cert__top">
                <div className="admin-cert__info">
                  <div className="admin-cid-row">
                    <span className="admin-cid">{b.batchId.slice(0, 10)}</span>
                    <Badge variant={b.kind === "reprint" ? "red" : "neu"}>{b.kind}</Badge>
                    <Badge variant={b.status === "printed" ? "act" : b.status === "printing" ? "prog" : "neu"}>{b.status}</Badge>
                  </div>
                  <div className="admin-cmeta">
                    {b.certCount} cert(s) · created {fmtDate(b.createdAt)} by {b.createdBy ?? "—"}
                    {b.createdByRole ? ` (${b.createdByRole})` : ""} · printed {fmtDate(b.printedAt)}
                  </div>
                  {b.reason && (
                    <div className="admin-cmeta">
                      Reason: {b.reasonCategory ? `[${b.reasonCategory}] ` : ""}
                      {b.reason}
                    </div>
                  )}
                  <div className="admin-filters" style={{ gap: 6, marginTop: 4 }}>
                    <a
                      className={adminButtonClass({ size: "sm" })}
                      href={rebaseUrl(`/api/admin/print-batch/${b.batchId}/pdf?download=1`, base)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Download size={12} /> PDF
                    </a>
                    {b.status !== "printed" && (
                      <AdminButton size="sm" disabled={busy} onClick={() => markPrinted(b.batchId)}>
                        <PrinterCheck size={12} /> Mark Printed
                      </AdminButton>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {reprintOpen && (
        <ReprintModal
          certIds={[...selected]}
          busy={busy}
          onClose={() => setReprintOpen(false)}
          onSubmit={submitReprint}
        />
      )}
      {auditCertId && <AuditDrawer base={base} certId={auditCertId} onClose={() => setAuditCertId(null)} />}
    </div>
  );
}

// ── Reprint modal ──────────────────────────────────────────────────────────────
function ReprintModal({
  certIds,
  busy,
  onClose,
  onSubmit,
}: {
  certIds: string[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (ids: string[], reason: string, category: ReprintReasonCategory) => void;
}) {
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState<ReprintReasonCategory>("damaged_print");
  const valid = reason.trim().length >= 10 && reason.trim().length <= 500 && certIds.length > 0;
  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60 }}
      onClick={onClose}
    >
      <div
        className="admin-records"
        style={{ background: "var(--admin-panel)", padding: 20, maxWidth: 460, width: "90%", borderRadius: 8, border: "1px solid var(--admin-line)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="admin-list-head">
          <h2 className="admin-list-head__t" style={{ fontSize: 15 }}>
            Reprint {certIds.length} cert(s)
          </h2>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--admin-ink)", cursor: "pointer" }}>
            <X size={16} />
          </button>
        </div>
        <div className="admin-cmeta" style={{ color: "var(--admin-red)", marginBottom: 8 }}>
          <AlertTriangle size={12} /> A reprint is logged permanently with your name and reason.
        </div>
        <label className="admin-filters__lab">Reason category</label>
        <select
          className="admin-input"
          value={category}
          onChange={(e) => setCategory(e.target.value as ReprintReasonCategory)}
          style={{ width: "100%", marginBottom: 10 }}
          data-testid="reprint-category"
        >
          {REPRINT_REASON_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {REPRINT_REASON_LABEL[c]}
            </option>
          ))}
        </select>
        <label className="admin-filters__lab">Reason (10–500 chars)</label>
        <textarea
          className="admin-input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          style={{ width: "100%", marginBottom: 12 }}
          placeholder="Describe why this label is being reprinted…"
          data-testid="reprint-reason"
        />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <AdminButton size="sm" onClick={onClose}>
            Cancel
          </AdminButton>
          <AdminButton
            variant="gold"
            size="sm"
            disabled={!valid || busy}
            onClick={() => onSubmit(certIds, reason.trim(), category)}
            data-testid="reprint-submit"
          >
            {busy ? <Loader2 className="animate-spin" size={13} /> : <RefreshCw size={13} />} Reprint
          </AdminButton>
        </div>
      </div>
    </div>
  );
}

// ── Audit drawer ────────────────────────────────────────────────────────────────
interface PrintEventRow {
  id: number;
  certId: string;
  batchId: string | null;
  actor: string;
  actorRole: string | null;
  action: string;
  fromState: string | null;
  toState: string | null;
  reason: string | null;
  reasonCategory: string | null;
  createdAt: string;
}
function AuditDrawer({ base, certId, onClose }: { base: string; certId: string; onClose: () => void }) {
  const { data, isLoading } = useQuery<{ events: PrintEventRow[] }>({
    queryKey: [`${base}/printing/workflow/events`, certId],
    queryFn: async () => {
      const res = await apiRequest("GET", `${base}/printing/workflow/events?certId=${encodeURIComponent(certId)}`);
      return res.json();
    },
  });
  const events = data?.events ?? [];
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", justifyContent: "flex-end", zIndex: 60 }} onClick={onClose}>
      <div
        className="admin-records"
        style={{ background: "var(--admin-panel)", padding: 20, width: 400, maxWidth: "92%", height: "100%", overflowY: "auto", borderLeft: "1px solid var(--admin-line)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="admin-list-head">
          <h2 className="admin-list-head__t" style={{ fontSize: 15 }}>
            History · {certId}
          </h2>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--admin-ink)", cursor: "pointer" }}>
            <X size={16} />
          </button>
        </div>
        {isLoading ? (
          <Loader2 className="animate-spin" />
        ) : events.length === 0 ? (
          <div className="admin-cmeta">No print history yet.</div>
        ) : (
          events.map((e) => (
            <div key={e.id} style={{ borderBottom: "1px solid var(--admin-line)", padding: "8px 0" }} className="admin-cmeta">
              <div>
                <strong>{e.action}</strong> · {e.fromState ?? "—"} → {e.toState ?? "—"}
              </div>
              <div>
                {fmtDate(e.createdAt)} · {e.actor}
                {e.actorRole ? ` (${e.actorRole})` : ""}
                {e.batchId ? ` · batch ${e.batchId.slice(0, 8)}` : ""}
              </div>
              {e.reason && (
                <div style={{ color: "var(--admin-red)" }}>
                  {e.reasonCategory ? `[${e.reasonCategory}] ` : ""}
                  {e.reason}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Admin dashboard mount (default /api/admin base). */
export default function AdminPrintQueue() {
  return (
    <PrintWfBase.Provider value="/api/admin">
      <PrintQueuePanel />
    </PrintWfBase.Provider>
  );
}

/** Staff mount — pass apiBase="/api/staff/print". */
export function PrintQueueConsole({ apiBase }: { apiBase: string }) {
  return (
    <PrintWfBase.Provider value={apiBase}>
      <PrintQueuePanel />
    </PrintWfBase.Provider>
  );
}
