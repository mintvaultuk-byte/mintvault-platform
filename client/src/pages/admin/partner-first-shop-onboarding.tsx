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
            <Step number={5} title="Station" complete={shop.operational.dimensions.station.status === "PASS"}>
              <p>Station enrolment must come from the real shop Scanner. Approval remains a protected Super Admin action.</p>
              <Link href={`/admin/partners/${shop.organisation.id}/stations`} data-testid="first-shop-station-action">Open station setup</Link>
            </Step>
            <Step number={6} title="Readiness" complete={shop.operational.overall.ready}>
              <ReadinessPanel readiness={shop.operational} audience="SUPER_ADMIN" />
              <div style={{ marginTop: 10 }}><Link href={`/admin/partners/${shop.organisation.id}/credits`} data-testid="first-shop-credits-action">Open credits / billing readiness</Link></div>
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
