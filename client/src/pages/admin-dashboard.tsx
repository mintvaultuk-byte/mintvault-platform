import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { CertificateRecord } from "@shared/schema";
import { gradeLabel, gradeLabelFull, isNonNumericGrade } from "@shared/schema";
import {
  LogOut, Plus, Edit, Download, Search, Eye, EyeOff,
  FileText, Image, X, Printer, BarChart3, Tag, Clock, FileDown,
  LayoutDashboard, List, Database, Shield, Ban, AlertTriangle,
  Package, ScanLine, DollarSign, Save, ArrowRight, Copy, Check, Loader2,
} from "lucide-react";

type CertsFilter = {
  status?: "all" | "active" | "voided";
  range?: "week" | "month";
  gradeType?: "numeric" | "authentic" | "altered";
  grade?: number;
};
import AdminSubmissions, { AdminIntake } from "@/pages/admin-submissions";
import AdminPricing from "@/pages/admin-pricing";
import AdminPrinting from "@/pages/admin-printing";

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

interface Props {
  onLogout: () => void;
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

export default function AdminDashboard({ onLogout }: Props) {
  const [activeTab, setActiveTab] = useState<"dashboard" | "certs" | "submissions" | "intake" | "pricing" | "printing">("dashboard");
  const [filterPreset, setFilterPreset] = useState<CertsFilter>({});
  const [showForm, setShowForm] = useState(false);
  const [editingCert, setEditingCert] = useState<CertificateRecord | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [previewCert, setPreviewCert] = useState<CertificateRecord | null>(null);

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

  const handleFormClose = () => {
    setShowForm(false);
    setEditingCert(null);
    queryClient.invalidateQueries({ queryKey: ["/api/admin/certificates"] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/stats"] });
  };

  const handleNewCert = () => {
    setEditingCert(null);
    setShowForm(true);
    setActiveTab("certs");
  };

  const handleGoToCerts = (filter: CertsFilter = {}) => {
    setFilterPreset(filter);
    setActiveTab("certs");
  };

  const filtered = searchQuery
    ? certs.filter((c) =>
        c.certId.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.cardName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.setName.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : certs;

  if (showForm) {
    return (
      <div className="min-h-screen bg-black">
        <AdminHeader onLogout={handleLogout} activeTab={activeTab} onTabChange={setActiveTab} />
        <div className="max-w-3xl mx-auto px-4 py-6">
          <button
            onClick={handleFormClose}
            className="text-[#D4AF37]/60 hover:text-[#D4AF37] text-sm mb-4 transition-colors"
            data-testid="button-back-list"
          >
            &larr; Back to list
          </button>
          <CertificateForm
            certificate={editingCert}
            onSuccess={handleFormClose}
          />
          {editingCert && editingCert.id && (
            <div className="mt-6 space-y-6">
              <OwnershipSection cert={editingCert} />
              <NfcSection
                cert={editingCert}
                onUpdated={(updated) => setEditingCert(updated)}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black">
      <AdminHeader onLogout={handleLogout} activeTab={activeTab} onTabChange={setActiveTab} />

      {activeTab === "dashboard" && (
        <DashboardView stats={stats} onNewCert={handleNewCert} onGoToCerts={handleGoToCerts} onTabChange={setActiveTab} />
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
      {activeTab === "printing" && <AdminPrinting />}

      {previewCert && (
        <LabelPreviewModal
          cert={previewCert}
          onClose={() => setPreviewCert(null)}
        />
      )}

      {voidTarget && (
        <VoidConfirmationModal
          cert={voidTarget}
          isPending={voidMutation.isPending}
          onConfirm={(reason) => voidMutation.mutate({ id: voidTarget.id, reason })}
          onCancel={() => setVoidTarget(null)}
        />
      )}
    </div>
  );
}

function AdminHeader({
  onLogout,
  activeTab,
  onTabChange,
}: {
  onLogout: () => void;
  activeTab: "dashboard" | "certs" | "submissions" | "intake" | "pricing" | "printing";
  onTabChange: (t: "dashboard" | "certs" | "submissions" | "intake" | "pricing" | "printing") => void;
}) {
  const { data: dbInfo } = useQuery<DbInfo>({
    queryKey: ["/api/admin/db-info"],
    refetchInterval: 60000,
  });

  const isProd = dbInfo?.env === "production";
  const shortHost = dbInfo?.neon_host
    ? dbInfo.neon_host.split(".")[0].slice(0, 12)
    : "...";

  return (
    <header className="border-b border-[#D4AF37]/20 bg-black/95 px-4 py-3">
      <div className="max-w-5xl mx-auto flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <span className="text-[#D4AF37] font-bold tracking-widest text-sm">MINTVAULT</span>
              <span className="text-[#D4AF37]/30 text-xs">ADMIN</span>
            </div>
            <nav className="flex gap-1">
              <button
                onClick={() => onTabChange("dashboard")}
                className={`text-xs px-3 py-1.5 rounded transition-colors flex items-center gap-1.5 ${
                  activeTab === "dashboard"
                    ? "bg-[#D4AF37]/20 text-[#D4AF37]"
                    : "text-[#D4AF37]/50 hover:text-[#D4AF37]"
                }`}
                data-testid="tab-dashboard"
              >
                <LayoutDashboard size={12} /> Overview
              </button>
              <button
                onClick={() => onTabChange("certs")}
                className={`text-xs px-3 py-1.5 rounded transition-colors flex items-center gap-1.5 ${
                  activeTab === "certs"
                    ? "bg-[#D4AF37]/20 text-[#D4AF37]"
                    : "text-[#D4AF37]/50 hover:text-[#D4AF37]"
                }`}
                data-testid="tab-certs"
              >
                <List size={12} /> Certificates
              </button>
              <button
                onClick={() => onTabChange("submissions")}
                className={`text-xs px-3 py-1.5 rounded transition-colors flex items-center gap-1.5 ${
                  activeTab === "submissions"
                    ? "bg-[#D4AF37]/20 text-[#D4AF37]"
                    : "text-[#D4AF37]/50 hover:text-[#D4AF37]"
                }`}
                data-testid="tab-submissions"
              >
                <Package size={12} /> Submissions
              </button>
              <button
                onClick={() => onTabChange("intake")}
                className={`text-xs px-3 py-1.5 rounded transition-colors flex items-center gap-1.5 ${
                  activeTab === "intake"
                    ? "bg-[#D4AF37]/20 text-[#D4AF37]"
                    : "text-[#D4AF37]/50 hover:text-[#D4AF37]"
                }`}
                data-testid="tab-intake"
              >
                <ScanLine size={12} /> Intake
              </button>
              <button
                onClick={() => onTabChange("pricing")}
                className={`text-xs px-3 py-1.5 rounded transition-colors flex items-center gap-1.5 ${
                  activeTab === "pricing"
                    ? "bg-[#D4AF37]/20 text-[#D4AF37]"
                    : "text-[#D4AF37]/50 hover:text-[#D4AF37]"
                }`}
                data-testid="tab-pricing"
              >
                <DollarSign size={12} /> Pricing
              </button>
              <button
                onClick={() => onTabChange("printing")}
                className={`text-xs px-3 py-1.5 rounded transition-colors flex items-center gap-1.5 ${
                  activeTab === "printing"
                    ? "bg-[#D4AF37]/20 text-[#D4AF37]"
                    : "text-[#D4AF37]/50 hover:text-[#D4AF37]"
                }`}
                data-testid="tab-printing"
              >
                <Printer size={12} /> Printing
              </button>
            </nav>
          </div>
          <button
            onClick={onLogout}
            className="text-[#D4AF37]/50 hover:text-[#D4AF37] text-sm flex items-center gap-1.5 transition-colors"
            data-testid="button-logout"
          >
            <LogOut size={14} /> Logout
          </button>
        </div>
        {dbInfo && (
          <div className="flex items-center gap-3 text-[10px] font-mono" data-testid="env-banner">
            <span
              className={`px-2 py-0.5 rounded font-bold tracking-wider uppercase ${
                isProd
                  ? "bg-green-600/20 text-green-400 border border-green-600/40"
                  : "bg-orange-600/20 text-orange-400 border border-orange-600/40"
              }`}
              data-testid="badge-env"
            >
              <Shield size={10} className="inline mr-1 -mt-px" />
              ENV: {dbInfo.env}
            </span>
            <span className="text-gray-500 flex items-center gap-1" data-testid="badge-db">
              <Database size={10} />
              DB: {shortHost}/{dbInfo.db_name}
            </span>
            <span className="text-gray-600" data-testid="text-db-counts">
              CM:{dbInfo.card_master_active_count} · CS:{dbInfo.card_sets_active_count} · Certs:{dbInfo.certificates_count}
            </span>
          </div>
        )}
      </div>
    </header>
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
  onTabChange: (t: "dashboard" | "certs" | "submissions" | "intake" | "pricing" | "printing") => void;
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

  const handleCertSearch = () => {
    if (certSearch.trim()) {
      window.open(`/cert/${certSearch.trim().toUpperCase()}`, "_blank");
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold text-[#D4AF37] tracking-widest mb-6" data-testid="text-dashboard-title">
        DASHBOARD
      </h1>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        <StatTile label="Total Certificates" value={stats?.totalCerts ?? 0} icon={<FileText size={20} />} testId="stat-total"
          onClick={() => onGoToCerts({})} />
        <StatTile label="Graded This Week" value={stats?.thisWeek ?? 0} icon={<Clock size={20} />} testId="stat-week"
          onClick={() => onGoToCerts({ range: "week" })} />
        <StatTile label="Graded This Month" value={stats?.thisMonth ?? 0} icon={<BarChart3 size={20} />} testId="stat-month"
          onClick={() => onGoToCerts({ range: "month" })} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
        <StatTile label="Card Master Active" value={dbInfo?.card_master_active_count ?? 0} icon={<Database size={20} />} testId="stat-cm-active" />
        <StatTile label="Card Sets Active" value={dbInfo?.card_sets_active_count ?? 0} icon={<Database size={20} />} testId="stat-cs-active" />
        <StatTile label="Last Issued MV Number" value={dbInfo?.last_issued_mv ?? "..."} icon={<FileText size={20} />} testId="stat-last-mv"
          onClick={dbInfo?.last_issued_mv ? () => window.open(`/cert/${dbInfo.last_issued_mv}`, "_blank") : undefined} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <StatTile label="Active Certificates" value={dbInfo?.certificates_count ?? 0} icon={<Shield size={20} />} testId="stat-cert-count"
          onClick={() => onGoToCerts({ status: "active" })} />
        <StatTile label="Voided Certificates" value={dbInfo?.voided_count ?? 0} icon={<Ban size={20} />} testId="stat-voided"
          onClick={() => onGoToCerts({ status: "voided" })} />
        <StatTile label="Authentic Only" value={stats?.authenticOnlyCount ?? 0} icon={<Tag size={20} />} testId="stat-auth-only"
          onClick={() => onGoToCerts({ gradeType: "authentic" })} />
      </div>

      <div className="flex flex-wrap gap-3 mb-8">
        <button
          onClick={onNewCert}
          className="border border-[#D4AF37] bg-[#D4AF37]/10 text-[#D4AF37] px-4 py-2 rounded font-medium tracking-wide text-sm transition-all btn-gold-glow hover:bg-[#D4AF37]/20 flex items-center gap-2"
          data-testid="button-quick-new-cert"
        >
          <Plus size={16} /> Create New Cert
        </button>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={certSearch}
            onChange={(e) => setCertSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCertSearch()}
            placeholder="Search Cert ID..."
            className="bg-transparent border border-[#D4AF37]/30 rounded px-3 py-2 text-white text-sm placeholder:text-[#D4AF37]/30 focus:outline-none focus:border-[#D4AF37] transition-colors w-48"
            data-testid="input-quick-search"
          />
          <button
            onClick={handleCertSearch}
            className="border border-[#D4AF37]/30 text-[#D4AF37]/60 hover:text-[#D4AF37] px-3 py-2 rounded transition-colors"
            data-testid="button-quick-search"
          >
            <Search size={14} />
          </button>
        </div>
        <a
          href="/api/admin/certificates/export-csv"
          className="border border-[#D4AF37]/30 text-[#D4AF37]/60 hover:text-[#D4AF37] px-4 py-2 rounded text-sm flex items-center gap-2 transition-colors"
          data-testid="button-export-csv"
        >
          <FileDown size={14} /> Export CSV
        </a>
        <a
          href="/api/admin/ownership-export"
          className="border border-[#D4AF37]/30 text-[#D4AF37]/60 hover:text-[#D4AF37] px-4 py-2 rounded text-sm flex items-center gap-2 transition-colors"
          data-testid="button-export-ownership-csv"
        >
          <Shield size={14} /> Ownership CSV
        </a>
        <button
          onClick={() => backfillClaimMutation.mutate()}
          disabled={backfillClaimMutation.isPending}
          className="border border-[#D4AF37]/30 text-[#D4AF37]/60 hover:text-[#D4AF37] px-4 py-2 rounded text-sm flex items-center gap-2 transition-colors disabled:opacity-50"
          data-testid="button-backfill-claim-codes"
        >
          {backfillClaimMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Shield size={14} />}
          Backfill Claim Codes
        </button>
      </div>
      {backfillStatus && (
        <p className="text-xs text-[#D4AF37]/80 -mt-6 mb-6" data-testid="text-backfill-status">{backfillStatus}</p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        <div className="border border-[#D4AF37]/20 rounded-lg p-5">
          <h3 className="text-[#D4AF37] font-bold tracking-widest text-xs mb-4 uppercase" data-testid="text-grade-dist-title">Grade Distribution</h3>
          {stats?.gradeDistribution ? (
            <GradeChart
              data={stats.gradeDistribution}
              onGradeClick={(g) => onGoToCerts({ grade: g })}
            />
          ) : (
            <div className="h-40 flex items-center justify-center text-gray-600 text-sm">No data</div>
          )}
        </div>

        <div className="border border-[#D4AF37]/20 rounded-lg p-5">
          <h3 className="text-[#D4AF37] font-bold tracking-widest text-xs mb-4 uppercase" data-testid="text-grade-type-title">By Grade Type</h3>
          <div className="space-y-1 mb-5">
            {[
              {
                label: "Numeric (1–10)",
                count: (stats?.totalCerts ?? 0) - (stats?.authenticOnlyCount ?? 0) - (stats?.authenticAlteredCount ?? 0),
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
            ].map(({ label, count, filter, testId }) => (
              <div
                key={testId}
                onClick={() => onGoToCerts(filter)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && onGoToCerts(filter)}
                className="flex items-center justify-between px-3 py-2 rounded cursor-pointer
                  hover:bg-[#D4AF37]/8 hover:border hover:border-[#D4AF37]/20 border border-transparent
                  active:scale-[0.98] active:bg-[#D4AF37]/12 transition-all select-none group"
                data-testid={testId}
              >
                <div className="flex items-center gap-2">
                  <Tag size={14} className="text-[#D4AF37]/50 group-hover:text-[#D4AF37]/80 transition-colors" />
                  <span className="text-white text-sm group-hover:text-[#D4AF37]/90 transition-colors">{label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[#D4AF37] font-bold text-sm">{count}</span>
                  <ArrowRight size={12} className="text-[#D4AF37]/20 group-hover:text-[#D4AF37]/50 transition-colors" />
                </div>
              </div>
            ))}
          </div>

        </div>
      </div>

      <div className="border border-[#D4AF37]/20 rounded-lg p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[#D4AF37] font-bold tracking-widest text-xs uppercase" data-testid="text-recent-title">Recent Activity</h3>
          <button
            onClick={() => onGoToCerts({})}
            className="text-[#D4AF37]/50 hover:text-[#D4AF37] text-xs transition-colors flex items-center gap-1"
            data-testid="button-view-all"
          >
            View All Certificates <ArrowRight size={11} />
          </button>
        </div>
        {stats?.recentCerts && stats.recentCerts.length > 0 ? (
          <div className="space-y-0">
            {stats.recentCerts.map((cert) => {
              const gt = (cert as any).gradeType || "numeric";
              const isNN = isNonNumericGrade(gt);
              const grade = isNN ? 0 : parseFloat(cert.gradeOverall || "0");
              const gradeDisplay = isNN ? gradeLabelFull(gt, cert.gradeOverall || "0") : String(grade);
              return (
                <RecentCertRow
                  key={cert.id}
                  cert={cert}
                  gradeDisplay={gradeDisplay}
                />
              );
            })}
          </div>
        ) : (
          <p className="text-gray-600 text-sm text-center py-8">No certificates yet</p>
        )}
      </div>
    </div>
  );
}

function RecentCertRow({
  cert,
  gradeDisplay,
}: {
  cert: CertificateRecord;
  gradeDisplay: string;
}) {
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

  return (
    <div
      onClick={handleOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && handleOpen()}
      className="flex items-center justify-between py-2.5 px-2 -mx-2 rounded border border-transparent
        cursor-pointer hover:bg-[#D4AF37]/5 hover:border-[#D4AF37]/15 active:scale-[0.99] active:bg-[#D4AF37]/8
        border-b border-b-[#D4AF37]/5 last:border-b-0 transition-all select-none group"
      data-testid={`recent-cert-${cert.id}`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[#D4AF37] font-mono text-xs font-bold">{cert.certId}</span>
          <button
            onClick={handleCopy}
            title="Copy cert ID"
            className="opacity-0 group-hover:opacity-100 transition-opacity text-[#D4AF37]/40 hover:text-[#D4AF37] p-0.5 rounded"
            data-testid={`button-copy-certid-${cert.id}`}
          >
            {copied
              ? <Check size={11} className="text-emerald-400" />
              : <Copy size={11} />}
          </button>
        </div>
        <span className="text-white text-sm truncate">{cert.cardName}</span>
        <span className="text-[#D4AF37]/40 text-xs shrink-0 hidden sm:inline">{cert.setName}</span>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="text-white font-bold text-sm">{gradeDisplay}</span>
        <span className={`text-xs px-1.5 py-0.5 rounded ${
          cert.status === "active" || cert.status === "published"
            ? "bg-emerald-500/20 text-emerald-400"
            : cert.status === "voided"
            ? "bg-red-500/20 text-red-400"
            : "bg-gray-500/20 text-gray-400"
        }`}>{cert.status}</span>
        <span className="text-gray-600 text-xs hidden sm:inline">
          {cert.createdAt ? new Date(cert.createdAt).toLocaleDateString("en-GB") : ""}
        </span>
        <ArrowRight size={12} className="text-[#D4AF37]/15 group-hover:text-[#D4AF37]/40 transition-colors" />
      </div>
    </div>
  );
}

function StatTile({
  label, value, icon, testId, onClick,
}: {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  testId: string;
  onClick?: () => void;
}) {
  const isString = typeof value === "string";
  const clickable = !!onClick;
  return (
    <div
      onClick={onClick}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => e.key === "Enter" && onClick?.() : undefined}
      className={`border border-[#D4AF37]/20 rounded-lg p-5 flex items-center gap-4 relative transition-all select-none
        ${clickable
          ? "cursor-pointer hover:border-[#D4AF37]/50 hover:bg-[#D4AF37]/5 hover:shadow-[0_0_14px_rgba(212,175,55,0.12)] active:scale-[0.98] active:bg-[#D4AF37]/10"
          : ""}`}
      data-testid={testId}
    >
      <div className="w-10 h-10 rounded-full border border-[#D4AF37]/30 flex items-center justify-center text-[#D4AF37]/60 shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className={`font-bold text-[#D4AF37] ${isString ? "text-sm font-mono tracking-wide" : "text-3xl"}`}>{value}</p>
        <p className="text-gray-500 text-xs uppercase tracking-wider">{label}</p>
      </div>
      {clickable && (
        <ArrowRight size={13} className="text-[#D4AF37]/25 shrink-0" aria-hidden />
      )}
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
  const maxCount = Math.max(...data.map(d => d.count), 1);

  return (
    <div className="flex items-end gap-2 h-40" data-testid="chart-grade-distribution">
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
            className={`flex-1 flex flex-col items-center gap-1 h-full justify-end group select-none
              ${clickable ? "cursor-pointer" : ""}`}
          >
            <span className="text-[#D4AF37] text-xs font-bold">{d.count > 0 ? d.count : ""}</span>
            <div
              className={`w-full rounded-t transition-all
                ${clickable
                  ? "bg-[#D4AF37]/30 group-hover:bg-[#D4AF37]/60 group-active:bg-[#D4AF37]/80 group-hover:shadow-[0_0_8px_rgba(212,175,55,0.25)]"
                  : "bg-[#D4AF37]/15"}`}
              style={{ height: `${Math.max((d.count / maxCount) * 100, d.count > 0 ? 8 : 2)}%` }}
            />
            <span className={`text-xs transition-colors ${clickable ? "text-gray-500 group-hover:text-[#D4AF37]" : "text-gray-600"}`}>
              {d.grade}
            </span>
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
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "voided">(
    initialFilter.status ?? "all"
  );
  const [gradeTypeFilter, setGradeTypeFilter] = useState<"all" | "numeric" | "authentic" | "altered">(
    initialFilter.gradeType ?? "all"
  );
  const [gradeFilter, setGradeFilter] = useState(
    initialFilter.grade !== undefined ? String(initialFilter.grade) : ""
  );
  const [dateFrom, setDateFrom] = useState(() => getInitialDateFrom(initialFilter.range));
  const [dateTo, setDateTo] = useState("");
  const [ownershipFilter, setOwnershipFilter] = useState<"all" | "claimed" | "unclaimed">("all");

  const filtered = certs.filter((c) => {
    if (statusFilter === "voided" && c.status !== "voided") return false;
    if (statusFilter === "active" && c.status === "voided") return false;
    if (gradeTypeFilter !== "all") {
      const gt: string = (c as any).gradeType || "numeric";
      if (gradeTypeFilter === "authentic" && gt !== "NO") return false;
      if (gradeTypeFilter === "altered"   && gt !== "AA") return false;
      if (gradeTypeFilter === "numeric"   && isNonNumericGrade(gt)) return false;
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
    return true;
  });

  const voidedCount = certs.filter((c) => c.status === "voided").length;
  const claimedCount = certs.filter((c) => (c as any).ownershipStatus === "claimed").length;
  const hasActiveFilters = statusFilter !== "all" || gradeTypeFilter !== "all" || gradeFilter || dateFrom || dateTo || searchQuery || ownershipFilter !== "all";

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#D4AF37] tracking-widest" data-testid="text-certs-title">
            CERTIFICATES
          </h1>
          <p className="text-gray-500 text-sm">{totalCount} total records{voidedCount > 0 ? ` · ${voidedCount} voided` : ""}{hasActiveFilters ? " (filtered)" : ""}</p>
        </div>
        <button
          onClick={onNewCert}
          className="border border-[#D4AF37] bg-[#D4AF37]/10 text-[#D4AF37] px-4 py-2 rounded font-medium tracking-wide text-sm transition-all btn-gold-glow hover:bg-[#D4AF37]/20 flex items-center gap-2"
          data-testid="button-new-cert"
        >
          <Plus size={16} /> New Certificate
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[#D4AF37]/40" size={16} />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search cert ID, card name, set..."
            className="w-full bg-transparent border border-[#D4AF37]/30 rounded px-4 py-2 pl-9 text-white text-sm placeholder:text-[#D4AF37]/30 focus:outline-none focus:border-[#D4AF37] transition-colors"
            data-testid="input-search-certs"
          />
        </div>
        <div className="flex gap-1 flex-wrap">
          {(["all", "active", "voided"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={`text-xs px-3 py-1.5 rounded border transition-colors capitalize ${
                statusFilter === f
                  ? f === "voided"
                    ? "bg-red-500/20 text-red-400 border-red-500/40"
                    : "bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37]/40"
                  : "text-gray-500 border-gray-700 hover:text-gray-300"
              }`}
              data-testid={`filter-${f}`}
            >
              {f}{f === "voided" && voidedCount > 0 ? ` (${voidedCount})` : ""}
            </button>
          ))}
          {(["numeric", "authentic", "altered"] as const).map((gt) => (
            <button
              key={gt}
              onClick={() => setGradeTypeFilter(gradeTypeFilter === gt ? "all" : gt)}
              className={`text-xs px-3 py-1.5 rounded border transition-colors capitalize ${
                gradeTypeFilter === gt
                  ? "bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37]/40"
                  : "text-gray-500 border-gray-700 hover:text-gray-300"
              }`}
              data-testid={`filter-gradetype-${gt}`}
            >
              {gt === "numeric" ? "Numeric" : gt === "authentic" ? "Auth Only" : "Altered"}
            </button>
          ))}
          <div className="w-px h-5 bg-[#D4AF37]/10" />
          {(["all", "claimed", "unclaimed"] as const).map((o) => (
            <button
              key={o}
              onClick={() => setOwnershipFilter(o)}
              className={`text-xs px-3 py-1.5 rounded border transition-colors flex items-center gap-1 ${
                ownershipFilter === o
                  ? o === "claimed"
                    ? "bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37]/40"
                    : o === "unclaimed"
                    ? "bg-gray-700 text-gray-300 border-gray-600"
                    : "bg-[#D4AF37]/20 text-[#D4AF37] border-[#D4AF37]/40"
                  : "text-gray-500 border-gray-700 hover:text-gray-300"
              }`}
              data-testid={`filter-ownership-${o}`}
            >
              {o === "claimed" && <Shield size={9} />}
              {o === "claimed" ? `Claimed (${claimedCount})` : o === "unclaimed" ? "Unclaimed" : "All Ownership"}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex items-center gap-2">
          <label className="text-gray-500 text-xs">Grade:</label>
          <select
            value={gradeFilter}
            onChange={(e) => setGradeFilter(e.target.value)}
            className="bg-transparent border border-[#D4AF37]/30 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-[#D4AF37] transition-colors"
            data-testid="select-grade-filter"
          >
            <option value="" className="bg-black">All grades</option>
            {[10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((g) => (
              <option key={g} value={String(g)} className="bg-black">{g}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-gray-500 text-xs">From:</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="bg-transparent border border-[#D4AF37]/30 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-[#D4AF37] transition-colors"
            data-testid="input-date-from-certs"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-gray-500 text-xs">To:</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="bg-transparent border border-[#D4AF37]/30 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-[#D4AF37] transition-colors"
            data-testid="input-date-to-certs"
          />
        </div>
        {hasActiveFilters && (
          <button
            onClick={() => { setStatusFilter("all"); setGradeTypeFilter("all"); setGradeFilter(""); setDateFrom(""); setDateTo(""); setSearchQuery(""); setOwnershipFilter("all"); }}
            className="text-xs text-gray-500 hover:text-[#D4AF37] flex items-center gap-1 transition-colors"
            data-testid="button-clear-filters-certs"
          >
            <X size={12} /> Clear filters
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="animate-pulse space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 bg-[#D4AF37]/5 rounded" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 border border-[#D4AF37]/10 rounded-lg">
          <FileText className="mx-auto text-[#D4AF37]/20 mb-3" size={40} />
          <p className="text-gray-500">
            {searchQuery ? "No matching certificates" : statusFilter === "voided" ? "No voided certificates" : "No certificates yet"}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
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
    </div>
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
  const label = gradeLabelFull(gradeType, cert.gradeOverall || "0");

  return (
    <div
      className="border border-[#D4AF37]/15 rounded-lg p-4 flex flex-col gap-3"
      data-testid={`cert-row-${cert.id}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-4 min-w-0 flex-1">
          {(cert as any).frontImageUrl || cert.frontImagePath ? (
            <img
              src={(cert as any).frontImageUrl || cert.frontImagePath}
              alt={cert.cardName}
              className="w-10 h-14 object-cover rounded border border-[#D4AF37]/20"
            />
          ) : (
            <div className="w-10 h-14 rounded border border-[#D4AF37]/10 flex items-center justify-center">
              <Image size={14} className="text-[#D4AF37]/20" />
            </div>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[#D4AF37] font-mono text-xs font-bold" data-testid={`text-cert-id-${cert.id}`}>
                {cert.certId}
              </span>
              <span className={`text-xs px-1.5 py-0.5 rounded ${
                cert.status === "active" || cert.status === "published"
                  ? "bg-emerald-500/20 text-emerald-400"
                  : cert.status === "voided"
                  ? "bg-red-500/20 text-red-400"
                  : "bg-gray-500/20 text-gray-400"
              }`}>
                {cert.status === "active" || cert.status === "published" ? <Eye size={10} className="inline mr-0.5" /> : <EyeOff size={10} className="inline mr-0.5" />}
                {cert.status}
              </span>
              {(cert as any).ownershipStatus === "claimed" ? (
                <span className="text-xs px-1.5 py-0.5 rounded bg-[#D4AF37]/20 text-[#D4AF37] flex items-center gap-0.5" data-testid={`badge-owned-${cert.id}`}>
                  <Shield size={9} className="inline" /> claimed
                </span>
              ) : (
                <span className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-600" data-testid={`badge-unclaimed-${cert.id}`}>
                  unclaimed
                </span>
              )}
              <span className="text-white font-bold text-sm">{isNonNum ? label : `${grade} ${label}`}</span>
            </div>
            <p className="text-white text-sm font-medium truncate" data-testid={`text-cert-name-${cert.id}`}>
              {cert.cardName}
            </p>
            <p className="text-gray-500 text-xs truncate">
              {cert.cardGame} · {cert.setName} · {cert.cardNumber}
              {cert.variant ? ` · ${cert.variant}` : ""}
              
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={onEdit}
            className="text-[#D4AF37]/50 hover:text-[#D4AF37] p-1.5 border border-[#D4AF37]/20 rounded transition-colors"
            title="Edit"
            data-testid={`button-edit-${cert.id}`}
          >
            <Edit size={12} />
          </button>
          {cert.status !== "voided" && (
            <button
              onClick={onVoid}
              className="text-orange-400/50 hover:text-orange-400 p-1.5 border border-orange-400/20 rounded transition-colors"
              title="Void certificate"
              data-testid={`button-void-${cert.id}`}
            >
              <Ban size={12} />
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-[#D4AF37]/10 pt-3">
        <span className="text-[#D4AF37]/40 text-xs uppercase tracking-wider mr-1">Labels:</span>

        <button
          onClick={onPreview}
          className="text-xs text-[#D4AF37]/60 hover:text-[#D4AF37] border border-[#D4AF37]/20 hover:border-[#D4AF37]/40 rounded px-2 py-1 flex items-center gap-1 transition-colors"
          data-testid={`button-preview-${cert.id}`}
        >
          <Eye size={10} /> Preview
        </button>

        <span className="text-[#D4AF37]/20">|</span>

        <a
          href={`/api/admin/certificates/${cert.id}/label/front?format=pdf`}
          className="text-xs text-[#D4AF37]/60 hover:text-[#D4AF37] border border-[#D4AF37]/20 hover:border-[#D4AF37]/40 rounded px-2 py-1 flex items-center gap-1 transition-colors"
          data-testid={`button-dl-front-pdf-${cert.id}`}
        >
          <Download size={10} /> Front PDF
        </a>
        <a
          href={`/api/admin/certificates/${cert.id}/label/front?format=png`}
          className="text-xs text-[#D4AF37]/60 hover:text-[#D4AF37] border border-[#D4AF37]/20 hover:border-[#D4AF37]/40 rounded px-2 py-1 flex items-center gap-1 transition-colors"
          data-testid={`button-dl-front-png-${cert.id}`}
        >
          <Download size={10} /> Front PNG
        </a>

        <span className="text-[#D4AF37]/20">|</span>

        <a
          href={`/api/admin/certificates/${cert.id}/label/back?format=pdf`}
          className="text-xs text-[#D4AF37]/60 hover:text-[#D4AF37] border border-[#D4AF37]/20 hover:border-[#D4AF37]/40 rounded px-2 py-1 flex items-center gap-1 transition-colors"
          data-testid={`button-dl-back-pdf-${cert.id}`}
        >
          <Download size={10} /> Back PDF
        </a>
        <a
          href={`/api/admin/certificates/${cert.id}/label/back?format=png`}
          className="text-xs text-[#D4AF37]/60 hover:text-[#D4AF37] border border-[#D4AF37]/20 hover:border-[#D4AF37]/40 rounded px-2 py-1 flex items-center gap-1 transition-colors"
          data-testid={`button-dl-back-png-${cert.id}`}
        >
          <Download size={10} /> Back PNG
        </a>

        <span className="text-[#D4AF37]/20">|</span>

        <a
          href={`/api/admin/certificates/${cert.id}/label/both?format=pdf`}
          className="text-xs text-[#D4AF37]/60 hover:text-[#D4AF37] border border-[#D4AF37]/20 hover:border-[#D4AF37]/40 rounded px-2 py-1 flex items-center gap-1 transition-colors"
          data-testid={`button-dl-both-pdf-${cert.id}`}
        >
          <Printer size={10} /> Both PDF
        </a>
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
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4" data-testid="modal-void">
      <div className="bg-gray-950 border border-red-500/30 rounded-lg max-w-md w-full p-6">
        <div className="flex items-center gap-3 mb-4">
          <AlertTriangle className="text-red-400 shrink-0" size={24} />
          <h3 className="text-red-400 font-bold tracking-wider text-sm uppercase">Void Certificate</h3>
        </div>
        <p className="text-gray-300 text-sm mb-2">
          You are about to void certificate <span className="text-white font-mono font-bold">{cert.certId}</span>.
        </p>
        <p className="text-gray-400 text-xs mb-4">
          This action is permanent. The certificate will be marked as VOIDED and will display as voided on the public lookup page. The certificate ID will be preserved.
        </p>

        <div className="mb-3">
          <label className="text-gray-400 text-xs block mb-1">Reason (optional)</label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Issued in error, duplicate entry..."
            className="w-full bg-transparent border border-gray-700 rounded px-3 py-2 text-white text-sm placeholder:text-gray-600 focus:outline-none focus:border-red-500/50 transition-colors"
            data-testid="input-void-reason"
          />
        </div>

        <div className="mb-5">
          <label className="text-gray-400 text-xs block mb-1">
            Type <span className="text-red-400 font-bold">VOID</span> to confirm
          </label>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value.toUpperCase())}
            placeholder="VOID"
            className="w-full bg-transparent border border-gray-700 rounded px-3 py-2 text-white text-sm placeholder:text-gray-600 focus:outline-none focus:border-red-500/50 transition-colors font-mono tracking-wider"
            data-testid="input-void-confirm"
          />
        </div>

        <div className="flex items-center gap-3 justify-end">
          <button
            onClick={onCancel}
            className="text-gray-400 hover:text-white text-sm px-4 py-2 rounded border border-gray-700 hover:border-gray-500 transition-colors"
            data-testid="button-void-cancel"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(reason)}
            disabled={typed !== "VOID" || isPending}
            className="bg-red-600 hover:bg-red-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm px-4 py-2 rounded font-medium tracking-wide transition-colors flex items-center gap-2"
            data-testid="button-void-submit"
          >
            <Ban size={14} />
            {isPending ? "Voiding..." : "Void Certificate"}
          </button>
        </div>
      </div>
    </div>
  );
}

function LabelPreviewModal({
  cert,
  onClose,
}: {
  cert: CertificateRecord;
  onClose: () => void;
}) {
  const ts = Date.now();

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-gray-950 border border-[#D4AF37]/30 rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-[#D4AF37]/20">
          <div>
            <h3 className="text-[#D4AF37] font-bold tracking-widest text-sm" data-testid="text-preview-title">
              LABEL PREVIEW
            </h3>
            <p className="text-gray-500 text-xs mt-0.5">{cert.certId} · {cert.cardName}</p>
          </div>
          <button
            onClick={onClose}
            className="text-[#D4AF37]/50 hover:text-[#D4AF37] transition-colors"
            data-testid="button-close-preview"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-6">
          <div>
            <p className="text-[#D4AF37]/60 text-xs uppercase tracking-wider mb-2">Front Label (70mm x 20mm)</p>
            <div className="bg-gray-900 rounded-lg p-3 flex items-center justify-center">
              <img
                src={`/api/admin/certificates/${cert.id}/label/front?format=png&preview=1&t=${ts}`}
                alt="Front label preview"
                className="max-w-full h-auto border border-[#D4AF37]/20 rounded"
                style={{ imageRendering: "auto" }}
                data-testid="img-preview-front"
              />
            </div>
          </div>

          <div>
            <p className="text-[#D4AF37]/60 text-xs uppercase tracking-wider mb-2">Back Label (70mm x 20mm)</p>
            <div className="bg-gray-900 rounded-lg p-3 flex items-center justify-center">
              <img
                src={`/api/admin/certificates/${cert.id}/label/back?format=png&preview=1&t=${ts}`}
                alt="Back label preview"
                className="max-w-full h-auto border border-[#D4AF37]/20 rounded"
                style={{ imageRendering: "auto" }}
                data-testid="img-preview-back"
              />
            </div>
          </div>

          <div className="border-t border-[#D4AF37]/10 pt-4">
            <p className="text-gray-600 text-xs mb-3">Print specs: 827 x 236px at 300 DPI = 70mm x 20mm exact</p>
            <div className="flex flex-wrap gap-2">
              <a
                href={`/api/admin/certificates/${cert.id}/label/front?format=pdf`}
                className="text-xs text-[#D4AF37] border border-[#D4AF37]/30 rounded px-3 py-1.5 flex items-center gap-1.5 hover:bg-[#D4AF37]/10 transition-colors"
                data-testid="button-modal-dl-front-pdf"
              >
                <Download size={11} /> Front PDF
              </a>
              <a
                href={`/api/admin/certificates/${cert.id}/label/front?format=png`}
                className="text-xs text-[#D4AF37] border border-[#D4AF37]/30 rounded px-3 py-1.5 flex items-center gap-1.5 hover:bg-[#D4AF37]/10 transition-colors"
                data-testid="button-modal-dl-front-png"
              >
                <Download size={11} /> Front PNG
              </a>
              <a
                href={`/api/admin/certificates/${cert.id}/label/back?format=pdf`}
                className="text-xs text-[#D4AF37] border border-[#D4AF37]/30 rounded px-3 py-1.5 flex items-center gap-1.5 hover:bg-[#D4AF37]/10 transition-colors"
                data-testid="button-modal-dl-back-pdf"
              >
                <Download size={11} /> Back PDF
              </a>
              <a
                href={`/api/admin/certificates/${cert.id}/label/back?format=png`}
                className="text-xs text-[#D4AF37] border border-[#D4AF37]/30 rounded px-3 py-1.5 flex items-center gap-1.5 hover:bg-[#D4AF37]/10 transition-colors"
                data-testid="button-modal-dl-back-png"
              >
                <Download size={11} /> Back PNG
              </a>
              <a
                href={`/api/admin/certificates/${cert.id}/label/both?format=pdf`}
                className="text-xs text-[#D4AF37] border border-[#D4AF37]/30 rounded px-3 py-1.5 flex items-center gap-1.5 hover:bg-[#D4AF37]/10 transition-colors"
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
