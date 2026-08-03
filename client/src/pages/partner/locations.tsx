import { useQuery } from "@tanstack/react-query";
import { MapPin } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { partnerErrorMessage, partnerLocations } from "@/lib/partner-api";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { usePartnerSession } from "@/hooks/use-partner-session";

export default function PartnerLocationsPage() {
  const { session } = usePartnerSession();
  const query = useQuery({ queryKey: ["/api/partner/locations"], queryFn: () => partnerLocations.list() });
  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase text-primary">Shop network</p>
        <h1 className="text-2xl font-semibold" data-testid="text-locations-title">
          Locations
        </h1>
      </div>
      {query.isLoading && <PartnerLoadingState label="Loading locations…" />}
      {query.error && <PartnerErrorState message={partnerErrorMessage(query.error)} onRetry={() => query.refetch()} />}
      {query.data && query.data.length === 0 && <p className="text-sm text-muted-foreground">No locations available</p>}
      <div className="grid md:grid-cols-2 gap-3">
        {query.data?.map((location) => (
          <Card key={location.id} className="rounded-md">
            <CardContent className="pt-5 flex gap-3">
              <MapPin className="h-5 w-5 text-primary shrink-0" aria-hidden="true" />
              <div>
                <p className="font-medium">{location.name}</p>
                <div className="flex flex-wrap gap-2 mt-2 text-xs">
                  <span className="border border-border rounded px-2 py-1">{location.status}</span>
                  {session?.locationId === location.id && (
                    <span className="border border-primary/40 text-primary rounded px-2 py-1">
                      Active grading location
                    </span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
