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
import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  PROFILE_FIELD_DEFS,
  profileFormFromRow,
  validateProfileForm,
  validateLegalName,
  validateInvitationForm,
  reasonError,
  canSubmit,
  diffProfile,
  isDirty,
  displayValue,
  computeChecklist,
  checklistPercent,
  profileHasDetail,
  invitationActions,
  submitAllowed,
  submitLabel,
  serverErrorMessage,
  deliveryBanner,
  type ProfileValues,
  type SubmitState,
  type FieldErrors,
} from "./partner-management-helpers";

const BASE = "/api/super-admin/partner-management";
const TABS = [
  "overview",
  "users",
  "profile",
  "contacts",
  "branding",
  "activity",
  "notes",
  "audit",
  "connector",
] as const;
type TabKey = (typeof TABS)[number];
const TAB_LABELS: Record<TabKey, string> = {
  overview: "Overview",
  users: "Users",
  profile: "Company Profile",
  contacts: "Contacts",
  branding: "Branding",
  activity: "Activity",
  notes: "Internal Notes",
  audit: "Audit",
  connector: "Connector Summary",
};

const TYPED_CONFIRM = "CONFIRM";
const USER_ROLES = ["OWNER", "ADMIN", "GRADER", "STAFF"] as const;

/** Shape of one row from GET /partners/:id/users (see listPartnerUsers in partner-management-service). */
interface PartnerUserRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  role: string;
  status: string;
  invitation_status: string | null;
  invitation_created_at?: string | null;
  invitation_delivered_at?: string | null;
  invitation_expires_at?: string | null;
  invitation_consumed_at?: string | null;
  last_login_at: string | null;
  active_sessions?: number;
  password_configured?: boolean;
  password_configured_at?: string | null;
  mfa_enabled?: boolean;
  mfa_required?: boolean;
  mfa_configured?: boolean;
  created_at: string;
}

interface OnboardingUser {
  id: string;
  email: string;
  role: string;
  userStatus: string;
  invitationStatus: string | null;
  invitationCreatedAt: string | null;
  invitationSentAt: string | null;
  invitationExpiresAt: string | null;
  acceptedAt: string | null;
  lastLoginAt: string | null;
  activeSessions: number;
  readiness: {
    organisationActive: boolean;
    userActive: boolean;
    invitationValid: boolean;
    passwordConfigured: boolean;
    passwordConfiguredAt: string | null;
    mfaRequired: boolean;
    mfaConfigured: boolean;
    locationEligible: boolean;
    loginEnabled: boolean;
    loginFlagEnabled: boolean;
    portalEnabled: boolean;
    onboardingState: string;
    blockedReasons: string[];
  };
}

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
    successMessage?: string;
    highRisk?: boolean;
    body?: ReactNode;
    /**
     * Optional single text field rendered inside the modal. This replaced `window.prompt`, which
     * could not be validated, was not keyboard-trappable, dropped the typed value on cancel and is
     * invisible to screen readers.
     */
    input?: { label: string; initial: string; testId: string; required?: boolean };
    run: (reason: string, value: string) => Promise<unknown>;
  } | null>(null);
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [modalValue, setModalValue] = useState("");
  // note modal
  const [noteBody, setNoteBody] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [userForm, setUserForm] = useState({ firstName: "", lastName: "", email: "", role: "OWNER" });
  // Company-profile editor. `profileBaseline` is the last-saved state; comparing the live form
  // against it is what drives both the before/after summary and the unsaved-changes warning.
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileForm, setProfileForm] = useState<ProfileValues>(() => profileFormFromRow(null));
  const [profileBaseline, setProfileBaseline] = useState<ProfileValues>(() => profileFormFromRow(null));
  const [legalNameForm, setLegalNameForm] = useState("");
  const [legalNameBaseline, setLegalNameBaseline] = useState("");
  const [profileReason, setProfileReason] = useState("");
  const [profileState, setProfileState] = useState<SubmitState>("idle");
  const [profileError, setProfileError] = useState<string | null>(null);
  // Invitation editor: which user is being amended (null = closed).
  const [inviteEdit, setInviteEdit] = useState<PartnerUserRow | null>(null);
  const [inviteForm, setInviteForm] = useState({ firstName: "", lastName: "", email: "", role: "OWNER" });
  const [inviteReason, setInviteReason] = useState("");
  const [inviteState, setInviteState] = useState<SubmitState>("idle");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteTouched, setInviteTouched] = useState(false);
  const [userState, setUserState] = useState<SubmitState>("idle");
  const [userError, setUserError] = useState<string | null>(null);
  // Errors are computed continuously but only SHOWN once the admin has tried to submit — a form that
  // turns red before it has been filled in reads as broken rather than helpful.
  const [userTouched, setUserTouched] = useState(false);

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
    // Also loaded on Overview: the setup checklist needs it. The detail payload does NOT carry
    // branding (getPartnerDetail returns organisation/profile/primaryContact only), so reading it
    // from `detail` silently pinned the checklist below 100% forever.
    enabled: on && (tab === "branding" || tab === "overview"),
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
  const users = useQuery({
    queryKey: pmKeys.users(partnerId),
    queryFn: () => apiRequest("GET", `${BASE}/partners/${partnerId}/users`).then((r) => r.json()),
    enabled: on && (tab === "users" || tab === "overview"),
  });
  const onboarding = useQuery({
    queryKey: [`${BASE}/partners`, partnerId, "onboarding-readiness"],
    queryFn: () => apiRequest("GET", `${BASE}/partners/${partnerId}/onboarding-readiness`).then((r) => r.json()),
    enabled: on && (tab === "users" || tab === "overview"),
  });

  // Only meaningful for the final-owner warning; the server + the 0032 DB trigger are the real guards.
  const activeOwnerCount = useMemo(
    () =>
      ((users.data?.users ?? []) as PartnerUserRow[]).filter((u) => u.role === "OWNER" && u.status === "ACTIVE").length,
    [users.data]
  );

  const org = detail.data?.organisation;
  const profile = detail.data?.profile;
  const version = profile?.version ?? 1;

  const mutation = useMutation({
    mutationFn: async (run: (reason: string, value: string) => Promise<unknown>) => run(reason, modalValue),
    onSuccess: (data: any) => {
      setBanner(
        modal?.successMessage
          ? deliveryBanner(data?.result?.deliveryStatus, modal.successMessage)
          : "Action completed."
      );
      closeModal();
      queryClient.invalidateQueries({ queryKey: pmKeys.partner(partnerId) });
      queryClient.invalidateQueries({ queryKey: pmKeys.users(partnerId) });
      queryClient.invalidateQueries({ queryKey: pmKeys.audit(partnerId) });
      queryClient.invalidateQueries({ queryKey: [`${BASE}/partners`, partnerId, "onboarding-readiness"] });
      queryClient.invalidateQueries({ queryKey: [`${BASE}/partners`] });
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
  const [userReason, setUserReason] = useState("");
  const userMutation = useMutation({
    mutationFn: async () =>
      (
        await apiRequest("POST", `${BASE}/partners/${partnerId}/users`, {
          ...userForm,
          reason: userReason,
        })
      ).json(),
    onSuccess: (d) => {
      setUserState("success");
      setUserError(null);
      setBanner(deliveryBanner(d?.result?.deliveryStatus, "Invitation created."));
      setUserOpen(false);
      setUserForm({ firstName: "", lastName: "", email: "", role: "OWNER" });
      setUserReason("");
      setUserTouched(false);
      setUserState("idle");
      queryClient.invalidateQueries({ queryKey: pmKeys.users(partnerId) });
      queryClient.invalidateQueries({ queryKey: pmKeys.partner(partnerId) });
      queryClient.invalidateQueries({ queryKey: [`${BASE}/partners`, partnerId, "onboarding-readiness"] });
    },
    onError: (err: unknown) => {
      setUserState("error");
      const msg = serverErrorMessage((err as { body?: unknown })?.body, "Invitation failed. Nothing was created.");
      setUserError(msg);
      setBanner(msg);
    },
  });

  const userRows = useMemo(() => (users.data?.users ?? []) as PartnerUserRow[], [users.data]);
  const checklist = useMemo(
    () =>
      computeChecklist({
        companyCreated: !!org,
        // "Owner invited" — deliberately NOT "owner login created": an INVITED user has no login
        // until they accept. Ticking on the mere existence of the row claimed something untrue.
        hasOwner: userRows.some((u) => u.role === "OWNER"),
        // An invitation that FAILED to send has not been sent. `invitation_status` being non-null
        // includes DELIVERY_FAILED, which would have ticked "Invitation sent" for an email that
        // demonstrably never left the building.
        hasInvitation: userRows.some((u) => !!u.invitation_status && u.invitation_status !== "DELIVERY_FAILED"),
        locationCount: statistics.data?.locationCount ?? 0,
        hasBranding: !!branding.data?.branding,
        hasProfileDetail: profileHasDetail(profile),
      }),
    [org, userRows, statistics.data, branding.data, profile]
  );

  const [profileTouched, setProfileTouched] = useState(false);
  const profileErrors: FieldErrors = useMemo(() => validateProfileForm(profileForm), [profileForm]);
  const legalNameErr = useMemo(() => validateLegalName(legalNameForm), [legalNameForm]);
  const profileChanges = useMemo(() => diffProfile(profileBaseline, profileForm), [profileBaseline, profileForm]);
  const legalNameChanged = legalNameForm.trim() !== legalNameBaseline.trim();
  const profileDirty = isDirty(profileBaseline, profileForm) || legalNameChanged;
  /*
   * SUBMIT-BLOCKING errors are scoped to the fields actually being SAVED.
   *
   * The editor is seeded straight from the stored row, and these validators are stricter than
   * whatever wrote it — a website stored as "acme.co.uk", or a phone with "ext 21", is invalid here.
   * Blocking on those locked an admin out of fixing an unrelated typo, even though saveProfile only
   * ever sends CHANGED keys, so the offending value would never have been transmitted. Only changed
   * fields can block the save; untouched legacy values still show their message as guidance.
   */
  const changedKeys = useMemo(() => new Set(profileChanges.map((c) => c.key)), [profileChanges]);
  const profileFieldErrors: FieldErrors = useMemo(() => {
    const blocking: FieldErrors = {};
    for (const [k, v] of Object.entries(profileErrors)) if (changedKeys.has(k)) blocking[k] = v;
    if (legalNameErr && legalNameChanged) blocking.legal_name = legalNameErr;
    return blocking;
  }, [profileErrors, changedKeys, legalNameErr, legalNameChanged]);

  /** Load the editor from the server row whenever the form is opened. */
  function openProfileEdit() {
    const base = profileFormFromRow(profile);
    setProfileForm(base);
    setProfileBaseline(base);
    setLegalNameForm(org?.legal_name ?? "");
    setLegalNameBaseline(org?.legal_name ?? "");
    setProfileReason("");
    setProfileError(null);
    setProfileState("idle");
    setProfileTouched(false);
    setProfileOpen(true);
  }

  function closeProfileEdit(force = false) {
    if (!force && profileDirty && !window.confirm("Discard your unsaved changes?")) return;
    setProfileOpen(false);
    setProfileState("idle");
    setProfileError(null);
  }

  /**
   * Save the editor.
   *
   * The legal name lives on partner_organisations and the rest on partner_profiles, so a change to
   * both is two audited requests. They share ONE optimistic-lock counter (partner_profiles.version),
   * and each successful write bumps it by one — hence `version + 1` for the second call. Order is
   * name-then-profile, and a failure of the second is reported explicitly as a PARTIAL save rather
   * than a flat "failed", because the first change is already committed and the admin needs to know
   * that before they retry.
   */
  async function saveProfile() {
    setProfileTouched(true);
    if (!submitAllowed(profileState)) return;
    if (Object.keys(profileFieldErrors).length > 0 || reasonError(profileReason) !== null) return;
    if (!profileDirty) {
      setProfileError("Nothing has changed.");
      return;
    }
    setProfileState("submitting");
    setProfileError(null);
    let nameSaved = false;
    try {
      let v = version;
      if (legalNameChanged) {
        await apiRequest("PATCH", `${BASE}/partners/${partnerId}/legal-name`, {
          legalName: legalNameForm.trim(),
          expectedVersion: v,
          reason: profileReason,
        });
        nameSaved = true;
        v = v + 1;
      }
      if (profileChanges.length > 0) {
        const body: Record<string, unknown> = { expectedVersion: v, reason: profileReason };
        for (const c of profileChanges) body[c.key] = profileForm[c.key].trim();
        await apiRequest("PATCH", `${BASE}/partners/${partnerId}/profile`, body);
      }
      setProfileState("success");
      setBanner("Company details saved.");
      setProfileOpen(false);
      queryClient.invalidateQueries({ queryKey: pmKeys.partner(partnerId) });
      queryClient.invalidateQueries({ queryKey: pmKeys.audit(partnerId) });
      queryClient.invalidateQueries({ queryKey: pmKeys.activity(partnerId) });
      // The list is cached with staleTime: Infinity, so without this the partners table keeps
      // showing the old legal/trading name until a hard reload.
      queryClient.invalidateQueries({ queryKey: [`${BASE}/partners`] });
    } catch (err) {
      setProfileState("error");
      const msg = serverErrorMessage((err as { body?: unknown })?.body, "Could not save. Nothing was changed.");
      if (nameSaved) {
        /*
         * The rename COMMITTED and the shared version counter moved; only the profile half failed.
         * Leaving the old baseline in place made the diff table keep listing an already-saved change
         * and made the next Save re-issue the rename with a stale expectedVersion — a guaranteed
         * VERSION_CONFLICT whose message ("someone else changed this") blamed a third party for our
         * own half-write. So: adopt the saved name as the new baseline and refetch the authoritative
         * version before the admin can retry.
         */
        setLegalNameBaseline(legalNameForm.trim());
        queryClient.invalidateQueries({ queryKey: pmKeys.partner(partnerId) });
        queryClient.invalidateQueries({ queryKey: [`${BASE}/partners`] });
        setProfileError(
          `Only part of your change was saved. The company name was updated; the remaining details were not: ${msg}`
        );
      } else {
        setProfileError(msg);
      }
    }
  }

  const inviteErrors = useMemo(() => validateInvitationForm(inviteForm), [inviteForm]);
  const userErrors = useMemo(() => validateInvitationForm(userForm), [userForm]);

  function openInviteEdit(u: PartnerUserRow) {
    setInviteEdit(u);
    setInviteForm({
      firstName: u.first_name ?? "",
      lastName: u.last_name ?? "",
      email: u.email,
      role: u.role,
    });
    setInviteReason("");
    setInviteError(null);
    setInviteState("idle");
    setInviteTouched(false);
  }

  async function saveInvitation() {
    setInviteTouched(true);
    if (!inviteEdit || !submitAllowed(inviteState)) return;
    if (Object.keys(inviteErrors).length > 0 || reasonError(inviteReason) !== null) return;
    setInviteState("submitting");
    setInviteError(null);
    try {
      const res = await apiRequest("PATCH", `${BASE}/partners/${partnerId}/users/${inviteEdit.id}/invitation`, {
        ...inviteForm,
        reason: inviteReason,
      });
      const body = (await res.json().catch(() => null)) as { result?: { deliveryStatus?: string } } | null;
      setInviteState("success");
      // NEVER claim delivery that was not confirmed. The server reports DELIVERY_NOT_CONFIGURED when
      // no transport is set up and DELIVERY_FAILED when the send threw — both return HTTP 200. Telling
      // the admin "re-sent" in those cases is the worst possible lie here: they stop chasing an
      // invitation that does not exist. The revocation half is unconditionally true and is stated as
      // such, because it happens inside the committed transaction.
      setBanner(deliveryBanner(body?.result?.deliveryStatus));
      setInviteEdit(null);
      queryClient.invalidateQueries({ queryKey: pmKeys.users(partnerId) });
      queryClient.invalidateQueries({ queryKey: pmKeys.audit(partnerId) });
      queryClient.invalidateQueries({ queryKey: [`${BASE}/partners`, partnerId, "onboarding-readiness"] });
    } catch (err) {
      setInviteState("error");
      setInviteError(serverErrorMessage((err as { body?: unknown })?.body, "Could not update the invitation."));
    }
  }

  function closeModal() {
    setModal(null);
    setReason("");
    setTyped("");
    setModalValue("");
  }
  useEffect(() => {
    if (!modal && !noteOpen && !userOpen && !profileOpen && !inviteEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The profile editor routes through closeProfileEdit so Escape cannot become a silent
      // data-loss path around the unsaved-changes check.
      if (profileOpen) {
        closeProfileEdit();
        return;
      }
      if (inviteEdit) {
        setInviteEdit(null);
        return;
      }
      closeModal();
      setNoteOpen(false);
      setUserOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // profileDirty is listed so the Escape handler always closes over the current dirty state.
  }, [modal, noteOpen, userOpen, profileOpen, inviteEdit, profileDirty]);

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
              <div style={{ marginTop: 12 }} data-testid="pm-setup-checklist">
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <div style={{ fontWeight: 600 }}>Setup checklist</div>
                  <span data-testid="pm-checklist-percent" style={{ fontSize: 12, opacity: 0.85 }}>
                    {checklistPercent(checklist)}% complete
                  </span>
                </div>
                {/*
                  Progress is exposed via role="progressbar" + aria-valuenow, not colour alone, so a
                  screen-reader user gets the same number a sighted user sees.
                */}
                <div
                  role="progressbar"
                  aria-valuenow={checklistPercent(checklist)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Partner setup completion"
                  data-testid="pm-checklist-bar"
                  style={{
                    height: 6,
                    borderRadius: 999,
                    background: "var(--admin-bg, #0d0d0d)",
                    overflow: "hidden",
                    marginBottom: 8,
                  }}
                >
                  <div
                    style={{
                      width: `${checklistPercent(checklist)}%`,
                      height: "100%",
                      background: "var(--admin-gold, #D4AF37)",
                    }}
                  />
                </div>
                {checklist.map((item) => (
                  <ChecklistItem key={item.key} state={item.state} label={item.label} hint={item.hint} />
                ))}
              </div>
              <OnboardingSection users={(onboarding.data?.users ?? []) as OnboardingUser[]} />
              {!(users.data?.users ?? []).some((u: any) => u.role === "OWNER") && (
                <div style={{ marginTop: 8 }}>
                  <AdminButton
                    size="sm"
                    variant="gold"
                    onClick={() => setUserOpen(true)}
                    data-testid="pm-create-owner-login"
                  >
                    Create owner login
                  </AdminButton>
                </div>
              )}
              <div style={{ marginTop: 8, fontSize: 13, opacity: 0.8 }}>
                Recent activity: {(activity.data?.activity ?? []).length} events
              </div>
            </div>
          </Panel>
        )}

        {tab === "users" && (
          <Panel
            title="Users"
            sub="Partner membership and invitation management"
            actions={
              <AdminButton size="sm" variant="gold" onClick={() => setUserOpen(true)} data-testid="pm-user-add-open">
                Add user
              </AdminButton>
            }
          >
            <div data-testid="pm-users">
              <OnboardingSection users={(onboarding.data?.users ?? []) as OnboardingUser[]} />
              {(users.data?.users ?? []).length === 0 ? (
                <div data-testid="pm-users-empty">No partner users yet. Create the owner login first.</div>
              ) : (
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Status</th>
                      <th>Onboarding</th>
                      <th>Last login</th>
                      <th>Invitation</th>
                      <th>Created</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(users.data?.users ?? []).map((u: any) => (
                      <tr key={u.id} data-testid={`pm-user-${u.id}`}>
                        <td>{[u.first_name, u.last_name].filter(Boolean).join(" ") || "—"}</td>
                        <td>{u.email}</td>
                        <td>{u.role}</td>
                        <td>{u.status}</td>
                        <td>
                          {u.password_configured ? "Password set" : "Password setup needed"}
                          <br />
                          {u.mfa_required ? (u.mfa_configured ? "MFA enabled" : "MFA setup needed") : "MFA not required"}
                        </td>
                        <td>{u.last_login_at ? new Date(u.last_login_at).toLocaleString() : "—"}</td>
                        <td>{u.invitation_status ?? (u.status === "ACTIVE" ? "ACCEPTED" : "—")}</td>
                        <td>{new Date(u.created_at).toLocaleString()}</td>
                        <td>
                          <UserActions
                            user={u}
                            busy={mutation.isPending}
                            openModal={setModal}
                            partnerId={partnerId}
                            activeOwnerCount={activeOwnerCount}
                            onEditInvitation={openInviteEdit}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
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
              <Field label="Address line 1" v={profile?.address_line1} />
              <Field label="Address line 2" v={profile?.address_line2} />
              <Field label="Town / city" v={profile?.address_city} />
              <Field label="Postcode" v={profile?.address_postcode} />
              <Field label="Country" v={profile?.address_country} />
              <Field label="Internal notes" v={profile?.health_note} />
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
                <span
                  style={{
                    display: "inline-block",
                    fontSize: 12,
                    opacity: 0.75,
                    padding: "4px 8px",
                    border: "1px dashed rgba(255,255,255,.2)",
                    borderRadius: 8,
                  }}
                >
                  Certificates / graded: {UNAVAILABLE_LABEL}
                </span>
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
              {modal.input && (
                <div style={{ marginBottom: 10 }}>
                  <label
                    htmlFor="pm-modal-input"
                    style={{ display: "block", fontSize: 12, opacity: 0.8, marginBottom: 4 }}
                  >
                    {modal.input.label}
                  </label>
                  <input
                    id="pm-modal-input"
                    data-testid={modal.input.testId}
                    autoFocus
                    value={modalValue}
                    onChange={(e) => setModalValue(e.target.value)}
                    style={{
                      width: "100%",
                      background: "var(--admin-bg, #0d0d0d)",
                      color: "#fff",
                      borderRadius: 8,
                      padding: 8,
                    }}
                  />
                  {modal.input.required && modalValue.trim() === "" && (
                    <div role="alert" style={{ color: "var(--admin-red, #ff6b6b)", fontSize: 12, marginTop: 4 }}>
                      {modal.input.label} is required.
                    </div>
                  )}
                </div>
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
              {modal.body && (
                <div style={{ marginTop: 8, color: "var(--admin-dim, #9c9c9c)" }} data-testid="pm-modal-body">
                  {modal.body}
                </div>
              )}
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
                    !reasonValid(reason) ||
                    (modal.highRisk && typed.trim() !== TYPED_CONFIRM) ||
                    (!!modal.input?.required && modalValue.trim() === "") ||
                    mutation.isPending
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

        {/* ---- Company profile editor ------------------------------------------------------- */}
        {profileOpen && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pm-profile-title"
            data-testid="pm-profile-modal"
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,.6)",
              display: "grid",
              placeItems: "center",
              zIndex: 50,
              padding: 16,
            }}
          >
            <div
              data-testid="pm-profile-form"
              style={{
                background: "var(--admin-panel, #141414)",
                padding: 20,
                borderRadius: 12,
                width: "min(720px,100%)",
                maxHeight: "90vh",
                overflowY: "auto",
              }}
            >
              <h3 id="pm-profile-title" style={{ marginBottom: 4 }}>
                Edit company details
              </h3>
              <p style={{ fontSize: 12, opacity: 0.75, marginBottom: 12 }}>
                Every change is recorded in the audit trail with the reason you give below.
              </p>

              {profileDirty && (
                <div
                  data-testid="pm-unsaved-warning"
                  style={{ fontSize: 12, marginBottom: 10, color: "var(--admin-gold, #D4AF37)" }}
                >
                  You have unsaved changes.
                </div>
              )}

              <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))" }}>
                <label style={{ display: "grid", gap: 4, fontSize: 12, opacity: 0.9 }}>
                  Legal company name
                  <input
                    data-testid="pm-profile-field-legal_name"
                    value={legalNameForm}
                    onChange={(e) => setLegalNameForm(e.target.value)}
                    aria-invalid={profileTouched && !!legalNameErr}
                    style={{
                      background: "var(--admin-bg, #0d0d0d)",
                      color: "#fff",
                      borderRadius: 8,
                      padding: 8,
                    }}
                  />
                  {profileTouched && legalNameErr && (
                    <span
                      role="alert"
                      data-testid="pm-profile-error-legal_name"
                      style={{ color: "var(--admin-red, #ff6b6b)" }}
                    >
                      {legalNameErr}
                    </span>
                  )}
                </label>

                {PROFILE_FIELD_DEFS.map((f) => (
                  <label
                    key={f.key}
                    style={{
                      display: "grid",
                      gap: 4,
                      fontSize: 12,
                      opacity: 0.9,
                      gridColumn: f.type === "textarea" ? "1 / -1" : undefined,
                    }}
                  >
                    {f.label}
                    {f.type === "textarea" ? (
                      <textarea
                        data-testid={`pm-profile-field-${f.key}`}
                        value={profileForm[f.key] ?? ""}
                        rows={3}
                        onChange={(e) => setProfileForm((p) => ({ ...p, [f.key]: e.target.value }))}
                        aria-invalid={profileTouched && !!profileErrors[f.key]}
                        style={{ background: "var(--admin-bg, #0d0d0d)", color: "#fff", borderRadius: 8, padding: 8 }}
                      />
                    ) : (
                      <input
                        data-testid={`pm-profile-field-${f.key}`}
                        type={f.type}
                        value={profileForm[f.key] ?? ""}
                        onChange={(e) => setProfileForm((p) => ({ ...p, [f.key]: e.target.value }))}
                        aria-invalid={profileTouched && !!profileErrors[f.key]}
                        style={{ background: "var(--admin-bg, #0d0d0d)", color: "#fff", borderRadius: 8, padding: 8 }}
                      />
                    )}
                    {f.hint && <span style={{ opacity: 0.6 }}>{f.hint}</span>}
                    {profileTouched && profileErrors[f.key] && (
                      <span
                        role="alert"
                        data-testid={`pm-profile-error-${f.key}`}
                        style={{ color: "var(--admin-red, #ff6b6b)" }}
                      >
                        {profileErrors[f.key]}
                      </span>
                    )}
                  </label>
                ))}
              </div>

              {/* Before/after summary — the admin confirms what they are changing, not just that they clicked save. */}
              {(profileChanges.length > 0 || legalNameChanged) && (
                <div style={{ marginTop: 14 }} data-testid="pm-profile-diff">
                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>What will change</div>
                  <table className="min-w-full text-left text-sm">
                    <thead>
                      <tr>
                        <th style={{ opacity: 0.6 }}>Field</th>
                        <th style={{ opacity: 0.6 }}>Before</th>
                        <th style={{ opacity: 0.6 }}>After</th>
                      </tr>
                    </thead>
                    <tbody>
                      {legalNameChanged && (
                        <tr data-testid="pm-profile-diff-legal_name">
                          <td>Legal company name</td>
                          <td style={{ opacity: 0.7 }}>{displayValue(legalNameBaseline)}</td>
                          <td>{displayValue(legalNameForm)}</td>
                        </tr>
                      )}
                      {profileChanges.map((c) => (
                        <tr key={c.key} data-testid={`pm-profile-diff-${c.key}`}>
                          <td>{c.label}</td>
                          <td style={{ opacity: 0.7 }}>{displayValue(c.before)}</td>
                          <td>{displayValue(c.after)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <label style={{ display: "grid", gap: 4, fontSize: 12, opacity: 0.9, marginTop: 14 }}>
                Reason (recorded in the audit trail)
                <textarea
                  data-testid="pm-profile-reason"
                  value={profileReason}
                  rows={2}
                  onChange={(e) => setProfileReason(e.target.value)}
                  style={{ background: "var(--admin-bg, #0d0d0d)", color: "#fff", borderRadius: 8, padding: 8 }}
                />
                {profileReason.length > 0 && reasonError(profileReason) && (
                  <span role="alert" style={{ color: "var(--admin-red, #ff6b6b)" }}>
                    {reasonError(profileReason)}
                  </span>
                )}
              </label>

              {profileError && (
                <div
                  role="alert"
                  data-testid="pm-profile-server-error"
                  style={{ marginTop: 10, color: "var(--admin-red, #ff6b6b)", fontSize: 13 }}
                >
                  {profileError}
                </div>
              )}

              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
                <AdminButton
                  size="sm"
                  variant="ghost"
                  onClick={() => closeProfileEdit()}
                  data-testid="pm-profile-cancel"
                >
                  Cancel
                </AdminButton>
                <AdminButton
                  size="sm"
                  variant="gold"
                  disabled={
                    !canSubmit(profileFieldErrors, profileReason, profileState === "submitting") || !profileDirty
                  }
                  onClick={() => void saveProfile()}
                  data-testid="pm-profile-save"
                >
                  {submitLabel(profileState, "Save changes", "Saving…")}
                </AdminButton>
              </div>
            </div>
          </div>
        )}

        {/* ---- Invitation editor ------------------------------------------------------------- */}
        {inviteEdit && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pm-invite-edit-title"
            data-testid="pm-invitation-edit-modal"
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,.6)",
              display: "grid",
              placeItems: "center",
              zIndex: 50,
              padding: 16,
            }}
          >
            <div
              data-testid="pm-invitation-edit-form"
              style={{
                background: "var(--admin-panel, #141414)",
                padding: 20,
                borderRadius: 12,
                width: "min(560px,100%)",
              }}
            >
              <h3 id="pm-invite-edit-title" style={{ marginBottom: 4 }}>
                Correct this invitation
              </h3>
              <p style={{ fontSize: 12, opacity: 0.8, marginBottom: 12 }}>
                Saving cancels the invitation link already sent and emails a fresh one to the address below. The old
                link stops working immediately.
              </p>
              <div style={{ display: "grid", gap: 10 }}>
                <UserInput
                  label="First name"
                  value={inviteForm.firstName}
                  onChange={(firstName) => setInviteForm((f) => ({ ...f, firstName }))}
                  testId="pm-invite-edit-first-name"
                  error={inviteTouched ? inviteErrors.firstName : undefined}
                />
                <UserInput
                  label="Last name"
                  value={inviteForm.lastName}
                  onChange={(lastName) => setInviteForm((f) => ({ ...f, lastName }))}
                  testId="pm-invite-edit-last-name"
                  error={inviteTouched ? inviteErrors.lastName : undefined}
                />
                <UserInput
                  label="Email"
                  type="email"
                  value={inviteForm.email}
                  onChange={(email) => setInviteForm((f) => ({ ...f, email }))}
                  testId="pm-invite-edit-email"
                  error={inviteTouched ? inviteErrors.email : undefined}
                />
                <label style={{ display: "grid", gap: 4, fontSize: 12, opacity: 0.9 }}>
                  Role
                  <select
                    value={inviteForm.role}
                    onChange={(e) => setInviteForm((f) => ({ ...f, role: e.target.value }))}
                    data-testid="pm-invite-edit-role"
                    style={{ background: "var(--admin-bg, #0d0d0d)", color: "#fff", borderRadius: 8, padding: 8 }}
                  >
                    {USER_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "grid", gap: 4, fontSize: 12, opacity: 0.9 }}>
                  Reason (recorded in the audit trail)
                  <textarea
                    value={inviteReason}
                    rows={2}
                    onChange={(e) => setInviteReason(e.target.value)}
                    data-testid="pm-invite-edit-reason"
                    style={{ background: "var(--admin-bg, #0d0d0d)", color: "#fff", borderRadius: 8, padding: 8 }}
                  />
                </label>
              </div>
              {inviteError && (
                <div
                  role="alert"
                  data-testid="pm-invite-edit-server-error"
                  style={{ marginTop: 10, color: "var(--admin-red, #ff6b6b)", fontSize: 13 }}
                >
                  {inviteError}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
                <AdminButton
                  size="sm"
                  variant="ghost"
                  onClick={() => setInviteEdit(null)}
                  data-testid="pm-invite-edit-cancel"
                >
                  Cancel
                </AdminButton>
                <AdminButton
                  size="sm"
                  variant="gold"
                  disabled={!canSubmit(inviteErrors, inviteReason, inviteState === "submitting")}
                  onClick={() => void saveInvitation()}
                  data-testid="pm-invite-edit-save"
                >
                  {submitLabel(inviteState, "Save and re-send", "Saving…")}
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

        {userOpen && (
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="pm-user-title"
            data-testid="pm-user-modal"
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
                width: "min(560px,92vw)",
              }}
            >
              <h3 id="pm-user-title" style={{ marginBottom: 8 }}>
                Create partner invitation
              </h3>
              <div style={{ display: "grid", gap: 10 }}>
                <UserInput
                  label="First name"
                  value={userForm.firstName}
                  onChange={(firstName) => setUserForm((f) => ({ ...f, firstName }))}
                  testId="pm-user-first-name"
                  error={userTouched ? userErrors.firstName : undefined}
                />
                <UserInput
                  label="Last name"
                  value={userForm.lastName}
                  onChange={(lastName) => setUserForm((f) => ({ ...f, lastName }))}
                  testId="pm-user-last-name"
                  error={userTouched ? userErrors.lastName : undefined}
                />
                <UserInput
                  label="Email"
                  value={userForm.email}
                  onChange={(email) => setUserForm((f) => ({ ...f, email }))}
                  testId="pm-user-email"
                  type="email"
                  error={userTouched ? userErrors.email : undefined}
                />
                <label style={{ display: "grid", gap: 4, fontSize: 12, opacity: 0.9 }}>
                  Role
                  <select
                    value={userForm.role}
                    onChange={(e) => setUserForm((f) => ({ ...f, role: e.target.value }))}
                    data-testid="pm-user-role"
                    style={{ background: "var(--admin-bg, #0d0d0d)", color: "#fff", borderRadius: 8, padding: 8 }}
                  >
                    {USER_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "grid", gap: 4, fontSize: 12, opacity: 0.9 }}>
                  Reason (recorded in the audit trail)
                  <textarea
                    value={userReason}
                    onChange={(e) => setUserReason(e.target.value)}
                    rows={2}
                    data-testid="pm-user-reason"
                    style={{ background: "var(--admin-bg, #0d0d0d)", color: "#fff", borderRadius: 8, padding: 8 }}
                  />
                </label>
              </div>
              {userError && (
                <div
                  role="alert"
                  data-testid="pm-user-server-error"
                  style={{ marginTop: 10, color: "var(--admin-red, #ff6b6b)", fontSize: 13 }}
                >
                  {userError}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
                <AdminButton
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setUserOpen(false);
                    setUserReason("");
                    setUserTouched(false);
                    setUserError(null);
                    setUserState("idle");
                  }}
                  data-testid="pm-user-cancel"
                >
                  Cancel
                </AdminButton>
                <AdminButton
                  size="sm"
                  variant="gold"
                  disabled={!canSubmit(userErrors, userReason, userMutation.isPending)}
                  onClick={() => {
                    setUserTouched(true);
                    if (!submitAllowed(userState)) return;
                    if (Object.keys(userErrors).length > 0 || reasonError(userReason) !== null) return;
                    setUserState("submitting");
                    userMutation.mutate();
                  }}
                  data-testid="pm-user-confirm"
                >
                  {submitLabel(userState, "Create invitation", "Creating…")}
                </AdminButton>
              </div>
            </div>
          </div>
        )}
      </div>
    </AdminShell>
  );

  // ---- edit-modal openers (the company profile now uses a real form; see saveProfile above) ----
  function openContactAdd() {
    setModalValue("");
    setModal({
      kind: "contact-add",
      title: "Add contact",
      input: { label: "Contact full name", initial: "", testId: "pm-contact-name-input", required: true },
      run: async (r, value) =>
        (
          await apiRequest("POST", `${BASE}/partners/${partnerId}/contacts`, {
            fullName: value,
            contactType: CONTACT_TYPES[0],
            reason: r,
          })
        ).json(),
    });
  }
  function openBrandingEdit() {
    const initial = branding.data?.branding?.display_name ?? "";
    setModalValue(initial);
    setModal({
      kind: "branding-edit",
      title: "Edit branding",
      input: { label: "Display name", initial, testId: "pm-branding-name-input", required: true },
      run: async (r, value) =>
        (
          await apiRequest("PUT", `${BASE}/partners/${partnerId}/branding`, {
            display_name: value,
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

/**
 * One checklist row. `unavailable` is a third state, not a synonym for "not done": device enrolment
 * and credits cannot be configured at all yet, and rendering them as an empty circle told admins to
 * go and do something impossible. The state is also written out in text, never signalled by the
 * symbol alone.
 */
function ChecklistItem({
  state,
  label,
  hint,
}: {
  state: "done" | "todo" | "unavailable";
  label: string;
  hint?: string;
}) {
  const symbol = state === "done" ? "✓" : state === "todo" ? "○" : "–";
  const stateLabel = state === "done" ? "Done" : state === "todo" ? "To do" : "Not available yet";
  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        padding: "2px 0",
        opacity: state === "unavailable" ? 0.6 : 1,
      }}
      data-testid={`pm-checklist-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`}
    >
      <span aria-hidden="true">{symbol}</span>
      <span className="sr-only">{stateLabel}:</span>
      <span style={{ opacity: state === "done" ? 0.85 : 0.65 }}>{label}</span>
      {hint && <span style={{ fontSize: 12, opacity: 0.55 }}>— {hint}</span>}
    </div>
  );
}

function OnboardingSection({ users }: { users: OnboardingUser[] }) {
  const primary = users.find((u) => u.role === "OWNER") ?? users[0] ?? null;
  if (!primary) {
    return (
      <div data-testid="pm-onboarding-section" style={{ marginTop: 14, paddingTop: 12 }}>
        <h3 style={{ fontSize: 15, fontWeight: 700 }}>Onboarding</h3>
        <div data-testid="pm-login-readiness-status">LOGIN BLOCKED</div>
        <div data-testid="pm-login-readiness-reasons">Add a partner user before login can be enabled.</div>
      </div>
    );
  }
  const ready = primary.readiness.loginEnabled;
  const invitationStatus = primary.invitationStatus ?? (primary.userStatus === "ACTIVE" ? "ACCEPTED" : "—");
  return (
    <div data-testid="pm-onboarding-section" style={{ marginTop: 14, paddingTop: 12 }}>
      <h3 style={{ fontSize: 15, fontWeight: 700 }}>Onboarding</h3>
      <div
        data-testid="pm-login-readiness-status"
        style={{
          display: "inline-flex",
          marginTop: 4,
          marginBottom: 8,
          padding: "4px 8px",
          borderRadius: 8,
          fontWeight: 700,
          background: ready ? "rgba(74, 146, 94, .2)" : "rgba(205, 128, 115, .2)",
          color: ready ? "var(--admin-green, #7fbf7f)" : "var(--admin-red, #cd8073)",
        }}
      >
        {/* Fly runs a ROLLING deploy across two machines, so a new SPA bundle can be served by
            one machine while the other still runs the previous build and returns a readiness
            object with no `onboardingState`. An unguarded .replaceAll() would throw during
            render and white-screen this page for the whole roll. */}
        {String(primary.readiness.onboardingState ?? "UNKNOWN").replaceAll("_", " ")}
      </div>
      <div style={{ display: "grid", gap: 4, gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))" }}>
        <Field label="Organisation status" v={primary.readiness.organisationActive ? "ACTIVE" : "Not active"} />
        <Field label="Partner user status" v={primary.userStatus} />
        <Field label="Email" v={primary.email} />
        <Field label="Role" v={primary.role} />
        <Field label="Invitation status" v={invitationStatus} />
        <Field label="Invitation sent" v={primary.invitationSentAt} />
        <Field label="Invitation expiry" v={primary.invitationExpiresAt} />
        <Field label="Accepted" v={primary.acceptedAt} />
        <Field label="Last login" v={primary.lastLoginAt} />
        <Field label="Active sessions" v={String(primary.activeSessions ?? 0)} />
        <Field label="Portal enabled" v={primary.readiness.portalEnabled ? "yes" : "no"} />
        <Field label="Login enabled" v={primary.readiness.loginFlagEnabled ? "yes" : "no"} />
        <Field label="Password configured" v={primary.readiness.passwordConfigured ? "yes" : "no"} />
        <Field label="MFA required" v={primary.readiness.mfaRequired ? "yes" : "no"} />
        <Field label="MFA configured" v={primary.readiness.mfaConfigured ? "yes" : "no"} />
        <Field label="Eligible location" v={primary.readiness.locationEligible ? "yes" : "no"} />
      </div>
      <div data-testid="pm-login-readiness-reasons" style={{ marginTop: 8, fontSize: 13 }}>
        {ready ? (
          "Login is currently allowed."
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {primary.readiness.blockedReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function UserInput({
  label,
  value,
  onChange,
  testId,
  type = "text",
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testId: string;
  type?: string;
  /** Inline validation message. Rendered in an alert region and linked via aria-describedby. */
  error?: string;
}) {
  const errId = `${testId}-error`;
  return (
    <label style={{ display: "grid", gap: 4, fontSize: 12, opacity: 0.9 }}>
      {label}
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
        aria-invalid={!!error}
        aria-describedby={error ? errId : undefined}
        style={{ background: "var(--admin-bg, #0d0d0d)", color: "#fff", borderRadius: 8, padding: 8 }}
      />
      {error && (
        <span id={errId} role="alert" data-testid={errId} style={{ color: "var(--admin-red, #ff6b6b)" }}>
          {error}
        </span>
      )}
    </label>
  );
}

/**
 * Super Admin per-user actions.
 *
 * Every one of these is destructive and audited, so every one goes through the page's shared
 * reason-modal (`openModal`) exactly like the partner status / contact / branding mutations do.
 * They must never fire on a bare click with a canned reason: the `reason` written to
 * partner_management_audit is the only record of WHY an operator suspended someone, and a constant
 * makes the ledger unable to tell "suspended for fraud" from "suspended by mistake".
 *
 * Actions that end a person's access (suspend, remove, revoke sessions, demote the last owner) are
 * marked highRisk, which additionally demands the typed CONFIRM.
 */
function UserActions({
  user,
  busy,
  openModal,
  partnerId,
  activeOwnerCount,
  onEditInvitation,
}: {
  user: PartnerUserRow;
  busy: boolean;
  openModal: (m: {
    kind: string;
    title: string;
    successMessage?: string;
    highRisk?: boolean;
    body?: ReactNode;
    run: (reason: string) => Promise<unknown>;
  }) => void;
  partnerId: string;
  activeOwnerCount: number;
  onEditInvitation: (u: PartnerUserRow) => void;
}) {
  const post = (path: string, body: Record<string, unknown>) => (reason: string) =>
    apiRequest("POST", `${BASE}${path}`, { ...body, reason }).then((r) => r.json());

  const [nextRole, setNextRole] = useState<(typeof USER_ROLES)[number]>(
    (USER_ROLES as readonly string[]).includes(user.role) ? (user.role as (typeof USER_ROLES)[number]) : "STAFF"
  );

  // Availability comes from the shared helper (unit-tested), not from an inline status list, so the
  // UI and the documented lifecycle rules cannot drift apart.
  const inviteAvailability = invitationActions(user.status, user.invitation_status);
  const pendingInvite = inviteAvailability.canResend;
  // Only warn when the action would actually take the tenant to zero active owners.
  const isLastActiveOwner = user.role === "OWNER" && user.status === "ACTIVE" && activeOwnerCount <= 1;
  const lastOwnerWarning = isLastActiveOwner ? (
    <p
      style={{ color: "var(--admin-red, #cd8073)", fontSize: 12, marginTop: 6 }}
      data-testid="pm-user-last-owner-warning"
    >
      This is the partner&rsquo;s only active owner. Removing or demoting them locks the partner out of their own
      account, and the database will reject it.
    </p>
  ) : null;

  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {/* Setup invitations only exist for accounts that have not completed setup. */}
      {inviteAvailability.canEdit && (
        <AdminButton
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => onEditInvitation(user)}
          data-testid={`pm-user-edit-invite-${user.id}`}
        >
          Edit invitation
        </AdminButton>
      )}
      {user.status === "INVITED" && pendingInvite && (
        <AdminButton
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            openModal({
              kind: "user-resend",
              title: `Resend the setup invitation to ${user.email}?`,
              body: <p style={{ fontSize: 12 }}>This cancels their current invitation link and emails a new one.</p>,
              run: post(`/partners/${partnerId}/users/${user.id}/resend-invitation`, {}),
            })
          }
          data-testid={`pm-user-resend-${user.id}`}
        >
          Resend
        </AdminButton>
      )}
      {user.status === "INVITED" && pendingInvite && (
        <AdminButton
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            openModal({
              kind: "user-copy-invite-link",
              title: `Copy a fresh setup link for ${user.email}?`,
              body: (
                <p style={{ fontSize: 12 }}>
                  Staging/internal only. This cancels any current invitation link, creates a fresh single-use link and
                  audits the action.
                </p>
              ),
              run: async (reason) => {
                const res = await apiRequest(
                  "POST",
                  `${BASE}/partners/${partnerId}/users/${user.id}/copy-invitation-link`,
                  {
                    reason,
                  }
                );
                const body = (await res.json()) as { result?: { invitationLink?: string } };
                const link = body.result?.invitationLink;
                if (!link) throw new Error("Invitation link copy is not available in this environment.");
                await navigator.clipboard?.writeText(link);
                return body;
              },
            })
          }
          data-testid={`pm-user-copy-invite-${user.id}`}
        >
          Copy invite link
        </AdminButton>
      )}
      <AdminButton
        size="sm"
        variant="ghost"
        disabled={busy || !pendingInvite}
        onClick={() =>
          openModal({
            kind: "user-revoke-invite",
            title: `Revoke the outstanding invitation for ${user.email}?`,
            body: <p style={{ fontSize: 12 }}>Their existing setup link stops working immediately.</p>,
            run: post(`/partners/${partnerId}/users/${user.id}/revoke-invitation`, {}),
          })
        }
        data-testid={`pm-user-revoke-invite-${user.id}`}
      >
        Revoke invite
      </AdminButton>
      <AdminButton
        size="sm"
        variant="ghost"
        disabled={busy || user.status !== "ACTIVE"}
        onClick={() =>
          openModal({
            kind: "user-suspend",
            title: `Suspend ${user.email}?`,
            highRisk: true,
            body: (
              <>
                <p style={{ fontSize: 12 }}>
                  They are signed out immediately and cannot sign in again until reactivated.
                </p>
                {lastOwnerWarning}
              </>
            ),
            run: post(`/partners/${partnerId}/users/${user.id}/status`, { status: "SUSPENDED" }),
          })
        }
        data-testid={`pm-user-suspend-${user.id}`}
      >
        Suspend
      </AdminButton>
      <AdminButton
        size="sm"
        variant="ghost"
        disabled={busy || user.status !== "SUSPENDED"}
        onClick={() =>
          openModal({
            kind: "user-reactivate",
            title: `Reactivate ${user.email}?`,
            body: (
              <p style={{ fontSize: 12 }}>They will be able to sign in again. No credential is changed or shown.</p>
            ),
            run: post(`/partners/${partnerId}/users/${user.id}/status`, { status: "ACTIVE" }),
          })
        }
        data-testid={`pm-user-reactivate-${user.id}`}
      >
        Reactivate
      </AdminButton>
      <AdminButton
        size="sm"
        variant="ghost"
        disabled={busy || user.status === "REVOKED"}
        onClick={() =>
          openModal({
            kind: "user-remove",
            title: `Remove ${user.email} from this partner?`,
            highRisk: true,
            body: (
              <>
                <p style={{ fontSize: 12 }}>
                  This is permanent. Removed members cannot be reactivated &mdash; they must be invited again from
                  scratch.
                </p>
                {lastOwnerWarning}
              </>
            ),
            run: post(`/partners/${partnerId}/users/${user.id}/status`, { status: "REVOKED" }),
          })
        }
        data-testid={`pm-user-remove-${user.id}`}
      >
        Remove
      </AdminButton>
      {/* Role picker + explicit old → new confirmation. Replaces a window.prompt that accepted any string. */}
      <select
        aria-label={`New role for ${user.email}`}
        value={nextRole}
        disabled={busy}
        onChange={(e) => setNextRole(e.target.value as (typeof USER_ROLES)[number])}
        data-testid={`pm-user-role-select-${user.id}`}
        style={{ background: "var(--admin-bg, #0d0d0d)", color: "#fff", borderRadius: 8, padding: "2px 6px" }}
      >
        {USER_ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <AdminButton
        size="sm"
        variant="ghost"
        disabled={busy || nextRole === user.role}
        onClick={() =>
          openModal({
            kind: "user-role",
            title: `Change ${user.email} from ${user.role} to ${nextRole}?`,
            highRisk: user.role === "OWNER",
            body: (
              <>
                <p style={{ fontSize: 12 }}>
                  Current role <strong>{user.role}</strong> &rarr; new role <strong>{nextRole}</strong>. They will be
                  signed out and must sign in again.
                </p>
                {nextRole !== "OWNER" ? lastOwnerWarning : null}
              </>
            ),
            run: post(`/partners/${partnerId}/users/${user.id}/role`, { role: nextRole }),
          })
        }
        data-testid={`pm-user-role-change-${user.id}`}
      >
        Change role
      </AdminButton>
      <AdminButton
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() =>
          openModal({
            kind: "user-revoke-sessions",
            title: `Sign ${user.email} out of every device?`,
            highRisk: true,
            body: (
              <p style={{ fontSize: 12 }}>
                All of their active sessions end immediately. No credential is changed or shown.
              </p>
            ),
            run: post(`/partners/${partnerId}/users/${user.id}/revoke-sessions`, {}),
          })
        }
        data-testid={`pm-user-revoke-${user.id}`}
      >
        Revoke sessions
      </AdminButton>
      <AdminButton
        size="sm"
        variant="ghost"
        disabled={busy || user.status !== "ACTIVE"}
        onClick={() =>
          openModal({
            kind: "user-password-reset",
            title: `Send a password-setup link to ${user.email}?`,
            successMessage: "Password setup link issued.",
            highRisk: true,
            body: <p style={{ fontSize: 12 }}>This sends a fresh single-use link. The password and link are never shown to MintVault staff.</p>,
            run: post(`/partners/${partnerId}/users/${user.id}/password-reset`, {}),
          })
        }
        data-testid={`pm-user-password-reset-${user.id}`}
      >
        Send password setup
      </AdminButton>
      <AdminButton
        size="sm"
        variant="ghost"
        disabled={busy || user.status !== "ACTIVE"}
        onClick={() =>
          openModal({
            kind: "user-reset-mfa",
            title: `Reset MFA for ${user.email}?`,
            highRisk: true,
            body: <p style={{ fontSize: 12 }}>All MFA methods and recovery codes are disabled and every active session is revoked. The user must enrol a new authenticator.</p>,
            run: post(`/partners/${partnerId}/users/${user.id}/reset-mfa`, {}),
          })
        }
        data-testid={`pm-user-reset-mfa-${user.id}`}
      >
        Reset MFA
      </AdminButton>
    </div>
  );
}
