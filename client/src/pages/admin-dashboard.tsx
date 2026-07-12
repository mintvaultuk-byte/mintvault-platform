import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { CertificateRecord } from "@shared/schema";
import { gradeLabelFull, isNonNumericGrade } from "@shared/schema";
import { getVariantDisplayLabel } from "@/lib/variantOptions";
import { mvgsTierName } from "@shared/mvgs-scoring";
import {
  Plus,
  Edit,
  Download,
  Search,
  Eye,
  EyeOff,
  FileText,
  Image,
  X,
  Printer,
  BarChart3,
  Tag,
  Clock,
  FileDown,
  Database,
  Shield,
  Ban,
  AlertTriangle,
  Save,
  ArrowRight,
  Copy,
  Check,
  Loader2,
} from "lucide-react";
import StagingHarnessPanel from "@/components/staging-harness-panel";
import {
  AdminShell,
  type AdminTab,
  StatCard,
  Panel,
  Chip,
  Badge,
  type AdminBadgeVariant,
  AdminButton,
  adminButtonClass,
  GoldShader,
} from "@/components/admin";

const isStagingHost = typeof window !== "undefined" && window.location.hostname.includes("mintvault-v2");

type CertsFilter = {
  status?: "all" | "active" | "voided";
  range?: "week" | "month";
  gradeType?: "numeric" | "authentic" | "altered";
  grade?: number;
};

type GradingStatus = "graded" | "in_progress" | "awaiting_grade" | "awaiting_images";

// Derived from existing columns — no schema changes. Order matters:
// gradeOverall is written on draft save (server/routes.ts:7530), so a cert
// with grade but no gradeApprovedAt is in_progress, NOT graded. Check
// gradeApprovedAt first.
function gradingStatus(cert: CertificateRecord): GradingStatus {
  if ((cert as any).gradeApprovedAt) return "graded";
  if (cert.gradeOverall) return "in_progress";
  if (cert.frontImagePath) return "awaiting_grade";
  return "awaiting_images";
}

const GRADING_STATUS_LABEL: Record<GradingStatus, string> = {
  graded: "Graded",
  in_progress: "In progress",
  awaiting_grade: "Awaiting grade",
  awaiting_images: "Awaiting images",
};

// Map grading status onto the admin Badge variants (status palette).
const GRADING_STATUS_VARIANT: Record<GradingStatus, AdminBadgeVariant> = {
  graded: "act",
  in_progress: "prog",
  awaiting_grade: "gold",
  awaiting_images: "neu",
};
import AdminSubmissions, { AdminIntake } from "@/pages/admin-submissions";
import AdminPricing from "@/pages/admin-pricing";
import AdminPromotions from "@/pages/admin-promotions";
import AdminPrinting from "@/pages/admin-printing";
import AdminLearningPage from "@/pages/admin-learning";
import AdminCaptureHealthPage from "@/pages/admin-capture-health";
import AdminDivergencePage from "@/pages/admin-divergence";
import AdminCapacity from "@/pages/admin-capacity";
import AdminTransfers from "@/pages/admin-transfers";
import AdminScanHistory from "@/pages/admin-scan-history";

interface DbInfo {
  env: string;
  neon_host: string;
  db_name: string;
  server_time: string;
  card_master_active_count: number;
  card_sets_active_count: number;
  certificates_count: number;
  voided_count: number;
  last_issued_mv: string;
  last_issued_seq: number;
}

import CertificateForm from "@/components/certificate-form";
import NfcSection from "@/components/nfc-section";
import OwnershipSection from "@/components/ownership-section";
import GradingPanel from "@/components/grading/grading-panel";
import GradingQueue from "@/components/grading/grading-queue";

interface Props {
  onLogout: () => void;
  /** Tab to open on first render (e.g. when deep-linked via /admin/promotions). */
  initialTab?: AdminTab;
}

interface DashboardStats {
  totalCerts: number;
  thisWeek: number;
  thisMonth: number;
  authenticOnlyCount: number;
  authenticAlteredCount: number;
  gradeDistribution: { grade: number; count: number }[];
  recentCerts: CertificateRecord[];
}

export default function AdminDashboard({ onLogout, initialTab }: Props) {
  const [activeTab, setActiveTab] = useState<AdminTab>(initialTab ?? "dashboard");
  const [filterPreset, setFilterPreset] = useState<CertsFilter>({});
  const [showForm, setShowForm] = useState(false);
  const [editingCert, setEditingCert] = useState<CertificateRecord | null>(null);
  const [pendingAnalysis, setPendingAnalysis] = useState<{ analysis: any; identification: any } | null>(null);
  const [externalIdentification, setExternalIdentification] = useState<Record<string, unknown> | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // Deep link: /admin?search=MV430 (used by the scanner app's "Grade" button)
  // pre-fills the search (exact cert-number match) and lands on the certs tab.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search).get("search");
    if (q) {
      setSearchQuery(q);
      setActiveTab("certs");
    }
  }, []);
  const [previewCert, setPreviewCert] = useState<CertificateRecord | null>(null);
  const [selectedGradingCertId, setSelectedGradingCertId] = useState<number | null>(null);
  const [approvedSignal, setApprovedSignal] = useState<{ certId: string; grade: string; ts: number } | null>(null);

  const { data: certs = [], isLoading } = useQuery<CertificateRecord[]>({
    queryKey: ["/api/admin/certificates"],
  });

  const { data: stats } = useQuery<DashboardStats>({
    queryKey: ["/api/admin/stats"],
  });

  const [voidTarget, setVoidTarget] = useState<CertificateRecord | null>(null);

  const voidMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: number; reason: string }) => {
      await apiRequest("POST", `/api/admin/certificates/${id}/void`, {
        confirmation: "VOID",
        reason,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/certificates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/db-info"] });
      setVoidTarget(null);
    },
  });

  const handleLogout = async () => {
    await apiRequest("POST", "/api/admin/logout");
    onLogout();
  };

  const handleEdit = (cert: CertificateRecord) => {
    setEditingCert(cert);
    setShowForm(true);
    setActiveTab("certs");
  };

  const handleFormClose = (newCert?: any) => {
    if (newCert && newCert.id) {
      // A new cert was just created — switch to edit mode so workstation mounts
      setEditingCert(newCert);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/certificates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/stats"] });
      return; // stay in showForm=true with the new cert loaded
    }
    setShowForm(false);
    setEditingCert(null);
    queryClient.invalidateQueries({ queryKey: ["/api/admin/certificates"] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/stats"] });
  };

  const handleNewCert = () => {
    // Open blank form — no DB row created until user saves with real data
    setEditingCert(null);
    setShowForm(true);
    setActiveTab("certs");
  };

  const handleGoToCerts = (filter: CertsFilter = {}) => {
    setFilterPreset(filter);
    setActiveTab("certs");
  };

  // A pure cert-number search (e.g. "16", "MV16", "mv-0000000016") resolves to
  // the EXACT cert number — typing 16 returns MV16 only, never MV160/MV416.
  // Free-text searches keep the substring match on certId / card / set name.
  const trimmedSearch = searchQuery.trim();
  const certNumMatch = trimmedSearch.match(/^(?:mv[-\s]?)?0*(\d+)$/i);
  const filtered = !trimmedSearch
    ? certs
    : certNumMatch
      ? certs.filter((c) => {
          const n = (c.certId.match(/\d+/) || [])[0];
          return n != null && parseInt(n, 10) === parseInt(certNumMatch[1], 10);
        })
      : certs.filter(
          (c) =>
            c.certId.toLowerCase().includes(trimmedSearch.toLowerCase()) ||
            (c.cardName ?? "").toLowerCase().includes(trimmedSearch.toLowerCase()) ||
            (c.setName ?? "").toLowerCase().includes(trimmedSearch.toLowerCase())
        );

  if (showForm) {
    return (
      <AdminShell activeTab={activeTab} onTabChange={setActiveTab} onLogout={handleLogout}>
        <div className="max-w-3xl mx-auto">
          <button
            onClick={handleFormClose}
            className="text-[var(--admin-gold)] hover:text-[var(--admin-gold-hi)] text-sm mb-4 transition-colors"
            data-testid="button-back-list"
          >
            &larr; Back to list
          </button>
          {/* Owner directive (2026-07-01): one continuous block, in workflow
              order — EDIT MV#### header → AI Identify → grading workstation
              (card tool + defects, passed into the form as workstationSlot) →
              Card Details → Grade — with Ownership + NFC at the very bottom
              of the page. */}
          <CertificateForm
            certificate={editingCert}
            onSuccess={handleFormClose}
            externalIdentification={externalIdentification}
            onExternalIdentificationConsumed={() => setExternalIdentification(null)}
            onIdentifyAndGrade={(result) => {
              // Push analysis to GradingPanel so it populates subgrades, defects, etc.
              setPendingAnalysis(result);
              // Also refetch cert for list updates
              if (editingCert) {
                fetch(`/api/admin/certificates?includeId=${editingCert.id}`, { credentials: "include" })
                  .then((r) => r.json())
                  .then((certs) => {
                    const updated = (Array.isArray(certs) ? certs : []).find((c: any) => c.id === editingCert.id);
                    if (updated) setEditingCert(updated);
                  })
                  .catch(() => {});
              }
              queryClient.invalidateQueries({ queryKey: ["/api/admin/certificates"] });
            }}
            workstationSlot={
              editingCert && editingCert.id ? (
                <GradingPanel
                  certId={editingCert.id}
                  cardName={editingCert.cardName || ""}
                  cardSet={editingCert.setName || ""}
                  cardGame={editingCert.cardGame || ""}
                  existingGrade={editingCert.gradeOverall}
                  pendingAnalysis={pendingAnalysis}
                  onPendingAnalysisConsumed={() => setPendingAnalysis(null)}
                  onManualIdentification={(id) => {
                    // Sync AI panel's manual identification to the cert form
                    setExternalIdentification(id);
                  }}
                  onGradeApproved={() => {
                    queryClient.invalidateQueries({ queryKey: ["/api/admin/certificates"] });
                    // Return to cert list
                    setShowForm(false);
                    setEditingCert(null);
                  }}
                  onCertUpdated={async () => {
                    // Refetch the cert to get AI-autofilled fields (card name, set, number, etc.)
                    try {
                      const r = await fetch(`/api/admin/certificates?includeId=${editingCert.id}`, {
                        credentials: "include",
                      });
                      const certs = await r.json();
                      const updated = (Array.isArray(certs) ? certs : []).find((c: any) => c.id === editingCert.id);
                      if (updated) setEditingCert(updated);
                    } catch {
                      /* ignore */
                    }
                    queryClient.invalidateQueries({ queryKey: ["/api/admin/certificates"] });
                  }}
                />
              ) : null
            }
          />
          {editingCert && editingCert.id && (
            <div className="mt-6 space-y-6">
              <OwnershipSection cert={editingCert} />
              <NfcSection cert={editingCert} onUpdated={(updated) => setEditingCert(updated)} />
            </div>
          )}
        </div>
      </AdminShell>
    );
  }

  return (
    <AdminShell
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onLogout={handleLogout}
      search={{ value: searchQuery, onChange: setSearchQuery }}
    >
      {isStagingHost && <StagingHarnessPanel />}

      {activeTab === "dashboard" && (
        <DashboardView
          stats={stats}
          onNewCert={handleNewCert}
          onGoToCerts={handleGoToCerts}
          onTabChange={setActiveTab}
        />
      )}
      {activeTab === "certs" && (
        <CertsView
          certs={filtered}
          isLoading={isLoading}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          onNewCert={handleNewCert}
          onEdit={handleEdit}
          onVoid={setVoidTarget}
          onPreview={setPreviewCert}
          totalCount={certs.length}
          initialFilter={filterPreset}
        />
      )}
      {activeTab === "submissions" && <AdminSubmissions />}
      {activeTab === "intake" && <AdminIntake />}
      {activeTab === "pricing" && <AdminPricing />}
      {activeTab === "promotions" && <AdminPromotions />}
      {activeTab === "capacity" && <AdminCapacity />}
      {activeTab === "printing" && <AdminPrinting />}
      {activeTab === "learning" && <AdminLearningPage />}
      {activeTab === "capture-health" && <AdminCaptureHealthPage />}
      {activeTab === "divergence" && <AdminDivergencePage />}
      {activeTab === "transfers" && <AdminTransfers />}
      {activeTab === "scans" && <AdminScanHistory />}
      {activeTab === "grading" &&
        (() => {
          const gradingCert = certs.find((c) => c.id === selectedGradingCertId) ?? null;
          return (
            <div className="max-w-5xl mx-auto px-4 py-6">
              <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6 items-start">
                <GradingQueue
                  currentCertId={selectedGradingCertId}
                  onSelectCert={(id) => {
                    setSelectedGradingCertId(id);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                  approvedSignal={approvedSignal}
                />
                {gradingCert ? (
                  <div className="space-y-4">
                    <div className="flex items-center gap-2">
                      <span
                        className="text-xs font-bold uppercase tracking-widest"
                        style={{ fontFamily: "var(--admin-mono)", color: "var(--admin-gold-hi)" }}
                      >
                        {gradingCert.certId}
                      </span>
                      <span className="text-xs" style={{ color: "var(--admin-ink-dim)" }}>
                        {gradingCert.cardName}
                      </span>
                    </div>
                    <GradingPanel
                      certId={gradingCert.id}
                      certIdStr={gradingCert.certId}
                      cardName={gradingCert.cardName || ""}
                      cardSet={gradingCert.setName || ""}
                      existingGrade={gradingCert.gradeOverall}
                      onGradeApproved={(cid, grade) => {
                        if (cid && grade) setApprovedSignal({ certId: cid, grade, ts: Date.now() });
                        queryClient.invalidateQueries({ queryKey: ["/api/admin/certificates"] });
                      }}
                    />
                  </div>
                ) : (
                  <div
                    className="rounded-xl p-8 text-center"
                    style={{
                      background: "var(--admin-panel)",
                      border: "1px solid var(--admin-line)",
                    }}
                  >
                    <p className="text-sm" style={{ color: "var(--admin-ink-dim)" }}>
                      Select a certificate from the queue to begin grading
                    </p>
                  </div>
                )}
              </div>
            </div>
          );
        })()}

      {previewCert && <LabelPreviewModal cert={previewCert} onClose={() => setPreviewCert(null)} />}

      {voidTarget && (
        <VoidConfirmationModal
          cert={voidTarget}
          isPending={voidMutation.isPending}
          onConfirm={(reason) => voidMutation.mutate({ id: voidTarget.id, reason })}
          onCancel={() => setVoidTarget(null)}
        />
      )}
    </AdminShell>
  );
}

// ── Capacity & Queue section ──────────────────────────────────────────────────

interface CapacityData {
  standard: { active: number; max: number; full: boolean; forceOpen: boolean };
  priority: { active: number; max: number; full: boolean; forceOpen: boolean };
  express: { active: number; max: number; full: boolean; forceOpen: boolean };
}

function CapacitySection() {
  const { data, refetch } = useQuery<CapacityData>({
    queryKey: ["/api/capacity"],
    refetchInterval: 30_000,
  });

  const [editing, setEditing] = useState<{ slug: string; max: number; forceOpen: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const tiers = [
    { slug: "standard", label: "Standard", color: "#D4AF37" },
    { slug: "priority", label: "Priority", color: "#B8960C" },
    { slug: "express", label: "Express", color: "#E8C547" },
  ] as const;

  const handleSave = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const res = await apiRequest("PUT", `/api/admin/capacity/${editing.slug}`, {
        maxActive: editing.max,
        forceOpen: editing.forceOpen,
      });
      if (!res.ok) throw new Error("Failed");
      setSaveMsg("Saved");
      setEditing(null);
      refetch();
    } catch {
      setSaveMsg("Error saving");
    } finally {
      setSaving(false);
      setTimeout(() => setSaveMsg(null), 3000);
    }
  };

  return (
    <Panel
      className="mt-[14px]"
      title="Capacity & Queue"
      actions={
        saveMsg ? (
          <span className="text-xs" style={{ color: "var(--admin-green)" }}>
            {saveMsg}
          </span>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {tiers.map(({ slug, label }) => {
          const cap = data?.[slug as keyof CapacityData];
          const active = cap?.active ?? 0;
          const max = cap?.max ?? 0;
          const full = cap?.full ?? false;
          const forceOpen = cap?.forceOpen ?? false;
          const pct = max > 0 ? Math.min(100, Math.round((active / max) * 100)) : 0;
          const fillColor = pct >= 90 ? "var(--admin-red)" : pct >= 70 ? "var(--admin-amber)" : "var(--admin-gold)";
          const isEdit = editing?.slug === slug;

          return (
            <div key={slug} className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <span
                    style={{
                      fontFamily: "var(--admin-mono)",
                      fontSize: 11,
                      letterSpacing: "1px",
                      textTransform: "uppercase",
                      color: "var(--admin-gold-hi)",
                      fontWeight: 600,
                    }}
                  >
                    {label}
                  </span>
                  {full && !forceOpen && <Badge variant="red">Full</Badge>}
                  {forceOpen && <Badge variant="prog">Force Open</Badge>}
                </div>
                <span style={{ fontFamily: "var(--admin-mono)", color: "var(--admin-ink-faint)" }}>
                  {active} / {max} active
                </span>
              </div>
              <div className="admin-track" style={{ height: 8 }}>
                <i style={{ width: `${pct}%`, background: fillColor }} />
              </div>

              {isEdit ? (
                <div className="flex items-center gap-3 pt-1 flex-wrap">
                  <label className="text-xs" style={{ color: "var(--admin-ink-faint)" }}>
                    Max
                  </label>
                  <input
                    type="number"
                    value={editing.max}
                    min={0}
                    onChange={(e) => setEditing({ ...editing, max: parseInt(e.target.value) || 0 })}
                    className="admin-input"
                    style={{ width: 90 }}
                  />
                  <label
                    className="flex items-center gap-1.5 text-xs cursor-pointer"
                    style={{ color: "var(--admin-ink-dim)" }}
                  >
                    <input
                      type="checkbox"
                      checked={editing.forceOpen}
                      onChange={(e) => setEditing({ ...editing, forceOpen: e.target.checked })}
                      style={{ accentColor: "var(--admin-gold)" }}
                    />
                    Force open
                  </label>
                  <AdminButton variant="gold" size="sm" onClick={handleSave} disabled={saving}>
                    {saving ? "Saving…" : "Save"}
                  </AdminButton>
                  <AdminButton size="sm" onClick={() => setEditing(null)}>
                    Cancel
                  </AdminButton>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setEditing({ slug, max: max, forceOpen })}
                  className="text-[10px] transition-colors"
                  style={{ color: "var(--admin-ink-faint)" }}
                >
                  Edit limits
                </button>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ── Stolen Reports section ────────────────────────────────────────────────────

interface StolenReport {
  id: number;
  cert_id: string;
  reporter_name: string;
  reporter_email: string;
  description: string | null;
  verified_at: string | null;
  created_at: string;
}

function StolenReportsSection() {
  const { data, refetch } = useQuery<StolenReport[]>({
    queryKey: ["/api/admin/stolen"],
    refetchInterval: 60_000,
  });
  const [clearing, setClearing] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const reports = data || [];

  const handleClear = async (certId: string, id: number) => {
    setClearing(id);
    try {
      const res = await apiRequest("POST", `/api/admin/stolen/${certId}/clear`);
      if (!res.ok) throw new Error("Failed");
      setMsg(`Cleared flag for ${certId}`);
      refetch();
    } catch {
      setMsg("Error clearing flag");
    } finally {
      setClearing(null);
      setTimeout(() => setMsg(null), 4000);
    }
  };

  if (reports.length === 0) return null;

  return (
    <Panel
      className="mt-[14px]"
      title={
        <span className="flex items-center gap-2" style={{ color: "var(--admin-red)" }}>
          <AlertTriangle size={14} />
          Stolen Reports
        </span>
      }
      sub={`${reports.length} active`}
      actions={msg ? <span style={{ color: "var(--admin-green)", fontSize: 12 }}>{msg}</span> : undefined}
    >
      <div className="admin-recent">
        {reports.map((r) => (
          <div key={r.id} className="admin-recent-row">
            <div className="admin-recent-row__l" style={{ flexWrap: "wrap", minWidth: 0 }}>
              <span className="admin-recent-row__id">{r.cert_id}</span>
              <span className="admin-recent-row__nm">{r.reporter_name}</span>
              <span style={{ fontFamily: "var(--admin-mono)", fontSize: 11, color: "var(--admin-ink-faint)" }}>
                &lt;{r.reporter_email}&gt;
              </span>
              {r.verified_at ? <Badge variant="red">Verified</Badge> : <Badge variant="prog">Unverified</Badge>}
            </div>
            <div className="admin-recent-row__r">
              <a
                href={`/vault/${r.cert_id}`}
                target="_blank"
                rel="noopener noreferrer"
                className={adminButtonClass({ variant: "ghost", size: "sm" })}
              >
                View
              </a>
              <button
                type="button"
                onClick={() => handleClear(r.cert_id, r.id)}
                disabled={clearing === r.id}
                className={adminButtonClass({ variant: "ghost", size: "sm" })}
                style={{
                  color: "var(--admin-red)",
                  borderColor: "color-mix(in srgb, var(--admin-red) 45%, transparent)",
                }}
              >
                {clearing === r.id ? "Clearing…" : "Clear Flag"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function DashboardView({
  stats,
  onNewCert,
  onGoToCerts,
  onTabChange,
}: {
  stats?: DashboardStats;
  onNewCert: () => void;
  onGoToCerts: (filter?: CertsFilter) => void;
  onTabChange: (t: "dashboard" | "certs" | "submissions" | "intake" | "pricing" | "capacity" | "printing") => void;
}) {
  const [certSearch, setCertSearch] = useState("");
  const [backupStatus, setBackupStatus] = useState<string | null>(null);

  const { data: dbInfo } = useQuery<DbInfo>({
    queryKey: ["/api/admin/db-info"],
    refetchInterval: 60000,
  });

  const backupMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/backup-card-master");
      return res.json();
    },
    onSuccess: (data: any) => {
      setBackupStatus(`Backup saved: ${data.r2Key} (${data.rowCount} rows)`);
      setTimeout(() => setBackupStatus(null), 8000);
    },
    onError: () => {
      setBackupStatus("Backup failed");
      setTimeout(() => setBackupStatus(null), 5000);
    },
  });

  const [backfillStatus, setBackfillStatus] = useState<string | null>(null);
  const backfillClaimMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/backfill-claim-codes");
      return res.json();
    },
    onSuccess: (data: any) => {
      if (data.count === 0) {
        setBackfillStatus("All certificates already have claim codes.");
      } else {
        const blob = new Blob([data.csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `claim-codes-${new Date().toISOString().split("T")[0]}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        setBackfillStatus(`Generated ${data.count} claim codes. CSV downloaded.`);
      }
      setTimeout(() => setBackfillStatus(null), 8000);
    },
    onError: () => {
      setBackfillStatus("Backfill failed");
      setTimeout(() => setBackfillStatus(null), 5000);
    },
  });

  // Bulk reprocess all active certs with grading_front_original. Server
  // processes concurrency-10 batches; large runs (100+) will exceed the
  // 60s Fly proxy timeout and the client fetch will report a network
  // error even though the server keeps working — that's why we mention
  // the audit log + fly logs in the confirm dialog.
  const [bulkReprocessStatus, setBulkReprocessStatus] = useState<string | null>(null);
  const bulkReprocessMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/bulk-reprocess-images", { all: true });
      return res.json();
    },
    onSuccess: (data: any) => {
      setBulkReprocessStatus(`Bulk reprocess complete: ${data.processed}/${data.total} ok, ${data.failed} failed.`);
      setTimeout(() => setBulkReprocessStatus(null), 20000);
    },
    onError: (err: any) => {
      // A long-running call typically reaches here on timeout. The
      // server may still be processing — direct the operator to logs.
      setBulkReprocessStatus(
        `Request error: ${err?.message || "timeout — server may still be processing. Check fly logs / audit_log."}`
      );
      setTimeout(() => setBulkReprocessStatus(null), 20000);
    },
  });

  const handleBulkReprocess = () => {
    if (
      !window.confirm(
        "Reprocess images for ALL active certs?\n\n" +
          "This re-runs the full image pipeline (deskew → detect → recentre → tightenForDisplay → whitewash → mask) " +
          "on every cert that has an R2 original, concurrency 10. For 100+ certs the request will likely time out " +
          "on the client side, but the server will keep processing — check fly logs for [bulk-reprocess] and audit_log for completion."
      )
    )
      return;
    bulkReprocessMutation.mutate();
  };

  const handleCertSearch = () => {
    if (certSearch.trim()) {
      window.open(`/cert/${certSearch.trim().toUpperCase()}`, "_blank");
    }
  };

  return (
    <>
      {/* Hero band — the Overview's only gold-shader surface */}
      <div className="admin-hero">
        <GoldShader className="admin-hero__fx" />
        <div className="admin-hero__in">
          <button
            type="button"
            className="admin-hero__stat is-clickable"
            onClick={() => onGoToCerts({})}
            data-testid="stat-total"
          >
            <div className="admin-hero__k" data-testid="text-dashboard-title">
              Total Certificates
            </div>
            <div className="admin-hero__num">{stats?.totalCerts ?? 0}</div>
            <div className="admin-hero__sub">
              <b>{dbInfo?.last_issued_mv ?? "…"}</b> last issued · <b>{stats?.thisWeek ?? 0}</b> graded this week
            </div>
          </button>
          <div className="admin-hero__side">
            <span className="admin-hero__tag">◆ Vault Live</span>
            <AdminButton variant="gold" onClick={onNewCert} data-testid="button-quick-new-cert">
              <Plus size={16} /> Create New Cert
            </AdminButton>
          </div>
        </div>
      </div>

      <div className="admin-grid admin-grid--g7" style={{ marginTop: 14 }}>
        <StatCard
          label="Graded This Week"
          value={stats?.thisWeek ?? 0}
          icon={<Clock />}
          testId="stat-week"
          onClick={() => onGoToCerts({ range: "week" })}
        />
        <StatCard
          label="Graded This Month"
          value={stats?.thisMonth ?? 0}
          icon={<BarChart3 />}
          testId="stat-month"
          onClick={() => onGoToCerts({ range: "month" })}
        />
        <StatCard
          label="Card Master Active"
          value={dbInfo?.card_master_active_count ?? 0}
          icon={<Database />}
          testId="stat-cm-active"
        />
        <StatCard
          label="Card Sets Active"
          value={dbInfo?.card_sets_active_count ?? 0}
          icon={<Database />}
          testId="stat-cs-active"
        />
        <StatCard
          label="Last Issued MV"
          value={dbInfo?.last_issued_mv ?? "…"}
          mono
          icon={<FileText />}
          testId="stat-last-mv"
          onClick={dbInfo?.last_issued_mv ? () => window.open(`/cert/${dbInfo.last_issued_mv}`, "_blank") : undefined}
        />
        <StatCard
          label="Active Certificates"
          value={dbInfo?.certificates_count ?? 0}
          icon={<Shield />}
          testId="stat-cert-count"
          onClick={() => onGoToCerts({ status: "active" })}
        />
        <StatCard
          label="Voided Certificates"
          value={dbInfo?.voided_count ?? 0}
          icon={<Ban />}
          testId="stat-voided"
          onClick={() => onGoToCerts({ status: "voided" })}
        />
        <StatCard
          label="Authentic Only"
          value={stats?.authenticOnlyCount ?? 0}
          icon={<Tag />}
          testId="stat-auth-only"
          onClick={() => onGoToCerts({ gradeType: "authentic" })}
        />
      </div>

      <div className="admin-toolbar" style={{ marginTop: 22 }}>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={certSearch}
            onChange={(e) => setCertSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCertSearch()}
            placeholder="Cert ID…"
            className="admin-input"
            style={{ width: 160 }}
            data-testid="input-quick-search"
          />
          <AdminButton iconOnly onClick={handleCertSearch} data-testid="button-quick-search">
            <Search size={14} />
          </AdminButton>
        </div>
        <a href="/api/admin/certificates/export-csv" className={adminButtonClass()} data-testid="button-export-csv">
          <FileDown size={14} /> Export CSV
        </a>
        <a href="/api/admin/ownership-export" className={adminButtonClass()} data-testid="button-export-ownership-csv">
          <Shield size={14} /> Ownership CSV
        </a>
        <AdminButton
          onClick={() => backfillClaimMutation.mutate()}
          disabled={backfillClaimMutation.isPending}
          data-testid="button-backfill-claim-codes"
        >
          {backfillClaimMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Shield size={14} />}
          Backfill Claim Codes
        </AdminButton>
        <AdminButton
          onClick={handleBulkReprocess}
          disabled={bulkReprocessMutation.isPending}
          data-testid="button-bulk-reprocess"
        >
          {bulkReprocessMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}
          Bulk Reprocess All
        </AdminButton>
      </div>
      {backfillStatus && (
        <p className="text-xs mt-2" style={{ color: "var(--admin-gold-hi)" }} data-testid="text-backfill-status">
          {backfillStatus}
        </p>
      )}
      {bulkReprocessStatus && (
        <p className="text-xs mt-2" style={{ color: "var(--admin-gold-hi)" }} data-testid="text-bulk-reprocess-status">
          {bulkReprocessStatus}
        </p>
      )}

      <div className="admin-cols">
        <Panel title={<span data-testid="text-grade-dist-title">Grade Distribution</span>}>
          {stats?.gradeDistribution ? (
            <GradeChart data={stats.gradeDistribution} onGradeClick={(g) => onGoToCerts({ grade: g })} />
          ) : (
            <div
              className="flex items-center justify-center text-sm"
              style={{ height: 170, color: "var(--admin-ink-faint)" }}
            >
              No data
            </div>
          )}
        </Panel>

        <Panel title={<span data-testid="text-grade-type-title">By Grade Type</span>}>
          <div className="admin-tin">
            {[
              {
                label: "Numeric (1–10)",
                count:
                  (stats?.totalCerts ?? 0) - (stats?.authenticOnlyCount ?? 0) - (stats?.authenticAlteredCount ?? 0),
                filter: { gradeType: "numeric" as const },
                testId: "grade-type-numeric",
              },
              {
                label: "Authentic Only (NO)",
                count: stats?.authenticOnlyCount ?? 0,
                filter: { gradeType: "authentic" as const },
                testId: "grade-type-auth-only",
              },
              {
                label: "Authentic Altered (AA)",
                count: stats?.authenticAlteredCount ?? 0,
                filter: { gradeType: "altered" as const },
                testId: "grade-type-auth-altered",
              },
            ].map(({ label, count, filter, testId }) => {
              const total = stats?.totalCerts ?? 0;
              const pct = total > 0 ? Math.min(100, Math.round((count / total) * 100)) : 0;
              return (
                <button
                  key={testId}
                  type="button"
                  className="admin-tin-row is-clickable"
                  onClick={() => onGoToCerts(filter)}
                  data-testid={testId}
                >
                  <div className="admin-tin-row__top">
                    <span className="admin-tin-row__nm">{label}</span>
                    <span className="admin-tin-row__ct">{count}</span>
                  </div>
                  <div className="admin-track">
                    <i style={{ width: `${pct}%` }} />
                  </div>
                </button>
              );
            })}
          </div>
        </Panel>
      </div>

      <CapacitySection />
      <StolenReportsSection />

      <Panel
        className="mt-[14px]"
        title={<span data-testid="text-recent-title">Recent Activity</span>}
        actions={
          <button
            type="button"
            onClick={() => onGoToCerts({})}
            className={adminButtonClass({ variant: "ghost", size: "sm" })}
            data-testid="button-view-all"
          >
            View All Certificates <ArrowRight size={11} />
          </button>
        }
      >
        {stats?.recentCerts && stats.recentCerts.length > 0 ? (
          <div className="admin-recent">
            {stats.recentCerts.map((cert) => {
              const gt = (cert as any).gradeType || "numeric";
              const isNN = isNonNumericGrade(gt);
              const grade = isNN ? 0 : parseFloat(cert.gradeOverall || "0");
              const gradeDisplay = isNN ? gradeLabelFull(gt, cert.gradeOverall || "0") : String(grade);
              return <RecentCertRow key={cert.id} cert={cert} gradeDisplay={gradeDisplay} />;
            })}
          </div>
        ) : (
          <p className="text-center text-sm" style={{ padding: "32px 0", color: "var(--admin-ink-faint)" }}>
            No certificates yet
          </p>
        )}
      </Panel>
    </>
  );
}

function RecentCertRow({ cert, gradeDisplay }: { cert: CertificateRecord; gradeDisplay: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(cert.certId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const handleOpen = () => {
    window.open(`/cert/${cert.certId}`, "_blank");
  };

  const statusVariant: AdminBadgeVariant =
    cert.status === "active" || cert.status === "published" ? "act" : cert.status === "voided" ? "red" : "neu";

  return (
    <div
      onClick={handleOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && handleOpen()}
      className="admin-recent-row"
      data-testid={`recent-cert-${cert.id}`}
    >
      <div className="admin-recent-row__l">
        <span className="admin-recent-row__id">{cert.certId}</span>
        <button
          type="button"
          onClick={handleCopy}
          title="Copy cert ID"
          className="admin-recent-copy"
          data-testid={`button-copy-certid-${cert.id}`}
        >
          {copied ? <Check size={11} style={{ color: "var(--admin-green)" }} /> : <Copy size={11} />}
        </button>
        <span className="admin-recent-row__nm">{cert.cardName}</span>
        <span className="admin-recent-row__set hidden sm:inline">{cert.setName}</span>
      </div>
      <div className="admin-recent-row__r">
        <span className="admin-recent-row__gr">{gradeDisplay}</span>
        <Badge variant={statusVariant}>{cert.status}</Badge>
        <span className="admin-recent-row__dt hidden sm:inline">
          {cert.createdAt ? new Date(cert.createdAt).toLocaleDateString("en-GB") : ""}
        </span>
        <ArrowRight size={12} style={{ color: "var(--admin-ink-faint)" }} />
      </div>
    </div>
  );
}

function GradeChart({
  data,
  onGradeClick,
}: {
  data: { grade: number; count: number }[];
  onGradeClick?: (grade: number) => void;
}) {
  const maxCount = Math.max(...data.map((d) => d.count), 1);

  return (
    <div className="admin-bars" data-testid="chart-grade-distribution">
      {data.map((d) => {
        const clickable = !!onGradeClick && d.count > 0;
        return (
          <div
            key={d.grade}
            onClick={clickable ? () => onGradeClick!(d.grade) : undefined}
            role={clickable ? "button" : undefined}
            tabIndex={clickable ? 0 : undefined}
            onKeyDown={clickable ? (e) => e.key === "Enter" && onGradeClick!(d.grade) : undefined}
            title={clickable ? `View grade ${d.grade} certificates` : undefined}
            className={`admin-bar ${d.count > 0 ? "" : "is-dim"} ${clickable ? "is-clickable" : ""}`
              .replace(/\s+/g, " ")
              .trim()}
          >
            <span className="admin-bar__val">{d.count > 0 ? d.count : ""}</span>
            <div
              className="admin-bar__col"
              style={{ height: `${Math.max((d.count / maxCount) * 100, d.count > 0 ? 8 : 2)}%` }}
            />
            <span className="admin-bar__gr">{d.grade}</span>
          </div>
        );
      })}
    </div>
  );
}

function getInitialDateFrom(range?: "week" | "month"): string {
  if (!range) return "";
  const d = new Date();
  if (range === "week") d.setDate(d.getDate() - 7);
  if (range === "month") d.setMonth(d.getMonth() - 1);
  return d.toISOString().split("T")[0];
}

function CertsView({
  certs,
  isLoading,
  searchQuery,
  setSearchQuery,
  onNewCert,
  onEdit,
  onVoid,
  onPreview,
  totalCount,
  initialFilter = {},
}: {
  certs: CertificateRecord[];
  isLoading: boolean;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  onNewCert: () => void;
  onEdit: (cert: CertificateRecord) => void;
  onVoid: (cert: CertificateRecord) => void;
  onPreview: (cert: CertificateRecord) => void;
  totalCount: number;
  initialFilter?: CertsFilter;
}) {
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "voided">(initialFilter.status ?? "all");
  const [gradeTypeFilter, setGradeTypeFilter] = useState<"all" | "numeric" | "authentic" | "altered">(
    initialFilter.gradeType ?? "all"
  );
  const [gradeFilter, setGradeFilter] = useState(initialFilter.grade !== undefined ? String(initialFilter.grade) : "");
  const [dateFrom, setDateFrom] = useState(() => getInitialDateFrom(initialFilter.range));
  const [dateTo, setDateTo] = useState("");
  const [ownershipFilter, setOwnershipFilter] = useState<"all" | "claimed" | "unclaimed">(() => {
    if (typeof window === "undefined") return "all";
    const o = new URLSearchParams(window.location.search).get("ownership");
    return o === "claimed" || o === "unclaimed" ? o : "all";
  });
  const [gradingStatusFilter, setGradingStatusFilter] = useState<"all" | GradingStatus>(() => {
    if (typeof window === "undefined") return "all";
    const g = new URLSearchParams(window.location.search).get("grading");
    if (g === "awaiting-grade") return "awaiting_grade";
    if (g === "awaiting-images") return "awaiting_images";
    if (g === "in-progress") return "in_progress";
    if (g === "graded") return "graded";
    return "all";
  });

  // Persist both filters to the URL query string. replaceState (not pushState)
  // so the back button isn't polluted with one history entry per click.
  // Re-running this effect on the initial render is idempotent — if the URL
  // already has the params we read on mount, we just write them back.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (gradingStatusFilter === "all") params.delete("grading");
    else params.set("grading", gradingStatusFilter.replace(/_/g, "-"));
    if (ownershipFilter === "all") params.delete("ownership");
    else params.set("ownership", ownershipFilter);
    const qs = params.toString();
    const newUrl = qs
      ? `${window.location.pathname}?${qs}${window.location.hash}`
      : `${window.location.pathname}${window.location.hash}`;
    window.history.replaceState(null, "", newUrl);
  }, [gradingStatusFilter, ownershipFilter]);

  const filtered = certs.filter((c) => {
    if (statusFilter === "voided" && c.status !== "voided") return false;
    if (statusFilter === "active" && c.status === "voided") return false;
    if (gradeTypeFilter !== "all") {
      const gt: string = (c as any).gradeType || "numeric";
      if (gradeTypeFilter === "authentic" && gt !== "NO" && gt !== "not_original") return false;
      if (gradeTypeFilter === "altered" && gt !== "AA" && gt !== "authentic_altered") return false;
      if (gradeTypeFilter === "numeric" && isNonNumericGrade(gt)) return false;
    }
    if (gradeFilter) {
      const gradeNum = parseFloat(gradeFilter);
      const certGrade = parseFloat(c.gradeOverall || "0");
      if (!isNaN(gradeNum) && certGrade !== gradeNum) return false;
    }
    if (dateFrom && c.createdAt) {
      const certDate = new Date(c.createdAt).toISOString().split("T")[0];
      if (certDate < dateFrom) return false;
    }
    if (dateTo && c.createdAt) {
      const certDate = new Date(c.createdAt).toISOString().split("T")[0];
      if (certDate > dateTo) return false;
    }
    if (ownershipFilter !== "all") {
      const os = (c as any).ownershipStatus || "unclaimed";
      if (ownershipFilter === "claimed" && os !== "claimed") return false;
      if (ownershipFilter === "unclaimed" && os === "claimed") return false;
    }
    if (gradingStatusFilter !== "all" && gradingStatus(c) !== gradingStatusFilter) return false;
    return true;
  });

  const voidedCount = certs.filter((c) => c.status === "voided").length;
  const claimedCount = certs.filter((c) => (c as any).ownershipStatus === "claimed").length;
  const hasActiveFilters =
    statusFilter !== "all" ||
    gradeTypeFilter !== "all" ||
    gradeFilter ||
    dateFrom ||
    dateTo ||
    searchQuery ||
    ownershipFilter !== "all" ||
    gradingStatusFilter !== "all";

  // Counts for the grading filter tabs — reflect statusFilter + gradeTypeFilter
  // only (not the grading filter itself, not date/grade/ownership/search), so
  // tab labels show how many certs would land in each bucket if the user
  // switched to that tab.
  const gradingCounts: Record<GradingStatus, number> = {
    graded: 0,
    in_progress: 0,
    awaiting_grade: 0,
    awaiting_images: 0,
  };
  for (const c of certs) {
    if (statusFilter === "voided" && c.status !== "voided") continue;
    if (statusFilter === "active" && c.status === "voided") continue;
    if (gradeTypeFilter !== "all") {
      const gt: string = (c as any).gradeType || "numeric";
      if (gradeTypeFilter === "authentic" && gt !== "NO" && gt !== "not_original") continue;
      if (gradeTypeFilter === "altered" && gt !== "AA" && gt !== "authentic_altered") continue;
      if (gradeTypeFilter === "numeric" && isNonNumericGrade(gt)) continue;
    }
    gradingCounts[gradingStatus(c)]++;
  }

  return (
    <>
      <div className="admin-list-head">
        <h1 className="admin-list-head__t" data-testid="text-certs-title">
          Certificates
        </h1>
        <AdminButton variant="gold" onClick={onNewCert} data-testid="button-new-cert">
          <Plus size={16} /> New Certificate
        </AdminButton>
      </div>
      <div className="admin-records">
        {totalCount} total records{voidedCount > 0 ? ` · ${voidedCount} voided` : ""}
        {hasActiveFilters ? " (filtered)" : ""}
      </div>

      <div className="admin-filters">
        <div className="relative" style={{ flex: 1, minWidth: 200, maxWidth: 360 }}>
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2"
            size={15}
            style={{ color: "var(--admin-ink-faint)" }}
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search cert ID, card name, set…"
            className="admin-input"
            style={{ paddingLeft: 34 }}
            data-testid="input-search-certs"
          />
        </div>
        {(["all", "active", "voided"] as const).map((f) => (
          <Chip
            key={f}
            active={statusFilter === f}
            count={f === "voided" && voidedCount > 0 ? voidedCount : undefined}
            onClick={() => setStatusFilter(f)}
            className="capitalize"
            testId={`filter-${f}`}
          >
            {f}
          </Chip>
        ))}
        <span className="admin-filters__div" />
        {(["numeric", "authentic", "altered"] as const).map((gt) => (
          <Chip
            key={gt}
            active={gradeTypeFilter === gt}
            onClick={() => setGradeTypeFilter(gradeTypeFilter === gt ? "all" : gt)}
            testId={`filter-gradetype-${gt}`}
          >
            {gt === "numeric" ? "Numeric" : gt === "authentic" ? "Auth Only" : "Altered"}
          </Chip>
        ))}
        <span className="admin-filters__div" />
        {(["all", "claimed", "unclaimed"] as const).map((o) => (
          <Chip
            key={o}
            active={ownershipFilter === o}
            count={o === "claimed" ? claimedCount : undefined}
            onClick={() => setOwnershipFilter(o)}
            testId={`filter-ownership-${o}`}
          >
            {o === "claimed" && <Shield size={11} style={{ marginRight: 5 }} />}
            {o === "claimed" ? "Claimed" : o === "unclaimed" ? "Unclaimed" : "All Ownership"}
          </Chip>
        ))}
      </div>

      <div className="admin-filters">
        <span className="admin-filters__lab">Grading</span>
        {(["all", "awaiting_images", "awaiting_grade", "in_progress", "graded"] as const).map((g) => (
          <Chip
            key={g}
            active={gradingStatusFilter === g}
            count={g === "all" ? undefined : gradingCounts[g]}
            onClick={() => setGradingStatusFilter(g)}
            testId={`filter-grading-${g}`}
          >
            {g === "all" ? "All" : GRADING_STATUS_LABEL[g]}
          </Chip>
        ))}
      </div>

      <div className="admin-daterow">
        <span className="admin-filters__lab">Grade</span>
        <select value={gradeFilter} onChange={(e) => setGradeFilter(e.target.value)} data-testid="select-grade-filter">
          <option value="">All grades</option>
          {[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((g) => (
            <option key={g} value={String(g)}>
              {g}
            </option>
          ))}
        </select>
        <span className="admin-filters__lab">From</span>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          data-testid="input-date-from-certs"
        />
        <span className="admin-filters__lab">To</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          data-testid="input-date-to-certs"
        />
        {hasActiveFilters && (
          <button
            type="button"
            onClick={() => {
              setStatusFilter("all");
              setGradeTypeFilter("all");
              setGradeFilter("");
              setDateFrom("");
              setDateTo("");
              setSearchQuery("");
              setOwnershipFilter("all");
              setGradingStatusFilter("all");
            }}
            className={adminButtonClass({ variant: "ghost", size: "sm" })}
            data-testid="button-clear-filters-certs"
          >
            <X size={12} /> Clear filters
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="animate-pulse" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {[1, 2, 3].map((i) => (
            <div key={i} style={{ height: 84, borderRadius: "var(--admin-r)", background: "var(--admin-line-soft)" }} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div
          className="text-center"
          style={{ padding: "64px 0", border: "1px solid var(--admin-line-soft)", borderRadius: "var(--admin-r)" }}
        >
          <FileText className="mx-auto mb-3" size={40} style={{ color: "var(--admin-ink-faint)", opacity: 0.55 }} />
          <p style={{ color: "var(--admin-ink-dim)" }}>
            {searchQuery
              ? "No matching certificates"
              : statusFilter === "voided"
                ? "No voided certificates"
                : "No certificates yet"}
          </p>
        </div>
      ) : (
        <div>
          {filtered.map((cert) => (
            <CertRow
              key={cert.id}
              cert={cert}
              onEdit={() => onEdit(cert)}
              onVoid={() => onVoid(cert)}
              onPreview={() => onPreview(cert)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function CertRow({
  cert,
  onEdit,
  onVoid,
  onPreview,
}: {
  cert: CertificateRecord;
  onEdit: () => void;
  onVoid: () => void;
  onPreview: () => void;
}) {
  const gradeType = (cert as any).gradeType || "numeric";
  const isNonNum = isNonNumericGrade(gradeType);
  const grade = isNonNum ? 0 : parseFloat(cert.gradeOverall || "0");
  // Tier NAME from the MVGS table for numeric grades so half grades read true
  // (8.5 → "NM-MINT+") instead of gradeLabelFull's rounded whole-grade name.
  const label = isNonNum ? gradeLabelFull(gradeType, cert.gradeOverall || "0") : mvgsTierName(grade).toUpperCase();

  // Embedding freshness — embeddedAt is null until the hourly job picks
  // it up; stale when a cert mutation (image swap, grade edit, etc.) has
  // bumped updatedAt since the last embed. cert.updatedAt fires on any
  // row change so "stale" here means "embedding text may be out of date".
  const embeddedAt = (cert as any).embeddedAt ? new Date((cert as any).embeddedAt) : null;
  const updatedAt = (cert as any).updatedAt ? new Date((cert as any).updatedAt) : null;
  const isStaleEmbedding = !!(embeddedAt && updatedAt && updatedAt.getTime() > embeddedAt.getTime());

  const [reembedBusy, setReembedBusy] = useState(false);
  const [reembedMsg, setReembedMsg] = useState<string | null>(null);
  async function handleReembed() {
    setReembedBusy(true);
    setReembedMsg(null);
    try {
      const res = await fetch(`/api/admin/embed-corpus/cert/${encodeURIComponent(cert.certId)}`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setReembedMsg(data.status === "embedded" ? "Embedded ✓" : data.reason || data.status);
      setTimeout(() => setReembedMsg(null), 4000);
    } catch (e: any) {
      setReembedMsg(`Error: ${e.message}`);
      setTimeout(() => setReembedMsg(null), 6000);
    } finally {
      setReembedBusy(false);
    }
  }

  const gs = gradingStatus(cert);
  const labelLinkClass = adminButtonClass({ variant: "ghost", size: "sm" });

  return (
    <div className="admin-cert" data-testid={`cert-row-${cert.id}`}>
      <div className="admin-cert__top">
        <div className="admin-thumb">
          {(cert as any).frontImageUrl || cert.frontImagePath ? (
            <img src={(cert as any).frontImageUrl || cert.frontImagePath} alt={cert.cardName ?? ""} />
          ) : (
            <Image />
          )}
        </div>
        <div className="admin-cert__info">
          <div className="admin-cid-row">
            <span className="admin-cid" data-testid={`text-cert-id-${cert.id}`}>
              {cert.certId}
            </span>
            <Badge
              variant={
                cert.status === "active" || cert.status === "published"
                  ? "act"
                  : cert.status === "voided"
                    ? "red"
                    : "neu"
              }
            >
              {cert.status === "active" || cert.status === "published" ? <Eye size={10} /> : <EyeOff size={10} />}
              {cert.status}
            </Badge>
            {(cert as any).ownershipStatus === "claimed" ? (
              <Badge variant="gold" testId={`badge-owned-${cert.id}`}>
                <Shield size={9} /> claimed
              </Badge>
            ) : (
              <Badge variant="neu" testId={`badge-unclaimed-${cert.id}`}>
                unclaimed
              </Badge>
            )}
            <Badge variant={GRADING_STATUS_VARIANT[gs]} testId={`badge-grading-status-${cert.id}`}>
              {GRADING_STATUS_LABEL[gs]}
            </Badge>
            <span className="admin-gradechip">{isNonNum ? label : `${grade} ${label}`}</span>
          </div>
          <div className="admin-cname" data-testid={`text-cert-name-${cert.id}`}>
            {cert.cardName}
          </div>
          <div className="admin-cmeta">
            {cert.cardGame} · {cert.setName} · {cert.cardNumber}
            {(() => {
              // Line-3 value, human-readable: variant label if set, else rarity.
              // Raw codes (TRAINER_GALLERY) map to labels; legacy free text
              // passes through; underscores never reach the screen.
              const line3 =
                getVariantDisplayLabel(cert.variant, (cert as any).variantOther) ||
                (cert.variant ? String(cert.variant) : "") ||
                (cert.rarity ? String(cert.rarity) : "");
              return line3 ? ` · ${line3.replace(/_/g, " ")}` : "";
            })()}
          </div>
          <div
            className="admin-cmeta"
            style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 6 }}
            data-testid={`text-embed-status-${cert.id}`}
          >
            <Database size={9} style={{ color: "var(--admin-gold)" }} />
            <span>
              Last embedded:{" "}
              {embeddedAt
                ? embeddedAt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
                : "never"}
            </span>
            {isStaleEmbedding && (
              <Badge variant="prog" testId={`badge-embed-stale-${cert.id}`}>
                STALE
              </Badge>
            )}
          </div>
        </div>

        <div className="admin-cert__acts">
          <AdminButton iconOnly onClick={onEdit} title="Edit" data-testid={`button-edit-${cert.id}`}>
            <Edit size={12} />
          </AdminButton>
          {cert.status !== "voided" && (
            <AdminButton iconOnly onClick={onVoid} title="Void certificate" data-testid={`button-void-${cert.id}`}>
              <Ban size={12} />
            </AdminButton>
          )}
        </div>
      </div>

      <div className="admin-labels">
        <span className="admin-labels__lab">Labels</span>
        <button type="button" onClick={onPreview} className={labelLinkClass} data-testid={`button-preview-${cert.id}`}>
          <Eye size={10} /> Preview
        </button>
        <a
          href={`/api/admin/certificates/${cert.id}/label/front?format=pdf`}
          className={labelLinkClass}
          data-testid={`button-dl-front-pdf-${cert.id}`}
        >
          <Download size={10} /> Front PDF
        </a>
        <a
          href={`/api/admin/certificates/${cert.id}/label/front?format=png`}
          className={labelLinkClass}
          data-testid={`button-dl-front-png-${cert.id}`}
        >
          <Download size={10} /> Front PNG
        </a>
        <a
          href={`/api/admin/certificates/${cert.id}/label/back?format=pdf`}
          className={labelLinkClass}
          data-testid={`button-dl-back-pdf-${cert.id}`}
        >
          <Download size={10} /> Back PDF
        </a>
        <a
          href={`/api/admin/certificates/${cert.id}/label/back?format=png`}
          className={labelLinkClass}
          data-testid={`button-dl-back-png-${cert.id}`}
        >
          <Download size={10} /> Back PNG
        </a>
        <a
          href={`/api/admin/certificates/${cert.id}/label/both?format=pdf`}
          className={labelLinkClass}
          data-testid={`button-dl-both-pdf-${cert.id}`}
        >
          <Printer size={10} /> Both PDF
        </a>
        <button
          type="button"
          onClick={handleReembed}
          disabled={reembedBusy}
          className={labelLinkClass}
          title={
            isStaleEmbedding ? "Re-embed: cert has changed since last embed" : "Re-embed: force regenerate RAG vector"
          }
          data-testid={`button-reembed-${cert.id}`}
        >
          <Database size={10} /> {reembedBusy ? "…" : "Re-embed"}
        </button>
        {reembedMsg && (
          <span style={{ fontSize: 10, color: "var(--admin-ink-faint)" }} data-testid={`text-reembed-msg-${cert.id}`}>
            {reembedMsg}
          </span>
        )}
      </div>
    </div>
  );
}

function VoidConfirmationModal({
  cert,
  isPending,
  onConfirm,
  onCancel,
}: {
  cert: CertificateRecord;
  isPending: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");

  return (
    <div className="admin-modal-overlay" data-testid="modal-void">
      <div className="admin-modal">
        <div className="flex items-center gap-3 mb-4">
          <AlertTriangle style={{ color: "var(--admin-red)", flexShrink: 0 }} size={24} />
          <h3 className="font-bold tracking-wider text-sm uppercase" style={{ color: "var(--admin-red)" }}>
            Void Certificate
          </h3>
        </div>
        <p className="text-sm mb-2" style={{ color: "var(--admin-ink-dim)" }}>
          You are about to void certificate{" "}
          <span style={{ fontFamily: "var(--admin-mono)", fontWeight: 700, color: "var(--admin-ink)" }}>
            {cert.certId}
          </span>
          .
        </p>
        <p className="text-xs mb-4" style={{ color: "var(--admin-ink-faint)" }}>
          This action is permanent. The certificate will be marked as VOIDED and will display as voided on the public
          lookup page. The certificate ID will be preserved.
        </p>

        <div className="mb-3">
          <label className="admin-field-label">Reason (optional)</label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Issued in error, duplicate entry…"
            className="admin-input"
            data-testid="input-void-reason"
          />
        </div>

        <div className="mb-5">
          <label className="admin-field-label">
            Type <span style={{ color: "var(--admin-red)", fontWeight: 700 }}>VOID</span> to confirm
          </label>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value.toUpperCase())}
            placeholder="VOID"
            className="admin-input"
            style={{ fontFamily: "var(--admin-mono)", letterSpacing: "0.12em" }}
            data-testid="input-void-confirm"
          />
        </div>

        <div className="flex items-center gap-3 justify-end">
          <AdminButton onClick={onCancel} data-testid="button-void-cancel">
            Cancel
          </AdminButton>
          <button
            type="button"
            onClick={() => onConfirm(reason)}
            disabled={typed !== "VOID" || isPending}
            className="admin-btn"
            style={{ background: "var(--admin-red)", color: "#1a0c0a", borderColor: "var(--admin-red)" }}
            data-testid="button-void-submit"
          >
            <Ban size={14} />
            {isPending ? "Voiding…" : "Void Certificate"}
          </button>
        </div>
      </div>
    </div>
  );
}

function LabelPreviewModal({ cert, onClose }: { cert: CertificateRecord; onClose: () => void }) {
  const ts = Date.now();

  const previewTileStyle: React.CSSProperties = {
    background: "#FAFAF8",
    borderRadius: 10,
    padding: 12,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };
  const dlClass = adminButtonClass({ size: "sm" });

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal admin-modal--wide" onClick={(e) => e.stopPropagation()}>
        <div className="admin-panel__head">
          <div>
            <div className="admin-panel__title" data-testid="text-preview-title">
              Label Preview
            </div>
            <div className="admin-panel__sub">
              {cert.certId} · {cert.cardName}
            </div>
          </div>
          <AdminButton iconOnly onClick={onClose} data-testid="button-close-preview">
            <X size={16} />
          </AdminButton>
        </div>

        <div className="space-y-6">
          <div>
            <p className="admin-field-label">Front Label (70mm × 20mm)</p>
            <div style={previewTileStyle}>
              <img
                src={`/api/admin/certificates/${cert.id}/label/front?format=png&preview=1&t=${ts}`}
                alt="Front label preview"
                className="max-w-full h-auto"
                style={{ imageRendering: "auto", border: "1px solid var(--admin-line-soft)", borderRadius: 6 }}
                data-testid="img-preview-front"
              />
            </div>
          </div>

          <div>
            <p className="admin-field-label">Back Label (70mm × 20mm)</p>
            <div style={previewTileStyle}>
              <img
                src={`/api/admin/certificates/${cert.id}/label/back?format=png&preview=1&t=${ts}`}
                alt="Back label preview"
                className="max-w-full h-auto"
                style={{ imageRendering: "auto", border: "1px solid var(--admin-line-soft)", borderRadius: 6 }}
                data-testid="img-preview-back"
              />
            </div>
          </div>

          <div style={{ borderTop: "1px solid var(--admin-line-soft)", paddingTop: 16 }}>
            <p className="text-xs mb-3" style={{ color: "var(--admin-ink-faint)" }}>
              Print specs: 826 × 236px at 300 DPI = 70mm × 20mm exact
            </p>
            <div className="flex flex-wrap gap-2">
              <a
                href={`/api/admin/certificates/${cert.id}/label/front?format=pdf`}
                className={dlClass}
                data-testid="button-modal-dl-front-pdf"
              >
                <Download size={11} /> Front PDF
              </a>
              <a
                href={`/api/admin/certificates/${cert.id}/label/front?format=png`}
                className={dlClass}
                data-testid="button-modal-dl-front-png"
              >
                <Download size={11} /> Front PNG
              </a>
              <a
                href={`/api/admin/certificates/${cert.id}/label/back?format=pdf`}
                className={dlClass}
                data-testid="button-modal-dl-back-pdf"
              >
                <Download size={11} /> Back PDF
              </a>
              <a
                href={`/api/admin/certificates/${cert.id}/label/back?format=png`}
                className={dlClass}
                data-testid="button-modal-dl-back-png"
              >
                <Download size={11} /> Back PNG
              </a>
              <a
                href={`/api/admin/certificates/${cert.id}/label/both?format=pdf`}
                className={dlClass}
                data-testid="button-modal-dl-both-pdf"
              >
                <Printer size={11} /> Both PDF
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
