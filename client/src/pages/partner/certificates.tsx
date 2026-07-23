import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { partnerErrorMessage, partnerLaunch } from "@/lib/partner-api";

export default function PartnerCertificatesPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["/api/partner/certificates"],
    queryFn: () => partnerLaunch.certificates(),
  });
  if (isLoading) return <PartnerLoadingState label="Loading certificates..." />;
  if (error) return <PartnerErrorState message={partnerErrorMessage(error)} onRetry={() => refetch()} />;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Certificates</h1>
      {data?.certificates.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            No Partner-origin certificates yet.
          </CardContent>
        </Card>
      )}
      <div className="space-y-2">
        {data?.certificates.map((cert) => (
          <Card key={cert.certificate_number}>
            <CardContent className="p-4 flex justify-between gap-3">
              <span className="font-medium">{cert.certificate_number}</span>
              <span className="text-sm text-muted-foreground">{cert.location_display_name ?? "Partner location"}</span>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
