/**
 * Partner Portal — Dashboard (Increment A). Tenant- and location-scoped submission counts from the
 * existing Phase 2 dashboard API, plus the primary "New Submission" action and a recent-submissions
 * shortcut. No financial totals shown here (billing/pricing summaries are gated by permission and
 * scoped separately per the spec — not invented on the dashboard).
 */
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { partnerDashboard, partnerErrorMessage } from "@/lib/partner-api";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { PlusCircle } from "lucide-react";

const CARDS: Array<{ key: "draft" | "submitted_to_mintvault" | "cancelled"; label: string }> = [
  { key: "draft", label: "Draft submissions" },
  { key: "submitted_to_mintvault", label: "Submitted to MintVault" },
  { key: "cancelled", label: "Cancelled" },
];

export default function PartnerDashboardPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["/api/partner/dashboard/submissions"],
    queryFn: () => partnerDashboard.summary(),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold" data-testid="text-dashboard-title">
          Dashboard
        </h1>
        <Link href="/partner/submissions/new">
          <Button data-testid="button-new-submission-dashboard">
            <PlusCircle className="h-4 w-4 mr-1.5" aria-hidden="true" />
            New Submission
          </Button>
        </Link>
      </div>

      {isLoading && <PartnerLoadingState label="Loading your dashboard…" />}
      {error && <PartnerErrorState message={partnerErrorMessage(error)} onRetry={() => refetch()} />}

      {data && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="grid-dashboard-cards">
          {CARDS.map((c) => (
            <Card key={c.key} data-testid={`card-dashboard-${c.key}`}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">{c.label}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-bold" data-testid={`text-count-${c.key}`}>
                  {data[c.key] ?? 0}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent activity</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            <Link href="/partner/submissions" className="underline" data-testid="link-view-all-submissions">
              View all submissions
            </Link>{" "}
            to see recent status changes.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
