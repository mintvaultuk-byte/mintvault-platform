/**
 * G4 Super-Admin Partner Connector Operations console.
 *
 * Lives inside the existing admin app (AdminShell + admin primitives). Self-auth-gates via
 * /api/admin/session, then renders: an overview (operational health + queue counts), a filtered
 * records table, and a record-detail drawer whose safe operator actions (revalidate / reconcile /
 * retry / release-expired-claim / mark- and resolve-manual-review / ack-permanent-failure) each open a
 * required-reason modal and POST to the G4 API. No connector logic here — the server delegates to the
 * audited G3F services. Connector suspend, deactivate, and the global processing halt are intentionally
 * deferred (owner-gated) and never exposed as controls here.
 *
 * The repo has no DOM test harness, so page logic lives in ./partner-network-helpers (unit-tested) and
 * this component is a thin renderer carrying data-testids for source-assertion tests.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { AdminShell, Panel, StatCard, Badge, AdminButton, Chip } from "@/components/admin";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  stateBadgeVariant,
  canRetry,
  canResolveManualReview,
  canAckFailure,
  canReconcile,
  canReleaseClaim,
  reasonValid,
  requiresTypedConfirm,
  unavailableReason,
  opsKeys,
  recordsQueryString,
} from "./partner-network-helpers";

/** The phrase an operator must type to confirm a high-risk (destructive) action. */
const TYPED_CONFIRM_PHRASE = "CONFIRM";

const BASE = "/api/super-admin/connector-ops";

type Filter = {
  state?: string;
  reconciliationRequired?: boolean;
  manualReview?: boolean;
  failed?: boolean;
  page: number;
};

interface ActionSpec {
  key: string;
  label: string;
  path: (id: string) => string;
  body: (reason: string, version: number, recordId: string) => Record<string, unknown>;
  available: (rec: RecordRow, mappingState?: string | null) => boolean;
}

interface RecordRow {
  id: string;
  tenant_id: string;
  state: string;
  attempt_count: number;
  last_error_code: string | null;
  claim_expires_at: string | null;
  version: number;
  updated_at: string;
}

const ACTIONS: ActionSpec[] = [
  {
    key: "retry",
    label: "Retry import",
    path: (id) => `${BASE}/records/${id}/retry`,
    body: (reason, version) => ({ reason, expectedVersion: version }),
    available: (r, m) => canRetry(r.state, m),
  },
  {
    key: "reconcile",
    label: "Request reconciliation",
    path: (id) => `${BASE}/records/${id}/reconcile`,
    body: (reason) => ({ reason }),
    available: (r) => canReconcile(r.state),
  },
  {
    key: "mark",
    label: "Mark manual review",
    path: (id) => `${BASE}/records/${id}/mark-manual-review`,
    body: (reason) => ({ reason }),
    available: (r) => ["ready_for_import", "reconciliation_required", "failed", "importing"].includes(r.state),
  },
  {
    key: "resolve-retry",
    label: "Manual review → retry",
    path: (id) => `${BASE}/records/${id}/manual-review/resolve`,
    body: (reason, version) => ({ reason, resolution: "retry", expectedVersion: version }),
    available: (r) => canResolveManualReview(r.state),
  },
  {
    key: "resolve-cancel",
    label: "Manual review → cancel",
    path: (id) => `${BASE}/records/${id}/manual-review/resolve`,
    body: (reason, version) => ({ reason, resolution: "cancel", expectedVersion: version }),
    available: (r) => canResolveManualReview(r.state),
  },
  {
    key: "ack",
    label: "Acknowledge permanent failure",
    path: (id) => `${BASE}/records/${id}/ack-failure`,
    body: (reason, version) => ({ reason, expectedVersion: version }),
    available: (r) => canAckFailure(r.state),
  },
  {
    key: "release",
    label: "Release expired claim",
    path: (id) => `${BASE}/records/${id}/release-claim`,
    body: (reason) => ({ reason }),
    available: (r) => canReleaseClaim({ claimExpiresAt: r.claim_expires_at }),
  },
];

const RECOVER_CREDIT_HOLD_ACTION: ActionSpec = {
  key: "recover-credit-hold",
  label: "Recover credit hold",
  path: (id) => `${BASE}/records/${id}/recover-credit`,
  body: (reason, version, recordId) => ({
    reason,
    // Retain this key for a retry of the same record/version, including a
    // browser retry after the initial response was lost.
    idempotencyKey: `g6d-recovery:${recordId}:${version}`,
  }),
  available: () => true,
};

export default function PartnerNetworkOpsPage() {
  const [pathname, navigate] = useLocation();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [filter, setFilter] = useState<Filter>({ page: 1 });
  const [selected, setSelected] = useState<string | null>(null);
  const [modal, setModal] = useState<{ action: ActionSpec; rec: RecordRow } | null>(null);
  const [reason, setReason] = useState("");
  const [typedConfirm, setTypedConfirm] = useState("");
  const [banner, setBanner] = useState<string | null>(null);

  const closeModal = () => {
    setModal(null);
    setReason("");
    setTypedConfirm("");
  };

  // Escape closes the reason modal (accessibility / keyboard dismissal).
  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal]);

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

  const health = useQuery({
    queryKey: opsKeys.workerStatus(),
    queryFn: () => apiRequest("GET", `${BASE}/worker/status`).then((r) => r.json()),
    enabled: authed === true,
  });
  const records = useQuery({
    queryKey: opsKeys.records(filter as Record<string, unknown>),
    queryFn: () => apiRequest("GET", `${BASE}/records${recordsQueryString(filter)}`).then((r) => r.json()),
    enabled: authed === true,
  });
  const detail = useQuery({
    queryKey: selected ? opsKeys.record(selected) : ["none"],
    queryFn: () => apiRequest("GET", `${BASE}/records/${selected}`).then((r) => r.json()),
    enabled: authed === true && !!selected,
  });

  const mutation = useMutation({
    mutationFn: async ({ action, rec, reason }: { action: ActionSpec; rec: RecordRow; reason: string }) => {
      const res = await apiRequest("POST", action.path(rec.id), action.body(reason, rec.version, rec.id));
      return res.json();
    },
    onSuccess: (data) => {
      setBanner(data?.alreadyCompleted ? "Already completed (idempotent)." : "Action completed.");
      closeModal();
      queryClient.invalidateQueries({ queryKey: [`${BASE}/records`] });
      queryClient.invalidateQueries({ queryKey: opsKeys.workerStatus() });
      if (selected) queryClient.invalidateQueries({ queryKey: opsKeys.record(selected) });
    },
    onError: (err: unknown) => {
      const body = (err as { body?: { error?: { message?: string } } })?.body;
      setBanner(body?.error?.message ?? "Action failed.");
    },
  });

  const rows: RecordRow[] = records.data?.records ?? [];
  const selectedRec = useMemo(() => rows.find((r) => r.id === selected) ?? null, [rows, selected]);

  if (authed === null) {
    return (
      <div
        className="admin-root"
        style={{ display: "grid", placeItems: "center", minHeight: "60vh" }}
        data-testid="pn-loading"
      >
        <span style={{ color: "var(--admin-gold, #D4AF37)" }}>Loading…</span>
      </div>
    );
  }

  const h = health.data ?? {};

  return (
    <AdminShell
      activeTab="dashboard"
      onTabChange={() => navigate("/admin")}
      onLogout={() => navigate("/admin")}
      title="Partner Connectors"
      crumb="Operations"
    >
      <div data-testid="pn-ops-root">
        {banner && (
          <div
            data-testid="pn-banner"
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
        {h.featureEnabled === false && (
          <div
            data-testid="pn-disabled-banner"
            style={{
              marginBottom: 12,
              color: "#fff",
              background: "var(--admin-red, #cd8073)",
              padding: "8px 12px",
              borderRadius: 8,
            }}
          >
            Connector processing is globally DISABLED (read-only). Enabling is deferred and owner-gated.
          </div>
        )}

        <Panel title="Operational health" sub="Read-only worker + queue state">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
            <StatCard label="Processing" value={h.featureEnabled ? "ENABLED" : "DISABLED"} testId="pn-stat-enabled" />
            <StatCard label="Emergency stop" value={h.emergencyStop ? "ON" : "off"} testId="pn-stat-stop" />
            <StatCard label="Eligible" value={h.eligibleCount ?? "—"} mono testId="pn-stat-eligible" />
            <StatCard label="Claimed" value={h.claimedCount ?? "—"} mono testId="pn-stat-claimed" />
            <StatCard label="Expired claims" value={h.expiredClaims ?? "—"} mono testId="pn-stat-expired" />
            <StatCard label="Reconciliation" value={h.reconciliationRequiredCount ?? "—"} mono testId="pn-stat-recon" />
            <StatCard label="Manual review" value={h.manualReviewCount ?? "—"} mono testId="pn-stat-manual" />
          </div>
        </Panel>

        <Panel title="Connector records" sub="Filter, inspect, and operate" className="mt-4">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }} data-testid="pn-filters">
            <Chip
              active={!filter.state && !filter.manualReview && !filter.reconciliationRequired && !filter.failed}
              onClick={() => setFilter({ page: 1 })}
              testId="pn-filter-all"
            >
              All
            </Chip>
            <Chip
              active={!!filter.manualReview}
              onClick={() => setFilter({ page: 1, manualReview: true })}
              testId="pn-filter-manual"
            >
              Manual review
            </Chip>
            <Chip
              active={!!filter.reconciliationRequired}
              onClick={() => setFilter({ page: 1, reconciliationRequired: true })}
              testId="pn-filter-recon"
            >
              Reconciliation
            </Chip>
            <Chip
              active={!!filter.failed}
              onClick={() => setFilter({ page: 1, failed: true })}
              testId="pn-filter-failed"
            >
              Failed
            </Chip>
          </div>

          {records.isLoading ? (
            <div data-testid="pn-records-loading">Loading records…</div>
          ) : rows.length === 0 ? (
            <div data-testid="pn-records-empty">No connector records match this filter.</div>
          ) : (
            <table className="min-w-full text-left text-sm" data-testid="pn-records-table">
              <thead>
                <tr>
                  <th>State</th>
                  <th>Attempts</th>
                  <th>Last error</th>
                  <th>Updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} data-testid={`pn-row-${r.id}`}>
                    <td>
                      <Badge variant={stateBadgeVariant(r.state)} testId={`pn-state-${r.id}`}>
                        {r.state}
                      </Badge>
                    </td>
                    <td>{r.attempt_count}</td>
                    <td>{r.last_error_code ?? "—"}</td>
                    <td>{new Date(r.updated_at).toLocaleString()}</td>
                    <td>
                      <AdminButton
                        size="sm"
                        variant="ghost"
                        onClick={() => setSelected(r.id)}
                        data-testid={`pn-open-${r.id}`}
                      >
                        Inspect
                      </AdminButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        {selected && selectedRec && (
          <Panel title={`Record ${selected.slice(0, 8)}…`} sub={`State: ${selectedRec.state}`} className="mt-4">
            <div data-testid="pn-detail">
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                {ACTIONS.map((a) => {
                  const avail = a.available(selectedRec, detail.data?.mapping?.state);
                  return (
                    <AdminButton
                      key={a.key}
                      size="sm"
                      variant={avail ? "gold" : "ghost"}
                      disabled={!avail}
                      title={avail ? undefined : unavailableReason(a.key, selectedRec.state)}
                      onClick={() => avail && setModal({ action: a, rec: selectedRec })}
                      data-testid={`pn-action-${a.key}`}
                    >
                      {a.label}
                    </AdminButton>
                  );
                })}
              </div>
              <div data-testid="pn-audit" style={{ fontSize: 12, opacity: 0.8 }}>
                {(detail.data?.adminActions ?? []).length} admin action(s) on record.
              </div>
              {detail.data?.partnerCredit && (
                <div data-testid="pn-credit-detail" style={{ fontSize: 12, marginTop: 8, opacity: 0.85 }}>
                  {detail.data.partnerCredit.error ? (
                    <div role="alert">{detail.data.partnerCredit.message}</div>
                  ) : (
                    <>
                      <div>
                        Partner: {detail.data.partnerCredit.partner_legal_name} ({detail.data.partnerCredit.partner_id})
                      </div>
                      <div>
                        Credit reservation: {detail.data.partnerCredit.reservation_id} (
                        {detail.data.partnerCredit.reservation_status})
                      </div>
                      <div>Wallet: {detail.data.partnerCredit.wallet_status ?? "unavailable"}</div>
                      {detail.data.partnerCredit.reservationLinkConflict && (
                        <div role="alert">Credit reservation linkage requires reconciliation.</div>
                      )}
                      {detail.data.partnerCredit.destinationCreditHold?.released_at == null && (
                        <>
                          <div role="alert">
                            Destination grading is blocked pending a replacement credit reservation.
                          </div>
                          <AdminButton
                            size="sm"
                            variant="gold"
                            onClick={() =>
                              selectedRec && setModal({ action: RECOVER_CREDIT_HOLD_ACTION, rec: selectedRec })
                            }
                            data-testid="pn-recover-credit-hold"
                          >
                            Recover credit hold
                          </AdminButton>
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </Panel>
        )}

        {modal &&
          (() => {
            const highRisk = requiresTypedConfirm(modal.action.key);
            const confirmOk =
              reasonValid(reason) && (!highRisk || typedConfirm.trim() === TYPED_CONFIRM_PHRASE) && !mutation.isPending;
            return (
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="pn-modal-title"
                data-testid="pn-reason-modal"
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
                    width: "min(520px,92vw)",
                  }}
                >
                  <h3 id="pn-modal-title" style={{ marginBottom: 8 }}>
                    {modal.action.label}
                  </h3>
                  <p style={{ fontSize: 13, opacity: 0.8, marginBottom: 8 }}>
                    {modal.action.key === "recover-credit-hold"
                      ? "A replacement reservation is created before the destination can resume grading; immutable recovery evidence is recorded."
                      : "A reason is required and recorded in the append-only admin audit."}
                  </p>
                  <label
                    htmlFor="pn-reason-input"
                    style={{ display: "block", fontSize: 12, opacity: 0.8, marginBottom: 4 }}
                  >
                    Operator reason
                  </label>
                  <textarea
                    id="pn-reason-input"
                    data-testid="pn-reason-input"
                    autoFocus
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={3}
                    style={{
                      width: "100%",
                      background: "var(--admin-bg, #0d0d0d)",
                      color: "#fff",
                      borderRadius: 8,
                      padding: 8,
                    }}
                    placeholder="Operator reason…"
                  />
                  {highRisk && (
                    <div style={{ marginTop: 10 }} data-testid="pn-typed-confirm-wrap">
                      <label
                        htmlFor="pn-typed-confirm"
                        style={{ display: "block", fontSize: 12, color: "var(--admin-red, #cd8073)", marginBottom: 4 }}
                      >
                        This is a destructive action. Type {TYPED_CONFIRM_PHRASE} to proceed.
                      </label>
                      <input
                        id="pn-typed-confirm"
                        data-testid="pn-typed-confirm"
                        value={typedConfirm}
                        onChange={(e) => setTypedConfirm(e.target.value)}
                        style={{
                          width: "100%",
                          background: "var(--admin-bg, #0d0d0d)",
                          color: "#fff",
                          borderRadius: 8,
                          padding: 8,
                        }}
                        placeholder={TYPED_CONFIRM_PHRASE}
                      />
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
                    <AdminButton size="sm" variant="ghost" onClick={closeModal} data-testid="pn-modal-cancel">
                      Cancel
                    </AdminButton>
                    <AdminButton
                      size="sm"
                      variant="gold"
                      disabled={!confirmOk}
                      onClick={() => mutation.mutate({ action: modal.action, rec: modal.rec, reason })}
                      data-testid="pn-modal-confirm"
                    >
                      {mutation.isPending ? "Working…" : "Confirm"}
                    </AdminButton>
                  </div>
                </div>
              </div>
            );
          })()}
      </div>
    </AdminShell>
  );
}
