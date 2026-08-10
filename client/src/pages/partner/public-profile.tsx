import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { usePartnerSession } from "@/hooks/use-partner-session";
import { partnerErrorMessage, partnerPublicListings, type PartnerPublicListing } from "@/lib/partner-api";

type EditableListing = Pick<
  PartnerPublicListing,
  "public_phone" | "public_email" | "public_website" | "public_opening_info" | "public_description"
>;

function RatingSummary({ listing }: { listing: PartnerPublicListing }) {
  if (!listing.current_rating_available) {
    return (
      <p className="text-sm text-muted-foreground">
        {listing.current_rating_label || "Rating building"} · {listing.current_sample_size} of{" "}
        {listing.current_minimum_sample} cards graded
      </p>
    );
  }
  return (
    <p className="text-sm">
      <span className="font-semibold">{listing.current_public_rating?.toFixed(1)} / 5</span> ·{" "}
      {listing.current_rating_label} · based on {listing.current_sample_size} graded cards
    </p>
  );
}

export default function PartnerPublicProfilePage() {
  const { hasPermission } = usePartnerSession();
  const queryClient = useQueryClient();
  const listings = useQuery({
    queryKey: ["/api/partner/public-listings"],
    queryFn: () => partnerPublicListings.list(),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<EditableListing | null>(null);
  const canEdit = hasPermission("partner.users.manage");
  const selected = listings.data?.rows.find((listing) => listing.id === selectedId) ?? listings.data?.rows[0];

  useEffect(() => {
    if (!selected) return;
    setSelectedId(selected.id);
    setForm({
      public_phone: selected.public_phone,
      public_email: selected.public_email,
      public_website: selected.public_website,
      public_opening_info: selected.public_opening_info,
      public_description: selected.public_description,
    });
  }, [selected?.id]);

  const save = useMutation({
    mutationFn: async () => {
      if (!selected || !form) return;
      await partnerPublicListings.update(selected.id, {
        phone: form.public_phone,
        email: form.public_email,
        website: form.public_website,
        openingInfo: form.public_opening_info,
        description: form.public_description,
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/partner/public-listings"] }),
  });

  if (listings.isLoading) return <PartnerLoadingState label="Loading public profile…" />;
  if (listings.error)
    return <PartnerErrorState message={partnerErrorMessage(listings.error)} onRetry={() => listings.refetch()} />;
  if (!selected || !form) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          This shop does not have a public listing yet. Contact MintVault to start the listing review.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6" data-testid="partner-public-profile-page">
      <div>
        <p className="text-xs font-semibold uppercase text-primary">Public network</p>
        <h1 className="text-2xl font-semibold">Public Profile</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          MintVault manages your listing identity, address, verification, status and rating. You can maintain public
          contact details below.
        </p>
      </div>
      {listings.data!.rows.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {listings.data!.rows.map((listing) => (
            <Button
              key={listing.id}
              type="button"
              variant={listing.id === selected.id ? "default" : "outline"}
              onClick={() => setSelectedId(listing.id)}
            >
              {listing.public_display_name}
            </Button>
          ))}
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-[1.3fr_0.7fr]">
        <Card className="rounded-md">
          <CardHeader>
            <CardTitle className="text-base">Public contact details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field
              label="Phone"
              value={form.public_phone}
              disabled={!canEdit}
              onChange={(public_phone) => setForm({ ...form, public_phone })}
            />
            <Field
              label="Email"
              type="email"
              value={form.public_email}
              disabled={!canEdit}
              onChange={(public_email) => setForm({ ...form, public_email })}
            />
            <Field
              label="Website"
              type="url"
              value={form.public_website}
              disabled={!canEdit}
              onChange={(public_website) => setForm({ ...form, public_website })}
            />
            <div className="space-y-2">
              <Label htmlFor="opening-info">Opening information</Label>
              <Textarea
                id="opening-info"
                value={form.public_opening_info ?? ""}
                disabled={!canEdit}
                onChange={(event) => setForm({ ...form, public_opening_info: event.target.value || null })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="profile-description">Description</Label>
              <Textarea
                id="profile-description"
                value={form.public_description ?? ""}
                disabled={!canEdit}
                onChange={(event) => setForm({ ...form, public_description: event.target.value || null })}
              />
            </div>
            {canEdit ? (
              <Button disabled={save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? "Saving…" : "Save public details"}
              </Button>
            ) : (
              <p className="text-sm text-muted-foreground">
                Your role can view this profile but cannot publish changes.
              </p>
            )}
            {save.error && (
              <p role="alert" className="text-sm text-destructive">
                {partnerErrorMessage(save.error)}
              </p>
            )}
            {save.isSuccess && <p className="text-sm text-emerald-600">Public details saved.</p>}
          </CardContent>
        </Card>
        <Card className="rounded-md">
          <CardHeader>
            <CardTitle className="text-base">MintVault-managed details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div>
              <p className="text-muted-foreground">Listing status</p>
              <p className="font-medium">{selected.listing_status}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Address</p>
              <p>
                {[selected.town_city, selected.county, selected.postcode].filter(Boolean).join(", ") ||
                  "Managed by MintVault"}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">MintVault Quality Rating</p>
              <RatingSummary listing={selected} />
            </div>
            <p className="border-t pt-3 text-muted-foreground">
              For address, identity, verification or status changes, contact MintVault.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  disabled,
  onChange,
  type = "text",
}: {
  label: string;
  value: string | null;
  disabled: boolean;
  onChange: (value: string | null) => void;
  type?: string;
}) {
  const id = `public-${label.toLowerCase()}`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || null)}
      />
    </div>
  );
}
