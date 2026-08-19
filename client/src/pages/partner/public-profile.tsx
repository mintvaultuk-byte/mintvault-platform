import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink, MapPin, RefreshCw, ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { partnerErrorMessage, partnerGooglePresence, partnerPublicProfile } from "@/lib/partner-api";
import { isStepUpCancelled, usePartnerStepUp } from "@/components/partner/partner-step-up";
import { queryClient } from "@/lib/queryClient";

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
      {query.data?.locations.length === 0 && <p className="text-sm text-muted-foreground">No locations available.</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        {query.data?.locations.map((location) => (
          <Card key={location.id} className="rounded-md">
            <CardContent className="space-y-4 pt-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex gap-3">
                  <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                  <div>
                    <h2 className="font-semibold">{location.name}</h2>
                    <p className="mt-1 text-sm text-muted-foreground">{location.address || "Address required"}</p>
                  </div>
                </div>
                <Badge variant={location.live ? "default" : "secondary"}>
                  {location.live ? "Live" : location.configured ? "Not live" : "Private"}
                </Badge>
              </div>

              <div className="rounded-md border p-3 text-sm">
                <div className="flex items-center gap-2 font-medium">
                  <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
                  Publication readiness
                </div>
                <ul className="mt-2 space-y-1 text-muted-foreground">
                  <li>{location.status === "ACTIVE" ? "✓" : "—"} Location is active</li>
                  <li>{location.address ? "✓" : "—"} Public shop address</li>
                  <li>{location.blockingReasons.includes("APPROVED_DISPLAY_NAME_REQUIRED") ? "—" : "✓"} Approved public display name</li>
                  <li>{location.configured ? "✓" : "—"} Approved for public display</li>
                  <li>{location.live ? "✓" : "—"} Network-wide directory is live</li>
                </ul>
              </div>

              {location.live ? (
                <a
                  href={location.publicUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-11 items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium"
                >
                  Open public page <ExternalLink className="h-4 w-4" aria-hidden="true" />
                </a>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Ask MintVault Partner Support to review and publish this location once the missing items are complete.
                </p>
              )}
            </CardContent>
          </Card>
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
