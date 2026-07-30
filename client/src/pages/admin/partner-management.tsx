/**
 * G5 Super-Admin Partner Management — partners list.
 *
 * Internal (requireAdmin) admin page inside the existing admin app (AdminShell + admin primitives).
 * Self-auth-gates via /api/admin/session, lists partner organisations with search + status/kind filters
 * + pagination, and opens a partner's detail page. A "Create partner" action opens a reason-modal.
 * No wallet/credits/slots/billing/devices/pricing/marketplace/portal controls appear here (future
 * phases); the repo has no DOM harness, so logic lives in ./partner-management-helpers (unit-tested)
 * and this component is a thin renderer carrying data-testids.
 */
import { useEffect, useState } from "react";
import { useLocation, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { AdminShell, Panel, Badge, AdminButton, Chip, adminButtonClass } from "@/components/admin";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  statusBadgeVariant,
  PARTNER_STATUSES,
  PARTNER_PILOT_FLAG_BASE,
  PARTNER_PILOT_FLAG_LABELS,
  PARTNER_PILOT_MUTABLE_FLAGS,
  PARTNER_PILOT_READONLY_FLAG,
  isPartnerPilotMutableFlag,
  pmKeys,
  partnersQueryString,
  type PartnerPilotDisplayFlag,
  type PartnerPilotMutableFlag,
} from "./partner-management-helpers";

const BASE = "/api/super-admin/partner-management";

interface PartnerRow {
  id: string;
  legal_name: string;
  status: string;
  trading_name: string | null;
  organisation_kind: string | null;
  primary_email: string | null;
  primary_contact_name: string | null;
  location_count: number;
  user_count: number;
  connector_total: number;
  last_connector_activity: string | null;
  created_at: string;
}

type Filter = { search?: string; status?: string; page: number };

interface PartnerPilotFlagRow {
  flag: string;
  enabled: boolean;
  configured: boolean;
  updatedAt: string | null;
}

interface PartnerPilotFlagState {
  flags: PartnerPilotFlagRow[];
}

function flagState(data: PartnerPilotFlagState | undefined, flag: PartnerPilotDisplayFlag): PartnerPilotFlagRow | null {
  return data?.flags.find((row) => row.flag === flag) ?? null;
}

export default function PartnerManagementPage() {
  const [, navigate] = useLocation();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [filter, setFilter] = useState<Filter>({ page: 1 });
  const [searchInput, setSearchInput] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [legalName, setLegalName] = useState("");
  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/admin/session", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && setAuthed(!!d?.authenticated))
      .catch(() => live && setAuthed(false));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (authed === false) navigate("/admin/login?next=/admin/partner-network/partners", { replace: true });
  }, [authed, navigate]);

  const partners = useQuery({
    queryKey: pmKeys.partners(filter as Record<string, unknown>),
    queryFn: () => apiRequest("GET", `${BASE}/partners${partnersQueryString(filter)}`).then((r) => r.json()),
    enabled: authed === true,
  });

  const pilotFlags = useQuery<PartnerPilotFlagState>({
    queryKey: pmKeys.pilotFlags(),
    queryFn: () => apiRequest("GET", PARTNER_PILOT_FLAG_BASE).then((r) => r.json()),
    enabled: authed === true,
  });

  const createMutation = useMutation({
    mutationFn: async (name: string) => (await apiRequest("POST", `${BASE}/partners`, { legalName: name })).json(),
    onSuccess: (d) => {
      setBanner("Partner created.");
      setCreateOpen(false);
      setLegalName("");
      queryClient.invalidateQueries({ queryKey: [`${BASE}/partners`] });
      if (d?.result?.partnerId) navigate(`/admin/partner-network/partners/${d.result.partnerId}`);
    },
    onError: (err: unknown) =>
      setBanner((err as { body?: { error?: { message?: string } } })?.body?.error?.message ?? "Create failed."),
  });

  const flagMutation = useMutation({
    mutationFn: async ({ flag, enabled }: { flag: PartnerPilotMutableFlag; enabled: boolean }) =>
      (
        await apiRequest("PUT", `${PARTNER_PILOT_FLAG_BASE}/${flag}`, {
          enabled,
          reason: `Pilot setup: ${PARTNER_PILOT_FLAG_LABELS[flag]} ${enabled ? "enabled" : "disabled"}`,
        })
      ).json(),
    onSuccess: (_data, vars) => {
      setBanner(`${PARTNER_PILOT_FLAG_LABELS[vars.flag]} ${vars.enabled ? "enabled" : "disabled"}.`);
      queryClient.invalidateQueries({ queryKey: pmKeys.pilotFlags() });
      pilotFlags.refetch();
    },
    onError: (err: unknown, vars) =>
      setBanner(
        (err as { body?: { error?: { message?: string } } })?.body?.error?.message ??
          `${PARTNER_PILOT_FLAG_LABELS[vars.flag]} update failed.`
      ),
  });

  const changePilotFlag = (flag: string, enabled: boolean) => {
    if (!isPartnerPilotMutableFlag(flag)) return;
    const label = PARTNER_PILOT_FLAG_LABELS[flag];
    if (!window.confirm(`${enabled ? "Enable" : "Disable"} ${label}?`)) return;
    flagMutation.mutate({ flag, enabled });
  };

  if (authed === null) {
    return (
      <div
        className="admin-root"
        style={{ display: "grid", placeItems: "center", minHeight: "60vh" }}
        data-testid="pm-loading"
      >
        <span style={{ color: "var(--admin-gold, #D4AF37)" }}>Loading…</span>
      </div>
    );
  }

  const rows: PartnerRow[] = partners.data?.partners ?? [];

  return (
    <AdminShell
      activeTab="dashboard"
      onTabChange={() => navigate("/admin")}
      onLogout={() => navigate("/admin")}
      title="Partner Management"
      crumb="Partner Network"
    >
      <div data-testid="pm-list-root">
        {banner && (
          <div
            data-testid="pm-banner"
            style={{
              marginBottom: 12,
              color: "var(--admin-gold-text, #1A1400)",
              background: "var(--admin-gold, #D4AF37)",
              padding: "8px 12px",
              borderRadius: 8,
            }}
          >
            {banner}
          </div>
        )}

        <Panel title="Partner Pilot Flags" sub="Super Admin pilot controls" className="mb-4">
          <div data-testid="pm-pilot-flags">
            {pilotFlags.isLoading ? (
              <div data-testid="pm-pilot-flags-loading">Loading Partner pilot flags…</div>
            ) : pilotFlags.isError ? (
              <div
                role="alert"
                data-testid="pm-pilot-flags-error"
                style={{
                  border: "1px solid rgba(220,80,80,.45)",
                  background: "rgba(220,80,80,.08)",
                  borderRadius: 8,
                  padding: "10px 12px",
                }}
              >
                Partner pilot flag state is unavailable. Pilot controls are disabled.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {[PARTNER_PILOT_READONLY_FLAG, ...PARTNER_PILOT_MUTABLE_FLAGS].map((flag) => {
                  const row = flagState(pilotFlags.data, flag);
                  const enabled = row?.enabled === true;
                  const known = row !== null;
                  const mutable = isPartnerPilotMutableFlag(flag);
                  return (
                    <div
                      key={flag}
                      data-testid={`pm-pilot-flag-${flag}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                        padding: "8px 10px",
                        border: "1px solid rgba(255,255,255,.12)",
                        borderRadius: 8,
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600 }}>{PARTNER_PILOT_FLAG_LABELS[flag]}</div>
                        <div style={{ fontSize: 12, opacity: 0.7 }}>{mutable ? flag : "Read-only master switch"}</div>
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <Badge
                          variant={known ? (enabled ? "act" : "neu") : "red"}
                          testId={`pm-pilot-flag-status-${flag}`}
                        >
                          {known ? (enabled ? "Enabled" : "Disabled") : "Unavailable"}
                        </Badge>
                        {mutable ? (
                          <AdminButton
                            size="sm"
                            variant={enabled ? "ghost" : "gold"}
                            disabled={!known || flagMutation.isPending}
                            onClick={() => changePilotFlag(flag, !enabled)}
                            data-testid={`pm-pilot-flag-toggle-${flag}`}
                          >
                            {flagMutation.isPending ? "Saving…" : enabled ? "Disable" : "Enable"}
                          </AdminButton>
                        ) : (
                          <span style={{ fontSize: 12, opacity: 0.7 }} data-testid="pm-pilot-portal-readonly">
                            Read-only
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Panel>

        <Panel
          title="Partners"
          sub="Internal partner-company management"
          actions={
            <AdminButton size="sm" variant="gold" onClick={() => setCreateOpen(true)} data-testid="pm-create-open">
              Create partner
            </AdminButton>
          }
        >
          <div
            style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}
            data-testid="pm-filters"
          >
            <input
              data-testid="pm-search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) =>
                e.key === "Enter" && setFilter((f) => ({ ...f, page: 1, search: searchInput.trim() || undefined }))
              }
              placeholder="Search name / email…"
              style={{
                background: "var(--admin-bg, #0d0d0d)",
                color: "#fff",
                borderRadius: 8,
                padding: "6px 10px",
                minWidth: 220,
              }}
            />
            <Chip
              active={!filter.status}
              onClick={() => setFilter((f) => ({ ...f, page: 1, status: undefined }))}
              testId="pm-filter-all"
            >
              All
            </Chip>
            {PARTNER_STATUSES.map((s) => (
              <Chip
                key={s}
                active={filter.status === s}
                onClick={() => setFilter((f) => ({ ...f, page: 1, status: s }))}
                testId={`pm-filter-${s}`}
              >
                {s}
              </Chip>
            ))}
          </div>

          {partners.isLoading ? (
            <div data-testid="pm-loading-rows">Loading partners…</div>
          ) : rows.length === 0 ? (
            <div data-testid="pm-empty">No partners match this filter.</div>
          ) : (
            <table className="min-w-full text-left text-sm" data-testid="pm-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Kind</th>
                  <th>Primary contact</th>
                  <th>Locations</th>
                  <th>Users</th>
                  <th>Connectors</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} data-testid={`pm-row-${p.id}`}>
                    <td>
                      <div>{p.legal_name}</div>
                      {p.trading_name && <div style={{ fontSize: 12, opacity: 0.7 }}>{p.trading_name}</div>}
                    </td>
                    <td>
                      <Badge variant={statusBadgeVariant(p.status)} testId={`pm-status-${p.id}`}>
                        {p.status}
                      </Badge>
                    </td>
                    <td>{p.organisation_kind ?? "—"}</td>
                    <td>{p.primary_contact_name ?? p.primary_email ?? "—"}</td>
                    <td>{p.location_count}</td>
                    <td>{p.user_count}</td>
                    <td>{p.connector_total}</td>
                    <td>
                      <Link
                        href={`/admin/partner-network/partners/${p.id}`}
                        className={adminButtonClass({ variant: "ghost", size: "sm" })}
                        data-testid={`pm-open-${p.id}`}
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }} data-testid="pm-pager">
            <AdminButton
              size="sm"
              variant="ghost"
              disabled={filter.page <= 1}
              onClick={() => setFilter((f) => ({ ...f, page: f.page - 1 }))}
              data-testid="pm-prev"
            >
              Prev
            </AdminButton>
            <span style={{ fontSize: 12, opacity: 0.7 }}>
              Page {partners.data?.page ?? 1} of {partners.data?.totalPages ?? 1}
            </span>
            <AdminButton
              size="sm"
              variant="ghost"
              disabled={(partners.data?.page ?? 1) >= (partners.data?.totalPages ?? 1)}
              onClick={() => setFilter((f) => ({ ...f, page: f.page + 1 }))}
              data-testid="pm-next"
            >
              Next
            </AdminButton>
          </div>
        </Panel>

        {createOpen && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pm-create-title"
            data-testid="pm-create-modal"
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,.6)",
              display: "grid",
              placeItems: "center",
              zIndex: 50,
            }}
          >
            <div
              style={{
                background: "var(--admin-panel, #141414)",
                padding: 20,
                borderRadius: 12,
                width: "min(480px,92vw)",
              }}
            >
              <h3 id="pm-create-title" style={{ marginBottom: 8 }}>
                Create partner
              </h3>
              <label htmlFor="pm-create-name" style={{ display: "block", fontSize: 12, opacity: 0.8, marginBottom: 4 }}>
                Legal company name
              </label>
              <input
                id="pm-create-name"
                data-testid="pm-create-name"
                autoFocus
                value={legalName}
                onChange={(e) => setLegalName(e.target.value)}
                style={{
                  width: "100%",
                  background: "var(--admin-bg, #0d0d0d)",
                  color: "#fff",
                  borderRadius: 8,
                  padding: 8,
                }}
              />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
                <AdminButton
                  size="sm"
                  variant="ghost"
                  onClick={() => setCreateOpen(false)}
                  data-testid="pm-create-cancel"
                >
                  Cancel
                </AdminButton>
                <AdminButton
                  size="sm"
                  variant="gold"
                  disabled={!legalName.trim() || createMutation.isPending}
                  onClick={() => createMutation.mutate(legalName.trim())}
                  data-testid="pm-create-confirm"
                >
                  {createMutation.isPending ? "Creating…" : "Create"}
                </AdminButton>
              </div>
            </div>
          </div>
        )}
      </div>
    </AdminShell>
  );
}
