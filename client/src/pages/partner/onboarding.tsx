import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { partnerErrorMessage, partnerLaunch } from "@/lib/partner-api";

export default function PartnerOnboardingPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["/api/partner/onboarding/readiness"],
    queryFn: () => partnerLaunch.readiness(),
  });
  if (isLoading) return <PartnerLoadingState label="Loading readiness..." />;
  if (error) return <PartnerErrorState message={partnerErrorMessage(error)} onRetry={() => refetch()} />;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Onboarding</h1>
      {data?.checks.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            Readiness checks have not been recorded yet.
          </CardContent>
        </Card>
      )}
      <div className="grid gap-2 md:grid-cols-2">
        {data?.checks.map((check) => (
          <Card key={check.check_key}>
            <CardContent className="p-4 flex justify-between gap-3">
              <span className="capitalize">{check.check_key.replace(/_/g, " ")}</span>
              <Badge
                variant={
                  check.status === "passed" ? "default" : check.status === "blocked" ? "destructive" : "secondary"
                }
              >
                {check.status}
              </Badge>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
