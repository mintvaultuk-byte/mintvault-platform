import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { partnerCredits, partnerDashboard, partnerErrorMessage } from "@/lib/partner-api";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { usePartnerSession } from "@/hooks/use-partner-session";
import { ArrowRight, PlusCircle } from "lucide-react";

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
  /**
   * Credit data is an INDEPENDENTLY permission-gated panel, not a page-level dependency.
   *
   * WHY (hostile review, 2026-08-03): this page previously merged both queries' errors into one
   * page-level error and gated ALL content on both succeeding. `partner.credits.view` is not held
   * by PARTNER_RECEPTION (the primary shop-floor persona), MVGS_ASSESSMENT_TECHNICIAN or
   * PARTNER_TRAINEE, so for those roles the whole dashboard collapsed to a single red box showing
   * the raw server string "forbidden" — and the submission counts they ARE entitled to see never
   * rendered. The shell already gates the Credits & Billing nav item on this same permission.
   *
   * The query is therefore not issued at all without the capability (no 403 is provoked, and no
   * wallet data can reach a client that may not see it), and any credit failure is contained to
   * the credit panel.
   */
  const { hasPermission } = usePartnerSession();
  const canViewCredits = hasPermission("partner.credits.view");
  const canCreateOrders = hasPermission("partner.orders.create");

  const submissions = useQuery({
    queryKey: ["/api/partner/dashboard/submissions"],
    queryFn: () => partnerDashboard.summary(),
  });
  const credits = useQuery({
    queryKey: ["/api/partner/credits"],
    queryFn: () => partnerCredits.view(),
    enabled: canViewCredits,
  });
  // Page-level state tracks ONLY the submission query. Credit state is handled inside its panel.
  const loading = submissions.isLoading;
  const error = submissions.error;

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <p className="text-xs font-semibold uppercase text-primary">Shop operations</p>
          <h1 className="text-2xl font-semibold" data-testid="text-dashboard-title">
            Dashboard
          </h1>
        </div>
        {canCreateOrders && (
          <Link href="/partner/submissions/new">
            <Button data-testid="button-new-submission-dashboard">
              <PlusCircle className="h-4 w-4 mr-1.5" aria-hidden="true" />
              New Submission
            </Button>
          </Link>
        )}
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

      {submissions.data && (
        <>
          <section aria-labelledby="credit-summary-title" className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 id="credit-summary-title" className="text-base font-semibold">
                Credit summary
              </h2>
              {canViewCredits && (
                <Link href="/partner/billing" className="text-sm text-primary inline-flex items-center gap-1">
                  Credits & Billing <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              )}
            </div>
            {!canViewCredits && (
              <p className="text-sm text-muted-foreground" data-testid="text-credit-not-authorised">
                Not authorised — your role does not include access to credit information.
              </p>
            )}
            {canViewCredits && credits.isLoading && (
              <p className="text-sm text-muted-foreground" data-testid="text-credit-loading">
                Loading credit summary…
              </p>
            )}
            {canViewCredits && credits.error && (
              <p className="text-sm text-muted-foreground" role="alert" data-testid="text-credit-error">
                Credit information is unavailable right now.{" "}
                <button type="button" className="text-primary underline" onClick={() => void credits.refetch()}>
                  Try again
                </button>
              </p>
            )}
            {canViewCredits && credits.data && (
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
            )}
          </section>

          <section aria-labelledby="submission-summary-title" className="space-y-3">
            <h2 id="submission-summary-title" className="text-base font-semibold">
              Submission summary
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" data-testid="grid-dashboard-cards">
              {[
                ["Drafts", submissions.data.draft, "draft"],
                ["Submitted", submissions.data.submitted_to_mintvault, "submitted"],
                ["Received", submissions.data.received, "received"],
                ["Grading", submissions.data.grading, "grading"],
                ["Graded", submissions.data.graded, "graded"],
                ["Awaiting settlement", submissions.data.awaiting_settlement, "awaiting-settlement"],
                ["Completed", submissions.data.completed, "completed"],
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

          {/*
            The "Operations" section (Cards in progress / Turnaround / Quality rating) was removed.
            All three were client-side literal "Not available" strings with no server field behind
            them — not even a MetricUnavailable reason code, so unlike the admin surface there was
            nothing for a future backend to light up. Reinstate them together with the server
            signal that populates them.
          */}

          {/* Recent activity is ledger data, so it carries the same permission gate as the panel above. */}
          {canViewCredits && credits.data && (
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
          )}
        </>
      )}
    </div>
  );
}
