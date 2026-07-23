import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { partnerErrorMessage, partnerLaunch } from "@/lib/partner-api";
import { AlertTriangle, CreditCard, PackagePlus } from "lucide-react";

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold">{value}</p>
      </CardContent>
    </Card>
  );
}

export default function PartnerDashboardPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["/api/partner/dashboard/launch"],
    queryFn: () => partnerLaunch.dashboard(),
  });

  if (isLoading) return <PartnerLoadingState label="Loading dashboard..." />;
  if (error) return <PartnerErrorState message={partnerErrorMessage(error)} onRetry={() => refetch()} />;
  if (!data) return null;

  const launchBlocked = data.pilot.status !== "authorised";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-dashboard-title">
            {data.partner?.legal_name ?? "Partner Portal"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {data.location?.name ?? "Organisation-wide"} · {data.roleLabels.join(", ") || "Partner user"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild data-testid="button-dashboard-new-submission">
            <Link href="/partner/submissions/new">
              <PackagePlus className="mr-2 h-4 w-4" aria-hidden="true" />
              New submission
            </Link>
          </Button>
          <Button asChild variant="outline" data-testid="button-dashboard-buy-credits">
            <Link href="/partner/credits">
              <CreditCard className="mr-2 h-4 w-4" aria-hidden="true" />
              Credits
            </Link>
          </Button>
        </div>
      </div>

      {launchBlocked && (
        <Card className="border-amber-300 bg-amber-50">
          <CardContent className="p-4 flex gap-3 text-amber-950">
            <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-medium">Pilot launch is not authorised yet.</p>
              <p className="text-sm">
                {data.pilot.reason || "MintVault Super Admin must complete readiness checks first."}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 md:grid-cols-4">
        <StatCard label="Available credits" value={data.credit?.availableCredits ?? "0"} />
        <StatCard label="Reserved credits" value={data.credit?.activeReservedCredits ?? "0"} />
        <StatCard label="Draft submissions" value={data.submissions.draft ?? 0} />
        <StatCard label="Open corrections" value={data.corrections.open ?? 0} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Work Requiring Attention</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span>Submitted to MintVault</span>
              <Badge>{data.submissions.submitted_to_mintvault ?? 0}</Badge>
            </div>
            <div className="flex justify-between">
              <span>Pending handoff</span>
              <Badge variant="secondary">{data.handoffs.pending ?? 0}</Badge>
            </div>
            <div className="flex justify-between">
              <span>Readiness blockers</span>
              <Badge variant={(data.readiness.blocked ?? 0) > 0 ? "destructive" : "outline"}>
                {data.readiness.blocked ?? 0}
              </Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent Credit Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {data.recentCreditActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground">No credit activity yet.</p>
            ) : (
              <div className="space-y-2">
                {data.recentCreditActivity.slice(0, 5).map((entry) => (
                  <div key={entry.id} className="flex justify-between gap-3 text-sm">
                    <span className="truncate">{entry.reason}</span>
                    <span className={Number(entry.amount) >= 0 ? "text-emerald-700" : "text-red-700"}>
                      {Number(entry.amount) >= 0 ? "+" : ""}
                      {entry.amount}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
