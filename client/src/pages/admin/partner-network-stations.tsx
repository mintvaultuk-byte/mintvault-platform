/**
 * Network Stations is deliberately observation-only. It reuses the existing
 * Super Admin fleet read and routes all station lifecycle work to a Partner
 * workspace, where the existing step-up-protected authority remains canonical.
 */
import { useEffect, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AdminShell, AdminButton, Badge, Chip, Panel } from "@/components/admin";
import { apiRequest } from "@/lib/queryClient";
import { runAdminProtected } from "@/components/admin/admin-step-up";

const BASE = "/api/super-admin/fleet/stations";
const statuses = ["", "PENDING", "ACTIVE", "SUSPENDED", "REVOKED"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WORKSPACE_LINKS = [
  ["Overview", ""], ["Onboarding", "/onboarding"], ["Cards", "/cards"], ["Staff", "/staff"],
  ["Locations", "/locations"], ["Stations", "/stations"], ["Credits", "/credits"], ["Activity", "/activity"], ["Security", "/security"],
] as const;

type Station = {
  stationCode: string;
  tenantId: string;
  partnerName: string;
  locationId: string;
  locationName: string;
  status: string;
  appVersion: string | null;
  scannerConnected: boolean;
  calibrationStatus: string;
  captureState: string;
  lastSeenAt: string | null;
  lastFailureCode: string | null;
};

type StationAction = { stationCode: string; label: string; route: "active" | "suspended" | "revoked" | "reject" };

function allowedActions(status: string): Array<Pick<StationAction, "label" | "route">> {
  if (status === "PENDING") return [{ label: "Approve", route: "active" }, { label: "Reject", route: "reject" }];
  if (status === "ACTIVE") return [{ label: "Suspend", route: "suspended" }, { label: "Revoke", route: "revoked" }];
  if (status === "SUSPENDED") return [{ label: "Activate", route: "active" }, { label: "Revoke", route: "revoked" }];
  return [];
}

function stationBadge(status: string): "act" | "wait" | "prog" | "red" | "neu" {
  if (status === "ACTIVE") return "act";
  if (status === "PENDING") return "wait";
  if (status === "SUSPENDED") return "prog";
  if (status === "REVOKED") return "red";
  return "neu";
}

export default function PartnerNetworkStationsPage() {
  const [, navigate] = useLocation();
  const [, params] = useRoute("/admin/partners/:partnerId/stations");
  const partnerId = params?.partnerId ?? null;
  const validPartnerId = !partnerId || UUID_RE.test(partnerId);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [status, setStatus] = useState<string>("");
  const [query, setQuery] = useState("");
  const [stationAction, setStationAction] = useState<StationAction | null>(null);
  const [reason, setReason] = useState("");
  useEffect(() => {
    let live = true;
    fetch("/api/admin/session", { credentials: "include" })
      .then((response) => (response.ok ? response.json() : null))
      .then((value) => live && setAuthed(value?.authenticated === true))
      .catch(() => live && setAuthed(false));
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (authed === false) navigate(`/admin/login?next=${partnerId ? `/admin/partners/${partnerId}/stations` : "/admin/partners/stations"}`, { replace: true });
  }, [authed, navigate, partnerId]);

  const fleet = useQuery<{ stations: Station[]; total: number }>({
    queryKey: [BASE, { status, query, partnerId }],
    queryFn: () => {
      const params = new URLSearchParams({ pageSize: "100" });
      if (status) params.set("status", status);
      if (query.trim()) params.set("query", query.trim());
      if (partnerId) params.set("tenantId", partnerId);
      return apiRequest("GET", `${BASE}?${params}`).then((response) => response.json());
    },
    enabled: authed === true && validPartnerId,
  });
  const stationMutation = useMutation({
    mutationFn: async (action: StationAction) =>
      runAdminProtected(async () =>
        apiRequest("POST", `${BASE}/${encodeURIComponent(action.stationCode)}/${action.route}`, { reason: reason.trim() })
      ),
    onSuccess: async () => {
      setStationAction(null);
      setReason("");
      await fleet.refetch();
    },
  });

  return (
    <AdminShell activeTab="dashboard" onTabChange={() => navigate("/admin")} onLogout={() => navigate("/admin")} title="Partner Network" crumb={partnerId ? "Partner Stations" : "Stations"}>
      {partnerId && <nav aria-label="Partner workspace" className="mb-3 flex flex-wrap gap-2" data-testid="pn-workspace-tabs">
        {WORKSPACE_LINKS.map(([label, suffix]) => <Link key={label} href={`/admin/partners/${partnerId}${suffix}`} className={`admin-chip ${suffix === "/stations" ? "is-on" : ""}`.trim()}>{label}</Link>)}
      </nav>}
      <Panel title={partnerId ? "Partner Stations" : "Network Stations"} sub={partnerId ? "Partner-scoped station context. Lifecycle actions use the existing step-up-protected server authority." : "Read-only fleet view. Open a Partner workspace for lifecycle operations."}>
        {partnerId && !validPartnerId ? <div role="alert">Partner not found.</div> : <>
        <div className="mb-3 flex flex-wrap gap-2">
          {statuses.map((candidate) => (
            <Chip key={candidate || "all"} active={status === candidate} onClick={() => setStatus(candidate)} testId={`pn-station-filter-${candidate || "all"}`}>
              {candidate || "All"}
            </Chip>
          ))}
          <label className="ml-auto flex items-center gap-2 text-sm">
            Search
            <input value={query} onChange={(event) => setQuery(event.target.value)} className="ss-input" aria-label="Search network stations" />
          </label>
        </div>
        {fleet.isLoading ? <div role="status">Loading stations…</div> : fleet.isError ? <div role="alert">Stations could not be loaded.</div> : (
          <table className="min-w-full text-left text-sm" data-testid="partner-network-stations">
            <thead><tr><th>Station</th><th>Partner</th><th>Location</th><th>Status</th><th>Scanner</th><th>Calibration</th><th>Version</th><th>Last seen</th>{partnerId && <th>Actions</th>}</tr></thead>
            <tbody>{(fleet.data?.stations ?? []).map((station) => (
              <tr key={station.stationCode} id={`station-${station.stationCode}`}>
                <td>{station.stationCode}</td>
                <td><Link href={`/admin/partners/${station.tenantId}/stations#station-${encodeURIComponent(station.stationCode)}`} className="underline">{station.partnerName}</Link></td>
                <td>{station.locationName}</td>
                <td><Badge variant={stationBadge(station.status)}>{station.status}</Badge></td>
                <td>{station.scannerConnected ? "Connected" : "Offline"}</td>
                <td>{station.calibrationStatus}</td>
                <td>{station.appVersion ?? "—"}</td>
                <td>{station.lastSeenAt ? new Date(station.lastSeenAt).toLocaleString() : "—"}</td>
                {partnerId && <td>
                  <div className="flex flex-wrap gap-1">
                    {allowedActions(station.status).map((action) => <AdminButton key={action.route} size="sm" variant={action.route === "revoked" || action.route === "reject" ? "gold" : "ghost"} onClick={() => { setReason(""); setStationAction({ ...action, stationCode: station.stationCode }); }} data-testid={`pn-station-${station.stationCode}-${action.route}`}>{action.label}</AdminButton>)}
                  </div>
                </td>}
              </tr>
            ))}</tbody>
          </table>
        )}
        <div className="mt-3 text-xs opacity-70">{fleet.data ? `${fleet.data.total} station(s)` : ""}</div>
        </>}
      </Panel>
      {stationAction && <div role="dialog" aria-modal="true" aria-labelledby="pn-station-action-title" className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
        <div className="w-full max-w-md rounded bg-slate-950 p-5 shadow-xl">
          <h2 id="pn-station-action-title" className="mb-2 text-lg font-semibold">{stationAction.label} {stationAction.stationCode}</h2>
          <p className="mb-3 text-sm opacity-80">This uses the existing Super Admin step-up flow and records the reason in the existing station event trail.</p>
          <label className="grid gap-1 text-sm">Reason
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} className="ss-input min-h-24" autoFocus />
          </label>
          {stationMutation.isError && <div role="alert" className="mt-2 text-sm text-red-300">Station action could not be completed.</div>}
          <div className="mt-4 flex justify-end gap-2"><AdminButton size="sm" variant="ghost" disabled={stationMutation.isPending} onClick={() => setStationAction(null)}>Cancel</AdminButton><AdminButton size="sm" variant="gold" disabled={stationMutation.isPending || !reason.trim()} onClick={() => stationMutation.mutate(stationAction)}>{stationMutation.isPending ? "Submitting…" : stationAction.label}</AdminButton></div>
        </div>
      </div>}
    </AdminShell>
  );
}
