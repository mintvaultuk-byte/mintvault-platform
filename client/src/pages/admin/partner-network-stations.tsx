/**
 * Network Stations is deliberately observation-only. It reuses the existing
 * Super Admin fleet read and routes all station lifecycle work to a Partner
 * workspace, where the existing step-up-protected authority remains canonical.
 */
import { useEffect, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AdminShell, Badge, Chip, Panel } from "@/components/admin";
import { apiRequest } from "@/lib/queryClient";

const BASE = "/api/super-admin/fleet/stations";
const statuses = ["", "PENDING", "ACTIVE", "SUSPENDED", "REVOKED"] as const;

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
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [status, setStatus] = useState<string>("");
  const [query, setQuery] = useState("");
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
    enabled: authed === true,
  });

  return (
    <AdminShell activeTab="dashboard" onTabChange={() => navigate("/admin")} onLogout={() => navigate("/admin")} title="Partner Network" crumb={partnerId ? "Partner Stations" : "Stations"}>
      <Panel title={partnerId ? "Partner Stations" : "Network Stations"} sub={partnerId ? "Partner-scoped station context. Station lifecycle authority remains server-side." : "Read-only fleet view. Open a Partner workspace for lifecycle operations."}>
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
            <thead><tr><th>Station</th><th>Partner</th><th>Location</th><th>Status</th><th>Scanner</th><th>Calibration</th><th>Version</th><th>Last seen</th></tr></thead>
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
              </tr>
            ))}</tbody>
          </table>
        )}
        <div className="mt-3 text-xs opacity-70">{fleet.data ? `${fleet.data.total} station(s)` : ""}</div>
      </Panel>
    </AdminShell>
  );
}
