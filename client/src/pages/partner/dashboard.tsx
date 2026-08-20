import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CreditCard, PlusCircle, ScanLine, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { usePartnerSession } from "@/hooks/use-partner-session";
import { partnerCredits, partnerErrorMessage, partnerOperations } from "@/lib/partner-api";

function count(value: number | null | undefined): string {
  return value == null ? "Not available" : value.toLocaleString("en-GB");
}

function balanceLabel(status: string): string {
  if (status === "healthy") return "Ready";
  if (status === "low") return "Running low";
  if (status === "empty") return "No available credits";
  if (status === "inactive") return "Wallet inactive";
  return "Unknown";
}

/**
 * The partner home deliberately remains a small, server-owned shop-floor board.
 * It does not query customer records, invent workflow totals, or pretend a browser can determine
 * Scanner or grading authority. Each visible count comes from the scoped operations service and
 * each tile sends the operator to a route that performs a real action.
 */
export default function PartnerDashboardPage() {
  const { hasPermission } = usePartnerSession();
  const canCreateSubmissions = hasPermission("partner.orders.view");
  const canAssessCards = hasPermission("partner.cards.assess");
  const canViewCredits = hasPermission("partner.credits.view");
  const canPurchaseCredits = hasPermission("partner.credits.purchase");

  const operations = useQuery({
    queryKey: ["/api/partner/dashboard/operations"],
    queryFn: () => partnerOperations.view(),
  });
  const credits = useQuery({
    queryKey: ["/api/partner/credits"],
    queryFn: () => partnerCredits.view(),
    enabled: canViewCredits,
  });
  const hasCardsToContinueGrading =
    (operations.data?.counts.readyToGrade !== undefined && operations.data.counts.readyToGrade > 0) ||
    (operations.data?.counts.inReview !== undefined && operations.data.counts.inReview > 0);

  return (
    <div className="space-y-8" data-testid="partner-shop-floor-dashboard">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase text-primary">Shop operations</p>
          <h1 className="text-2xl font-semibold" data-testid="text-dashboard-title">
            Dashboard
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Start a submission, keep scans moving, and open grading.</p>
        </div>
        {canCreateSubmissions ? (
          <Link href="/partner/submissions/new">
            <Button data-testid="button-new-submission-dashboard">
              <PlusCircle className="mr-1.5 h-4 w-4" aria-hidden="true" />
              New Submission
            </Button>
          </Link>
        ) : null}
      </header>

      <section aria-labelledby="card-work-title" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="card-work-title" className="text-base font-semibold">
              Card work
            </h2>
            {operations.data?.locationScoped ? (
              <p className="text-xs text-muted-foreground" data-testid="text-operations-location-scoped">
                Showing your assigned location only
              </p>
            ) : null}
          </div>
          {canAssessCards ? (
            <Link href="/partner/grading" className="inline-flex items-center gap-1 text-sm text-primary">
              Open grading <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          ) : null}
        </div>

        {operations.isLoading ? <PartnerLoadingState label="Loading card work…" /> : null}
        {operations.error ? (
          <PartnerErrorState
            message={partnerErrorMessage(operations.error)}
            onRetry={() => void operations.refetch()}
          />
        ) : null}
        {operations.data ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" data-testid="grid-operations">
            <OperationTile
              label="Needs scan"
              value={operations.data.counts.needsScan}
              href={canAssessCards ? "/partner/grading" : undefined}
              description="Cards waiting for their first accepted side."
              testId="needs-scan"
            />
            <OperationTile
              label="FIX required"
              value={operations.data.counts.fixRequired}
              href={canAssessCards ? "/partner/grading" : undefined}
              description="Replacement evidence only; no additional credit is charged."
              testId="fix-required"
            />
            <OperationTile
              label="Ready to grade"
              value={operations.data.counts.readyToGrade}
              href={canAssessCards ? "/partner/grading" : undefined}
              description="Both evidence sides are accepted and ready for inspection."
              testId="ready-to-grade"
            />
            <OperationTile
              label="In review"
              value={operations.data.counts.inReview}
              href={canAssessCards ? "/partner/grading" : undefined}
              description="Cards currently being graded or awaiting review."
              testId="in-review"
            />
            <OperationTile
              label="Completed / return"
              value={operations.data.counts.completed}
              href={canCreateSubmissions ? "/partner/certificates" : undefined}
              description="Cards finished for return, with certificate status available."
              testId="completed"
            />
          </div>
        ) : null}
      </section>

      <section aria-labelledby="actions-title" className="space-y-3">
        <h2 id="actions-title" className="text-base font-semibold">
          Next actions
        </h2>
        <div className="grid gap-3 md:grid-cols-3" data-testid="grid-primary-actions">
          <Card data-testid="action-start-submission">
            <CardContent className="space-y-2 pt-6">
              <p className="inline-flex items-center gap-2 font-medium">
                <PlusCircle className="h-4 w-4" aria-hidden="true" /> Start a submission
              </p>
              <p className="text-xs text-muted-foreground">
                Create the intake first, without a required customer CRM record.
              </p>
              {canCreateSubmissions ? (
                <Link href="/partner/submissions/new" className="inline-flex text-sm text-primary">
                  New Submission <ArrowRight className="ml-1 h-4 w-4" aria-hidden="true" />
                </Link>
              ) : (
                <p className="text-xs text-muted-foreground">Your role cannot create submissions.</p>
              )}
            </CardContent>
          </Card>
          <Card data-testid="action-scan-new-card">
            <CardContent className="space-y-2 pt-6">
              <p className="inline-flex items-center gap-2 font-medium">
                <ScanLine className="h-4 w-4" aria-hidden="true" /> Scan cards
              </p>
              <p className="text-xs text-muted-foreground">
                Use the approved MintVault Scanner station. The station confirms capture authority and credit
                reservation.
              </p>
              {canAssessCards ? (
                <Link href="/partner/grading" className="inline-flex text-sm text-primary">
                  View scan queue <ArrowRight className="ml-1 h-4 w-4" aria-hidden="true" />
                </Link>
              ) : null}
            </CardContent>
          </Card>
          <Card data-testid="action-open-grading">
            <CardContent className="space-y-2 pt-6">
              <p className="inline-flex items-center gap-2 font-medium">
                <Wrench className="h-4 w-4" aria-hidden="true" /> Grade or fix evidence
              </p>
              <p className="text-xs text-muted-foreground">
                Queue state and full-resolution evidence are verified by the server.
              </p>
              {canAssessCards && hasCardsToContinueGrading ? (
                <Link href="/partner/grading" className="inline-flex text-sm text-primary">
                  Continue Grading <ArrowRight className="ml-1 h-4 w-4" aria-hidden="true" />
                </Link>
              ) : canAssessCards ? (
                <p className="text-xs text-muted-foreground">No cards are currently ready for grading.</p>
              ) : (
                <p className="text-xs text-muted-foreground">Your role does not include grading.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </section>

      <section aria-labelledby="credit-summary-title" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 id="credit-summary-title" className="text-base font-semibold">
            Grading credits
          </h2>
          {canViewCredits ? (
            <Link href="/partner/billing" className="inline-flex items-center gap-1 text-sm text-primary">
              Credits &amp; Billing <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          ) : null}
        </div>
        {!canViewCredits ? (
          <p className="text-sm text-muted-foreground" data-testid="text-credit-not-authorised">
            Your role does not include credit information.
          </p>
        ) : null}
        {canViewCredits && credits.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading credit summary…</p>
        ) : null}
        {canViewCredits && credits.error ? (
          <p className="text-sm text-muted-foreground" role="alert">
            Credit information is unavailable right now.{" "}
            <button type="button" className="text-primary underline" onClick={() => void credits.refetch()}>
              Try again
            </button>
          </p>
        ) : null}
        {canViewCredits && credits.data ? (
          <div className="grid gap-3 sm:grid-cols-3" data-testid="grid-credit-summary">
            <CreditTile label="Available" value={credits.data.summary.availableCredits} testId="available" />
            <CreditTile label="Reserved" value={credits.data.summary.reservedCredits} testId="reserved" />
            <Card className="border-primary/30">
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground">Balance status</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm font-semibold text-primary" data-testid="text-credit-status">
                  {balanceLabel(credits.data.summary.balanceStatus)}
                </p>
              </CardContent>
            </Card>
          </div>
        ) : null}
        {canViewCredits && credits.data?.summary.balanceStatus === "empty" ? (
          <Card className="border-rose-400/50" data-testid="card-credit-empty">
            <CardContent className="flex flex-col justify-between gap-3 p-4 sm:flex-row sm:items-center">
              <div>
                <p className="font-medium" data-testid="text-credit-empty-title">
                  No Grading Credits left
                </p>
                <p className="text-sm text-muted-foreground">
                  New cards cannot be started until you add credits; grading, fixing a missing image and printing all
                  continue as normal; FIX and grading are unaffected.
                </p>
              </div>
              {canPurchaseCredits && (
                <Link href="/partner/billing">
                  <Button data-testid="button-buy-credits-empty">Buy more Grading Credits</Button>
                </Link>
              )}
            </CardContent>
          </Card>
        ) : null}
        {canViewCredits && credits.data?.summary.balanceStatus === "low" ? (
          <Card className="border-amber-400/50" data-testid="card-credit-low">
            <CardContent className="flex flex-col justify-between gap-3 p-4 sm:flex-row sm:items-center">
              <div>
                <p className="font-medium" data-testid="text-credit-low-title">
                  Running low on Grading Credits
                </p>
                <p className="text-sm text-muted-foreground">Top up before the Scanner runs out of capacity.</p>
              </div>
              {canPurchaseCredits && (
                <Link href="/partner/billing">
                  <Button variant="outline" data-testid="button-buy-credits-low">
                    Buy more Grading Credits
                  </Button>
                </Link>
              )}
            </CardContent>
          </Card>
        ) : null}
        {canPurchaseCredits ? (
          <Link href="/partner/billing" className="inline-flex">
            <Button variant="outline" data-testid="button-buy-credits-dashboard">
              <CreditCard className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Buy more credits
            </Button>
          </Link>
        ) : null}
      </section>
    </div>
  );
}

function OperationTile({
  label,
  value,
  href,
  description,
  testId,
}: {
  label: string;
  value: number | null | undefined;
  href?: string;
  description: string;
  testId: string;
}) {
  const card = (
    <Card
      className={`h-full ${href ? "transition-colors hover:border-primary/60" : ""}`}
      data-testid={`card-operations-${testId}`}
    >
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold" data-testid={`text-ops-${testId}`}>
          {count(value)}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
  return href ? <Link href={href} className="block">{card}</Link> : card;
}

function CreditTile({ label, value, testId }: { label: string; value: number | null | undefined; testId: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold" data-testid={`text-credit-${testId}`}>
          {count(value)}
        </p>
      </CardContent>
    </Card>
  );
}
