/**
 * G5 Super-Admin Partner Management — partner detail.
 *
 * In-page tabs (Overview / Company Profile / Contacts / Branding / Activity / Internal Notes / Audit /
 * Connector Summary) over the requireAdmin partner-management API. Mutations open a required-reason
 * modal; a status change to SUSPENDED/REVOKED additionally requires a typed CONFIRM and carries the
 * expectedVersion optimistic lock. Status changes are business-status labels only (a visible note says
 * so). Unavailable statistics are labeled, never shown as a fake 0. No future-phase controls appear.
 * Logic is in ./partner-management-helpers (unit-tested); this is a thin renderer with data-testids.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { AdminShell, Panel, Badge, AdminButton, Chip } from "@/components/admin";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  statusBadgeVariant,
  allowedNextStatuses,
  isHighRiskStatus,
  reasonValid,
  noteValid,
  pmKeys,
  CONTACT_TYPES,
  UNAVAILABLE_LABEL,
} from "./partner-management-helpers";

const BASE = "/api/super-admin/partner-management";
const TABS = ["overview", "profile", "contacts", "branding", "activity", "notes", "audit", "connector"] as const;
type TabKey = (typeof TABS)[number];
const TAB_LABELS: Record<TabKey, string> = {
  overview: "Overview",
  profile: "Company Profile",
  contacts: "Contacts",
  branding: "Branding",
  activity: "Activity",
  notes: "Internal Notes",
  audit: "Audit",
  connector: "Connector Summary",
};

const TYPED_CONFIRM = "CONFIRM";

export default function PartnerManagementDetailPage() {
  const [, navigate] = useLocation();
  const [, params] = useRoute("/admin/partner-network/partners/:partnerId");
  const partnerId = params?.partnerId ?? "";
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<TabKey>("overview");
  const [banner, setBanner] = useState<string | null>(null);
  // generic reason modal state
  const [modal, setModal] = useState<{
    kind: string;
    title: string;
    highRisk?: boolean;
    run: (reason: string) => Promise<unknown>;
  } | null>(null);
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  // note modal
  const [noteBody, setNoteBody] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);

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
    if (authed === false) navigate(`/admin/login?next=/admin/partner-network/partners/${partnerId}`, { replace: true });
  }, [authed, navigate, partnerId]);

  const on = authed === true && !!partnerId;
  const detail = useQuery({
    queryKey: pmKeys.partner(partnerId),
    queryFn: () => apiRequest("GET", `${BASE}/partners/${partnerId}`).then((r) => r.json()),
    enabled: on,
  });
  const contacts = useQuery({
    queryKey: pmKeys.contacts(partnerId),
    queryFn: () => apiRequest("GET", `${BASE}/partners/${partnerId}/contacts`).then((r) => r.json()),
    enabled: on && tab === "contacts",
  });
  const branding = useQuery({
    queryKey: pmKeys.branding(partnerId),
    queryFn: () => apiRequest("GET", `${BASE}/partners/${partnerId}/branding`).then((r) => r.json()),
    enabled: on && tab === "branding",
  });
  const notes = useQuery({
    queryKey: pmKeys.notes(partnerId),
    queryFn: () => apiRequest("GET", `${BASE}/partners/${partnerId}/notes`).then((r) => r.json()),
    enabled: on && tab === "notes",
  });
  const activity = useQuery({
    queryKey: pmKeys.activity(partnerId),
    queryFn: () => apiRequest("GET", `${BASE}/partners/${partnerId}/activity`).then((r) => r.json()),
    enabled: on && (tab === "activity" || tab === "overview"),
  });
  const statistics = useQuery({
    queryKey: pmKeys.statistics(partnerId),
    queryFn: () => apiRequest("GET", `${BASE}/partners/${partnerId}/statistics`).then((r) => r.json()),
    enabled: on && (tab === "connector" || tab === "overview"),
  });
  const audit = useQuery({
    queryKey: pmKeys.audit(partnerId),
    queryFn: () => apiRequest("GET", `${BASE}/partners/${partnerId}/audit`).then((r) => r.json()),
    enabled: on && tab === "audit",
  });

  const org = detail.data?.organisation;
  const profile = detail.data?.profile;
  const version = profile?.version ?? 1;

  const mutation = useMutation({
    mutationFn: async (run: (reason: string) => Promise<unknown>) => run(reason),
    onSuccess: () => {
      setBanner("Action completed.");
      closeModal();
      queryClient.invalidateQueries({ queryKey: pmKeys.partner(partnerId) });
      queryClient.invalidateQueries({ queryKey: [`${BASE}/partners/${partnerId}`] });
    },
    onError: (err: unknown) =>
      setBanner((err as { body?: { error?: { message?: string } } })?.body?.error?.message ?? "Action failed."),
  });

  const noteMutation = useMutation({
    mutationFn: async (body: string) =>
      (await apiRequest("POST", `${BASE}/partners/${partnerId}/notes`, { body })).json(),
    onSuccess: () => {
      setBanner("Note added.");
      setNoteOpen(false);
      setNoteBody("");
      queryClient.invalidateQueries({ queryKey: pmKeys.notes(partnerId) });
    },
    onError: (err: unknown) =>
      setBanner((err as { body?: { error?: { message?: string } } })?.body?.error?.message ?? "Note failed."),
  });

  function closeModal() {
    setModal(null);
    setReason("");
    setTyped("");
  }
  useEffect(() => {
    if (!modal && !noteOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeModal();
        setNoteOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal, noteOpen]);

  const nextStatuses = useMemo(() => (org ? allowedNextStatuses(org.status) : []), [org]);

  if (authed === null || detail.isLoading) {
    return (
      <div
        className="admin-root"
        style={{ display: "grid", placeItems: "center", minHeight: "60vh" }}
        data-testid="pm-detail-loading"
      >
        <span style={{ color: "var(--admin-gold, #D4AF37)" }}>Loading…</span>
      </div>
    );
  }
  if (!org) {
    return (
      <AdminShell
        activeTab="dashboard"
        onTabChange={() => navigate("/admin")}
        onLogout={() => navigate("/admin")}
        title="Partner"
        crumb="Partner Network"
      >
        <Panel title="Not found">
          <div data-testid="pm-detail-notfound">Partner not found.</div>
        </Panel>
      </AdminShell>
    );
  }

  const changeStatus = (to: string) =>
    setModal({
      kind: `status-${to}`,
      title: `Change status → ${to}`,
      highRisk: isHighRiskStatus(to),
      run: async (r) =>
        (
          await apiRequest("POST", `${BASE}/partners/${partnerId}/status`, {
            status: to,
            reason: r,
            expectedVersion: version,
          })
        ).json(),
    });

  return (
    <AdminShell
      activeTab="dashboard"
      onTabChange={() => navigate("/admin")}
      onLogout={() => navigate("/admin")}
      title={org.legal_name}
      crumb="Partner Network"
    >
      <div data-testid="pm-detail-root">
        {banner && (
          <div
            data-testid="pm-detail-banner"
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
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
          <AdminButton
            size="sm"
            variant="ghost"
            onClick={() => navigate("/admin/partner-network/partners")}
            data-testid="pm-back"
          >
            ← Partners
          </AdminButton>
          <Badge variant={statusBadgeVariant(org.status)} testId="pm-detail-status">
            {org.status}
          </Badge>
          {nextStatuses.map((s) => (
            <AdminButton
              key={s}
              size="sm"
              variant="gold"
              onClick={() => changeStatus(s)}
              data-testid={`pm-status-to-${s}`}
            >
              → {s}
            </AdminButton>
          ))}
        </div>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }} data-testid="pm-tabs">
          {TABS.map((k) => (
            <Chip key={k} active={tab === k} onClick={() => setTab(k)} testId={`pm-tab-${k}`}>
              {TAB_LABELS[k]}
            </Chip>
          ))}
        </div>

        {tab === "overview" && (
          <Panel title="Overview">
            <div data-testid="pm-overview">
              <div>Legal name: {org.legal_name}</div>
              <div>Status: {org.status}</div>
              <div>Accreditation: {org.accreditation_level}</div>
              <div>Health: {org.health}</div>
              <div>Created: {new Date(org.created_at).toLocaleString()}</div>
              <div style={{ marginTop: 8, fontSize: 13, opacity: 0.8 }}>
                Recent activity: {(activity.data?.activity ?? []).length} events
              </div>
            </div>
          </Panel>
        )}

        {tab === "profile" && (
          <Panel
            title="Company Profile"
            actions={
              <AdminButton
                size="sm"
                variant="gold"
                onClick={() => openProfileEdit()}
                data-testid="pm-profile-edit-open"
              >
                Edit profile
              </AdminButton>
            }
          >
            <div data-testid="pm-profile">
              <Field label="Trading name" v={profile?.trading_name} />
              <Field label="Organisation kind" v={profile?.organisation_kind} />
              <Field label="Company number" v={profile?.company_number} />
              <Field label="VAT number" v={profile?.vat_number} />
              <Field label="Website" v={profile?.website} />
              <Field label="Primary email" v={profile?.primary_email} />
              <Field label="Primary phone" v={profile?.primary_phone} />
              <Field label="Onboarding date" v={profile?.onboarding_date} />
              <Field label="Internal tier" v={profile?.internal_tier} />
            </div>
          </Panel>
        )}

        {tab === "contacts" && (
          <Panel
            title="Contacts"
            actions={
              <AdminButton size="sm" variant="gold" onClick={() => openContactAdd()} data-testid="pm-contact-add-open">
                Add contact
              </AdminButton>
            }
          >
            <div data-testid="pm-contacts">
              {(contacts.data?.contacts ?? []).length === 0 ? (
                <div>No contacts.</div>
              ) : (
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Email</th>
                      <th>Primary</th>
                      <th>Active</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {(contacts.data?.contacts ?? []).map((c: any) => (
                      <tr key={c.id} data-testid={`pm-contact-${c.id}`}>
                        <td>{c.full_name}</td>
                        <td>{c.contact_type}</td>
                        <td>{c.email ?? "—"}</td>
                        <td>{c.is_primary ? "yes" : ""}</td>
                        <td>{c.active ? "yes" : "no"}</td>
                        <td>
                          {c.active && (
                            <AdminButton
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setModal({
                                  kind: `contact-deactivate-${c.id}`,
                                  title: "Deactivate contact",
                                  run: async (r) =>
                                    (
                                      await apiRequest(
                                        "POST",
                                        `${BASE}/partners/${partnerId}/contacts/${c.id}/deactivate`,
                                        { reason: r }
                                      )
                                    ).json(),
                                })
                              }
                              data-testid={`pm-contact-deactivate-${c.id}`}
                            >
                              Deactivate
                            </AdminButton>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Panel>
        )}

        {tab === "branding" && (
          <Panel
            title="Branding metadata"
            actions={
              <AdminButton
                size="sm"
                variant="gold"
                onClick={() => openBrandingEdit()}
                data-testid="pm-branding-edit-open"
              >
                Edit branding
              </AdminButton>
            }
          >
            <div data-testid="pm-branding">
              <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
                Metadata only — logo upload, custom-domain routing and certificate skinning are deferred.
              </div>
              <Field label="Display name" v={branding.data?.branding?.display_name} />
              <Field label="Logo key" v={branding.data?.branding?.logo_r2_key} />
              <Field label="Primary colour" v={branding.data?.branding?.primary_colour} />
              <Field label="Support email" v={branding.data?.branding?.support_email} />
              <Field label="Custom domain (status only)" v={branding.data?.branding?.custom_domain} />
              <Field label="Branding status" v={branding.data?.branding?.branding_status} />
            </div>
          </Panel>
        )}

        {tab === "activity" && (
          <Panel title="Activity">
            <div data-testid="pm-activity">
              {(activity.data?.activity ?? []).length === 0 ? (
                <div>No activity.</div>
              ) : (
                (activity.data?.activity ?? []).map((a: any, i: number) => (
                  <div
                    key={i}
                    style={{ fontSize: 13, borderBottom: "1px solid rgba(255,255,255,.06)", padding: "4px 0" }}
                  >
                    <span style={{ opacity: 0.6 }}>{new Date(a.created_at).toLocaleString()}</span> · {a.source} ·{" "}
                    {a.kind}
                    {a.detail ? ` — ${a.detail}` : ""}
                  </div>
                ))
              )}
            </div>
          </Panel>
        )}

        {tab === "notes" && (
          <Panel
            title="Internal Notes (staff-only)"
            actions={
              <AdminButton size="sm" variant="gold" onClick={() => setNoteOpen(true)} data-testid="pm-note-add-open">
                Add note
              </AdminButton>
            }
          >
            <div data-testid="pm-notes">
              <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
                Internal — never visible to partners. Append-only (no edit/delete).
              </div>
              {(notes.data?.notes ?? []).length === 0 ? (
                <div>No notes.</div>
              ) : (
                (notes.data?.notes ?? []).map((n: any) => (
                  <div
                    key={n.id}
                    style={{ fontSize: 13, borderBottom: "1px solid rgba(255,255,255,.06)", padding: "6px 0" }}
                  >
                    <div style={{ opacity: 0.6, fontSize: 12 }}>
                      {new Date(n.created_at).toLocaleString()} · {n.author_email}
                    </div>
                    <div>{n.body}</div>
                  </div>
                ))
              )}
            </div>
          </Panel>
        )}

        {tab === "audit" && (
          <Panel title="Audit">
            <div data-testid="pm-audit">
              {(audit.data?.audit ?? []).length === 0 ? (
                <div>No audit rows.</div>
              ) : (
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Actor</th>
                      <th>Action</th>
                      <th>Result</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(audit.data?.audit ?? []).map((a: any) => (
                      <tr key={a.id}>
                        <td>{new Date(a.created_at).toLocaleString()}</td>
                        <td>{a.actor_email}</td>
                        <td>{a.action_type}</td>
                        <td>{a.result}</td>
                        <td>{a.reason ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Panel>
        )}

        {tab === "connector" && (
          <Panel title="Connector Summary">
            <div data-testid="pm-connector">
              <Field label="Locations" v={String(statistics.data?.locationCount ?? "—")} />
              <Field label="Users" v={String(statistics.data?.userCount ?? "—")} />
              <Field label="Submissions" v={String(statistics.data?.submissionCount ?? "—")} />
              <Field
                label="Connector records by state"
                v={JSON.stringify(statistics.data?.connectorCountsByState ?? {})}
              />
              <Field label="Last connector activity" v={statistics.data?.lastConnectorActivityAt} />
              <div data-testid="pm-stat-unavailable" style={{ marginTop: 8 }}>
                <Chip active={false} onClick={() => {}}>
                  Certificates / graded: {UNAVAILABLE_LABEL}
                </Chip>
              </div>
              <div style={{ marginTop: 8 }}>
                <AdminButton
                  size="sm"
                  variant="ghost"
                  onClick={() => navigate("/admin/partner-network")}
                  data-testid="pm-connector-ops-link"
                >
                  Open Connector Operations
                </AdminButton>
              </div>
            </div>
          </Panel>
        )}

        {/* reason modal (with typed-confirm for high-risk status changes) */}
        {modal && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pm-modal-title"
            data-testid="pm-reason-modal"
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
              <h3 id="pm-modal-title" style={{ marginBottom: 8 }}>
                {modal.title}
              </h3>
              {modal.kind.startsWith("status-") && (
                <p style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
                  This is a business-status label only. No accounts, devices, sessions or feature flags are changed.
                </p>
              )}
              <label htmlFor="pm-reason" style={{ display: "block", fontSize: 12, opacity: 0.8, marginBottom: 4 }}>
                Reason
              </label>
              <textarea
                id="pm-reason"
                data-testid="pm-reason-input"
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
              />
              {modal.highRisk && (
                <div style={{ marginTop: 10 }} data-testid="pm-typed-confirm-wrap">
                  <label
                    htmlFor="pm-typed-confirm"
                    style={{ display: "block", fontSize: 12, color: "var(--admin-red, #cd8073)", marginBottom: 4 }}
                  >
                    Type {TYPED_CONFIRM} to proceed.
                  </label>
                  <input
                    id="pm-typed-confirm"
                    data-testid="pm-typed-confirm"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    style={{
                      width: "100%",
                      background: "var(--admin-bg, #0d0d0d)",
                      color: "#fff",
                      borderRadius: 8,
                      padding: 8,
                    }}
                  />
                </div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
                <AdminButton size="sm" variant="ghost" onClick={closeModal} data-testid="pm-modal-cancel">
                  Cancel
                </AdminButton>
                <AdminButton
                  size="sm"
                  variant="gold"
                  disabled={
                    !reasonValid(reason) || (modal.highRisk && typed.trim() !== TYPED_CONFIRM) || mutation.isPending
                  }
                  onClick={() => mutation.mutate(modal.run)}
                  data-testid="pm-modal-confirm"
                >
                  {mutation.isPending ? "Working…" : "Confirm"}
                </AdminButton>
              </div>
            </div>
          </div>
        )}

        {/* note modal */}
        {noteOpen && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pm-note-title"
            data-testid="pm-note-modal"
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
              <h3 id="pm-note-title" style={{ marginBottom: 8 }}>
                Add internal note
              </h3>
              <label htmlFor="pm-note-body" style={{ display: "block", fontSize: 12, opacity: 0.8, marginBottom: 4 }}>
                Note (internal, append-only)
              </label>
              <textarea
                id="pm-note-body"
                data-testid="pm-note-input"
                autoFocus
                value={noteBody}
                onChange={(e) => setNoteBody(e.target.value)}
                rows={4}
                style={{
                  width: "100%",
                  background: "var(--admin-bg, #0d0d0d)",
                  color: "#fff",
                  borderRadius: 8,
                  padding: 8,
                }}
              />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
                <AdminButton size="sm" variant="ghost" onClick={() => setNoteOpen(false)} data-testid="pm-note-cancel">
                  Cancel
                </AdminButton>
                <AdminButton
                  size="sm"
                  variant="gold"
                  disabled={!noteValid(noteBody) || noteMutation.isPending}
                  onClick={() => noteMutation.mutate(noteBody.trim())}
                  data-testid="pm-note-confirm"
                >
                  {noteMutation.isPending ? "Adding…" : "Add note"}
                </AdminButton>
              </div>
            </div>
          </div>
        )}
      </div>
    </AdminShell>
  );

  // ---- edit-modal openers (simple field prompts reusing the reason modal for audit reason) ----
  function openProfileEdit() {
    const trading = window.prompt("Trading name", profile?.trading_name ?? "");
    if (trading === null) return;
    setModal({
      kind: "profile-edit",
      title: "Edit profile",
      run: async (r) =>
        (
          await apiRequest("PATCH", `${BASE}/partners/${partnerId}/profile`, {
            trading_name: trading,
            expectedVersion: version,
            reason: r,
          })
        ).json(),
    });
  }
  function openContactAdd() {
    const name = window.prompt("Contact full name");
    if (!name) return;
    setModal({
      kind: "contact-add",
      title: "Add contact",
      run: async (r) =>
        (
          await apiRequest("POST", `${BASE}/partners/${partnerId}/contacts`, {
            fullName: name,
            contactType: CONTACT_TYPES[0],
            reason: r,
          })
        ).json(),
    });
  }
  function openBrandingEdit() {
    const display = window.prompt("Display name", branding.data?.branding?.display_name ?? "");
    if (display === null) return;
    setModal({
      kind: "branding-edit",
      title: "Edit branding",
      run: async (r) =>
        (
          await apiRequest("PUT", `${BASE}/partners/${partnerId}/branding`, {
            display_name: display,
            expectedVersion: branding.data?.branding?.version,
            reason: r,
          })
        ).json(),
    });
  }
}

function Field({ label, v }: { label: string; v?: string | null }) {
  return (
    <div style={{ display: "flex", gap: 8, padding: "2px 0" }}>
      <span style={{ opacity: 0.6, minWidth: 200 }}>{label}</span>
      <span>{v ?? "—"}</span>
    </div>
  );
}
