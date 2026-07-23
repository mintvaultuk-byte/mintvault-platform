import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { partnerErrorMessage } from "@/lib/partner-api";
import { apiRequest } from "@/lib/queryClient";

export default function PartnerGradingPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["/api/partner/grading"],
    queryFn: async () =>
      (await apiRequest("GET", "/api/partner/grading")).json() as Promise<{
        queue: Record<string, number>;
        note: string;
      }>,
  });
  if (isLoading) return <PartnerLoadingState label="Loading grading queue..." />;
  if (error) return <PartnerErrorState message={partnerErrorMessage(error)} onRetry={() => refetch()} />;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Grading</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">MVGS Queue</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <div>
            <p className="text-xs text-muted-foreground">Submitted</p>
            <p className="text-3xl font-semibold">{data?.queue.submittedToMintVault ?? 0}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Awaiting completion</p>
            <p className="text-3xl font-semibold">{data?.queue.cardsAwaitingCompletion ?? 0}</p>
          </div>
          <p className="md:col-span-2 text-sm text-muted-foreground">{data?.note}</p>
        </CardContent>
      </Card>
    </div>
  );
}
