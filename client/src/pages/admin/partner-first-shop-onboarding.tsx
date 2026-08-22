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
import type { PartnerOperationalReadiness } from "@shared/partner-readiness";

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

function Step({ number, title, complete, children }: { number: number; title: string; complete: boolean; children: React.ReactNode }) {
  return (
    <Panel title={`${number}. ${title}`} sub={complete ? "Complete" : "Action required"}>
      <div data-testid={`first-shop-step-${number}`} data-complete={complete ? "true" : "false"}>
        {children}
      </div>
    </Panel>
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
  const [legalName, setLegalName] = useState("");
  const [locationName, setLocationName] = useState("Main location");
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
        locationName,
        deliveryAddress: address,
        operationsContact: { fullName: contactName, email: contactEmail },
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
            <Step number={1} title="Shop" complete={false}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Input label="Legal / shop name" value={legalName} onChange={resetCreateIntent(setLegalName)} />
                <Input label="Main location name" value={locationName} onChange={resetCreateIntent(setLocationName)} />
              </div>
            </Step>
            <Step number={2} title="Main location delivery address" complete={false}>
              <AddressFields value={addressValue} onChange={setAddressField} />
            </Step>
            <Step number={3} title="Primary operations contact" complete={false}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Input label="Contact name" value={contactName} onChange={resetCreateIntent(setContactName)} />
                <Input label="Operational email" value={contactEmail} onChange={resetCreateIntent(setContactEmail)} type="email" />
              </div>
            </Step>
            <Step number={4} title="Partner Owner" complete={false}>
              <p style={{ marginTop: 0 }}>Submitting sends this Owner the existing invitation flow. They set their own password and MFA; neither secret is shown to MintVault staff.</p>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Input label="Owner first name" value={ownerFirstName} onChange={resetCreateIntent(setOwnerFirstName)} />
                <Input label="Owner last name" value={ownerLastName} onChange={resetCreateIntent(setOwnerLastName)} />
                <Input label="Owner email" value={ownerEmail} onChange={resetCreateIntent(setOwnerEmail)} type="email" />
              </div>
            </Step>
            <Panel title="Create first shop" sub="Creates canonical records atomically before the Owner invitation is delivered.">
              <AdminButton type="submit" variant="gold" disabled={create.isPending} data-testid="first-shop-create-submit">
                {create.isPending ? "Creating…" : "Create shop and send Owner invitation"}
              </AdminButton>
            </Panel>
          </form>
        ) : onboarding.isLoading ? (
          <div role="status">Loading the canonical first-shop records…</div>
        ) : !shop ? (
          <div role="alert">This Partner could not be loaded.</div>
        ) : (
          <>
            <Panel title="Current scope" sub="Every action below is scoped to this exact Partner and Main location.">
              <div data-testid="first-shop-current-partner"><b>Current Partner:</b> {shop.organisation.legalName} <Badge variant={shop.organisation.status === "ACTIVE" ? "act" : "wait"}>{shop.organisation.status}</Badge></div>
              <div data-testid="first-shop-current-location" style={{ marginTop: 6 }}><b>Current location:</b> {mainLocation ? `${mainLocation.name} (${mainLocation.status})` : "No active Main location"}</div>
            </Panel>
            <Step number={1} title="Shop" complete={shop.organisation.status === "ACTIVE"}>
              <p>Partner status: <b>{shop.organisation.status}</b>. The record remains pending until the operator deliberately activates it.</p>
              {shop.organisation.status === "PENDING" && <AdminButton size="sm" variant="gold" disabled={activate.isPending} onClick={() => activate.mutate()} data-testid="first-shop-activate">Activate Partner</AdminButton>}
            </Step>
            <Step number={2} title="Main location delivery address" complete={shop.operational.dimensions.delivery.status === "PASS"}>
              <form onSubmit={(event) => { event.preventDefault(); saveAddress.mutate(); }}>
                <AddressFields value={addressValue} onChange={setAddressField} />
                <AdminButton type="submit" size="sm" variant="gold" disabled={!mainLocation || saveAddress.isPending} data-testid="first-shop-save-address" style={{ marginTop: 12 }}>Save Main location address</AdminButton>
              </form>
            </Step>
            <Step number={3} title="Primary operations contact" complete={shop.operational.dimensions.operationsContact.status === "PASS"}>
              <form onSubmit={(event) => { event.preventDefault(); saveContact.mutate(); }}>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <Input label="Contact name" value={contactNameValue} onChange={setContactNameForCurrentShop} />
                  <Input label="Operational email" value={contactEmailValue} onChange={setContactEmailForCurrentShop} type="email" />
                </div>
                <AdminButton type="submit" size="sm" variant="gold" disabled={saveContact.isPending} data-testid="first-shop-save-contact" style={{ marginTop: 12 }}>Save primary operations contact</AdminButton>
              </form>
            </Step>
            <Step number={4} title="Partner Owner" complete={shop.operational.dimensions.owner.status === "PASS"}>
              <p>{shop.owner ? `Owner: ${shop.owner.email} — ${shop.owner.readiness?.onboardingState ?? shop.owner.userStatus}` : "No Partner Owner has been invited."}</p>
              <Link href={`/admin/partners/${shop.organisation.id}/staff`} data-testid="first-shop-owner-action">Open Owner setup</Link>
            </Step>
            <Step number={5} title="Staff and operator access" complete={shop.operational.dimensions.staff?.status === "PASS"}>
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
            <Step number={6} title="Scanner station" complete={shop.operational.dimensions.station.status === "PASS"}>
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
            <Step number={7} title="Calibration and Scanner health" complete={shop.operational.dimensions.scanner.status === "PASS"}>
              <p data-testid="first-shop-scanner-message">{shop.operational.dimensions.scanner.message}</p>
              <p style={{ marginTop: 8, fontSize: 12, opacity: 0.85 }}>
                Calibration happens physically in the Scanner app on the shop Mac. This step turns green once the
                station reports a VALID calibration.
              </p>
            </Step>
            <Step number={8} title="Credits" complete={shop.operational.dimensions.credits.status === "PASS"}>
              <p data-testid="first-shop-credits-message">{shop.operational.dimensions.credits.message}</p>
              <div style={{ marginTop: 10 }}>
                <Link href={`/admin/partners/${shop.organisation.id}/credits`} data-testid="first-shop-credits-action">Open credits / billing readiness</Link>
              </div>
            </Step>
            <Step number={9} title="Ready to grade" complete={shop.operational.overall.ready}>
              {/* Server-authoritative: rendered verbatim from derivePartnerOperationalReadiness. */}
              <ReadinessPanel readiness={shop.operational} audience="SUPER_ADMIN" />
            </Step>
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
