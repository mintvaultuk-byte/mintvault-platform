/** Partner Owner confirmation of the same first-shop records the Super Admin guide created. */
import { useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { ReadinessPanel } from "@/components/partner/readiness-panel";
import { partnerErrorMessage, partnerOnboarding } from "@/lib/partner-api";

interface DeliveryAddressForm {
  line1: string;
  line2: string;
  city: string;
  postcode: string;
  country: string;
}

const requestKey = () => `partner-owner-onboarding-${crypto.randomUUID()}`;

function Field({ label, value, setValue, type = "text", required = true }: { label: string; value: string; setValue: (value: string) => void; type?: string; required?: boolean }) {
  const fieldId = `partner-onboarding-${label.toLocaleLowerCase("en-GB").replace(/[^a-z0-9]+/g, "-")}`;
  return (
    <div className="space-y-1">
      <Label className="text-xs" htmlFor={fieldId}>{label}{required ? " *" : ""}</Label>
      <Input id={fieldId} type={type} required={required} value={value} onChange={(event) => setValue(event.target.value)} />
    </div>
  );
}

export default function PartnerOnboardingPage() {
  const onboarding = useQuery({ queryKey: ["/api/partner/onboarding"], queryFn: () => partnerOnboarding.view() });
  const [notice, setNotice] = useState<string | null>(null);
  const [address, setAddress] = useState<DeliveryAddressForm | null>(null);
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const addressIdempotencyKey = useRef(requestKey());
  const contactIdempotencyKey = useRef(requestKey());
  const shop = onboarding.data;
  const fromServer = useMemo(
    () => ({
      line1: shop?.mainLocation?.addressLine1 ?? "",
      line2: shop?.mainLocation?.addressLine2 ?? "",
      city: shop?.mainLocation?.addressCity ?? "",
      postcode: shop?.mainLocation?.addressPostcode ?? "",
      country: shop?.mainLocation?.addressCountry ?? "United Kingdom",
    }),
    [shop]
  );
  const addressValue = address ?? fromServer;
  const contactNameValue = contactName || shop?.primaryContact?.full_name || "";
  const contactEmailValue = contactEmail || shop?.primaryContact?.email || "";
  const setAddressField = (key: keyof DeliveryAddressForm, value: string) => {
    addressIdempotencyKey.current = requestKey();
    setAddress((current) => ({ ...(current ?? fromServer), [key]: value }));
  };
  const setContactNameForCurrentShop = (value: string) => {
    contactIdempotencyKey.current = requestKey();
    setContactName(value);
  };
  const setContactEmailForCurrentShop = (value: string) => {
    contactIdempotencyKey.current = requestKey();
    setContactEmail(value);
  };

  const saveAddress = useMutation({
    mutationFn: () => partnerOnboarding.updateMainLocation(addressValue, addressIdempotencyKey.current),
    onSuccess: async () => {
      setNotice("Main location delivery address confirmed.");
      addressIdempotencyKey.current = requestKey();
      await onboarding.refetch();
    },
    onError: (error) => setNotice(partnerErrorMessage(error)),
  });
  const saveContact = useMutation({
    mutationFn: () => partnerOnboarding.updateOperationsContact(
      { fullName: contactNameValue, email: contactEmailValue },
      contactIdempotencyKey.current
    ),
    onSuccess: async () => {
      setNotice("Primary operations contact confirmed.");
      contactIdempotencyKey.current = requestKey();
      await onboarding.refetch();
    },
    onError: (error) => setNotice(partnerErrorMessage(error)),
  });

  if (onboarding.isLoading) return <PartnerLoadingState label="Loading shop setup…" />;
  if (onboarding.error) return <PartnerErrorState message={partnerErrorMessage(onboarding.error)} onRetry={() => void onboarding.refetch()} />;
  if (!shop) return <PartnerErrorState message="Shop setup is unavailable." onRetry={() => void onboarding.refetch()} />;

  return (
    <div className="space-y-6" data-testid="partner-first-shop-onboarding">
      <header>
        <p className="text-xs font-semibold uppercase text-primary">First-shop setup</p>
        <h1 className="text-2xl font-semibold">Confirm your shop details</h1>
        <p className="mt-1 text-sm text-muted-foreground">These details are shared by Supplies, Scanner readiness and grading. Confirm them here once — do not create a second contact or location.</p>
      </header>
      <Card>
        <CardContent className="pt-5 text-sm space-y-1">
          <p data-testid="partner-onboarding-current-partner"><b>Current Partner:</b> {shop.organisation.legalName} ({shop.organisation.status})</p>
          <p data-testid="partner-onboarding-current-location"><b>Current location:</b> {shop.mainLocation ? `${shop.mainLocation.name} (${shop.mainLocation.status})` : "No active Main location"}</p>
        </CardContent>
      </Card>
      {notice ? <p role="status" className="rounded-md border border-primary/40 p-3 text-sm">{notice}</p> : null}
      <Card>
        <CardHeader><CardTitle className="text-base">1. Main location delivery address</CardTitle></CardHeader>
        <CardContent>
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); saveAddress.mutate(); }}>
            <Field label="Address line 1" value={addressValue.line1} setValue={(value) => setAddressField("line1", value)} />
            <Field label="Address line 2" value={addressValue.line2} setValue={(value) => setAddressField("line2", value)} required={false} />
            <Field label="Town / city" value={addressValue.city} setValue={(value) => setAddressField("city", value)} />
            <Field label="Postcode" value={addressValue.postcode} setValue={(value) => setAddressField("postcode", value)} />
            <Field label="Country" value={addressValue.country} setValue={(value) => setAddressField("country", value)} />
            <div className="sm:col-span-2"><Button type="submit" disabled={saveAddress.isPending || !shop.mainLocation}>Confirm delivery address</Button></div>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">2. Primary operations contact</CardTitle></CardHeader>
        <CardContent>
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); saveContact.mutate(); }}>
            <Field label="Contact name" value={contactNameValue} setValue={setContactNameForCurrentShop} />
            <Field label="Operational email" value={contactEmailValue} setValue={setContactEmailForCurrentShop} type="email" />
            <div className="sm:col-span-2"><Button type="submit" disabled={saveContact.isPending}>Confirm operations contact</Button></div>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">3. Owner, station and credits</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>Set up or review your password and two-step sign-in in <Link className="text-primary underline" href="/partner/security">Security &amp; Account</Link>.</p>
          <p>Request and operate the station from MintVault Scanner at this Main location. MintVault must approve it before capture can begin.</p>
          <Link className="text-primary underline" href="/partner/billing">Open Credits &amp; Billing</Link>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">4. Readiness</CardTitle></CardHeader>
        <CardContent><ReadinessPanel readiness={shop.operational} audience="PARTNER" /></CardContent>
      </Card>
    </div>
  );
}
