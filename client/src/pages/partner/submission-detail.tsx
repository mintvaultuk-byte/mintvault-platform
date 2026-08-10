/**
 * Partner Portal — Submission detail (Increment B, minimum viable tracking). Shows what was sent,
 * its current status, and the event history returned by GET /api/partner/submissions/:id. Deeper
 * tracking (MintVault-side grading progress, information requests) is Increment C — deferred, see
 * INTEGRATION-ORDER.md. This page only ever reflects Partner-side intake state; it never shows a
 * MintVault grade or internal grader/fraud notes, because the backend does not return them here.
 */
import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { partnerSubmissions, partnerErrorMessage, formatPence } from "@/lib/partner-api";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { ArrowLeft } from "lucide-react";

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  submitted_to_mintvault: "Submitted to MintVault",
  cancelled: "Cancelled",
};

const EVENT_LABELS: Record<string, string> = {
  created: "Submission created",
  updated: "Details updated",
  card_added: "Card added",
  card_updated: "Card updated",
  card_removed: "Card removed",
  card_image_uploaded: "Card image uploaded",
  submitted: "Submitted to MintVault",
  cancelled: "Submission cancelled",
};

export default function PartnerSubmissionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["/api/partner/submissions", id],
    queryFn: () => partnerSubmissions.detail(id!),
    enabled: !!id,
  });

  if (isLoading) return <PartnerLoadingState label="Loading submission…" />;
  if (error) return <PartnerErrorState message={partnerErrorMessage(error)} onRetry={() => refetch()} />;
  if (!data) return null;

  const { submission, cards, events } = data;

  return (
    <div className="space-y-6" data-testid="page-submission-detail">
      <Link
        href="/partner/submissions"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        data-testid="link-back-to-submissions"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to submissions
      </Link>

      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-submission-detail-ref">
            {submission.internalReference || submission.publicRef}
          </h1>
          <p className="text-sm text-muted-foreground font-mono">{submission.publicRef}</p>
        </div>
        <Badge data-testid={`badge-detail-status-${submission.status}`}>
          {STATUS_LABELS[submission.status] ?? submission.status}
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Service</p>
            <p>{submission.serviceTierCode ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Estimated price</p>
            <p data-testid="text-detail-price">{formatPence(submission.estimatedPricePence)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Cards</p>
            <p>{submission.cardCount}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Submitted</p>
            <p>{submission.submittedAt ? new Date(submission.submittedAt).toLocaleString() : "Not yet submitted"}</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Cards ({cards.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y" data-testid="list-detail-cards">
            {cards.map((c) => (
              <li key={c.id} className="py-3">
                <p className="font-medium">
                  {c.sequence_number}. {c.card_name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {[c.game, c.card_set, c.year].filter(Boolean).join(" · ")}
                </p>
                {c.intake_notes && (
                  <p className="text-xs text-muted-foreground italic mt-1">
                    Intake observation — not a MintVault grade: {c.intake_notes}
                  </p>
                )}
                <div className="mt-2 flex gap-2">
                  {(["front", "back"] as const).map((side) => {
                    const url = side === "front" ? c.front_image_url : c.back_image_url;
                    return url ? (
                      <a
                        key={side}
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-primary underline"
                        data-testid={`link-detail-${side}-image-${c.id}`}
                      >
                        {side} image
                      </a>
                    ) : (
                      <span key={side} className="text-xs text-muted-foreground">
                        {side} image missing
                      </span>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-2 text-sm" data-testid="list-detail-events">
            {events.map((e) => (
              <li key={e.id} className="flex items-center justify-between border-b pb-2 last:border-0">
                <span>{EVENT_LABELS[e.event_type] ?? e.event_type}</span>
                <span className="text-xs text-muted-foreground">{new Date(e.created_at).toLocaleString()}</span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
