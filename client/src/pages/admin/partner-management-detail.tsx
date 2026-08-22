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
import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { AdminShell, Panel, Badge, AdminButton, Chip } from "@/components/admin";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { runAdminProtected } from "@/components/admin/admin-step-up";
import type { PartnerDeletionAssessment } from "@shared/partner-deletion";
import {
  canSuspendLocation,
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
  checklistProgress,
  googleMapsSearchUrl,
  profileHasDetail,
  invitationActions,
  submitAllowed,
  submitLabel,
  serverErrorMessage,
  deliveryBanner,
  EMPTY_PARTNER_LOCATION_ADDRESS,
  PARTNER_LOCATION_CREATE_REASONS,
  composePartnerLocationAddress,
  locationCreationAuditReason,
  validatePartnerLocationCreate,
  type ProfileValues,
  type SubmitState,
  type FieldErrors,
  type PartnerLocationAddressInput,
  type PartnerLocationCreateReason,
} from "./partner-management-helpers";
import { ReadinessPanel } from "@/components/partner/readiness-panel";
import { PartnerDrilldown } from "./partner-dashboard";
import { partnerLifecycleSummary } from "./partner-network-lifecycle";
import { PublicPartnerProfileView } from "@/components/public-partner-profile-view";
import type { AuthenticatedPublicProfileRow, AuthenticatedPublicProfileStatus } from "@shared/public-partner";

const BASE = "/api/super-admin/partner-management";
const TABS = [
  "overview",
  "cards",
  "credits",
  "users",
  "locations",
  "profile",
  "contacts",
  "branding",
  "activity",
  "notes",
  "audit",
  "connector",
] as const;
type TabKey = (typeof TABS)[number];
const LEGACY_DETAIL_TABS = [
  "overview",
  "users",
  "locations",
  "profile",
  "contacts",
  "branding",
  "activity",
  "notes",
  "audit",
  "connector",
] as const;
const LEGACY_DETAIL_TAB_LABELS: Record<(typeof LEGACY_DETAIL_TABS)[number], string> = {
  overview: "Overview",
  users: "Users",
  locations: "Locations",
  profile: "Company Profile",
  contacts: "Contacts",
  branding: "Branding",
  activity: "Activity",
  notes: "Internal Notes",
  audit: "Audit",
  connector: "Connector Summary",
};

/** The route contract for the one canonical Partner workspace. */
const WORKSPACE_TABS = [
  "overview",
  "onboarding",
  "cards",
  "staff",
  "locations",
  "stations",
  "credits",
  "activity",
  "security",
] as const;
type WorkspaceTab = (typeof WORKSPACE_TABS)[number];
const WORKSPACE_LABELS: Record<WorkspaceTab, string> = {
  overview: "Overview",
  onboarding: "Onboarding",
  cards: "Cards",
  staff: "Staff",
  locations: "Locations",
  stations: "Stations",
  credits: "Credits",
  activity: "Activity",
  security: "Security",
};
const WORKSPACE_DETAIL_TABS: Record<Exclude<WorkspaceTab, "stations">, TabKey> = {
  overview: "overview",
  onboarding: "users",
  cards: "cards",
  staff: "users",
  locations: "locations",
  credits: "credits",
  activity: "activity",
  security: "audit",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isWorkspaceTab(value: string | undefined): value is WorkspaceTab {
  return !!value && (WORKSPACE_TABS as readonly string[]).includes(value);
}

const TYPED_CONFIRM = "CONFIRM";
const USER_ROLES = ["OWNER", "ADMIN", "GRADER", "STAFF"] as const;

/** Shape of one row from GET /partners/:id/locations (listPartnerLocations, AG-1). */
interface PartnerLocationRow {
  id: string;
  publicRef: string;
  name: string;
  address: string | null;
  status: "PENDING" | "ACTIVE" | "SUSPENDED";
  createdAt: string;
  /** Stations enrolled here, excluding REVOKED. */
  stationCount: number;
  /** Users pinned to this floor. Org-wide roles are deliberately not counted. */
  assignedUserCount: number;
  publicProfileConfigured: boolean;
  publicProfileReady: boolean;
  publicProfileLive: boolean;
  publicProfileBlockingReasons: string[];
  publicProfileUrl: string;
}

interface AdminGooglePresenceRow {
  locationId: string;
  state: "NOT_CONNECTED" | "CONNECTING" | "CONNECTED" | "ACTION_REQUIRED" | "REVOKED" | "ERROR";
  businessName: string | null;
  businessAddress: string | null;
  placeId: string | null;
  mapsUrl: string | null;
  lastSyncAt: string | null;
}

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

interface PartnerQueueItem {
  certId: number;
  certIdStr: string;
  cardName: string | null;
  graderStatus: string;
}

export default function PartnerManagementDetailPage() {
  const [pathname, navigate] = useLocation();
  const [, canonicalParams] = useRoute("/admin/partners/:partnerId");
  const [, canonicalWorkspaceParams] = useRoute("/admin/partners/:partnerId/:workspaceTab");
  const [, legacyParams] = useRoute("/admin/partner-network/partners/:partnerId");
  const partnerId = canonicalWorkspaceParams?.partnerId ?? canonicalParams?.partnerId ?? legacyParams?.partnerId ?? "";
  const requestedWorkspaceTab = canonicalWorkspaceParams?.workspaceTab;
  const workspaceTab: WorkspaceTab = isWorkspaceTab(requestedWorkspaceTab) ? requestedWorkspaceTab : "overview";
  const [administrationTab, setAdministrationTab] = useState<TabKey | null>(null);
  const tab: TabKey =
    administrationTab ?? (workspaceTab === "stations" ? "overview" : WORKSPACE_DETAIL_TABS[workspaceTab]);
  const isLegacyPath = pathname.startsWith("/admin/partner-network/partners/");
  // Canonical workspace URLs reject malformed identifiers locally. The older retained route is
  // deliberately left to its existing server-side not-found behaviour until its retirement date.
  const validPartnerId = pathname.startsWith("/admin/partner-network/partners/") || UUID_RE.test(partnerId);
  const [authed, setAuthed] = useState<boolean | null>(null);
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
    /**
     * `mustEqual` turns the field from "not empty" into "exactly this". Used by permanent deletion,
     * where the whole point of typing the shop's name is that it identifies WHICH shop — so text
     * that cannot possibly work must not enable a destructive button and send the operator to a
     * server refusal with no inline explanation.
     */
    input?: { label: string; initial: string; testId: string; required?: boolean; mustEqual?: string };
    /**
     * A SECOND optional field, added for locations: a shop floor is created with a name and an
     * address together, and splitting that into two sequential one-field dialogs would mean a
     * location existed briefly with no address and two audit rows describing one act.
     */
    input2?: { label: string; initial: string; testId: string; required?: boolean };
    run: (reason: string, value: string, value2: string) => Promise<unknown>;
  } | null>(null);
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [modalValue, setModalValue] = useState("");
  const [modalValue2, setModalValue2] = useState("");
  const [locationAddress, setLocationAddress] = useState<PartnerLocationAddressInput>(EMPTY_PARTNER_LOCATION_ADDRESS);
  const [locationReason, setLocationReason] = useState<PartnerLocationCreateReason>("new_partner_location");
  const [locationOtherExplanation, setLocationOtherExplanation] = useState("");
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
    if (authed === false)
      navigate(
        `/admin/login?next=${encodeURIComponent(`${pathname}${window.location.search}${window.location.hash}`)}`,
        { replace: true }
      );
  }, [authed, navigate, pathname]);

  const on = authed === true && validPartnerId;
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
  const locations = useQuery({
    queryKey: pmKeys.locations(partnerId),
    queryFn: () => apiRequest("GET", `${BASE}/partners/${partnerId}/locations`).then((r) => r.json()),
    enabled: on && tab === "locations",
  });
  const googlePresence = useQuery<{ available: boolean; locations: AdminGooglePresenceRow[] }>({
    queryKey: [`${BASE}/partners`, partnerId, "google-presence"],
    queryFn: () => apiRequest("GET", `${BASE}/partners/${partnerId}/google-presence`).then((r) => r.json()),
    enabled: on && tab === "locations",
  });
  const publicProfileStatus = useQuery<AuthenticatedPublicProfileStatus>({
    queryKey: ["/api/super-admin/grading-partners", partnerId, "public-profile"],
    queryFn: () => apiRequest("GET", `/api/super-admin/grading-partners/${partnerId}/public-profile`).then((r) => r.json()),
    enabled: on && tab === "locations",
  });
  const [publicPreview, setPublicPreview] = useState<AuthenticatedPublicProfileRow | null>(null);
  const publicPreviewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const publicPreviewWasOpenRef = useRef(false);
  useEffect(() => {
    if (!publicPreview && publicPreviewWasOpenRef.current) {
      publicPreviewWasOpenRef.current = false;
      publicPreviewTriggerRef.current?.focus();
    }
  }, [publicPreview]);
  const onboarding = useQuery({
    queryKey: [`${BASE}/partners`, partnerId, "onboarding-readiness"],
    queryFn: () => apiRequest("GET", `${BASE}/partners/${partnerId}/onboarding-readiness`).then((r) => r.json()),
    enabled: on && (tab === "users" || tab === "overview"),
  });
  // R1 remains the only Partner-scoped QA read. The link carries the numeric cert id into the
  // existing Staff workstation; this page never opens, approves, returns or rejects a grade.
  const partnerQueue = useQuery<{ queue: PartnerQueueItem[] }>({
    queryKey: ["/api/admin/grading-queue", { partnerId }],
    queryFn: () =>
      apiRequest("GET", `/api/admin/grading-queue?status=all&partnerId=${encodeURIComponent(partnerId)}`).then((r) =>
        r.json()
      ),
    enabled: on && workspaceTab === "cards",
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
    mutationFn: async (run: (reason: string, value: string, value2: string) => Promise<unknown>) =>
      run(
        modal?.kind === "location-create"
          ? (locationCreationAuditReason(locationReason, locationOtherExplanation) ?? "")
          : reason,
        modalValue,
        modal?.kind === "location-create" ? (composePartnerLocationAddress(locationAddress) ?? "") : modalValue2
      ),
    onSuccess: (data: any) => {
      setBanner(
        modal?.successMessage ? deliveryBanner(data?.result?.deliveryStatus, modal.successMessage) : "Action completed."
      );
      const deleted = modal?.kind === "partner-permanent-delete";
      closeModal();
      /*
       * A deleted Partner has no detail page left to refresh. Staying here would immediately re-fetch
       * a record that no longer exists and replace a successful deletion with "Partner not found" —
       * so the operator is returned to the directory, where the removal is visible.
       */
      if (deleted) {
        queryClient.invalidateQueries({ queryKey: [`${BASE}/partners`] });
        navigate(isLegacyPath ? "/admin/partner-network/partners" : "/admin/partners/directory");
        return;
      }
      queryClient.invalidateQueries({ queryKey: pmKeys.partner(partnerId) });
      queryClient.invalidateQueries({ queryKey: pmKeys.users(partnerId) });
      queryClient.invalidateQueries({ queryKey: pmKeys.locations(partnerId) });
      queryClient.invalidateQueries({ queryKey: ["/api/super-admin/grading-partners", partnerId, "public-profile"] });
      queryClient.invalidateQueries({ queryKey: pmKeys.audit(partnerId) });
      queryClient.invalidateQueries({ queryKey: [`${BASE}/partners`, partnerId, "onboarding-readiness"] });
      queryClient.invalidateQueries({ queryKey: [`${BASE}/partners`] });
    },
    onError: (err: unknown) => {
      const body = (err as { body?: { error?: { code?: string; message?: string } } })?.body?.error;
      setBanner(
        modal?.kind === "location-create" &&
          body?.code === "VALIDATION_ERROR" &&
          body.message === "A field value is not permitted."
          ? "Location creation cannot be recorded because the Partner audit schema is incomplete. Apply migration 0084_partner_location_management.sql."
          : (body?.message ?? "Action failed.")
      );
    },
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
  const lifecycle = partnerLifecycleSummary(partnerId, onboarding.data?.operational);

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
      queryClient.invalidateQueries({ queryKey: pmKeys.locations(partnerId) });
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
    setModalValue2("");
    setLocationAddress(EMPTY_PARTNER_LOCATION_ADDRESS);
    setLocationReason("new_partner_location");
    setLocationOtherExplanation("");
  }

  /**
   * Open a modal AND seed its fields from their declared `initial` values.
   *
   * The older openers below seed `modalValue` by hand immediately before `setModal`, which works
   * but means the initial value is stated twice and a caller that forgets the first half silently
   * gets an empty box — an "Edit" dialog that opens blank reads as "this location has no name" and
   * invites the operator to retype it. Declaring `initial` and having it honoured removes that
   * class of bug for every new caller.
   */
  function openModalSeeded(m: NonNullable<typeof modal>) {
    setModalValue(m.input?.initial ?? "");
    setModalValue2(m.input2?.initial ?? "");
    if (m.kind === "location-create") {
      setLocationAddress(EMPTY_PARTNER_LOCATION_ADDRESS);
      setLocationReason("new_partner_location");
      setLocationOtherExplanation("");
    }
    setModal(m);
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
  const publicByLocation = new Map(
    (publicProfileStatus.data?.locations ?? []).map((location) => [location.id, location] as const)
  );

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
          await runAdminProtected(() =>
            apiRequest("POST", `${BASE}/partners/${partnerId}/status`, {
              status: to,
              reason: r,
              expectedVersion: version,
            })
          )
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
        {publicPreview?.preview && (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) setPublicPreview(null);
            }}
          >
            <DialogContent
              className="max-h-[90vh] max-w-6xl overflow-y-auto bg-[#FAFAF8] p-6 text-[#171717]"
              data-testid="admin-public-profile-preview-dialog"
            >
              <DialogHeader className="mb-2 border-b border-[#D8D2C7] pb-4 pr-8">
                <p className="text-xs font-semibold uppercase tracking-wider text-[#765B00]">Private Super Admin preview</p>
                <DialogTitle className="text-xl">Exact customer view — version {publicPreview.version}</DialogTitle>
                <DialogDescription>Escape closes this private preview and returns focus to the action that opened it.</DialogDescription>
              </DialogHeader>
              <PublicPartnerProfileView location={publicPreview.preview} />
            </DialogContent>
          </Dialog>
        )}
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
            onClick={() => navigate(isLegacyPath ? "/admin/partner-network/partners" : "/admin/partners/directory")}
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

        {isLegacyPath ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }} data-testid="pm-tabs">
            {LEGACY_DETAIL_TABS.map((key) => (
              <Chip key={key} active={tab === key} onClick={() => setAdministrationTab(key)} testId={`pm-tab-${key}`}>
                {LEGACY_DETAIL_TAB_LABELS[key]}
              </Chip>
            ))}
          </div>
        ) : (
          <nav
            aria-label="Partner workspace"
            style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}
            data-testid="pm-workspace-tabs"
          >
            {WORKSPACE_TABS.map((key) => {
              const href = key === "overview" ? `/admin/partners/${partnerId}` : `/admin/partners/${partnerId}/${key}`;
              return (
                <Chip
                  key={key}
                  active={workspaceTab === key && !administrationTab}
                  onClick={() => {
                    setAdministrationTab(null);
                    navigate(href);
                  }}
                  testId={`pm-workspace-tab-${key}`}
                >
                  {WORKSPACE_LABELS[key]}
                </Chip>
              );
            })}
          </nav>
        )}
        {pathname.startsWith("/admin/partner-network/") && (
          <div role="status" style={{ fontSize: 12, opacity: 0.75, marginBottom: 12 }}>
            This legacy Partner URL is retained for compatibility. Use the workspace navigation above for the canonical
            routes.
          </div>
        )}

        {workspaceTab === "onboarding" && (
          <Panel title="Onboarding" sub="Operational readiness and owner access.">
            <div style={{ marginBottom: 12 }}>
              <Link href={`/admin/partners/${partnerId}/onboarding`} data-testid="pm-open-guided-onboarding">
                Continue guided first-shop onboarding
              </Link>
            </div>
            <ReadinessPanel readiness={onboarding.data?.operational} audience="SUPER_ADMIN" />
          </Panel>
        )}

        {workspaceTab === "cards" && (
          <Panel title="Cards" sub="Current Partner pipeline. Grading and review remain in Staff.">
            <PartnerDrilldown partnerId={partnerId} tab="submissions" />
            <div style={{ marginTop: 16 }} data-testid="pm-partner-qa">
              <div style={{ fontWeight: 600, marginBottom: 6 }}>QA review queue</div>
              {partnerQueue.isLoading ? (
                <div role="status">Loading Partner QA items…</div>
              ) : (partnerQueue.data?.queue ?? []).filter((item) => item.graderStatus === "pending_review").length ===
                0 ? (
                <div>No Partner cards are awaiting QA review.</div>
              ) : (
                <ul>
                  {(partnerQueue.data?.queue ?? [])
                    .filter((item) => item.graderStatus === "pending_review")
                    .map((item) => (
                      <li key={item.certId}>
                        <a href={`/admin/staff?certId=${item.certId}`} className="underline">
                          Review {item.certIdStr} {item.cardName ? `— ${item.cardName}` : ""}
                        </a>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          </Panel>
        )}

        {workspaceTab === "credits" && (
          <Panel title="Credits" sub="Existing wallet authority and audited adjustment controls.">
            <PartnerDrilldown partnerId={partnerId} tab="wallet" />
          </Panel>
        )}

        {workspaceTab === "security" && (
          <Panel title="Security" sub="Partner security state and audit records.">
            <PartnerDrilldown partnerId={partnerId} tab="security" />
          </Panel>
        )}

        {((workspaceTab === "overview" && !administrationTab) || (isLegacyPath && tab === "overview")) && (
          <Panel title="Overview">
            <div data-testid="pm-overview">
              <div>Legal name: {org.legal_name}</div>
              <div>Status: {org.status}</div>
              <div>Accreditation: {org.accreditation_level}</div>
              <div>Health: {org.health}</div>
              <div>Created: {new Date(org.created_at).toLocaleString()}</div>
              <section
                aria-label="Partner lifecycle"
                data-testid="pm-lifecycle-summary"
                style={{ marginTop: 12, padding: 12, border: "1px solid rgba(255,255,255,.14)", borderRadius: 8 }}
              >
                <div style={{ fontWeight: 600 }}>Current stage: {lifecycle?.currentStage ?? "—"}</div>
                {lifecycle ? (
                  <>
                    <div style={{ marginTop: 6, fontSize: 13 }}>
                      Completed: {lifecycle.completed.length ? lifecycle.completed.join(" · ") : "—"}
                    </div>
                    <div style={{ marginTop: 6, fontSize: 13 }}>
                      Blockers: {lifecycle.blockers.length ? lifecycle.blockers.join(" · ") : "None"}
                    </div>
                    {lifecycle.nextAction ? (
                      <Link
                        href={lifecycle.nextAction.href}
                        className="underline"
                        data-testid="pm-lifecycle-next-action"
                        style={{ display: "inline-block", marginTop: 8, fontSize: 13 }}
                      >
                        Next action: {lifecycle.nextAction.label}
                      </Link>
                    ) : (
                      <div style={{ marginTop: 8, fontSize: 13 }}>Next action: Start grading when work arrives.</div>
                    )}
                  </>
                ) : (
                  <div style={{ marginTop: 6, fontSize: 13 }}>Readiness is unavailable right now.</div>
                )}
              </section>
              <ReadinessPanel readiness={onboarding.data?.operational} audience="SUPER_ADMIN" />
              <div style={{ marginTop: 12 }} data-testid="pm-setup-checklist">
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <div style={{ fontWeight: 600 }}>Administrative setup</div>
                  <span data-testid="pm-checklist-progress" style={{ fontSize: 12, opacity: 0.85 }}>
                    {checklistProgress(checklist).done} of {checklistProgress(checklist).total} details recorded
                  </span>
                </div>
                <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
                  Record-keeping only. These do not affect whether the shop can grade.
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
              <div style={{ marginTop: 12 }}>
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Partner administration</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {(["profile", "contacts", "branding", "notes", "connector"] as const).map((key) => (
                    <Chip
                      key={key}
                      active={false}
                      onClick={() => setAdministrationTab(key)}
                      testId={`pm-admin-tab-${key}`}
                    >
                      {
                        {
                          profile: "Company Profile",
                          contacts: "Contacts",
                          branding: "Branding",
                          notes: "Internal Notes",
                          connector: "Connector Summary",
                        }[key]
                      }
                    </Chip>
                  ))}
                </div>
              </div>
            </div>
          </Panel>
        )}

        {(workspaceTab === "onboarding" || workspaceTab === "staff" || (isLegacyPath && tab === "users")) && (
          <Panel
            title={workspaceTab === "onboarding" ? "Onboarding access" : "Staff"}
            sub={
              workspaceTab === "onboarding"
                ? "Owner invitation and login readiness."
                : "Partner membership and invitation management"
            }
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
                          {u.mfa_required
                            ? u.mfa_configured
                              ? "MFA enabled"
                              : "MFA setup needed"
                            : "MFA not required"}
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

        {/*
          LOCATIONS (AG-1). The backend has been proven since 0084 and had no operator surface at
          all: a partner's second shop floor could only be created by hand in SQL. Every route here
          is the canonical partner-management one. The older super-admin suspend route is
          deliberately NOT used: it predates AG-1 and carries none of its invariants — no
          last-active-location guard and no partner_management_audit row — and a test asserts this
          file never names it.
        */}
        {(workspaceTab === "locations" || (isLegacyPath && tab === "locations")) && (
          <Panel
            title="Locations"
            sub="Shop floors belonging to this partner. A location id is never reissued — stations, Card Jobs, certificate origin snapshots and audit rows all point at it."
            actions={
              <AdminButton
                size="sm"
                variant="gold"
                disabled={mutation.isPending}
                data-testid="pm-location-create"
                onClick={() =>
                  openModalSeeded({
                    kind: "location-create",
                    title: "Add a location",
                    successMessage: "Location created.",
                    input: { label: "Location name", initial: "", testId: "pm-location-name", required: true },
                    run: async (r, name, address) =>
                      (
                        await apiRequest("POST", `${BASE}/partners/${partnerId}/locations`, {
                          name,
                          address: address.trim() === "" ? null : address,
                          reason: r,
                        })
                      ).json(),
                  })
                }
              >
                Add location
              </AdminButton>
            }
          >
            <div data-testid="pm-locations">
              {locations.isLoading ? (
                <div data-testid="pm-locations-loading">Loading locations…</div>
              ) : (locations.data?.locations ?? []).length === 0 ? (
                <div data-testid="pm-locations-empty">
                  This partner has no locations. Every partner needs at least one active shop floor before a station can
                  be enrolled.
                </div>
              ) : (
                <table className="min-w-full text-left text-sm">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Reference</th>
                      <th>Address</th>
                      <th>Status</th>
                      <th>Public profile</th>
                      <th>Google Business</th>
                      <th>Stations</th>
                      <th>Assigned users</th>
                      <th>Created</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(locations.data?.locations ?? []).map((l: PartnerLocationRow) => (
                      <tr key={l.id} data-testid={`pm-location-${l.id}`}>
                        <td>{l.name}</td>
                        <td>{l.publicRef}</td>
                        <td>
                          <div>{l.address ?? "—"}</div>
                          {googleMapsSearchUrl(l.address) && (
                            <a
                              href={googleMapsSearchUrl(l.address) ?? undefined}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`Open ${l.name} address in Google Maps`}
                              data-testid={`pm-location-maps-${l.id}`}
                              className="mt-1 inline-block text-xs underline"
                            >
                              Open in Google Maps
                            </a>
                          )}
                        </td>
                        <td>
                          <Badge variant={statusBadgeVariant(l.status)} testId={`pm-location-status-${l.id}`}>
                            {l.status}
                          </Badge>
                        </td>
                        <td data-testid={`pm-location-public-${l.id}`}>
                          {(() => {
                            const publicLocation = publicByLocation.get(l.id);
                            if (publicProfileStatus.data?.available === false) return <div>Migration not applied — private</div>;
                            if (!publicLocation) return <div>{publicProfileStatus.isLoading ? "Loading…" : "Partner consent required"}</div>;
                            return <div>
                              <div>{publicLocation.publication.live ? "Live" : publicLocation.publication.approved ? "Approved — not live" : publicLocation.publication.readyForApproval ? "Ready for approval" : "Not ready"}</div>
                              <div className="text-xs text-muted-foreground">{publicLocation.privacyState.replaceAll("_", " ")}</div>
                              {publicLocation.preview && (
                                <button
                                  type="button"
                                  className="mr-2 text-xs underline"
                                  onClick={(event) => {
                                    publicPreviewTriggerRef.current = event.currentTarget;
                                    publicPreviewWasOpenRef.current = true;
                                    setPublicPreview(publicLocation);
                                  }}
                                >
                                  View public profile
                                </button>
                              )}
                              {publicLocation.publication.live && (
                                <a href={publicLocation.publicUrl} target="_blank" rel="noopener noreferrer" className="text-xs underline">
                              Open public page
                                </a>
                              )}
                            </div>;
                          })()}
                        </td>
                        <td data-testid={`pm-location-google-${l.id}`}>
                          {(() => {
                            const google = googlePresence.data?.locations.find((row) => row.locationId === l.id);
                            if (googlePresence.data?.available === false) return "Not configured";
                            if (!google) return googlePresence.isLoading ? "Loading…" : "Not connected";
                            return (
                              <div>
                                <div>{google.state.replaceAll("_", " ")}</div>
                                {google.businessName && <div className="text-xs text-muted-foreground">{google.businessName}</div>}
                                {google.lastSyncAt && (
                                  <div className="text-xs text-muted-foreground">
                                    Last sync {new Date(google.lastSyncAt).toLocaleString()}
                                  </div>
                                )}
                                {google.placeId && <div className="text-xs text-muted-foreground">Place ID {google.placeId}</div>}
                                {google.mapsUrl && (
                                  <a
                                    href={google.mapsUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-xs underline"
                                    aria-label={`Open ${google.businessName || l.name} Google Business listing in Google Maps`}
                                  >
                                    Open in Google Maps
                                  </a>
                                )}
                              </div>
                            );
                          })()}
                        </td>
                        {/*
                          stationCount excludes REVOKED and is NOT the same number the suspend
                          confirmation reports (which counts ACTIVE only). Labelled so the two
                          cannot be read as disagreeing.
                        */}
                        <td data-testid={`pm-location-stations-${l.id}`}>{l.stationCount} enrolled</td>
                        <td>{l.assignedUserCount}</td>
                        <td>{new Date(l.createdAt).toLocaleString()}</td>
                        <td>
                          <LocationActions
                            location={l}
                            publication={publicByLocation.get(l.id)}
                            profileVersion={publicProfileStatus.data?.profile?.version}
                            partnerId={partnerId}
                            busy={mutation.isPending}
                            activeLocationCount={
                              (locations.data?.locations ?? []).filter(
                                (row: PartnerLocationRow) => row.status === "ACTIVE"
                              ).length
                            }
                            openModal={openModalSeeded}
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

        {((workspaceTab === "overview" && !administrationTab) || (isLegacyPath && tab === "overview")) && (
          <PermanentDeletionPanel
            partnerId={partnerId}
            legalName={org.legal_name}
            busy={mutation.isPending}
            /*
             * openModalSeeded, NOT setModal. `modalValue` is ONE piece of state shared by every
             * dialog on this page, and several openers seed it by hand — openBrandingEdit writes the
             * branding display name straight into it. Opening this dialog with a bare setModal
             * touches none of that, so the DESTRUCTIVE confirmation box inherited whatever the last
             * dialog left behind; on staging (2026-08-22) it opened already containing "shop".
             *
             * The server refused it correctly and nothing was deleted, but a confirmation field that
             * arrives pre-filled and enabled is the exact trap that typing the shop's name exists to
             * prevent. openModalSeeded honours `initial: ""` and blanks the field every time.
             */
            openModal={openModalSeeded}
          />
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

        {(workspaceTab === "activity" || (isLegacyPath && tab === "activity")) && (
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

        {(workspaceTab === "security" || (isLegacyPath && tab === "audit")) && (
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
                  onClick={() => navigate("/admin/partners/infrastructure")}
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
                      {modal.kind === "location-create"
                        ? "Enter a location name."
                        : `${modal.input.label} is required.`}
                    </div>
                  )}
                  {!!modal.input.mustEqual &&
                    modalValue.trim() !== "" &&
                    modalValue.trim() !== modal.input.mustEqual && (
                      <div
                        role="alert"
                        data-testid="pm-modal-input-mismatch"
                        style={{ color: "var(--admin-red, #ff6b6b)", fontSize: 12, marginTop: 4 }}
                      >
                        That does not match. Type exactly: {modal.input.mustEqual}
                      </div>
                    )}
                </div>
              )}
              {modal.input2 && (
                <div style={{ marginBottom: 10 }}>
                  <label
                    htmlFor="pm-modal-input2"
                    style={{ display: "block", fontSize: 12, opacity: 0.8, marginBottom: 4 }}
                  >
                    {modal.input2.label}
                  </label>
                  <input
                    id="pm-modal-input2"
                    data-testid={modal.input2.testId}
                    value={modalValue2}
                    onChange={(e) => setModalValue2(e.target.value)}
                    style={{
                      width: "100%",
                      background: "var(--admin-bg, #0d0d0d)",
                      color: "#fff",
                      borderRadius: 8,
                      padding: 8,
                    }}
                  />
                  {modal.input2.required && modalValue2.trim() === "" && (
                    <div role="alert" style={{ color: "var(--admin-red, #ff6b6b)", fontSize: 12, marginTop: 4 }}>
                      {modal.input2.label} is required.
                    </div>
                  )}
                </div>
              )}
              {modal.kind === "location-create" ? (
                <LocationCreateFields
                  address={locationAddress}
                  setAddress={setLocationAddress}
                  reason={locationReason}
                  setReason={setLocationReason}
                  otherExplanation={locationOtherExplanation}
                  setOtherExplanation={setLocationOtherExplanation}
                />
              ) : (
                <>
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
                </>
              )}
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
                    (modal.kind === "location-create"
                      ? Object.keys(
                          validatePartnerLocationCreate({
                            name: modalValue,
                            address: locationAddress,
                            reason: locationReason,
                            otherExplanation: locationOtherExplanation,
                          })
                        ).length > 0
                      : !reasonValid(reason)) ||
                    (modal.highRisk && typed.trim() !== TYPED_CONFIRM) ||
                    (!!modal.input?.required && modalValue.trim() === "") ||
                    (!!modal.input?.mustEqual && modalValue.trim() !== modal.input.mustEqual) ||
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

function LocationCreateFields({
  address,
  setAddress,
  reason,
  setReason,
  otherExplanation,
  setOtherExplanation,
}: {
  address: PartnerLocationAddressInput;
  setAddress: Dispatch<SetStateAction<PartnerLocationAddressInput>>;
  reason: PartnerLocationCreateReason;
  setReason: Dispatch<SetStateAction<PartnerLocationCreateReason>>;
  otherExplanation: string;
  setOtherExplanation: Dispatch<SetStateAction<string>>;
}) {
  const errors = validatePartnerLocationCreate({ name: "location", address, reason, otherExplanation });
  const inputStyle = {
    width: "100%",
    background: "var(--admin-bg, #0d0d0d)",
    color: "#fff",
    borderRadius: 8,
    padding: 8,
  };
  const fields: Array<{ key: keyof PartnerLocationAddressInput; label: string; optional?: boolean }> = [
    { key: "line1", label: "Address line 1" },
    { key: "line2", label: "Address line 2", optional: true },
    { key: "townCity", label: "Town / City" },
    { key: "county", label: "County", optional: true },
    { key: "postcode", label: "Postcode" },
    { key: "country", label: "Country" },
  ];
  return (
    <div style={{ display: "grid", gap: 10, marginTop: 10 }} data-testid="pm-location-create-fields">
      <div style={{ fontSize: 12, opacity: 0.8 }}>Address (optional)</div>
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))" }}>
        {fields.map((field) => (
          <label key={field.key} style={{ display: "grid", gap: 4, fontSize: 12 }}>
            {field.label}
            {field.optional ? " (optional)" : ""}
            <input
              data-testid={`pm-location-address-${field.key}`}
              value={address[field.key]}
              onChange={(event) => setAddress((current) => ({ ...current, [field.key]: event.target.value }))}
              aria-invalid={!!errors[field.key]}
              style={inputStyle}
            />
            {errors[field.key] && (
              <span role="alert" style={{ color: "var(--admin-red, #ff6b6b)" }}>
                {errors[field.key]}
              </span>
            )}
          </label>
        ))}
      </div>
      {errors.address && (
        <span role="alert" style={{ color: "var(--admin-red, #ff6b6b)" }}>
          {errors.address}
        </span>
      )}
      <label htmlFor="pm-location-reason" style={{ display: "grid", gap: 4, fontSize: 12 }}>
        Reason
        <select
          id="pm-location-reason"
          data-testid="pm-location-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value as PartnerLocationCreateReason)}
          style={inputStyle}
        >
          {PARTNER_LOCATION_CREATE_REASONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {reason === "other" && (
        <label htmlFor="pm-location-other-explanation" style={{ display: "grid", gap: 4, fontSize: 12 }}>
          Please explain
          <textarea
            id="pm-location-other-explanation"
            data-testid="pm-location-other-explanation"
            value={otherExplanation}
            onChange={(event) => setOtherExplanation(event.target.value)}
            rows={3}
            aria-invalid={!!errors.otherExplanation}
            style={inputStyle}
          />
          {errors.otherExplanation && (
            <span role="alert" style={{ color: "var(--admin-red, #ff6b6b)" }}>
              {errors.otherExplanation}
            </span>
          )}
        </label>
      )}
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
  // VERSION-SKEW GUARD — same reasoning as the onboardingState guard below, applied to the whole
  // object rather than one field. Fly runs a ROLLING deploy across two Machines, so a new SPA bundle
  // can be served by one Machine while the other still runs the previous build and returns a user
  // row with no `readiness` object at all. Every unguarded deref below then throws during
  // render, and because the ONLY error boundary is at the application root
  // (client/src/App.tsx) whose sole recovery is window.location.reload(), a persistently
  // old-shaped response white-screens the entire admin SPA in a reload loop.
  const readiness = primary.readiness ?? null;
  const ready = readiness?.loginEnabled ?? false;
  const blockedReasons = readiness?.blockedReasons ?? [];
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
        {String(readiness?.onboardingState ?? "UNKNOWN").replaceAll("_", " ")}
      </div>
      <div style={{ display: "grid", gap: 4, gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))" }}>
        <Field label="Organisation status" v={readiness?.organisationActive ? "ACTIVE" : "Not active"} />
        <Field label="Partner user status" v={primary.userStatus} />
        <Field label="Email" v={primary.email} />
        <Field label="Role" v={primary.role} />
        <Field label="Invitation status" v={invitationStatus} />
        <Field label="Invitation sent" v={primary.invitationSentAt} />
        <Field label="Invitation expiry" v={primary.invitationExpiresAt} />
        <Field label="Accepted" v={primary.acceptedAt} />
        <Field label="Last login" v={primary.lastLoginAt} />
        <Field label="Active sessions" v={String(primary.activeSessions ?? 0)} />
        <Field label="Portal enabled" v={readiness?.portalEnabled ? "yes" : "no"} />
        <Field label="Login enabled" v={readiness?.loginFlagEnabled ? "yes" : "no"} />
        <Field label="Password configured" v={readiness?.passwordConfigured ? "yes" : "no"} />
        <Field label="MFA required" v={readiness?.mfaRequired ? "yes" : "no"} />
        <Field label="MFA configured" v={readiness?.mfaConfigured ? "yes" : "no"} />
        <Field label="Eligible location" v={readiness?.locationEligible ? "yes" : "no"} />
      </div>
      <div data-testid="pm-login-readiness-reasons" style={{ marginTop: 8, fontSize: 13 }}>
        {ready ? (
          "Login is currently allowed."
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {blockedReasons.length === 0 ? (
              <li>Readiness detail is unavailable — retry after the deployment settles.</li>
            ) : (
              blockedReasons.map((reason) => <li key={reason}>{reason}</li>)
            )}
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
/**
 * Per-location actions: rename/re-address, and the status change.
 *
 * There is no delete, because AG-1 has none — a location id is referenced by stations, Card Jobs,
 * certificate origin snapshots and audit rows, so it is suspended, never removed. Offering a delete
 * that the server would refuse would be a lie in the interface.
 */
function LocationActions({
  location,
  publication,
  profileVersion,
  partnerId,
  busy,
  activeLocationCount,
  openModal,
}: {
  location: PartnerLocationRow;
  publication?: AuthenticatedPublicProfileRow;
  profileVersion?: number;
  partnerId: string;
  busy: boolean;
  activeLocationCount: number;
  openModal: (m: {
    kind: string;
    title: string;
    successMessage?: string;
    highRisk?: boolean;
    body?: ReactNode;
    input?: { label: string; initial: string; testId: string; required?: boolean; mustEqual?: string };
    input2?: { label: string; initial: string; testId: string; required?: boolean };
    run: (reason: string, value: string, value2: string) => Promise<unknown>;
  }) => void;
}) {
  const suspendable = canSuspendLocation(location.status, activeLocationCount);
  const published = publication?.publication.locationListed === true;
  const canPublish =
    publication?.publication.readyForApproval === true &&
    !!publication.preview &&
    Number.isInteger(profileVersion) &&
    Number.isInteger(publication.version);
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      <AdminButton
        size="sm"
        variant="ghost"
        disabled={busy || (!published && !canPublish)}
        title={!published && !canPublish
          ? "Partner Owner consent and a complete safe public preview are required before publication."
          : undefined}
        data-testid={`pm-location-public-toggle-${location.id}`}
        onClick={() =>
          openModal({
            kind: published ? "location-unpublish" : "location-publish",
            title: `${published ? "Unpublish" : "Approve and publish"} ${location.name}`,
            successMessage: published ? "Public profile unpublished." : "Exact public profile version approved.",
            highRisk: true,
            body: (
              <div style={{ fontSize: 12, opacity: 0.85 }}>
                <p>{published
                  ? "The page will stop resolving and leave the public directory immediately."
                  : `Approve Partner-attested version ${publication?.version}. The separate View public profile action renders the exact customer DTO.`}</p>
                {!published && publication?.preview && (
                  <ul>
                    <li>Business: {publication.preview.displayName}</li>
                    <li>Location: {publication.preview.locationName}</li>
                    <li>{publication.preview.address ? `Public street address: ${publication.preview.address}` : `Private-address service area: ${publication.preview.serviceArea}`}</li>
                    <li>Maps: {publication.preview.mapsUrl ? "shown" : "not shown"}</li>
                    <li>Phone/email/website: {[publication.preview.phone, publication.preview.email, publication.preview.websiteUrl].filter(Boolean).join(" · ") || "none"}</li>
                  </ul>
                )}
              </div>
            ),
            run: async (reason) =>
              (
                await runAdminProtected(() => apiRequest(
                  "POST",
                  `/api/super-admin/grading-partners/${partnerId}/locations/${location.id}/publication`,
                  {
                    enabled: !published,
                    reason,
                    expectedProfileVersion: profileVersion,
                    expectedLocationVersion: publication?.version,
                  }
                ))
              ).json(),
          })
        }
      >
        {published ? "Unpublish" : "Approve & publish"}
      </AdminButton>
      <AdminButton
        size="sm"
        variant="ghost"
        disabled={busy}
        data-testid={`pm-location-edit-${location.id}`}
        onClick={() =>
          openModal({
            kind: "location-edit",
            title: `Edit ${location.name}`,
            successMessage: "Location updated.",
            input: { label: "Location name", initial: location.name, testId: "pm-location-name", required: true },
            input2: { label: "Address", initial: location.address ?? "", testId: "pm-location-address" },
            run: async (reason, name, address) =>
              (
                await apiRequest("PATCH", `${BASE}/partners/${partnerId}/locations/${location.id}`, {
                  name,
                  address: address.trim() === "" ? null : address,
                  reason,
                })
              ).json(),
          })
        }
      >
        Edit
      </AdminButton>

      {location.status === "ACTIVE" ? (
        <AdminButton
          size="sm"
          variant="ghost"
          disabled={busy || !suspendable}
          /*
           * Disabled rather than hidden, with the reason in the title: an operator who cannot find
           * the control assumes a bug, whereas one who sees why reaches the right action — suspend
           * the ORGANISATION — without a support call.
           */
          title={
            suspendable
              ? undefined
              : "This is the partner's only active location. Suspend the partner organisation instead — leaving it with no active location would stop all work while still looking healthy."
          }
          data-testid={`pm-location-suspend-${location.id}`}
          onClick={() =>
            openModal({
              kind: "location-status-SUSPENDED",
              title: `Suspend ${location.name}`,
              successMessage: "Location suspended.",
              highRisk: true,
              body: (
                <p style={{ fontSize: 12, opacity: 0.8 }}>
                  Stations at this floor stop being able to start new cards. Its name becomes reusable. Cards already in
                  progress keep their location on record.
                </p>
              ),
              run: async (reason) =>
                (
                  await apiRequest("POST", `${BASE}/partners/${partnerId}/locations/${location.id}/status`, {
                    status: "SUSPENDED",
                    reason,
                  })
                ).json(),
            })
          }
        >
          Suspend
        </AdminButton>
      ) : (
        <AdminButton
          size="sm"
          variant="ghost"
          disabled={busy}
          data-testid={`pm-location-activate-${location.id}`}
          onClick={() =>
            openModal({
              kind: "location-status-ACTIVE",
              title: `Activate ${location.name}`,
              successMessage: "Location activated.",
              run: async (reason) =>
                (
                  await apiRequest("POST", `${BASE}/partners/${partnerId}/locations/${location.id}/status`, {
                    status: "ACTIVE",
                    reason,
                  })
                ).json(),
            })
          }
        >
          Activate
        </AdminButton>
      )}
    </div>
  );
}

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
  // Every partner-user action reached through this helper — role, status, password reset, MFA reset,
  // session revocation — is behind requireAdminStepUp. runAdminProtected performs the call and, ONLY
  // if the server answers 403 admin_step_up_required, prompts and retries this exact action once.
  const post = (path: string, body: Record<string, unknown>) => (reason: string) =>
    runAdminProtected(() => apiRequest("POST", `${BASE}${path}`, { ...body, reason }).then((r) => r.json()));

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
            body: (
              <p style={{ fontSize: 12 }}>
                This sends a fresh single-use link. The password and link are never shown to MintVault staff.
              </p>
            ),
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
            body: (
              <p style={{ fontSize: 12 }}>
                All MFA methods and recovery codes are disabled and every active session is revoked. The user must enrol
                a new authenticator.
              </p>
            ),
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

/**
 * PERMANENT DELETION — shown only when the SERVER says the shop can actually be deleted.
 *
 * WHY THE ASSESSMENT COMES FIRST. Deletion here is decided by dozens of foreign keys, most of them
 * deliberately ON DELETE RESTRICT. A button that simply issued the DELETE would, for almost every
 * real Partner, produce a raw PostgreSQL foreign-key violation on screen — naming one arbitrary
 * constraint out of several, in a vocabulary no operator can act on. So this panel asks the server
 * first and renders one of two entirely different things: a destructive control, or the reasons
 * there isn't one. It never offers a button that is certain to fail.
 *
 * Everything shown is server-derived. This component classifies nothing and counts nothing.
 */
function PermanentDeletionPanel({
  partnerId,
  legalName,
  busy,
  openModal,
}: {
  partnerId: string;
  legalName: string;
  busy: boolean;
  openModal: (modal: {
    kind: string;
    title: string;
    successMessage?: string;
    highRisk?: boolean;
    body?: ReactNode;
    input?: { label: string; initial: string; testId: string; required?: boolean; mustEqual?: string };
    run: (reason: string, value: string, value2: string) => Promise<unknown>;
  }) => void;
}) {
  const assessment = useQuery<PartnerDeletionAssessment>({
    queryKey: [`${BASE}/partners/${partnerId}/deletion-assessment`],
  });

  if (assessment.isLoading) {
    return (
      <Panel title="Permanent deletion">
        <div data-testid="pm-delete-loading">Checking what depends on this shop…</div>
      </Panel>
    );
  }
  if (!assessment.data) {
    return (
      <Panel title="Permanent deletion">
        {/* Fail closed in the UI too: an unreadable assessment shows no destructive control. */}
        <div role="alert" data-testid="pm-delete-unavailable">
          MintVault could not confirm what depends on this shop, so it cannot be permanently deleted here.
        </div>
      </Panel>
    );
  }

  const data = assessment.data;
  if (!data.canDelete) {
    return (
      <Panel title="Permanent deletion" sub="Not available for this shop">
        <div data-testid="pm-delete-blocked" data-can-delete="false">
          <p style={{ marginTop: 0, fontWeight: 700, letterSpacing: "0.04em" }}>CANNOT PERMANENTLY DELETE</p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.blockers.map((blocker) => (
              <li key={blocker.code + blocker.dependency} data-testid={`pm-delete-blocker-${blocker.code}`}>
                {blocker.message}
              </li>
            ))}
          </ul>
          <p style={{ fontSize: 12, opacity: 0.75, marginBottom: 0 }}>
            Suspend or revoke the shop instead. Its records are kept.
          </p>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Permanent deletion" sub="This shop has setup records only">
      <div data-testid="pm-delete-available" data-can-delete="true">
        <p style={{ marginTop: 0 }}>This removes {data.removes.join(", ")}.</p>
        <p style={{ fontSize: 12, opacity: 0.85 }}>Kept: {data.retains.join(", ")}.</p>
        <AdminButton
          size="sm"
          variant="gold"
          disabled={busy}
          onClick={() =>
            openModal({
              kind: "partner-permanent-delete",
              title: `Permanently delete ${legalName}?`,
              highRisk: true,
              successMessage: "Shop permanently deleted. Its audit and security history was kept.",
              body: (
                <p style={{ fontSize: 12 }}>
                  This cannot be undone. The shop record, its locations, staff accounts, sessions,
                  invitations, contacts, branding and empty credit wallet are destroyed. Every audit and
                  security event about it is kept and re-attributed to a deletion tombstone.
                </p>
              ),
              input: {
                label: `Type the shop's exact legal name to confirm: ${data.confirmationPhrase}`,
                initial: "",
                testId: "pm-delete-confirm-name",
                required: true,
                // The server checks this too and remains the real gate; stating it here means the
                // operator is told what is wrong inside the dialog rather than by a refusal after
                // pressing a destructive button that was never going to work.
                mustEqual: data.confirmationPhrase,
              },
              run: async (reasonText, typedName) =>
                (
                  // The SAME admin step-up every other destructive Partner action uses. The server
                  // requires it independently; this only makes the browser satisfy it up front.
                  await runAdminProtected(() =>
                    apiRequest("POST", `${BASE}/partners/${partnerId}/permanent-delete`, {
                      reason: reasonText,
                      confirmLegalName: typedName,
                    })
                  )
                ).json(),
            })
          }
          data-testid="pm-delete-partner"
        >
          Permanently delete setup-only partner
        </AdminButton>
      </div>
    </Panel>
  );
}
