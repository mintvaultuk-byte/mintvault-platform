/**
 * G5 Super-Admin Partner Management — partners list.
 *
 * Internal (requireAdmin) admin page inside the existing admin app (AdminShell + admin primitives).
 * Self-auth-gates via /api/admin/session, lists partner organisations with search + status/kind filters
 * + pagination, and opens a partner's detail page. A "Create partner" action opens a reason-modal.
 * The only wallet control here is the one-off audited WALLET-BACKFILL1 button for staging wallet
 * provisioning. Credit adjustments remain in the Partner Master Dashboard wallet tab.
 */
import { useEffect, useState } from "react";
import { useLocation, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { AdminShell, Panel, Badge, AdminButton, Chip, adminButtonClass } from "@/components/admin";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { runAdminProtected, isAdminStepUpCancelled } from "@/components/admin/admin-step-up";
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
  validateLegalName,
  canCreateDespiteDuplicates,
  duplicateOverrideNote,
  duplicateSummary,
  blockingDuplicates,
  overridableDuplicates,
  submitAllowed,
  submitLabel,
  serverErrorMessage,
  reasonValid,
  type PartnerPilotDisplayFlag,
  type PartnerPilotMutableFlag,
  type DuplicateMatch,
  type SubmitState,
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

interface PartnerListResponse {
  partners: PartnerRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

interface WalletBackfillTenantResult {
  tenantId: string;
  legalName: string;
  walletId?: string;
  status?: string;
  reason?: string;
}

interface WalletBackfillResult {
  backfillId: "WALLET-BACKFILL1";
  considered: number;
  provisioned: WalletBackfillTenantResult[];
  alreadyPresent: WalletBackfillTenantResult[];
  skipped: WalletBackfillTenantResult[];
  ledgerEntriesCreated: 0;
}

type FleetStationStatus = "PENDING" | "ACTIVE" | "SUSPENDED" | "REVOKED";
interface FleetStation {
  stationCode: string;
  status: FleetStationStatus;
  tenantId: string;
  partnerName: string;
  locationId: string;
  locationName: string;
  appVersion: string | null;
  scannerConnected: boolean;
  calibrationStatus: string;
  pendingUploadCount: number;
  captureState: string;
  lastSeenAt: string | null;
  lastFailureCode: string | null;
}
interface FleetStationsResponse {
  stations: FleetStation[];
  total: number;
  page: number;
  pageSize: number;
}

const FLEET_BASE = "/api/super-admin/fleet";

function fleetBadge(status: FleetStationStatus): "act" | "neu" | "prog" | "wait" | "red" {
  if (status === "ACTIVE") return "act";
  if (status === "PENDING") return "wait";
  if (status === "SUSPENDED") return "prog";
  return "red";
}

function flagState(data: PartnerPilotFlagState | undefined, flag: PartnerPilotDisplayFlag): PartnerPilotFlagRow | null {
  return data?.flags.find((row) => row.flag === flag) ?? null;
}

export default function PartnerManagementPage() {
  const [pathname, navigate] = useLocation();
  // Fleet lifecycle controls stay on the retained legacy screen only. Canonical network-wide
  // Stations is observation-only; its Partner-scoped successor owns these privileged controls.
  const showLegacyFleetControls = pathname.startsWith("/admin/partner-network/partners");
  const isCanonicalSettings = pathname === "/admin/partners/settings";
  // Legacy keeps its established combined page for flag-off rollback. With consolidation on,
  // Directory owns organisations/create and Settings owns programme controls/backfill.
  const showSettingsControls = showLegacyFleetControls || isCanonicalSettings;
  const showDirectory = showLegacyFleetControls || !isCanonicalSettings;
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [filter, setFilter] = useState<Filter>({ page: 1 });
  const [searchInput, setSearchInput] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [legalName, setLegalName] = useState("");
  const [banner, setBanner] = useState<string | null>(null);
  // Create flow: form → duplicate scan → confirmation summary → create.
  const [createStep, setCreateStep] = useState<"form" | "confirm">("form");
  const [createState, setCreateState] = useState<SubmitState>("idle");
  const [createError, setCreateError] = useState<string | null>(null);
  const [createTouched, setCreateTouched] = useState(false);
  const [duplicates, setDuplicates] = useState<DuplicateMatch[]>([]);
  const [dupChecking, setDupChecking] = useState(false);
  // Distinguishes "checked, found nothing" from "could not check". Conflating them let a network
  // blip render a positive all-clear over a check that never ran.
  const [dupCheckFailed, setDupCheckFailed] = useState(false);
  const [dupAcknowledged, setDupAcknowledged] = useState(false);
  const [walletReason, setWalletReason] = useState("Owner-approved staging wallet provisioning");
  const [walletConfirm, setWalletConfirm] = useState("");
  const [walletBackfillResult, setWalletBackfillResult] = useState<WalletBackfillResult | null>(null);
  const [fleetStatus, setFleetStatus] = useState<FleetStationStatus | "ALL">("PENDING");
  const [fleetReason, setFleetReason] = useState("");
  const [fleetAction, setFleetAction] = useState<{
    stationCode: string;
    action: "active" | "suspended" | "revoked" | "reject";
  } | null>(null);

  const legalNameErr = validateLegalName(legalName);
  const dupDecision = canCreateDespiteDuplicates(duplicates, dupAcknowledged);

  function closeCreate() {
    setCreateOpen(false);
    setCreateStep("form");
    setLegalName("");
    setDuplicates([]);
    setDupAcknowledged(false);
    setDupCheckFailed(false);
    setCreateTouched(false);
    setCreateError(null);
    setCreateState("idle");
  }

  /**
   * Scan for existing partners that look like this one, then show the confirmation summary.
   *
   * A failed scan does NOT block creation: duplicate detection is an assistive check, and refusing to
   * create a partner because a advisory lookup errored would be a worse failure than the duplicate it
   * was trying to prevent. The step advances either way; the banner says the check could not run.
   */
  async function runDuplicateCheck() {
    setCreateTouched(true);
    if (legalNameErr) return;
    setDupChecking(true);
    setCreateError(null);
    setDupCheckFailed(false);
    try {
      const qs = new URLSearchParams({ legalName: legalName.trim() }).toString();
      const res = await apiRequest("GET", `${BASE}/partners/duplicate-check?${qs}`);
      const data = await res.json();
      setDuplicates(Array.isArray(data?.matches) ? (data.matches as DuplicateMatch[]) : []);
    } catch {
      setDuplicates([]);
      // The warning must travel to the step the operator is LOOKING at. The page banner renders
      // behind the modal's own backdrop, dimmed — it cannot carry a safety message.
      setDupCheckFailed(true);
    } finally {
      setDupChecking(false);
      setDupAcknowledged(false);
      setCreateStep("confirm");
    }
  }

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
    if (authed === false)
      navigate(
        `/admin/login?next=${encodeURIComponent(`${pathname}${window.location.search}${window.location.hash}`)}`,
        { replace: true }
      );
  }, [authed, navigate, pathname]);

  const partners = useQuery<PartnerListResponse>({
    queryKey: pmKeys.partners(filter as Record<string, unknown>),
    queryFn: () => apiRequest("GET", `${BASE}/partners${partnersQueryString(filter)}`).then((r) => r.json()),
    enabled: authed === true && showDirectory,
  });

  const activePartnersForWallets = useQuery<PartnerListResponse>({
    queryKey: pmKeys.partners({ status: "ACTIVE", pageSize: 100, walletBackfillPreview: true }),
    queryFn: () =>
      apiRequest("GET", `${BASE}/partners${partnersQueryString({ status: "ACTIVE", pageSize: 100 })}`).then((r) =>
        r.json()
      ),
    enabled: authed === true && showSettingsControls,
  });

  const pilotFlags = useQuery<PartnerPilotFlagState>({
    queryKey: pmKeys.pilotFlags(),
    queryFn: () => apiRequest("GET", PARTNER_PILOT_FLAG_BASE).then((r) => r.json()),
    enabled: authed === true && showSettingsControls,
  });

  const fleet = useQuery<FleetStationsResponse>({
    queryKey: [FLEET_BASE, fleetStatus],
    queryFn: () => {
      const search = new URLSearchParams({ pageSize: "50" });
      if (fleetStatus !== "ALL") search.set("status", fleetStatus);
      return apiRequest("GET", `${FLEET_BASE}/stations?${search.toString()}`).then((r) => r.json());
    },
    enabled: authed === true && showLegacyFleetControls,
  });

  const fleetMutation = useMutation({
    mutationFn: async ({
      stationCode,
      action,
      reason,
    }: {
      stationCode: string;
      action: "active" | "suspended" | "revoked" | "reject";
      reason: string;
    }) =>
      // Station approve/suspend/revoke/reject are behind requireAdminStepUp. runAdminProtected performs
      // the call and, ONLY if the server answers 403 admin_step_up_required, prompts and retries this
      // exact action once. Without it the request was refused and the operator had nowhere to comply.
      runAdminProtected(async () =>
        (
          await apiRequest("POST", `${FLEET_BASE}/stations/${encodeURIComponent(stationCode)}/${action}`, { reason })
        ).json()
      ),
    onSuccess: async (_data, input) => {
      setBanner(
        `${input.stationCode} ${input.action === "active" ? "approved" : input.action === "reject" ? "rejected" : input.action}.`
      );
      setFleetAction(null);
      setFleetReason("");
      await queryClient.invalidateQueries({ queryKey: [FLEET_BASE] });
    },
    onError: (err: unknown) => {
      // Dismissing the confirmation is not a failure: nothing was changed, so the operator is
      // returned to the list silently rather than shown an error they caused.
      if (isAdminStepUpCancelled(err)) return;
      setBanner(
        serverErrorMessage((err as { body?: unknown })?.body, "Station action failed. No station state was changed.")
      );
    },
  });

  const createMutation = useMutation({
    mutationFn: async (name: string) =>
      (
        await apiRequest("POST", `${BASE}/partners`, {
          legalName: name,
          // The override acknowledgement rides on the audited create reason, so a soft-duplicate
          // override is permanently visible in partner_management_audit rather than only in the UI.
          reason: `Partner created${duplicateOverrideNote(duplicates)}`,
        })
      ).json(),
    onSuccess: (d) => {
      setCreateState("idle");
      setCreateError(null);
      setBanner("Partner created.");
      closeCreate();
      queryClient.invalidateQueries({ queryKey: [`${BASE}/partners`] });
      if (d?.result?.partnerId) navigate(`/admin/partners/${d.result.partnerId}`);
    },
    onError: (err: unknown) => {
      setCreateState("error");
      const msg = serverErrorMessage((err as { body?: unknown })?.body, "Create failed. Nothing was created.");
      setCreateError(msg);
      setBanner(msg);
    },
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
      if (vars.flag === "super_admin_command_centre_enabled") {
        queryClient.removeQueries({ queryKey: ["protected", "command-centre"] });
        queryClient.removeQueries({ queryKey: ["/api/admin/db-info"] });
      }
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

  const walletTargets = activePartnersForWallets.data?.partners ?? [];
  const walletBackfillCanSubmit =
    walletConfirm.trim() === "WALLET-BACKFILL1" &&
    walletTargets.length > 0 &&
    activePartnersForWallets.data?.totalPages === 1 &&
    !activePartnersForWallets.isLoading &&
    reasonValid(walletReason);

  const walletBackfillMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `${BASE}/wallet-backfills/WALLET-BACKFILL1`, {
        confirm: "WALLET-BACKFILL1",
        reason: walletReason.trim(),
        idempotencyKey: "WALLET-BACKFILL1-ui",
        targetTenantIds: walletTargets.map((row) => row.id),
      });
      return response.json() as Promise<{ result: WalletBackfillResult }>;
    },
    onSuccess: async (data) => {
      const result = data.result;
      setWalletBackfillResult(result);
      setBanner(
        `Wallet backfill complete: ${result.provisioned.length} created, ${result.alreadyPresent.length} already existed, ${result.skipped.length} skipped, 0 failed, ${result.ledgerEntriesCreated} ledger entries.`
      );
      await queryClient.invalidateQueries({ queryKey: pmKeys.partners({}) });
      await queryClient.invalidateQueries({ queryKey: pmKeys.walletBackfill() });
      activePartnersForWallets.refetch();
    },
    onError: (err: unknown) => {
      const msg = serverErrorMessage(
        (err as { body?: unknown })?.body,
        "Wallet backfill failed. No result was recorded."
      );
      setBanner(msg);
    },
  });

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

        {showSettingsControls && (
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
                          <div style={{ fontSize: 12, opacity: 0.7 }}>
                            {flag === "super_admin_command_centre_enabled"
                              ? "Super Admin only · hides navigation and fails the route/API closed"
                              : mutable
                                ? flag
                                : "Read-only master switch"}
                          </div>
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
        )}

        {showSettingsControls && (
          <Panel title="Wallets / Credits" sub="Owner-approved staging controls" className="mb-4">
            <div data-testid="pm-wallet-backfill" style={{ display: "grid", gap: 12 }}>
              <div>
                <strong>Provision Missing Partner Wallets</strong>
                <div style={{ fontSize: 12, opacity: 0.72 }} data-testid="pm-wallet-backfill-scope">
                  All ACTIVE partner organisations missing wallets
                </div>
              </div>

              {activePartnersForWallets.isLoading ? (
                <div data-testid="pm-wallet-backfill-loading">Loading active partner organisations…</div>
              ) : activePartnersForWallets.isError ? (
                <div role="alert" data-testid="pm-wallet-backfill-error" style={{ color: "var(--admin-red)" }}>
                  Active partner organisations are unavailable. Wallet provisioning is disabled.
                </div>
              ) : walletTargets.length === 0 ? (
                <div data-testid="pm-wallet-backfill-empty">No ACTIVE partner organisations are available.</div>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {activePartnersForWallets.data?.totalPages && activePartnersForWallets.data.totalPages > 1 ? (
                    <div role="alert" data-testid="pm-wallet-backfill-page-limit" style={{ color: "var(--admin-red)" }}>
                      Too many ACTIVE organisations to preview in one guarded action. Wallet provisioning is disabled.
                    </div>
                  ) : null}
                  <div style={{ display: "grid", gap: 6 }} data-testid="pm-wallet-backfill-targets">
                    {walletTargets.map((row) => (
                      <div
                        key={row.id}
                        data-testid={`pm-wallet-backfill-target-${row.id}`}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 10,
                          padding: "8px 10px",
                          border: "1px solid rgba(255,255,255,.12)",
                          borderRadius: 8,
                        }}
                      >
                        <span>{row.legal_name}</span>
                        <code style={{ fontSize: 11, opacity: 0.75 }}>{row.id}</code>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <label style={{ display: "grid", gap: 5, fontSize: 12 }}>
                Reason
                <textarea
                  rows={2}
                  maxLength={2000}
                  value={walletReason}
                  onChange={(event) => setWalletReason(event.target.value)}
                  style={{
                    border: "1px solid var(--admin-line-hard)",
                    borderRadius: 6,
                    padding: "9px 10px",
                    background: "var(--admin-panel2)",
                  }}
                  data-testid="pm-wallet-backfill-reason"
                />
              </label>
              <label style={{ display: "grid", gap: 5, fontSize: 12 }}>
                Type WALLET-BACKFILL1
                <input
                  value={walletConfirm}
                  onChange={(event) => setWalletConfirm(event.target.value)}
                  autoComplete="off"
                  style={{
                    border: "1px solid var(--admin-line-hard)",
                    borderRadius: 6,
                    padding: "9px 10px",
                    background: "var(--admin-panel2)",
                  }}
                  data-testid="pm-wallet-backfill-confirm"
                />
              </label>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <AdminButton
                  variant="gold"
                  disabled={!walletBackfillCanSubmit || walletBackfillMutation.isPending}
                  onClick={() => walletBackfillMutation.mutate()}
                  data-testid="pm-wallet-backfill-submit"
                >
                  {walletBackfillMutation.isPending ? "Provisioning…" : "Provision Missing Partner Wallets"}
                </AdminButton>
                <Link
                  href="/admin/partners/directory"
                  className={adminButtonClass({ variant: "ghost", size: "sm" })}
                  data-testid="pm-wallet-dashboard-link"
                >
                  Open Partner Credits
                </Link>
              </div>
              {walletBackfillMutation.isError && (
                <div role="alert" data-testid="pm-wallet-backfill-mutation-error" style={{ color: "var(--admin-red)" }}>
                  {serverErrorMessage(
                    (walletBackfillMutation.error as { body?: unknown })?.body,
                    "Wallet backfill failed. No result was recorded."
                  )}
                </div>
              )}
              {walletBackfillResult && (
                <div data-testid="pm-wallet-backfill-result" style={{ fontSize: 12, display: "grid", gap: 4 }}>
                  <div>Created: {walletBackfillResult.provisioned.length}</div>
                  <div>Already existed: {walletBackfillResult.alreadyPresent.length}</div>
                  <div>Skipped: {walletBackfillResult.skipped.length}</div>
                  <div>Failed: 0</div>
                  <div>Ledger entries created: {walletBackfillResult.ledgerEntriesCreated}</div>
                </div>
              )}
            </div>
          </Panel>
        )}

        {showLegacyFleetControls && (
          <Panel title="Station Fleet" sub="Super Admin approval, rejection and safety state" className="mb-4">
            <div data-testid="pm-station-fleet" style={{ display: "grid", gap: 12 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {(["PENDING", "ACTIVE", "SUSPENDED", "REVOKED", "ALL"] as const).map((status) => (
                  <Chip
                    key={status}
                    active={fleetStatus === status}
                    onClick={() => setFleetStatus(status)}
                    testId={`pm-fleet-filter-${status}`}
                  >
                    {status}
                  </Chip>
                ))}
              </div>
              {fleet.isLoading ? (
                <div data-testid="pm-fleet-loading">Loading station fleet…</div>
              ) : fleet.isError ? (
                <div role="alert" data-testid="pm-fleet-error" style={{ color: "var(--admin-red)" }}>
                  Station fleet is unavailable. No station action can be submitted.
                </div>
              ) : (fleet.data?.stations?.length ?? 0) === 0 ? (
                <div data-testid="pm-fleet-empty">No stations match this state.</div>
              ) : (
                <table className="min-w-full text-left text-sm" data-testid="pm-fleet-table">
                  <thead>
                    <tr>
                      <th>Station</th>
                      <th>Partner / location</th>
                      <th>Readiness</th>
                      <th>Last seen</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {fleet.data?.stations?.map((station) => (
                      <tr key={station.stationCode} data-testid={`pm-fleet-row-${station.stationCode}`}>
                        <td>
                          <code>{station.stationCode}</code>
                          <div>
                            <Badge variant={fleetBadge(station.status)}>{station.status}</Badge>
                          </div>
                        </td>
                        <td>
                          {station.partnerName}
                          <div style={{ fontSize: 12, opacity: 0.7 }}>{station.locationName}</div>
                        </td>
                        <td>
                          {station.calibrationStatus} · {station.scannerConnected ? "connected" : "offline"}
                          <div style={{ fontSize: 12, opacity: 0.7 }}>
                            {station.lastFailureCode || station.captureState}
                          </div>
                        </td>
                        <td>{station.lastSeenAt ? new Date(station.lastSeenAt).toLocaleString() : "Never"}</td>
                        <td>
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            {station.status === "PENDING" && (
                              <>
                                <AdminButton
                                  size="sm"
                                  variant="gold"
                                  onClick={() => setFleetAction({ stationCode: station.stationCode, action: "active" })}
                                >
                                  Approve
                                </AdminButton>
                                <AdminButton
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => setFleetAction({ stationCode: station.stationCode, action: "reject" })}
                                >
                                  Reject
                                </AdminButton>
                              </>
                            )}
                            {station.status === "ACTIVE" && (
                              <AdminButton
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  setFleetAction({ stationCode: station.stationCode, action: "suspended" })
                                }
                              >
                                Suspend
                              </AdminButton>
                            )}
                            {station.status === "SUSPENDED" && (
                              <>
                                <AdminButton
                                  size="sm"
                                  variant="gold"
                                  onClick={() => setFleetAction({ stationCode: station.stationCode, action: "active" })}
                                >
                                  Re-approve
                                </AdminButton>
                                <AdminButton
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    setFleetAction({ stationCode: station.stationCode, action: "revoked" })
                                  }
                                >
                                  Revoke
                                </AdminButton>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Panel>
        )}

        {showDirectory && (
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
                          href={
                            showLegacyFleetControls
                              ? `/admin/partner-network/partners/${p.id}`
                              : `/admin/partners/${p.id}`
                          }
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
        )}

        {showDirectory && createOpen && (
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
                {createStep === "form" ? "Create partner" : "Confirm the new partner"}
              </h3>

              {createStep === "form" && (
                <>
                  <label
                    htmlFor="pm-create-name"
                    style={{ display: "block", fontSize: 12, opacity: 0.8, marginBottom: 4 }}
                  >
                    Legal company name
                  </label>
                  <input
                    id="pm-create-name"
                    data-testid="pm-create-name"
                    autoFocus
                    value={legalName}
                    onChange={(e) => setLegalName(e.target.value)}
                    aria-invalid={createTouched && !!legalNameErr}
                    aria-describedby={createTouched && legalNameErr ? "pm-create-name-error" : undefined}
                    onBlur={() => setCreateTouched(true)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" || dupChecking) return;
                      setCreateTouched(true);
                      if (!legalNameErr) void runDuplicateCheck();
                    }}
                    style={{
                      width: "100%",
                      background: "var(--admin-bg, #0d0d0d)",
                      color: "#fff",
                      borderRadius: 8,
                      padding: 8,
                    }}
                  />
                  {createTouched && legalNameErr && (
                    <div
                      id="pm-create-name-error"
                      role="alert"
                      data-testid="pm-create-error-legal-name"
                      style={{ color: "var(--admin-red, #ff6b6b)", fontSize: 12, marginTop: 4 }}
                    >
                      {legalNameErr}
                    </div>
                  )}
                  <p style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
                    Creating a partner also creates its Main location automatically. You can add the trading name,
                    address and contact details straight afterwards.
                  </p>
                </>
              )}

              {createStep === "confirm" && (
                <div>
                  {/* What is about to be created — shown before the irreversible action, not after. */}
                  <div data-testid="pm-create-confirm-summary" style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>About to create:</div>
                    <SummaryRow label="Company" value={legalName.trim()} />
                    <SummaryRow label="Status" value="PENDING" />
                    <SummaryRow label="Location" value="Main location (ACTIVE)" />
                    <SummaryRow label="Owner" value="None yet — invite them on the next screen" />
                    <SummaryRow label="Credits" value="None" />
                  </div>

                  {duplicates.length > 0 && (
                    <div data-testid="pm-create-duplicates" style={{ marginBottom: 12 }}>
                      <div role="alert" style={{ color: "var(--admin-gold, #D4AF37)", fontSize: 13, marginBottom: 6 }}>
                        {blockingDuplicates(duplicates).length > 0
                          ? "This conflicts with an existing partner."
                          : "This looks similar to a partner you already have."}
                      </div>
                      <ul style={{ fontSize: 12, opacity: 0.85, paddingLeft: 18, listStyle: "disc" }}>
                        {duplicates.map((m, i) => (
                          <li key={`${m.kind}-${m.partnerId}-${i}`} data-testid={`pm-create-dup-${m.kind}`}>
                            {duplicateSummary(m)}
                          </li>
                        ))}
                      </ul>
                      {blockingDuplicates(duplicates).length > 0 ? (
                        <p style={{ fontSize: 12, marginTop: 6, color: "var(--admin-red, #ff6b6b)" }}>
                          This cannot be overridden — the email address is already in use by a partner user.
                        </p>
                      ) : (
                        overridableDuplicates(duplicates).length > 0 && (
                          <label
                            style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, marginTop: 8 }}
                          >
                            <input
                              type="checkbox"
                              checked={dupAcknowledged}
                              onChange={(e) => setDupAcknowledged(e.target.checked)}
                              data-testid="pm-create-dup-ack"
                            />
                            <span>
                              I have checked these and this is genuinely a different partner. This acknowledgement is
                              recorded in the audit trail.
                            </span>
                          </label>
                        )
                      )}
                    </div>
                  )}

                  {dupCheckFailed && (
                    <div
                      role="alert"
                      data-testid="pm-create-dup-failed"
                      style={{ color: "var(--admin-red, #ff6b6b)", fontSize: 13, marginBottom: 8 }}
                    >
                      The duplicate check could not run, so this partner has NOT been checked against existing ones.
                      Review the partners list before continuing.
                    </div>
                  )}
                  {!dupCheckFailed && duplicates.length === 0 && (
                    <p data-testid="pm-create-no-duplicates" style={{ fontSize: 12, opacity: 0.7 }}>
                      No similar partner found.
                    </p>
                  )}

                  {createError && (
                    <div
                      role="alert"
                      data-testid="pm-create-server-error"
                      style={{ marginTop: 10, color: "var(--admin-red, #ff6b6b)", fontSize: 13 }}
                    >
                      {createError}
                    </div>
                  )}
                </div>
              )}

              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
                <AdminButton size="sm" variant="ghost" onClick={closeCreate} data-testid="pm-create-cancel">
                  Cancel
                </AdminButton>
                {createStep === "confirm" && (
                  <AdminButton
                    size="sm"
                    variant="ghost"
                    onClick={() => setCreateStep("form")}
                    data-testid="pm-create-back"
                  >
                    Back
                  </AdminButton>
                )}
                {createStep === "form" ? (
                  <AdminButton
                    size="sm"
                    variant="gold"
                    disabled={dupChecking}
                    onClick={() => void runDuplicateCheck()}
                    data-testid="pm-create-continue"
                  >
                    {dupChecking ? "Checking…" : "Continue"}
                  </AdminButton>
                ) : (
                  <AdminButton
                    size="sm"
                    variant="gold"
                    disabled={!dupDecision.allowed || !submitAllowed(createState) || createMutation.isPending}
                    onClick={() => {
                      if (!submitAllowed(createState) || !dupDecision.allowed) return;
                      setCreateState("submitting");
                      createMutation.mutate(legalName.trim());
                    }}
                    data-testid="pm-create-confirm"
                  >
                    {submitLabel(createState, "Create partner", "Creating…")}
                  </AdminButton>
                )}
              </div>
            </div>
          </div>
        )}
        {showLegacyFleetControls && fleetAction && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pm-fleet-action-title"
            data-testid="pm-fleet-action-modal"
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
              <h3 id="pm-fleet-action-title">
                {fleetAction.action === "active"
                  ? "Approve"
                  : fleetAction.action === "reject"
                    ? "Reject"
                    : fleetAction.action}{" "}
                station
              </h3>
              <p style={{ fontSize: 12, opacity: 0.75 }}>
                <code>{fleetAction.stationCode}</code>. This rotates its credential epoch. A reason is required and
                recorded.
              </p>
              <label style={{ display: "grid", gap: 5, fontSize: 12 }}>
                Reason
                <textarea
                  autoFocus
                  rows={3}
                  maxLength={1000}
                  value={fleetReason}
                  onChange={(event) => setFleetReason(event.target.value)}
                  data-testid="pm-fleet-action-reason"
                  style={{
                    border: "1px solid var(--admin-line-hard)",
                    borderRadius: 6,
                    padding: "9px 10px",
                    background: "var(--admin-panel2)",
                  }}
                />
              </label>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                <AdminButton
                  size="sm"
                  variant="ghost"
                  disabled={fleetMutation.isPending}
                  onClick={() => {
                    setFleetAction(null);
                    setFleetReason("");
                  }}
                >
                  Cancel
                </AdminButton>
                <AdminButton
                  size="sm"
                  variant={fleetAction.action === "active" ? "gold" : "ghost"}
                  disabled={fleetReason.trim().length < 3 || fleetMutation.isPending}
                  onClick={() => fleetMutation.mutate({ ...fleetAction, reason: fleetReason.trim() })}
                  data-testid="pm-fleet-action-submit"
                >
                  {fleetMutation.isPending ? "Saving…" : "Confirm"}
                </AdminButton>
              </div>
            </div>
          </div>
        )}
      </div>
    </AdminShell>
  );
}

/** One label/value line in the pre-creation confirmation summary. */
function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: 8, padding: "2px 0", fontSize: 13 }}>
      <span style={{ opacity: 0.6, minWidth: 90 }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}
