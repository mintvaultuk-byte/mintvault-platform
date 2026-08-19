/**
 * GB-04 Growth Command — a Super Admin-only, aggregate-first commercial view.
 *
 * It deliberately has no customer/order drill-down. Partner application details are
 * shown only to progress an explicit applicant through the limited pre-onboarding
 * state machine; no action here provisions a Partner tenant or credits.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Copy, ExternalLink, RefreshCw } from "lucide-react";
import { AdminButton, AdminShell, Badge, Panel, StatCard, adminButtonClass } from "@/components/admin";
import { apiRequest, queryClient } from "@/lib/queryClient";

const BASE = "/api/super-admin/growth";
const PERIODS = ["today", "7d", "30d", "90d", "all"] as const;
const LEAD_STATES = ["NEW", "CONTACTED", "QUALIFIED", "NOT_A_FIT", "ONBOARDING"] as const;

type Period = (typeof PERIODS)[number];
type LeadState = (typeof LEAD_STATES)[number];
type Measured = { state: "MEASURED"; value: number };
type NotInstrumented = { state: "NOT_INSTRUMENTED"; reason: string };
type Metric = Measured | NotInstrumented;
type Performance = {
  category: string;
  paidSubmissions: number;
  paidCards: number;
  revenuePence: number;
  partnerApplications: number;
};
type CampaignPerformance = Performance & { campaign: string };
type Summary = {
  period: Period;
  timezone: string;
  paid: {
    paidSubmissions: Measured;
    paidCards: Measured;
    revenuePence: Measured;
    averageCardsPerPaidOrder: Measured;
    unattributedPaidSubmissions: Measured;
  };
  sourcePerformance: Performance[];
  campaignPerformance: CampaignPerformance[];
  partnerApplications: Record<"total" | "new" | "contacted" | "qualified" | "notAFit" | "onboarding", Measured>;
  activePartners: Metric;
  partnerCardsPerPartner: NotInstrumented;
  partnerRevenue: NotInstrumented;
  repeatCustomerRate: NotInstrumented;
  historical: NotInstrumented;
};
type Lead = {
  id: string;
  businessName: string;
  city: string;
  postcode: string;
  businessType: string;
  webPresence: string | null;
  status: LeadState;
  source: string;
  campaign: string;
  createdAt: string;
};
type LeadDetail = Lead & {
  contactName: string;
  email: string;
  phone: string | null;
  interestReason: string;
  physicalRetail: boolean | null;
  categories: string[];
  demandBand: string | null;
  existingGradingSubmissions: string | null;
};
type LinkOptions = {
  targets: Array<{ value: "partner" | "collector"; label: string; path: string }>;
  sources: string[];
  mediums: string[];
  campaigns: string[];
  contents: string[];
};
type AdminSession = { authenticated: boolean; isSuperAdmin?: boolean };

function formatMoney(pence: number): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-GB").format(value);
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown date" : new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}

function leadBadgeVariant(status: LeadState): "act" | "neu" | "prog" | "wait" | "red" {
  if (status === "NEW") return "neu";
  if (status === "CONTACTED") return "wait";
  if (status === "QUALIFIED") return "prog";
  if (status === "ONBOARDING") return "act";
  return "red";
}

export function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function copyTrackedLink(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // The fallback below is for a restricted clipboard context, not a silent success.
  }
  if (typeof document === "undefined") return false;
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  return copied;
}

function MetricText({ metric, money = false }: { metric: Metric; money?: boolean }) {
  if (metric.state !== "MEASURED") return <span title={metric.reason}>Not instrumented</span>;
  return <>{money ? formatMoney(metric.value) : formatNumber(metric.value)}</>;
}

function EmptyState({ children }: { children: ReactNode }) {
  return <p className="px-4 py-7 text-sm text-[var(--admin-muted,#8a8a8a)]">{children}</p>;
}

function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div role="alert" className="m-4 rounded border border-red-400/50 bg-red-400/10 p-3 text-sm">
      <p>{message}</p>
      <AdminButton size="sm" className="mt-2" onClick={retry}><RefreshCw size={14} /> Retry</AdminButton>
    </div>
  );
}

export default function GrowthCommandPage() {
  const [, navigate] = useLocation();
  const [period, setPeriod] = useState<Period>("30d");
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [linkForm, setLinkForm] = useState({ target: "partner", source: "outreach", medium: "email", campaign: "medway_cataclysm", content: "" });

  const session = useQuery<AdminSession>({
    queryKey: ["/api/admin/session"],
    queryFn: async () => {
      const response = await fetch("/api/admin/session", { credentials: "include" });
      return response.ok ? ((await response.json()) as AdminSession) : { authenticated: false };
    },
    retry: false,
  });
  const permitted = session.data?.authenticated === true && session.data.isSuperAdmin === true;

  useEffect(() => {
    if (session.data && !session.data.authenticated) navigate("/admin/login?next=/admin/growth", { replace: true });
    if (session.data?.authenticated && !session.data.isSuperAdmin) navigate("/admin", { replace: true });
  }, [navigate, session.data]);

  const summary = useQuery<Summary>({
    queryKey: [BASE, "summary", period],
    queryFn: async () => {
      const response = await fetch(`${BASE}/summary?period=${period}`, { credentials: "include" });
      if (!response.ok) throw new Error("Growth Command data is unavailable");
      return response.json() as Promise<Summary>;
    },
    enabled: permitted,
  });
  const leads = useQuery<{ leads: Lead[] }>({
    queryKey: [BASE, "leads"],
    queryFn: async () => {
      const response = await fetch(`${BASE}/leads`, { credentials: "include" });
      if (!response.ok) throw new Error("Partner applications are unavailable");
      return response.json() as Promise<{ leads: Lead[] }>;
    },
    enabled: permitted,
  });
  const lead = useQuery<{ lead: LeadDetail }>({
    queryKey: [BASE, "lead", selectedLeadId],
    queryFn: async () => {
      const response = await fetch(`${BASE}/leads/${selectedLeadId}`, { credentials: "include" });
      if (!response.ok) throw new Error("Partner application is unavailable");
      return response.json() as Promise<{ lead: LeadDetail }>;
    },
    enabled: permitted && !!selectedLeadId,
  });
  const options = useQuery<LinkOptions>({
    queryKey: [BASE, "link-options"],
    queryFn: async () => {
      const response = await fetch(`${BASE}/link-options`, { credentials: "include" });
      if (!response.ok) throw new Error("Campaign link options are unavailable");
      return response.json() as Promise<LinkOptions>;
    },
    enabled: permitted,
  });

  const changeStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: LeadState }) => {
      const response = await apiRequest("POST", `${BASE}/leads/${id}/status`, { status });
      return response.json() as Promise<unknown>;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [BASE] });
    },
  });
  const createLink = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `${BASE}/links`, {
        ...linkForm,
        content: linkForm.content || undefined,
      });
      return response.json() as Promise<{ url: string }>;
    },
  });
  const selectedLead = lead.data?.lead;
  const selectedExternalUrl = safeExternalUrl(selectedLead?.webPresence);
  const canShowPartnerHandoff = selectedLead?.status === "ONBOARDING";
  const summaryValue = summary.data;
  const recentLeads = useMemo(() => leads.data?.leads ?? [], [leads.data?.leads]);

  function logout() {
    window.location.assign("/api/admin/logout");
  }

  if (session.isLoading || !session.data) return <div className="min-h-screen bg-[#10110f]" />;
  if (!permitted) return null;

  return (
    <AdminShell
      activeTab="growth"
      onTabChange={(tab) => navigate(tab === "growth" ? "/admin/growth" : tab === "promotions" ? "/admin/promotions" : `/admin?tab=${encodeURIComponent(tab)}`)}
      onLogout={logout}
      title="Growth Command"
      crumb="MINTVAULT · INSIGHT"
    >
      <div className="mx-auto max-w-[1600px] space-y-4 p-4 sm:p-6" data-testid="growth-command">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm text-[var(--admin-muted,#8a8a8a)]">Paid-order attribution, Partner application operations, and controlled campaign links.</p>
            <p className="mt-1 text-xs text-[var(--admin-muted,#8a8a8a)]">Revenue uses Stripe-verified paid submissions only. No browser tracking or customer-level revenue drill-down is used.</p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            Period
            <select value={period} onChange={(event) => setPeriod(event.target.value as Period)} className="rounded border border-[var(--admin-line,#333)] bg-transparent px-2 py-1" data-testid="growth-period">
              {PERIODS.map((value) => <option key={value} value={value}>{value === "all" ? "All instrumented time" : value === "today" ? "Today" : `Last ${value}`}</option>)}
            </select>
          </label>
        </div>

        {summary.isError ? <ErrorState message="Growth Command summary could not be loaded." retry={() => void summary.refetch()} /> : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <StatCard label="Paid submissions" value={summaryValue ? formatNumber(summaryValue.paid.paidSubmissions.value) : "…"} foot="Stripe-verified in selected period" testId="growth-paid-submissions" />
              <StatCard label="Paid cards" value={summaryValue ? formatNumber(summaryValue.paid.paidCards.value) : "…"} foot="Paid orders only" testId="growth-paid-cards" />
              <StatCard label="Revenue" value={summaryValue ? formatMoney(summaryValue.paid.revenuePence.value) : "…"} foot="Actual Stripe payment amount" testId="growth-revenue" />
              <StatCard label="Average cards / paid order" value={summaryValue ? summaryValue.paid.averageCardsPerPaidOrder.value.toFixed(2) : "…"} foot="Measured paid orders" testId="growth-average-cards" />
              <StatCard label="Unattributed paid orders" value={summaryValue ? formatNumber(summaryValue.paid.unattributedPaidSubmissions.value) : "…"} foot="No approved acquisition reference" testId="growth-unattributed" />
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <PerformancePanel title="Source performance" rows={summaryValue?.sourcePerformance ?? []} />
              <CampaignPanel title="Campaign performance" rows={summaryValue?.campaignPerformance ?? []} />
            </div>

            <Panel title="Partner pipeline" sub="Application measurement is distinct from operational Partner accounts.">
              <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-6">
                <PipelineValue label="All applications" metric={summaryValue?.partnerApplications.total} />
                <PipelineValue label="New" metric={summaryValue?.partnerApplications.new} />
                <PipelineValue label="Contacted" metric={summaryValue?.partnerApplications.contacted} />
                <PipelineValue label="Qualified" metric={summaryValue?.partnerApplications.qualified} />
                <PipelineValue label="Not a fit" metric={summaryValue?.partnerApplications.notAFit} />
                <PipelineValue label="Onboarding" metric={summaryValue?.partnerApplications.onboarding} />
              </div>
              <div className="grid gap-3 border-t border-[var(--admin-line,#333)] p-4 md:grid-cols-4 text-sm">
                <UnavailableMetric label="Active Partners" metric={summaryValue?.activePartners} />
                <UnavailableMetric label="Partner cards / Partner" metric={summaryValue?.partnerCardsPerPartner} />
                <UnavailableMetric label="Partner revenue" metric={summaryValue?.partnerRevenue} />
                <UnavailableMetric label="Repeat customer rate" metric={summaryValue?.repeatCustomerRate} />
              </div>
              {summaryValue?.historical && <p className="px-4 pb-4 text-xs text-[var(--admin-muted,#8a8a8a)]">Historical data: {summaryValue.historical.reason}</p>}
            </Panel>
          </>
        )}

        <div className="grid gap-4 2xl:grid-cols-[1.35fr_.65fr]">
          <Panel title="Partner application leads" sub="Review and classify interest applications. These actions never create a Partner account.">
            {leads.isError ? <ErrorState message="Partner applications could not be loaded." retry={() => void leads.refetch()} /> : recentLeads.length === 0 ? <EmptyState>No applications have been received in this measured view.</EmptyState> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="border-y border-[var(--admin-line,#333)] text-xs uppercase text-[var(--admin-muted,#8a8a8a)]"><tr><th className="p-3">Business</th><th className="p-3">Location</th><th className="p-3">State</th><th className="p-3">Acquisition</th><th className="p-3">Received</th><th className="p-3" /></tr></thead>
                  <tbody>{recentLeads.map((item) => <tr key={item.id} className="border-b border-[var(--admin-line,#333)]"><td className="p-3 font-medium">{item.businessName}<div className="text-xs text-[var(--admin-muted,#8a8a8a)]">{item.businessType}</div></td><td className="p-3">{item.city || "—"}<div className="text-xs text-[var(--admin-muted,#8a8a8a)]">{item.postcode || "—"}</div></td><td className="p-3"><Badge variant={leadBadgeVariant(item.status)}>{item.status.replaceAll("_", " ")}</Badge></td><td className="p-3">{item.source}<div className="text-xs text-[var(--admin-muted,#8a8a8a)]">{item.campaign}</div></td><td className="p-3 whitespace-nowrap">{formatDate(item.createdAt)}</td><td className="p-3"><AdminButton size="sm" onClick={() => setSelectedLeadId(item.id)}>Review</AdminButton></td></tr>)}</tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title={selectedLead ? selectedLead.businessName : "Application detail"} sub={selectedLead ? "Internal contact data — do not export." : "Choose a Partner application to review."}>
            {!selectedLeadId ? <EmptyState>Select a lead to review its application, update its state, or make a manual onboarding handoff.</EmptyState> : lead.isError ? <ErrorState message="This Partner application could not be loaded." retry={() => void lead.refetch()} /> : !selectedLead ? <EmptyState>Loading application…</EmptyState> : (
              <div className="space-y-4 p-4 text-sm">
                <div className="flex flex-wrap items-center gap-2"><Badge variant={leadBadgeVariant(selectedLead.status)}>{selectedLead.status.replaceAll("_", " ")}</Badge><span className="text-[var(--admin-muted,#8a8a8a)]">{formatDate(selectedLead.createdAt)}</span></div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3"><Detail label="Contact" value={selectedLead.contactName} /><Detail label="Email" value={selectedLead.email} /><Detail label="Phone" value={selectedLead.phone || "Not supplied"} /><Detail label="Location" value={[selectedLead.city, selectedLead.postcode].filter(Boolean).join(" · ") || "Not supplied"} /><Detail label="Retail presence" value={selectedLead.physicalRetail === null ? "Not supplied" : selectedLead.physicalRetail ? "Yes" : "No"} /><Detail label="Card categories" value={selectedLead.categories.join(", ") || "Not supplied"} /></dl>
                <div><p className="text-xs uppercase text-[var(--admin-muted,#8a8a8a)]">Interest / readiness</p><p className="mt-1 whitespace-pre-wrap">{selectedLead.interestReason || "Not supplied"}</p></div>
                {selectedExternalUrl && <a href={selectedExternalUrl} target="_blank" rel="noreferrer" className={adminButtonClass({ size: "sm" })}><ExternalLink size={14} /> Open website / profile</a>}
                <div className="border-t border-[var(--admin-line,#333)] pt-3"><p className="mb-2 text-xs uppercase text-[var(--admin-muted,#8a8a8a)]">Classify application</p><div className="flex flex-wrap gap-2">{LEAD_STATES.filter((status) => status !== selectedLead.status).map((status) => <AdminButton key={status} size="sm" variant={status === "ONBOARDING" ? "gold" : "ghost"} disabled={changeStatus.isPending} onClick={() => changeStatus.mutate({ id: selectedLead.id, status })}>{status.replaceAll("_", " ")}</AdminButton>)}</div>{changeStatus.isError && <p role="alert" className="mt-2 text-xs text-red-400">The state change did not complete. Retry before taking another action.</p>}</div>
                {canShowPartnerHandoff && <div className="rounded border border-amber-400/35 bg-amber-400/5 p-3"><p className="font-medium">Ready for manual Partner Management handoff</p><p className="mt-1 text-xs text-[var(--admin-muted,#8a8a8a)]">No tenant, user, location, station, credit or approval has been created by this application state.</p><Link className={`${adminButtonClass({ size: "sm", variant: "gold", className: "mt-2 inline-flex" })}`} href={`/admin/partners/settings?growthLead=${encodeURIComponent(selectedLead.id)}`}>Open Partner Management <ArrowUpRight size={14} /></Link></div>}
              </div>
            )}
          </Panel>
        </div>

        <Panel title="Controlled campaign link generator" sub="Only MintVault-approved source, medium and campaign codes can be generated. No free-text UTM values are accepted.">
          {options.isError ? <ErrorState message="Controlled link options could not be loaded." retry={() => void options.refetch()} /> : !options.data ? <EmptyState>Loading controlled campaign registry…</EmptyState> : (
            <div className="space-y-4 p-4">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <SelectField label="Audience" value={linkForm.target} options={options.data.targets.map((entry) => ({ value: entry.value, label: entry.label }))} onChange={(value) => setLinkForm((current) => ({ ...current, target: value }))} />
                <SelectField label="Source" value={linkForm.source} options={options.data.sources.map((value) => ({ value, label: value }))} onChange={(value) => setLinkForm((current) => ({ ...current, source: value }))} />
                <SelectField label="Medium" value={linkForm.medium} options={options.data.mediums.map((value) => ({ value, label: value }))} onChange={(value) => setLinkForm((current) => ({ ...current, medium: value }))} />
                <SelectField label="Campaign" value={linkForm.campaign} options={options.data.campaigns.map((value) => ({ value, label: value }))} onChange={(value) => setLinkForm((current) => ({ ...current, campaign: value }))} />
                <SelectField label="Content (optional)" value={linkForm.content} options={[{ value: "", label: "No content variant" }, ...options.data.contents.map((value) => ({ value, label: value }))]} onChange={(value) => setLinkForm((current) => ({ ...current, content: value }))} />
              </div>
              <div className="flex flex-wrap items-center gap-3"><AdminButton variant="gold" disabled={createLink.isPending} onClick={() => createLink.mutate()}>Generate tracked link</AdminButton><span className="text-xs text-[var(--admin-muted,#8a8a8a)]">Default example: Medway Cataclysm · Partner outreach · Email.</span></div>
              {createLink.isError && <p role="alert" className="text-sm text-red-400">The link could not be generated. Use one of the controlled values shown above.</p>}
              {createLink.data?.url && <div className="flex flex-col gap-2 rounded border border-[var(--admin-line,#333)] p-3 sm:flex-row sm:items-center"><code className="min-w-0 flex-1 break-all text-xs">{createLink.data.url}</code><AdminButton size="sm" onClick={() => { void copyTrackedLink(createLink.data!.url).then((copied) => setCopyState(copied ? "copied" : "failed")); }}><Copy size={14} /> {copyState === "copied" ? "Copied" : "Copy"}</AdminButton>{copyState === "failed" && <span role="alert" className="text-xs text-red-400">Copy was blocked. Select the URL manually.</span>}</div>}
            </div>
          )}
        </Panel>
      </div>
    </AdminShell>
  );
}

function Detail({ label, value }: { label: string; value: string }) { return <div><dt className="text-xs uppercase text-[var(--admin-muted,#8a8a8a)]">{label}</dt><dd className="mt-1 break-words">{value}</dd></div>; }
function PipelineValue({ label, metric }: { label: string; metric: Measured | undefined }) { return <div><p className="text-xs uppercase text-[var(--admin-muted,#8a8a8a)]">{label}</p><p className="mt-1 text-2xl font-semibold">{metric ? formatNumber(metric.value) : "…"}</p></div>; }
function UnavailableMetric({ label, metric }: { label: string; metric: Metric | undefined }) { return <div><p className="text-xs uppercase text-[var(--admin-muted,#8a8a8a)]">{label}</p><p className="mt-1 text-sm"><MetricText metric={metric ?? { state: "NOT_INSTRUMENTED", reason: "Loading measurement status" }} /></p></div>; }
function SelectField({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) { return <label className="grid gap-1 text-xs uppercase text-[var(--admin-muted,#8a8a8a)]">{label}<select value={value} onChange={(event) => onChange(event.target.value)} className="rounded border border-[var(--admin-line,#333)] bg-transparent px-2 py-2 text-sm normal-case text-inherit">{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>; }
function PerformancePanel({ title, rows }: { title: string; rows: Performance[] }) { return <Panel title={title} sub="Paid-order and Partner-application counts are measured separately.">{rows.length === 0 ? <EmptyState>No measured results in the selected period.</EmptyState> : <div className="overflow-x-auto"><table className="w-full min-w-[580px] text-left text-sm"><thead className="border-y border-[var(--admin-line,#333)] text-xs uppercase text-[var(--admin-muted,#8a8a8a)]"><tr><th className="p-3">Source</th><th className="p-3">Paid orders</th><th className="p-3">Cards</th><th className="p-3">Revenue</th><th className="p-3">Applications</th></tr></thead><tbody>{rows.map((row) => <tr key={row.category} className="border-b border-[var(--admin-line,#333)]"><td className="p-3">{row.category.replaceAll("_", " ")}</td><td className="p-3">{formatNumber(row.paidSubmissions)}</td><td className="p-3">{formatNumber(row.paidCards)}</td><td className="p-3">{formatMoney(row.revenuePence)}</td><td className="p-3">{formatNumber(row.partnerApplications)}</td></tr>)}</tbody></table></div>}</Panel>; }
function CampaignPanel({ title, rows }: { title: string; rows: CampaignPerformance[] }) { return <Panel title={title} sub="Only controlled campaign codes are displayed; unapproved historical values are unattributed.">{rows.length === 0 ? <EmptyState>No measured campaign results in the selected period.</EmptyState> : <div className="overflow-x-auto"><table className="w-full min-w-[620px] text-left text-sm"><thead className="border-y border-[var(--admin-line,#333)] text-xs uppercase text-[var(--admin-muted,#8a8a8a)]"><tr><th className="p-3">Campaign</th><th className="p-3">Source</th><th className="p-3">Paid orders</th><th className="p-3">Revenue</th><th className="p-3">Applications</th></tr></thead><tbody>{rows.map((row) => <tr key={`${row.category}-${row.campaign}`} className="border-b border-[var(--admin-line,#333)]"><td className="p-3">{row.campaign}</td><td className="p-3">{row.category.replaceAll("_", " ")}</td><td className="p-3">{formatNumber(row.paidSubmissions)}</td><td className="p-3">{formatMoney(row.revenuePence)}</td><td className="p-3">{formatNumber(row.partnerApplications)}</td></tr>)}</tbody></table></div>}</Panel>; }
