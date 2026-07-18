/**
 * Partner Portal — Submissions list (Increment B, minimum viable tracking). Wired to the existing
 * GET /api/partner/submissions (status filter + pagination already supported server-side). Full
 * tracking detail (search by MintVault reference, status timeline, information requests) is
 * Increment C and explicitly deferred — see INTEGRATION-ORDER.md.
 */
import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { partnerSubmissions, partnerErrorMessage, type SubmissionSummary } from "@/lib/partner-api";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { PlusCircle } from "lucide-react";

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  submitted_to_mintvault: "Submitted to MintVault",
  cancelled: "Cancelled",
};

function StatusBadge({ status }: { status: string }) {
  const variant = status === "draft" ? "secondary" : status === "cancelled" ? "outline" : "default";
  return (
    <Badge variant={variant} data-testid={`badge-status-${status}`}>
      {STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

export default function PartnerSubmissionsPage() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["/api/partner/submissions", statusFilter, page],
    queryFn: () => partnerSubmissions.list({ status: statusFilter === "all" ? undefined : statusFilter, page, pageSize }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold" data-testid="text-submissions-title">
          Submissions
        </h1>
        <Link href="/partner/submissions/new">
          <Button data-testid="button-new-submission-list">
            <PlusCircle className="h-4 w-4 mr-1.5" aria-hidden="true" />
            New Submission
          </Button>
        </Link>
      </div>

      <div className="flex items-center gap-3">
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            setStatusFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[220px]" data-testid="select-status-filter" aria-label="Filter by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="submitted_to_mintvault">Submitted to MintVault</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading && <PartnerLoadingState label="Loading submissions…" />}
      {error && <PartnerErrorState message={partnerErrorMessage(error)} onRetry={() => refetch()} />}

      {data && data.items.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground" data-testid="text-empty-submissions">
            <p className="mb-4">No submissions yet.</p>
            <Link href="/partner/submissions/new">
              <Button data-testid="button-new-submission-empty">Create your first submission</Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {data && data.items.length > 0 && (
        <div className="space-y-2" data-testid="list-submissions">
          {data.items.map((s: SubmissionSummary) => (
            <Link key={s.id} href={`/partner/submissions/${s.id}`}>
              <Card className="hover:bg-accent/50 cursor-pointer" data-testid={`card-submission-${s.id}`}>
                <CardContent className="p-4 flex items-center justify-between gap-4 flex-wrap">
                  <div>
                    <p className="font-medium" data-testid={`text-ref-${s.id}`}>
                      {s.internalReference || s.publicRef.slice(0, 8)}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {s.cardCount} card{s.cardCount === 1 ? "" : "s"} · Created{" "}
                      {new Date(s.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <StatusBadge status={s.status} />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {data && data.total > pageSize && (
        <div className="flex items-center justify-between">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} data-testid="button-page-prev">
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {Math.ceil(data.total / pageSize)}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page * pageSize >= data.total}
            onClick={() => setPage((p) => p + 1)}
            data-testid="button-page-next"
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
