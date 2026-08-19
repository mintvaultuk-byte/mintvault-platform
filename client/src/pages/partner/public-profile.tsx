import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink, Eye, MapPin, RefreshCw, ShieldCheck, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { partnerErrorMessage, partnerGooglePresence, partnerPublicProfile } from "@/lib/partner-api";
import { isStepUpCancelled, usePartnerStepUp } from "@/components/partner/partner-step-up";
import { queryClient } from "@/lib/queryClient";
import { PublicPartnerProfileView } from "@/components/public-partner-profile-view";
import type { AuthenticatedPublicProfileRow, PartnerPublicPrivacyState } from "@shared/public-partner";

function ProfilePreview({ location, onClose }: { location: AuthenticatedPublicProfileRow; onClose(): void }) {
  if (!location.preview) return null;
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby={`preview-${location.id}`}>
      <div className="mx-auto max-w-6xl rounded-lg bg-[#FAFAF8] p-5 text-[#171717] shadow-xl sm:p-8">
        <div className="mb-6 flex items-center justify-between gap-4 border-b border-[#D8D2C7] pb-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-[#765B00]">Private preview — not a publication action</p>
            <h2 id={`preview-${location.id}`} className="text-xl font-semibold">Exact customer view</h2>
          </div>
          <button type="button" onClick={onClose} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border" aria-label="Close public profile preview">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <PublicPartnerProfileView location={location.preview} />
      </div>
    </div>
  );
}

function PublicLocationCard({
  location,
  displayName,
  owner,
  googleConnected,
}: {
  location: AuthenticatedPublicProfileRow;
  displayName: string;
  owner: boolean;
  googleConnected: boolean;
}) {
  const { runProtected } = usePartnerStepUp();
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState(false);
  const [privacyState, setPrivacyState] = useState<PartnerPublicPrivacyState>(location.privacyState);
  const [form, setForm] = useState({
    publicDisplayName: displayName,
    publicLocationName: location.publicLocationName ?? location.operationalName,
    publicStreetAddress: location.publicStreetAddress ?? "",
    publicServiceArea: location.publicServiceArea ?? "",
    publicWebsite: location.publicWebsite ?? "",
    publicPhone: location.publicPhone ?? "",
    publicEmail: location.publicEmail ?? "",
    mapsEnabled: location.mapsEnabled,
    attested: false,
  });
  const save = useMutation({
    mutationFn: () => runProtected(() => partnerPublicProfile.save(location.id, { ...form, privacyState })),
    onSuccess: async () => {
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ["/api/partner/public-profile"] });
    },
  });
  const live = location.publication.live;
  return (
    <Card className="rounded-md">
      <CardContent className="space-y-4 pt-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex gap-3">
            <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <div>
              <h2 className="font-semibold">{location.operationalName}</h2>
              <p className="mt-1 text-sm text-muted-foreground">Operational address (private): {location.operationalAddress || "Not supplied"}</p>
            </div>
          </div>
          <Badge variant={live ? "default" : "secondary"}>{live ? "Live" : location.publication.approved ? "Approved — not live" : "Private"}</Badge>
        </div>

        <div className="rounded-md border p-3 text-sm">
          <div className="flex items-center gap-2 font-medium"><ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />Public Profile</div>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            <li>{displayName ? "✓" : "—"} Business name</li>
            <li>{location.preview?.address || location.preview?.serviceArea ? "✓" : "—"} Public location</li>
            <li>{location.publicPhone ? "✓" : "—"} Phone</li>
            <li>{location.publicWebsite ? "✓" : "—"} Website</li>
            <li>— Opening hours</li>
            <li>{googleConnected ? "✓ Connected" : "— Not connected"} Google Business Profile</li>
          </ul>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={!location.preview} onClick={() => setPreview(true)}>
            <Eye className="mr-2 h-4 w-4" aria-hidden="true" /> View public profile
          </Button>
          {live && (
            <a href={location.publicUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium">
              Open live page <ExternalLink className="h-4 w-4" aria-hidden="true" />
            </a>
          )}
          {owner && <Button type="button" onClick={() => setEditing((value) => !value)}>{editing ? "Cancel editing" : "Edit public details"}</Button>}
        </div>
        {!location.preview && <p className="text-sm text-muted-foreground">Complete a public business name, location name and safe storefront address or service area to enable preview.</p>}
        {location.consentedAt && <p className="text-xs text-muted-foreground">Partner-attested version {location.version}. Any edit immediately removes it from the directory until Super Admin approves the new exact version.</p>}

        {editing && owner && (
          <form className="space-y-4 rounded-md border p-4" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
            <label className="block text-sm font-medium">Public business name
              <input className="mt-1 min-h-11 w-full rounded-md border bg-background px-3" maxLength={160} value={form.publicDisplayName} onChange={(e) => setForm({ ...form, publicDisplayName: e.target.value })} required />
            </label>
            <label className="block text-sm font-medium">Address/privacy classification
              <select className="mt-1 min-h-11 w-full rounded-md border bg-background px-3" value={privacyState} onChange={(e) => setPrivacyState(e.target.value as PartnerPublicPrivacyState)}>
                <option value="INCOMPLETE_UNVERIFIED">Incomplete / unverified</option>
                <option value="PUBLIC_STOREFRONT">Public storefront</option>
                <option value="SERVICE_AREA_PRIVATE_ADDRESS">Service area / private address</option>
                <option value="NOT_PUBLIC">Not public</option>
              </select>
            </label>
            <label className="block text-sm font-medium">Public location name
              <input className="mt-1 min-h-11 w-full rounded-md border bg-background px-3" maxLength={120} value={form.publicLocationName} onChange={(e) => setForm({ ...form, publicLocationName: e.target.value })} />
            </label>
            {privacyState === "PUBLIC_STOREFRONT" && (
              <label className="block text-sm font-medium">Public storefront address
                <textarea className="mt-1 min-h-20 w-full rounded-md border bg-background px-3 py-2" maxLength={500} value={form.publicStreetAddress} onChange={(e) => setForm({ ...form, publicStreetAddress: e.target.value })} />
              </label>
            )}
            {privacyState === "SERVICE_AREA_PRIVATE_ADDRESS" && (
              <label className="block text-sm font-medium">Public service area (no street address shown)
                <input className="mt-1 min-h-11 w-full rounded-md border bg-background px-3" maxLength={160} value={form.publicServiceArea} onChange={(e) => setForm({ ...form, publicServiceArea: e.target.value })} />
              </label>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-medium">Public website<input className="mt-1 min-h-11 w-full rounded-md border bg-background px-3" value={form.publicWebsite} onChange={(e) => setForm({ ...form, publicWebsite: e.target.value })} placeholder="https://…" /></label>
              <label className="text-sm font-medium">Public phone<input className="mt-1 min-h-11 w-full rounded-md border bg-background px-3" value={form.publicPhone} onChange={(e) => setForm({ ...form, publicPhone: e.target.value })} /></label>
              <label className="text-sm font-medium sm:col-span-2">Public email<input className="mt-1 min-h-11 w-full rounded-md border bg-background px-3" type="email" value={form.publicEmail} onChange={(e) => setForm({ ...form, publicEmail: e.target.value })} /></label>
            </div>
            {privacyState === "PUBLIC_STOREFRONT" && (
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={form.mapsEnabled} onChange={(e) => setForm({ ...form, mapsEnabled: e.target.checked })} />I consent to this exact public street address being used for Maps and directions.</label>
            )}
            <label className="flex items-start gap-2 rounded-md bg-muted p-3 text-sm"><input type="checkbox" className="mt-1" checked={form.attested} onChange={(e) => setForm({ ...form, attested: e.target.checked })} />I am a Partner Owner and attest that every populated field above is intended for public display. I understand the operational address is separate.</label>
            {save.error && !isStepUpCancelled(save.error) && <p className="text-sm text-destructive" role="alert">{partnerErrorMessage(save.error)}</p>}
            <Button type="submit" disabled={!form.attested || save.isPending}>{save.isPending ? "Saving…" : "Save and attest exact public fields"}</Button>
          </form>
        )}
        {preview && <ProfilePreview location={location} onClose={() => setPreview(false)} />}
      </CardContent>
    </Card>
  );
}

export default function PartnerPublicProfilePage() {
  const { runProtected } = usePartnerStepUp();
  const query = useQuery({
    queryKey: ["/api/partner/public-profile"],
    queryFn: () => partnerPublicProfile.get(),
  });
  const google = useQuery({
    queryKey: ["/api/partner/google-business/status"],
    queryFn: () => partnerGooglePresence.status(),
  });
  const googleMutation = useMutation({
    mutationFn: (action: () => Promise<unknown>) => runProtected(action),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/partner/google-business/status"] }),
  });
  const googleError = googleMutation.error && !isStepUpCancelled(googleMutation.error)
    ? partnerErrorMessage(googleMutation.error)
    : null;
  const callbackState = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("google") : null;

  return (
    <div className="space-y-6" data-testid="partner-public-profile-page">
      <div>
        <p className="text-xs font-semibold uppercase text-primary">Public network</p>
        <h1 className="text-2xl font-semibold">Public Profile</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          See exactly which shop locations are ready and visible to customers. MintVault Super Admin controls publication;
          operational status and public visibility remain separate.
        </p>
      </div>

      {query.isLoading && <PartnerLoadingState label="Loading public profile state…" />}
      {query.error && <PartnerErrorState message={partnerErrorMessage(query.error)} onRetry={() => query.refetch()} />}
      {query.data?.available === false && (
        <Card className="rounded-md"><CardContent className="pt-5 text-sm text-muted-foreground">Public-profile editing is not available until the publication migration is applied. No operational location data is public.</CardContent></Card>
      )}
      {query.data?.locations.length === 0 && <p className="text-sm text-muted-foreground">No locations available.</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        {query.data?.locations.map((location) => (
          <PublicLocationCard
            key={`${location.id}-${location.version}`}
            location={location}
            displayName={query.data.profile?.publicDisplayName ?? ""}
            owner={query.data.owner}
            googleConnected={google.data?.available === true && google.data.locations.some((item) => item.locationId === location.id && item.state === "CONNECTED")}
          />
        ))}
      </div>

      <section aria-labelledby="google-business-heading" className="space-y-4">
        <div>
          <p className="text-xs font-semibold uppercase text-primary">Optional listing connection</p>
          <h2 id="google-business-heading" className="text-xl font-semibold">Google Business Profile</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Link an existing Google listing so MintVault can use its exact Maps destination. Google remains the listing
            provider; connecting it does not publish a private MintVault location.
          </p>
        </div>

        {callbackState === "select" && (
          <p className="rounded-md border border-primary/40 bg-primary/5 p-3 text-sm" role="status">
            Google authorised successfully. Select the exact shop listing below to finish.
          </p>
        )}
        {callbackState && callbackState !== "select" && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm" role="status">
            The Google connection was not completed. Nothing about your MintVault public profile changed.
          </p>
        )}
        {googleError && <p className="text-sm text-destructive" role="alert">{googleError}</p>}
        {google.isLoading && <PartnerLoadingState label="Loading Google Business state…" />}
        {google.error && <PartnerErrorState message={partnerErrorMessage(google.error)} onRetry={() => google.refetch()} />}
        {google.data?.available === false && (
          <Card className="rounded-md"><CardContent className="pt-5 text-sm text-muted-foreground">
            Google Business connection is not available yet. Your MintVault profile and public directory status are unaffected.
          </CardContent></Card>
        )}

        {google.data?.available && google.data.locations.map((location) => (
          <Card key={location.locationId} className="rounded-md" data-testid={`partner-google-${location.locationId}`}>
            <CardContent className="space-y-4 pt-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold">{location.locationName}</h3>
                  <p className="text-sm text-muted-foreground">
                    {location.businessName || "No Google listing connected"}
                    {location.businessAddress ? ` · ${location.businessAddress}` : ""}
                  </p>
                </div>
                <Badge variant={location.state === "CONNECTED" ? "default" : "secondary"}>
                  {location.state === "CONNECTED" ? "Connected ✓" : location.state.replaceAll("_", " ")}
                </Badge>
              </div>

              {location.state === "CONNECTING" && location.candidates.length > 0 && (
                <fieldset className="space-y-3">
                  <legend className="text-sm font-medium">Choose the exact Google listing</legend>
                  {location.candidates.map((candidate) => (
                    <div key={candidate.handle} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
                      <div>
                        <div className="text-sm font-medium">{candidate.businessName}</div>
                        <div className="text-xs text-muted-foreground">{candidate.businessAddress || "Address not supplied by Google"}</div>
                      </div>
                      <Button
                        type="button"
                        disabled={!google.data.owner || googleMutation.isPending}
                        onClick={() => googleMutation.mutate(() => partnerGooglePresence.confirm(location.locationId, candidate.handle))}
                      >
                        This is my shop
                      </Button>
                    </div>
                  ))}
                </fieldset>
              )}

              {!google.data.owner ? (
                <p className="text-sm text-muted-foreground">A Partner Owner can manage this connection.</p>
              ) : location.state === "NOT_CONNECTED" ? (
                <Button
                  type="button"
                  disabled={googleMutation.isPending}
                  onClick={() => googleMutation.mutate(async () => {
                    const result = await partnerGooglePresence.connect(location.locationId);
                    window.location.assign(result.authorizationUrl);
                  })}
                >
                  Connect Google Business
                </Button>
              ) : location.state === "CONNECTED" ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={googleMutation.isPending}
                    onClick={() => googleMutation.mutate(() => partnerGooglePresence.refresh(location.locationId))}
                  >
                    <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" /> Refresh listing
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={googleMutation.isPending}
                    onClick={() => {
                      if (window.confirm(`Disconnect Google Business from ${location.locationName}?`)) {
                        googleMutation.mutate(() => partnerGooglePresence.disconnect(location.locationId));
                      }
                    }}
                  >
                    Disconnect
                  </Button>
                </div>
              ) : location.state !== "CONNECTING" ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={googleMutation.isPending}
                    onClick={() => googleMutation.mutate(async () => {
                      const result = await partnerGooglePresence.connect(location.locationId);
                      window.location.assign(result.authorizationUrl);
                    })}
                  >
                    Reconnect Google
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={googleMutation.isPending}
                    onClick={() => {
                      if (window.confirm(`Disconnect Google Business from ${location.locationName}?`)) {
                        googleMutation.mutate(() => partnerGooglePresence.disconnect(location.locationId));
                      }
                    }}
                  >
                    Disconnect
                  </Button>
                </div>
              ) : null}
              {location.lastSyncAt && (
                <p className="text-xs text-muted-foreground">Last refreshed {new Date(location.lastSyncAt).toLocaleString()}</p>
              )}
              {location.mapsUrl && location.state === "CONNECTED" && (
                <a
                  href={location.mapsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium"
                >
                  Open in Google Maps <ExternalLink className="h-4 w-4" aria-hidden="true" />
                </a>
              )}
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}
