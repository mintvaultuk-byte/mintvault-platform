import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { partnerErrorMessage, partnerLaunch } from "@/lib/partner-api";

export default function PartnerCorrectionsPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["/api/partner/corrections"],
    queryFn: () => partnerLaunch.corrections(),
  });
  if (isLoading) return <PartnerLoadingState label="Loading corrections..." />;
  if (error) return <PartnerErrorState message={partnerErrorMessage(error)} onRetry={() => refetch()} />;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Corrections</h1>
      {data?.corrections.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">No open correction requests.</CardContent>
        </Card>
      )}
      <div className="space-y-2">
        {data?.corrections.map((correction) => (
          <Card key={correction.id}>
            <CardContent className="p-4 space-y-2">
              <div className="flex justify-between gap-3">
                <span className="font-medium">{correction.certificate_number}</span>
                <Badge>{correction.status}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">{correction.request_reason}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
