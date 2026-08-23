/**
 * First-shop onboarding is deliberately a thin Super Admin workflow over the existing Partner
 * authorities. It creates no profile/contact/address shadow record: the page writes the Main
 * `partner_locations` row, `partner_contacts`, the existing invitation service and wallet service.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AdminButton, AdminShell, Badge, Panel } from "@/components/admin";
import { ReadinessPanel } from "@/components/partner/readiness-panel";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { runAdminProtected } from "@/components/admin/admin-step-up";
import { PARTNER_READINESS_DIMENSION_ORDER } from "@shared/partner-readiness";
import type {
  PartnerNextAction,
  PartnerOperationalReadiness,
  PartnerReadinessCode,
  PartnerSetupStage,
  ReadinessStatus,
} from "@shared/partner-readiness";

const BASE = "/api/super-admin/partner-management";
const emptyAddress = { line1: "", line2: "", city: "", postcode: "", country: "United Kingdom" };

type Location = {
  id: string;
  name: string;
  status: string;
  addressLine1: string | null;
  addressLine2: string | null;
  addressCity: string | null;
  addressPostcode: string | null;
  addressCountry: string | null;
};
type Contact = { full_name?: string; email?: string; contact_type?: string; active?: boolean; is_primary?: boolean };
type FirstShop = {
  organisation: { id: string; legalName: string; status: string };
  profileVersion: number;
  mainLocation: Location | null;
  primaryContact: Contact | null;
  owner: { id?: string; email: string; userStatus: string; readiness?: { onboardingState?: string } } | null;
  operational: PartnerOperationalReadiness;
  /** When MintVault declared this shop's next card to be its onboarding test. null = not armed. */
  testCardArmedAt: string | null;
  /** False when the arming authority could not be read (migration 0109 not applied here). */
  testCardArmingReadable: boolean;
};

type StaffUser = {
  id: string;
  email: string;
  status: string;
  role?: string;
  role_codes?: string[];
  location_eligible?: boolean;
};
type FleetStation = { stationCode?: string; station_code?: string; status: string; tenantId?: string; tenant_id?: string };

const ORG_WIDE_ROLE_CODES = ["PARTNER_OWNER", "PARTNER_MANAGER", "PARTNER_FINANCE_VIEWER"];

function requestKey(): string {
  return `first-shop-${crypto.randomUUID()}`;
}

function Input({ label, value, onChange, type = "text", required = true }: { label: string; value: string; onChange: (value: string) => void; type?: string; required?: boolean }) {
  return (
    <label style={{ display: "grid", gap: 4, minWidth: 190, flex: 1 }}>
      <span style={{ fontSize: 12, opacity: 0.8 }}>{label}{required ? " *" : ""}</span>
      <input
        required={required}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={{ background: "#0d0d0d", color: "#fff", border: "1px solid #555", borderRadius: 7, padding: "8px 10px" }}
      />
    </label>
  );
}

function Step({
  number,
  title,
  complete,
  status,
  children,
}: {
  number: number;
  title: string;
  complete: boolean;
  /** The dimension's own four-state status, when this step maps to one. */
  status?: ReadinessStatus;
  children: React.ReactNode;
}) {
  const glyph = checkGlyph(status ?? (complete ? "PASS" : "NOT_STARTED"));
  return (
    <Panel title={`${number}. ${title}`} sub={`${glyph.mark} ${glyph.label}`}>
      <div
        data-testid={`first-shop-step-${number}`}
        data-complete={complete ? "true" : "false"}
        data-check-status={glyph.label}
      >
        {children}
      </div>
    </Panel>
  );
}

/**
 * Which numbered step owns each blocker, so "Show me" can open the right one.
 *
 * The card deliberately does NOT re-implement the controls those steps already hold. Approving a
 * Scanner means approving a PARTICULAR Mac, and assigning an operator means choosing a PARTICULAR
 * person — real decisions the card cannot make on the operator's behalf. For those it reveals the
 * step that owns the choice. Only argument-free actions run straight from the card.
 */
const STEP_FOR_CODE: Partial<Record<PartnerReadinessCode, number>> = {
  PARTNER_SUSPENDED: 1,
  DELIVERY_ADDRESS_REQUIRED: 2,
  OPERATIONS_CONTACT_REQUIRED: 3,
  OWNER_SETUP_REQUIRED: 4,
  INVITATION_EXPIRED: 4,
  AWAITING_PASSWORD_SETUP: 4,
  AWAITING_MFA_SETUP: 4,
  USER_SUSPENDED: 4,
  STAFF_OPERATOR_REQUIRED: 5,
  STAFF_LOCATION_ASSIGNMENT_REQUIRED: 5,
  LOCATION_REQUIRED: 5,
  STATION_SETUP_REQUIRED: 6,
  STATION_APPROVAL_PENDING: 6,
  STATION_UNAVAILABLE: 6,
  SCANNER_OFFLINE: 7,
  SCANNER_UPDATE_REQUIRED: 7,
  CALIBRATION_REQUIRED: 7,
  CREDITS_REQUIRED: 8,
  TEST_CARD_REQUIRED: 9,
  TEST_CARD_IN_PROGRESS: 9,
  TEST_CARD_AWAITING_REVIEW: 9,
  TEST_CARD_BLOCKED: 9,
};

/** One glyph vocabulary for the collapsed detail list. */
function checkGlyph(status: ReadinessStatus | "NOT_STARTED"): { mark: string; label: string } {
  if (status === "PASS") return { mark: "\u2713", label: "READY" };
  if (status === "PENDING") return { mark: "\u25cf", label: "IN PROGRESS" };
  if (status === "BLOCKED") return { mark: "!", label: "BLOCKED" };
  return { mark: "\u2014", label: "NOT STARTED" };
}

/**
 * THE FIVE-STAGE INDICATOR.
 *
 * CREATE -> ACTIVATE -> CONNECT -> TEST -> LIVE, with the current stage marked. It renders the
 * server's `nextAction.stage` and computes nothing: a client that decided its own stage would be a
 * second readiness opinion, which is the thing this whole package exists to prevent.
 */
const SETUP_STAGES: PartnerSetupStage[] = ["CREATE", "ACTIVATE", "CONNECT", "TEST", "LIVE"];

function StageBar({ current }: { current: PartnerSetupStage }) {
  const currentIndex = SETUP_STAGES.indexOf(current);
  return (
    <div
      data-testid="first-shop-stage-bar"
      data-stage={current}
      style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center", margin: "0 0 16px" }}
    >
      {SETUP_STAGES.map((stage, index) => {
        const done = index < currentIndex;
        const active = index === currentIndex;
        return (
          <span
            key={stage}
            data-stage-step={stage}
            data-stage-state={done ? "done" : active ? "active" : "todo"}
            style={{
              fontSize: 11,
              letterSpacing: 1.4,
              textTransform: "uppercase",
              fontWeight: active ? 800 : 600,
              color: done ? "#7fd6a0" : active ? "#D4AF37" : "var(--admin-ink-faint)",
              opacity: done || active ? 1 : 0.55,
            }}
          >
            {done ? "\u2713" : active ? "\u25cf" : "\u25cb"} {stage}
          </span>
        );
      })}
    </div>
  );
}

/**
 * What the operator is told at each stage, in their words rather than the system's.
 *
 * The SENTENCE still comes from the server for anything condition-specific; this only supplies the
 * stage headline and the standing instruction, which are the same whatever the underlying code is.
 */
const STAGE_INSTRUCTION: Record<PartnerSetupStage, string> = {
  CREATE: "Enter the shop's details.",
  ACTIVATE: "The Owner needs to open the MintVault email, create their password and set up their authenticator.",
  CONNECT: "Open MintVault Scanner on this Mac and sign in with the Owner account.",
  TEST: "Scan one test card on the shop's Mac.",
  LIVE: "This shop can grade cards.",
};

/**
 * THE ONE NEXT ACTION.
 *
 * The 10 checks below are the authority and stay exactly as they were; this is the operator's
 * working surface. It renders `readiness.nextAction` verbatim — the server chose which blocker and
 * wrote the words — and offers at most ONE dominant control, so nothing competes with it.
 *
 * There is no manual "next step": every action on this page refetches readiness on success, so the
 * server re-picks and this card advances by itself.
 */
function NextActionCard({
  next,
  onRun,
  runLabel,
  pending,
  failed,
  onReveal,
}: {
  next: PartnerNextAction;
  onRun: (() => void) | null;
  runLabel: string | null;
  pending: boolean;
  failed: boolean;
  onReveal: (step: number) => void;
}) {
  const step = STEP_FOR_CODE[next.code];
  const ready = next.state === "READY";
  return (
    <div
      data-testid="first-shop-next-action"
      data-state={next.state}
      data-code={next.code}
      data-source={next.source ?? ""}
      style={{
        border: `1px solid ${ready ? "#2f7d4f" : "#D4AF37"}`,
        borderRadius: 10,
        padding: "18px 20px",
        marginBottom: 18,
        background: ready ? "rgba(47,125,79,0.08)" : "rgba(212,175,55,0.08)",
      }}
    >
      <div style={{ fontSize: 11, letterSpacing: 1.5, opacity: 0.75, textTransform: "uppercase" }}>
        {ready ? "Status" : "Next action"}
      </div>
      <h2 data-testid="first-shop-next-action-title" style={{ margin: "6px 0 4px", fontSize: 22 }}>
        {ready ? "Shop ready to grade" : next.title}
      </h2>
      <p data-testid="first-shop-next-action-message" style={{ margin: "0 0 14px", opacity: 0.9 }}>
        {next.message}
      </p>
      {failed && (
        <p role="alert" data-testid="first-shop-next-action-error" style={{ color: "#ff8a8a", marginTop: 0 }}>
          That did not go through. Nothing was changed — try again.
        </p>
      )}
      {!ready && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {onRun && runLabel ? (
            <AdminButton
              variant="gold"
              disabled={pending}
              onClick={onRun}
              data-testid="first-shop-next-action-run"
            >
              {pending ? "Working\u2026" : failed ? `Retry \u2014 ${runLabel}` : runLabel}
            </AdminButton>
          ) : step ? (
            <AdminButton variant="gold" onClick={() => onReveal(step)} data-testid="first-shop-next-action-reveal">
              {next.action?.label ?? "Show me"}
            </AdminButton>
          ) : (
            /* Nothing MintVault can click — e.g. the owner has to set their own password. Say so
               rather than render a button that cannot work. */
            <span data-testid="first-shop-next-action-waiting" style={{ opacity: 0.85 }}>
              Waiting — nothing for MintVault to do here yet.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return (error as { body?: { error?: { message?: string } } })?.body?.error?.message ?? fallback;
}

export default function PartnerFirstShopOnboardingPage() {
  const [, params] = useRoute("/admin/partners/:partnerId/onboarding");
  const partnerId = params?.partnerId;
  const [, navigate] = useLocation();
  const [banner, setBanner] = useState<string | null>(null);
  /*
   * The 10 checks are collapsed by default: they are the authority and the audit trail, but they
   * are not the day-to-day workflow. `revealStep` opens them and scrolls to one, which is what the
   * Next Action card does for any blocker whose fix needs a choice the card cannot make for you.
   */
  const [checksOpen, setChecksOpen] = useState(false);
  /** Off by default: the operations contact is the Owner unless the operator says otherwise. */
  const [useDifferentContact, setUseDifferentContact] = useState(false);
  const [legalName, setLegalName] = useState("");
  const [address, setAddress] = useState(emptyAddress);
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [ownerFirstName, setOwnerFirstName] = useState("");
  const [ownerLastName, setOwnerLastName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const createIdempotencyKey = useRef(requestKey());
  const addressIdempotencyKey = useRef(requestKey());
  const contactIdempotencyKey = useRef(requestKey());

  // This route stays mounted when an operator navigates Partner A → B. Unsaved values are scoped
  // to the current route parameter so no prior shop's record can appear under a new context label.
  useEffect(() => {
    setAddress(emptyAddress);
    setContactName("");
    setContactEmail("");
    addressIdempotencyKey.current = requestKey();
    contactIdempotencyKey.current = requestKey();
  }, [partnerId]);

  const onboarding = useQuery<FirstShop>({
    queryKey: [BASE, "partners", partnerId, "first-shop"],
    queryFn: () => apiRequest("GET", `${BASE}/partners/${partnerId}/first-shop`).then((response) => response.json()),
    enabled: !!partnerId,
  });
  const shop = onboarding.data;
  const mainLocation = shop?.mainLocation ?? null;
  const contact = shop?.primaryContact ?? null;

  const create = useMutation({
    mutationFn: () =>
      apiRequest("POST", `${BASE}/first-shop`, {
        legalName,
        // locationName and operationsContact are deliberately omitted: the SERVER defaults the
        // Main location name and makes the Owner the operations contact, so every caller produces
        // the same canonical record.
        deliveryAddress: address,
        operationsContact: useDifferentContact ? { fullName: contactName, email: contactEmail } : undefined,
        owner: { firstName: ownerFirstName, lastName: ownerLastName, email: ownerEmail },
        idempotencyKey: createIdempotencyKey.current,
        reason: "first-shop guided onboarding",
      }).then((response) => response.json() as Promise<{ result?: { partnerId?: string; invitationDeliveryStatus?: string } }>),
    onSuccess: (data) => {
      const id = data.result?.partnerId;
      if (!id) {
        setBanner("The onboarding request completed, but its Partner identifier was not returned. Refresh the Partner directory before retrying.");
        return;
      }
      setBanner(`First shop created. Owner invitation delivery: ${data.result?.invitationDeliveryStatus ?? "recorded"}.`);
      createIdempotencyKey.current = requestKey();
      void queryClient.invalidateQueries({ queryKey: [BASE, "partners"] });
      navigate(`/admin/partners/${id}/onboarding`);
    },
    onError: (error) => setBanner(errorMessage(error, "First-shop onboarding could not be created. Nothing was partially saved.")),
  });
  const saveAddress = useMutation({
    mutationFn: () =>
      apiRequest("PATCH", `${BASE}/partners/${partnerId}/first-shop/location`, {
        deliveryAddress: address,
        idempotencyKey: addressIdempotencyKey.current,
        reason: "guided Main location delivery address update",
      }),
    onSuccess: () => {
      setBanner("Main location delivery address saved.");
      addressIdempotencyKey.current = requestKey();
      void onboarding.refetch();
    },
    onError: (error) => setBanner(errorMessage(error, "The Main location address was not changed.")),
  });
  const saveContact = useMutation({
    mutationFn: () =>
      apiRequest("PUT", `${BASE}/partners/${partnerId}/first-shop/operations-contact`, {
        fullName: contactName,
        email: contactEmail,
        idempotencyKey: contactIdempotencyKey.current,
        reason: "guided primary operations contact update",
      }),
    onSuccess: () => {
      setBanner("Primary operations contact saved.");
      contactIdempotencyKey.current = requestKey();
      void onboarding.refetch();
    },
    onError: (error) => setBanner(errorMessage(error, "The operations contact was not changed.")),
  });
  const activate = useMutation({
    mutationFn: async () => {
      if (!shop) throw new Error("Partner is not loaded.");
      return runAdminProtected(() =>
        apiRequest("POST", `${BASE}/partners/${shop.organisation.id}/status`, {
          status: "ACTIVE",
          expectedVersion: shop.profileVersion,
          reason: "guided first-shop activation after review",
        })
      );
    },
    onSuccess: () => {
      setBanner("Partner activated.");
      void onboarding.refetch();
    },
    onError: (error) => setBanner(errorMessage(error, "Partner status was not changed.")),
  });

  // Existing Partner records arrive populated. Prefill only once per loaded current location/contact;
  // we never submit automatically or write a duplicate because a read succeeded.
  const existingAddress = useMemo(
    () => ({
      line1: mainLocation?.addressLine1 ?? "",
      line2: mainLocation?.addressLine2 ?? "",
      city: mainLocation?.addressCity ?? "",
      postcode: mainLocation?.addressPostcode ?? "",
      country: mainLocation?.addressCountry ?? "United Kingdom",
    }),
    [mainLocation]
  );
  const addressValue = partnerId && address.line1 === "" ? existingAddress : address;
  const contactNameValue = partnerId && contactName === "" ? contact?.full_name ?? "" : contactName;
  const contactEmailValue = partnerId && contactEmail === "" ? contact?.email ?? "" : contactEmail;
  const setAddressField = (key: keyof typeof emptyAddress, value: string) => {
    addressIdempotencyKey.current = requestKey();
    setAddress((current) => ({ ...current, ...(partnerId && current.line1 === "" ? existingAddress : {}), [key]: value }));
  };
  const setContactNameForCurrentShop = (value: string) => {
    contactIdempotencyKey.current = requestKey();
    setContactName(value);
  };
  const setContactEmailForCurrentShop = (value: string) => {
    contactIdempotencyKey.current = requestKey();
    setContactEmail(value);
  };
  const resetCreateIntent = (setValue: (value: string) => void) => (value: string) => {
    createIdempotencyKey.current = requestKey();
    setValue(value);
  };

  /*
   * Staff + station data the wizard needs to ACT rather than link out. Both come from the existing
   * canonical admin endpoints; nothing here re-derives an authority.
   */
  const staffQuery = useQuery<{ users: StaffUser[] }>({
    queryKey: [`${BASE}/partners/${partnerId}/users`],
    enabled: Boolean(partnerId),
  });
  const locationsQuery = useQuery<{ locations: Location[] }>({
    queryKey: [`${BASE}/partners/${partnerId}/locations`],
    enabled: Boolean(partnerId),
  });
  const stationsQuery = useQuery<{ stations: FleetStation[] }>({
    queryKey: [`/api/super-admin/fleet/stations?tenantId=${partnerId}`],
    enabled: Boolean(partnerId),
    refetchInterval: 15_000,
  });

  const activeLocations = (locationsQuery.data?.locations ?? []).filter((l) => l.status === "ACTIVE");
  /*
   * Operators the Scanner cannot serve: ACTIVE, NOT org-wide, and not eligible at any location.
   * Same rule the server readiness dimension uses — this only decides who to OFFER a fix for.
   */
  const unassignedOperators = (staffQuery.data?.users ?? []).filter(
    (u) =>
      u.status === "ACTIVE" &&
      !(u.role_codes ?? []).some((c) => ORG_WIDE_ROLE_CODES.includes(c)) &&
      u.location_eligible !== true
  );
  const pendingStations = (stationsQuery.data?.stations ?? []).filter((st) => st.status === "PENDING");
  const stationCodeOf = (st: FleetStation) => st.stationCode ?? st.station_code ?? "";

  const [assignLocationId, setAssignLocationId] = useState<string>("");
  const assignLocation = useMutation({
    mutationFn: async (userId: string) => {
      const locationId = assignLocationId || activeLocations[0]?.id;
      if (!locationId) throw new Error("No ACTIVE location is available to assign.");
      // Canonical, audited authority (partner_user_locations_changed). No direct SQL.
      return runAdminProtected(() =>
        apiRequest("POST", `${BASE}/partners/${partnerId}/users/${userId}/locations`, {
          locationIds: [locationId],
          reason: "First-shop onboarding: authorise operator location",
        }).then((r) => r.json())
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [`${BASE}/partners/${partnerId}/users`] });
      void queryClient.invalidateQueries({ queryKey: [`${BASE}/partners/${partnerId}/first-shop`] });
    },
  });

  const approveStation = useMutation({
    mutationFn: async (stationCode: string) =>
      // The EXISTING station transition authority, behind its existing admin step-up.
      runAdminProtected(() =>
        apiRequest("POST", `/api/super-admin/fleet/stations/${encodeURIComponent(stationCode)}/active`, {
          reason: "First-shop onboarding: approve shop Scanner",
        }).then((r) => r.json())
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [`/api/super-admin/fleet/stations?tenantId=${partnerId}`] });
      void queryClient.invalidateQueries({ queryKey: [`${BASE}/partners/${partnerId}/first-shop`] });
    },
  });

  /*
   * ARM THE TEST CARD. The wizard cannot scan a card — that happens physically, on the shop Mac —
   * so what it can do is DECLARE that the next card scanned there is the test. The server consumes
   * that declaration inside the NEW transaction and stamps the Card Job, which is why this step can
   * be truthful about a card nobody here has touched.
   */
  /*
   * RESEND, from the EXISTING canonical authority. Same route the Staff screen calls; no second
   * invitation system, and no trip into Staff to reach it during onboarding.
   */
  const resendInvitation = useMutation({
    mutationFn: async (userId: string) =>
      apiRequest("POST", `${BASE}/partners/${partnerId}/users/${userId}/resend-invitation`, {
        reason: "First-shop onboarding: resend Owner invitation",
      }).then((r) => r.json()),
    onSuccess: () => {
      setBanner("Invitation sent.");
      void queryClient.invalidateQueries({ queryKey: [`${BASE}/partners/${partnerId}/users`] });
      void onboarding.refetch();
    },
    onError: (error) => setBanner(errorMessage(error, "The invitation could not be sent.")),
  });

  const armTestCard = useMutation({
    mutationFn: async () =>
      apiRequest("POST", `${BASE}/partners/${partnerId}/first-shop/test-card/arm`, {
        reason: "First-shop onboarding: arm the shop's test card",
      }).then((response) => response.json()),
    onSuccess: () => {
      setBanner("The next card scanned at this shop will be recorded as its onboarding test card.");
      void onboarding.refetch();
    },
    onError: (error) => setBanner(errorMessage(error, "The onboarding test card was not armed.")),
  });

  const revealStep = (step: number) => {
    setChecksOpen(true);
    // After the <details> has actually opened, bring the owning step into view.
    window.setTimeout(() => {
      document.querySelector(`[data-testid="first-shop-step-${step}"]`)?.scrollIntoView({ block: "center" });
    }, 0);
  };

  /*
   * Which blockers the card can clear in ONE click. Only argument-free actions qualify: approving a
   * Scanner means approving a particular Mac and assigning an operator means choosing a particular
   * person, so those reveal the step that owns the choice instead of guessing.
   *
   * Each of these mutations already refetches readiness on success, which is what makes the card
   * advance on its own — there is deliberately no "next step" button anywhere on this page.
   */
  const nextRun: { run: () => void; label: string; pending: boolean; failed: boolean } | null = (() => {
    const code = shop?.operational.nextAction.code;
    if (code === "PARTNER_SUSPENDED" && shop?.organisation.status === "PENDING") {
      return { run: () => activate.mutate(), label: "Activate Partner", pending: activate.isPending, failed: activate.isError };
    }
    if (code === "TEST_CARD_REQUIRED" && shop?.operational.testCard.state === "NOT_STARTED" && shop?.testCardArmingReadable && !shop?.testCardArmedAt) {
      return { run: () => armTestCard.mutate(), label: "Arm the test card", pending: armTestCard.isPending, failed: armTestCard.isError };
    }
    /*
     * An expired or failed invitation has exactly one remedy and exactly one Owner to apply it to,
     * so it runs from the card. Super Admin should not have to go into Staff to resend.
     */
    if ((code === "INVITATION_EXPIRED" || code === "OWNER_SETUP_REQUIRED") && shop?.owner?.id) {
      const ownerId = shop.owner.id;
      return {
        run: () => resendInvitation.mutate(ownerId),
        label: "Resend invitation",
        pending: resendInvitation.isPending,
        failed: resendInvitation.isError,
      };
    }
    /*
     * ONE pending Scanner is unambiguous, so approval runs from the card behind the SAME canonical
     * step-up. More than one is a real choice between Macs, so that reveals the step instead.
     */
    if (code === "STATION_APPROVAL_PENDING" && pendingStations.length === 1) {
      const code0 = stationCodeOf(pendingStations[0]);
      if (code0) {
        return {
          run: () => approveStation.mutate(code0),
          label: "Approve Scanner",
          pending: approveStation.isPending,
          failed: approveStation.isError,
        };
      }
    }
    return null;
  })();

  return (
    <AdminShell activeTab="dashboard" onTabChange={() => navigate("/admin")} onLogout={() => navigate("/admin")} title="First-shop onboarding" crumb="Partner Network">
      <div data-testid="first-shop-onboarding-root" style={{ maxWidth: 980 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
          <div>
            <h1 style={{ margin: 0 }}>First-shop onboarding</h1>
            <p style={{ margin: "6px 0", opacity: 0.8 }}>One guided flow over the canonical Partner, location, contact, Owner, station and wallet records.</p>
          </div>
          <Link href="/admin/partners/directory" style={{ alignSelf: "center" }}>← Partner directory</Link>
        </div>
        {banner && <div role="status" data-testid="first-shop-banner" style={{ padding: 10, borderRadius: 8, background: "#24200e", marginBottom: 12 }}>{banner}</div>}

        {!partnerId ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
            data-testid="first-shop-create-form"
          >
            {/*
              * ONE FORM. This used to be four numbered "steps" for shop, address, contact and
              * Owner, which read like a technical checklist for something that is really one
              * decision: open this shop. Nothing about the canonical record changed — the server
              * still writes the same organisation, location, contact, Owner, role, wallet and
              * invitation in one transaction. The form just stopped asking for what the server
              * already knows.
              */}
            <Panel title="Create shop" sub="One form. MintVault creates the shop, its Main location, the Owner and the invitation together.">
              <div style={{ fontSize: 11, letterSpacing: 1.4, opacity: 0.7, textTransform: "uppercase", marginBottom: 6 }}>Shop</div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Input label="Shop / legal name" value={legalName} onChange={resetCreateIntent(setLegalName)} />
              </div>

              <div style={{ fontSize: 11, letterSpacing: 1.4, opacity: 0.7, textTransform: "uppercase", margin: "16px 0 6px" }}>Owner</div>
              <p style={{ marginTop: 0, fontSize: 12, opacity: 0.85 }}>
                The Owner receives the invitation and sets their own password and authenticator. Neither secret is ever
                shown to MintVault staff.
              </p>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Input label="First name" value={ownerFirstName} onChange={resetCreateIntent(setOwnerFirstName)} />
                <Input label="Last name" value={ownerLastName} onChange={resetCreateIntent(setOwnerLastName)} />
                <Input label="Email" value={ownerEmail} onChange={resetCreateIntent(setOwnerEmail)} type="email" />
              </div>

              <div style={{ fontSize: 11, letterSpacing: 1.4, opacity: 0.7, textTransform: "uppercase", margin: "16px 0 6px" }}>Delivery address</div>
              <AddressFields value={addressValue} onChange={setAddressField} />

              {/*
                * The operations contact is the Owner unless somebody says otherwise. Revealed only
                * when asked for, so the normal path never types the same name and email twice —
                * which is how a shop ended up with two contacts differing by a typo.
                */}
              <div style={{ marginTop: 16 }}>
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={useDifferentContact}
                    onChange={(event) => {
                      // Changing WHAT is being created changes the request, so the idempotency key
                      // must move with it — same rule every other field on this form follows.
                      createIdempotencyKey.current = requestKey();
                      setUseDifferentContact(event.target.checked);
                    }}
                    data-testid="first-shop-use-different-contact"
                  />
                  Use a different operations contact
                </label>
                {useDifferentContact && (
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }} data-testid="first-shop-contact-fields">
                    <Input label="Contact name" value={contactName} onChange={resetCreateIntent(setContactName)} />
                    <Input label="Operational email" value={contactEmail} onChange={resetCreateIntent(setContactEmail)} type="email" />
                  </div>
                )}
              </div>
            </Panel>
            <Panel title="" sub="Everything is created in one transaction. If any part fails, nothing is saved.">
              <AdminButton type="submit" variant="gold" disabled={create.isPending} data-testid="first-shop-create-submit">
                {create.isPending ? "Creating\u2026" : "Create shop & send invitation"}
              </AdminButton>
            </Panel>
          </form>
        ) : onboarding.isLoading ? (
          <div role="status">Loading the canonical first-shop records…</div>
        ) : !shop ? (
          <div role="alert">This Partner could not be loaded.</div>
        ) : (
          <>
            <StageBar current={shop.operational.nextAction.stage} />
            <p data-testid="first-shop-stage-instruction" style={{ margin: "0 0 14px", opacity: 0.85 }}>
              {STAGE_INSTRUCTION[shop.operational.nextAction.stage]}
            </p>
            <NextActionCard
              next={shop.operational.nextAction}
              onRun={nextRun ? nextRun.run : null}
              runLabel={nextRun ? nextRun.label : null}
              pending={nextRun?.pending ?? false}
              failed={nextRun?.failed ?? false}
              onReveal={revealStep}
            />
            {shop.operational.nextAction.state === "READY" && (
              <Panel title="Shop ready to grade" sub="Setup is finished. Nothing below needs attention.">
                <ul data-testid="first-shop-ready-facts" style={{ margin: 0, paddingLeft: 18 }}>
                  <li>Owner ready</li>
                  <li>Scanner active</li>
                  <li>Calibration valid</li>
                  <li>Credits available</li>
                  <li>Test card complete</li>
                </ul>
                <div style={{ marginTop: 12 }}>
                  <Link href={`/admin/partners/${shop.organisation.id}`} data-testid="first-shop-open-shop">
                    Open shop
                  </Link>
                </div>
              </Panel>
            )}
            <Panel title="Current scope" sub="Every action below is scoped to this exact Partner and Main location.">
              <div data-testid="first-shop-current-partner"><b>Current Partner:</b> {shop.organisation.legalName} <Badge variant={shop.organisation.status === "ACTIVE" ? "act" : "wait"}>{shop.organisation.status}</Badge></div>
              <div data-testid="first-shop-current-location" style={{ marginTop: 6 }}><b>Current location:</b> {mainLocation ? `${mainLocation.name} (${mainLocation.status})` : "No active Main location"}</div>
            </Panel>
            {/*
              * THE 10 AUTHORITATIVE CHECKS. Unchanged, and still the thing the server actually
              * decides on — but collapsed, because managing a checklist is not the operator's job
              * any more. This is for troubleshooting and audit.
              */}
            <details
              open={checksOpen}
              onToggle={(event) => setChecksOpen((event.currentTarget as HTMLDetailsElement).open)}
              data-testid="first-shop-all-checks"
            >
              <summary style={{ cursor: "pointer", padding: "10px 0", fontWeight: 600 }}>
                Advanced setup diagnostics — view all checks
                <span style={{ opacity: 0.7, fontWeight: 400 }}>
                  {" "}
                  — {PARTNER_READINESS_DIMENSION_ORDER.filter((key) => shop.operational.dimensions[key]?.status === "PASS").length} of{" "}
                  {PARTNER_READINESS_DIMENSION_ORDER.length} ready
                </span>
              </summary>
            <Step number={1} title="Shop" complete={shop.organisation.status === "ACTIVE"} status={shop.operational.dimensions.organisation.status}>
              <p>Partner status: <b>{shop.organisation.status}</b>. The record remains pending until the operator deliberately activates it.</p>
              {shop.organisation.status === "PENDING" && <AdminButton size="sm" variant="gold" disabled={activate.isPending} onClick={() => activate.mutate()} data-testid="first-shop-activate">Activate Partner</AdminButton>}
            </Step>
            <Step number={2} title="Main location delivery address" complete={shop.operational.dimensions.delivery.status === "PASS"} status={shop.operational.dimensions.delivery.status}>
              <form onSubmit={(event) => { event.preventDefault(); saveAddress.mutate(); }}>
                <AddressFields value={addressValue} onChange={setAddressField} />
                <AdminButton type="submit" size="sm" variant="gold" disabled={!mainLocation || saveAddress.isPending} data-testid="first-shop-save-address" style={{ marginTop: 12 }}>Save Main location address</AdminButton>
              </form>
            </Step>
            <Step number={3} title="Primary operations contact" complete={shop.operational.dimensions.operationsContact.status === "PASS"} status={shop.operational.dimensions.operationsContact.status}>
              <form onSubmit={(event) => { event.preventDefault(); saveContact.mutate(); }}>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <Input label="Contact name" value={contactNameValue} onChange={setContactNameForCurrentShop} />
                  <Input label="Operational email" value={contactEmailValue} onChange={setContactEmailForCurrentShop} type="email" />
                </div>
                <AdminButton type="submit" size="sm" variant="gold" disabled={saveContact.isPending} data-testid="first-shop-save-contact" style={{ marginTop: 12 }}>Save primary operations contact</AdminButton>
              </form>
            </Step>
            <Step number={4} title="Partner Owner" complete={shop.operational.dimensions.owner.status === "PASS"} status={shop.operational.dimensions.owner.status}>
              <p>{shop.owner ? `Owner: ${shop.owner.email} — ${shop.owner.readiness?.onboardingState ?? shop.owner.userStatus}` : "No Partner Owner has been invited."}</p>
              <Link href={`/admin/partners/${shop.organisation.id}/staff`} data-testid="first-shop-owner-action">Open Owner setup</Link>
            </Step>
            <Step number={5} title="Staff and operator access" complete={shop.operational.dimensions.staff?.status === "PASS"} status={shop.operational.dimensions.staff?.status}>
              <p data-testid="first-shop-staff-message">{shop.operational.dimensions.staff?.message ?? "Operator access could not be confirmed."}</p>
              {unassignedOperators.length > 0 && (
                <div data-testid="first-shop-staff-unassigned" style={{ marginTop: 10 }}>
                  <p style={{ fontSize: 12, opacity: 0.85 }}>
                    A location-scoped operator has every scanning capability but no authorised location, so their
                    Scanner is offered nothing to enrol against. Assign a location here.
                  </p>
                  {activeLocations.length === 0 ? (
                    <p role="alert" data-testid="first-shop-staff-no-location">
                      This shop has no ACTIVE location yet — complete the location step first.
                    </p>
                  ) : (
                    <>
                      <label style={{ display: "grid", gap: 4, maxWidth: 320, marginBottom: 8 }}>
                        <span style={{ fontSize: 12, opacity: 0.8 }}>Authorised location *</span>
                        <select
                          data-testid="first-shop-staff-location-select"
                          value={assignLocationId || activeLocations[0].id}
                          onChange={(event) => setAssignLocationId(event.target.value)}
                          style={{ background: "#0d0d0d", color: "#fff", border: "1px solid #555", borderRadius: 7, padding: "8px 10px" }}
                        >
                          {activeLocations.map((l) => (
                            <option key={l.id} value={l.id}>{l.name}</option>
                          ))}
                        </select>
                      </label>
                      {unassignedOperators.map((u) => (
                        <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
                          <span data-testid={`first-shop-staff-user-${u.id}`}>{u.email}{u.role ? ` — ${u.role}` : ""}</span>
                          <AdminButton
                            size="sm"
                            variant="gold"
                            disabled={assignLocation.isPending}
                            onClick={() => assignLocation.mutate(u.id)}
                            data-testid={`first-shop-assign-location-${u.id}`}
                          >
                            Assign location
                          </AdminButton>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
              <div style={{ marginTop: 10 }}>
                <Link href={`/admin/partners/${shop.organisation.id}/staff`} data-testid="first-shop-staff-action">Open Staff</Link>
              </div>
            </Step>
            <Step number={6} title="Scanner station" complete={shop.operational.dimensions.station.status === "PASS"} status={shop.operational.dimensions.station.status}>
              <p data-testid="first-shop-station-message">{shop.operational.dimensions.station.message}</p>
              {pendingStations.length > 0 ? (
                <div data-testid="first-shop-station-pending" style={{ marginTop: 10 }}>
                  {/* The wizard answers "what do I do next?" here, instead of sending the operator
                      to hunt through Station Fleet. Approval itself is still the existing canonical
                      station transition behind its existing admin step-up. */}
                  <p style={{ fontWeight: 700, letterSpacing: "0.04em" }}>SCANNER WAITING FOR APPROVAL</p>
                  {pendingStations.map((st) => (
                    <div key={stationCodeOf(st)} style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
                      <code>{stationCodeOf(st)}</code>
                      <AdminButton
                        size="sm"
                        variant="gold"
                        disabled={approveStation.isPending}
                        onClick={() => approveStation.mutate(stationCodeOf(st))}
                        data-testid={`first-shop-approve-station-${stationCodeOf(st)}`}
                      >
                        Approve Scanner
                      </AdminButton>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
                  Station enrolment must come from the real shop Scanner: the operator signs in on the Mac and
                  registers it. This step updates by itself when a request arrives.
                </p>
              )}
              <div style={{ marginTop: 10 }}>
                <Link href={`/admin/partners/${shop.organisation.id}/stations`} data-testid="first-shop-station-action">Open station setup</Link>
              </div>
            </Step>
            <Step number={7} title="Calibration and Scanner health" complete={shop.operational.dimensions.scanner.status === "PASS"} status={shop.operational.dimensions.scanner.status}>
              <p data-testid="first-shop-scanner-message">{shop.operational.dimensions.scanner.message}</p>
              <p style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
                Calibration happens physically in the Scanner app on the shop Mac. This step turns green once the
                station reports a VALID calibration.
              </p>
            </Step>
            <Step number={8} title="Credits" complete={shop.operational.dimensions.credits.status === "PASS"} status={shop.operational.dimensions.credits.status}>
              <p data-testid="first-shop-credits-message">{shop.operational.dimensions.credits.message}</p>
              <div style={{ marginTop: 10 }}>
                <Link href={`/admin/partners/${shop.organisation.id}/credits`} data-testid="first-shop-credits-action">Open credits / billing readiness</Link>
              </div>
            </Step>
            <Step number={9} title="Test card" complete={shop.operational.testCard.state === "COMPLETE"} status={shop.operational.testCard.status}>
              {/*
                * EVERY WORD HERE COMES FROM THE SERVER. The state, the sentence and the actions are
                * all produced by derivePartnerOperationalReadiness from the explicit
                * `purpose = 'ONBOARDING_TEST'` marker and the Card Job lifecycle. Nothing on this
                * page inspects a status, counts a card or infers which job the test one is — that
                * inference is the exact defect the marker was added to remove.
                */}
              <p data-testid="first-shop-test-card-message" data-state={shop.operational.testCard.state}>
                {shop.operational.testCard.message}
              </p>
              {shop.operational.testCard.cardJob?.mvNumber && (
                <p style={{ fontSize: 12, opacity: 0.85 }} data-testid="first-shop-test-card-mv">
                  Test card: <code>{shop.operational.testCard.cardJob.mvNumber}</code>
                  {shop.operational.testCard.cardJob.sidesAccepted
                    ? ` — captured: ${
                        shop.operational.testCard.cardJob.sidesAccepted.length > 0
                          ? shop.operational.testCard.cardJob.sidesAccepted.join(" + ")
                          : "neither side yet"
                      }`
                    : ""}
                </p>
              )}
              {shop.operational.testCard.state === "NOT_STARTED" &&
                (!shop.testCardArmingReadable ? (
                  <p role="alert" data-testid="first-shop-test-card-unavailable">
                    Test card status unavailable.
                  </p>
                ) : shop.testCardArmedAt ? (
                  <p data-testid="first-shop-test-card-armed" style={{ fontSize: 12, opacity: 0.85 }}>
                    Armed. The next card scanned in MintVault Scanner at this shop is recorded as the
                    onboarding test card. It costs one Grading Credit, exactly like any other card.
                  </p>
                ) : (
                  <div data-testid="first-shop-test-card-arm-panel" style={{ marginTop: 10 }}>
                    <p style={{ fontSize: 12, opacity: 0.85 }}>
                      The shop scans its test card on its own Mac. Arm it here first so MintVault records
                      that card as the test rather than guessing which one it was.
                    </p>
                    <AdminButton
                      size="sm"
                      variant="gold"
                      disabled={armTestCard.isPending}
                      onClick={() => armTestCard.mutate()}
                      data-testid="first-shop-arm-test-card"
                    >
                      {armTestCard.isPending ? "Arming…" : "Arm the test card"}
                    </AdminButton>
                  </div>
                ))}
            </Step>
            <Step number={10} title="Ready" complete={shop.operational.onboarding.complete}>
              {/*
                * `onboarding.complete`, NOT `overall.ready`. The two are different questions and the
                * server keeps them apart: `ready` is "can this shop grade a card now", which is true
                * before any test card exists, while `onboarding.complete` additionally requires the
                * shop to have put one card all the way through. This step is the second question.
                */}
              <p data-testid="first-shop-ready-message">{shop.operational.onboarding.message}</p>
              <ReadinessPanel readiness={shop.operational} audience="SUPER_ADMIN" />
            </Step>
            </details>
          </>
        )}
      </div>
    </AdminShell>
  );
}

function AddressFields({ value, onChange }: { value: typeof emptyAddress; onChange: (key: keyof typeof emptyAddress, value: string) => void }) {
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      <Input label="Address line 1" value={value.line1} onChange={(next) => onChange("line1", next)} />
      <Input label="Address line 2" value={value.line2} onChange={(next) => onChange("line2", next)} required={false} />
      <Input label="Town / city" value={value.city} onChange={(next) => onChange("city", next)} />
      <Input label="Postcode" value={value.postcode} onChange={(next) => onChange("postcode", next)} />
      <Input label="Country" value={value.country} onChange={(next) => onChange("country", next)} />
    </div>
  );
}
