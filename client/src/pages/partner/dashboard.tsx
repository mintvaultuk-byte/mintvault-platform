import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { partnerCredits, partnerDashboard, partnerErrorMessage } from "@/lib/partner-api";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { ArrowRight, CircleGauge, Clock3, PlusCircle } from "lucide-react";

function metric(value: number | null | undefined, empty = "Not available") {
  return value == null ? empty : value.toLocaleString("en-GB");
}

function statusLabel(status: string) {
  return status === "healthy"
    ? "Ready"
    : status === "low"
      ? "Running low"
      : status === "empty"
        ? "No available credits"
        : status === "inactive"
          ? "Wallet inactive"
          : "Unknown";
}

export default function PartnerDashboardPage() {
  const submissions = useQuery({
    queryKey: ["/api/partner/dashboard/submissions"],
    queryFn: () => partnerDashboard.summary(),
  });
  const credits = useQuery({ queryKey: ["/api/partner/credits"], queryFn: () => partnerCredits.view() });
  const loading = submissions.isLoading || credits.isLoading;
  const error = submissions.error || credits.error;

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <p className="text-xs font-semibold uppercase text-primary">Shop operations</p>
          <h1 className="text-2xl font-semibold" data-testid="text-dashboard-title">
            Dashboard
          </h1>
        </div>
        <Link href="/partner/submissions/new">
          <Button data-testid="button-new-submission-dashboard">
            <PlusCircle className="h-4 w-4 mr-1.5" aria-hidden="true" />
            New Submission
          </Button>
        </Link>
      </div>

      {loading && <PartnerLoadingState label="Loading your dashboard…" />}
      {error && (
        <PartnerErrorState
          message={partnerErrorMessage(error)}
          onRetry={() => {
            void submissions.refetch();
            void credits.refetch();
          }}
        />
      )}

      {submissions.data && credits.data && (
        <>
          <section aria-labelledby="credit-summary-title" className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 id="credit-summary-title" className="text-base font-semibold">
                Credit summary
              </h2>
              <Link href="/partner/billing" className="text-sm text-primary inline-flex items-center gap-1">
                Credits & Billing <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </div>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3" data-testid="grid-credit-summary">
              {[
                ["Available", credits.data.summary.availableCredits, "available"],
                ["Reserved", credits.data.summary.reservedCredits, "reserved"],
                ["Consumed this month", credits.data.summary.consumedThisMonth, "consumed-month"],
                ["Lifetime consumed", credits.data.summary.consumedLifetime, "consumed-lifetime"],
              ].map(([label, value, id]) => (
                <Card key={String(id)} className="rounded-md">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-2xl font-semibold" data-testid={`text-credit-${id}`}>
                      {metric(value as number | null, credits.data.summary.configured ? "Unknown" : "Not available")}
                    </p>
                  </CardContent>
                </Card>
              ))}
              <Card className="rounded-md border-primary/30">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs font-medium text-muted-foreground">Balance status</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm font-semibold text-primary" data-testid="text-credit-status">
                    {statusLabel(credits.data.summary.balanceStatus)}
                  </p>
                </CardContent>
              </Card>
            </div>
          </section>

          <section aria-labelledby="submission-summary-title" className="space-y-3">
            <h2 id="submission-summary-title" className="text-base font-semibold">
              Submission summary
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-7 gap-3" data-testid="grid-dashboard-cards">
              {[
                ["Drafts", submissions.data.draft, "draft"],
                ["Submitted", submissions.data.submitted_to_mintvault, "submitted"],
                ["Validating", null, "validating"],
                ["Grading", null, "grading"],
                ["Awaiting correction", null, "correction"],
                ["Completed", null, "completed"],
                ["Cancelled", submissions.data.cancelled, "cancelled"],
              ].map(([label, value, id]) => (
                <Card key={String(id)} className="rounded-md" data-testid={`card-dashboard-${id}`}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-xl font-semibold" data-testid={`text-count-${id}`}>
                      {metric(value as number | null)}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>

          <section aria-labelledby="operations-title" className="space-y-3">
            <h2 id="operations-title" className="text-base font-semibold">
              Operations
            </h2>
            <div className="grid md:grid-cols-3 gap-3">
              <Card className="rounded-md">
                <CardContent className="pt-5 flex gap-3">
                  <CircleGauge className="h-5 w-5 text-primary" aria-hidden="true" />
                  <div>
                    <p className="text-sm font-medium">Cards in progress</p>
                    <p className="text-sm text-muted-foreground">Not available</p>
                  </div>
                </CardContent>
              </Card>
              <Card className="rounded-md">
                <CardContent className="pt-5 flex gap-3">
                  <Clock3 className="h-5 w-5 text-primary" aria-hidden="true" />
                  <div>
                    <p className="text-sm font-medium">Turnaround</p>
                    <p className="text-sm text-muted-foreground">Not available</p>
                  </div>
                </CardContent>
              </Card>
              <Card className="rounded-md">
                <CardContent className="pt-5">
                  <p className="text-sm font-medium">Quality rating</p>
                  <p className="text-sm text-muted-foreground">Not available</p>
                </CardContent>
              </Card>
            </div>
          </section>

          <section aria-labelledby="recent-activity-title" className="space-y-3">
            <h2 id="recent-activity-title" className="text-base font-semibold">
              Recent activity
            </h2>
            {credits.data.ledger.length === 0 ? (
              <p className="text-sm text-muted-foreground">No activity yet</p>
            ) : (
              <div className="divide-y divide-border border-y border-border">
                {credits.data.ledger.slice(0, 5).map((entry) => (
                  <div key={entry.id} className="py-3 flex items-center justify-between gap-4 text-sm">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{entry.reason}</p>
                      <p className="text-xs text-muted-foreground">{new Date(entry.date).toLocaleString("en-GB")}</p>
                    </div>
                    <span className={entry.quantity > 0 ? "text-emerald-300" : "text-rose-300"}>
                      {entry.quantity > 0 ? "+" : ""}
                      {entry.quantity}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
