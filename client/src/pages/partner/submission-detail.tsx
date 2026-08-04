/**
 * Partner Portal — Submission detail (Increment B, minimum viable tracking). Shows what was sent,
 * its current status, and the event history returned by GET /api/partner/submissions/:id. Deeper
 * tracking (MintVault-side grading progress, information requests) is Increment C — deferred, see
 * INTEGRATION-ORDER.md. This page only ever reflects Partner-side intake state; it never shows a
 * MintVault grade or internal grader/fraud notes, because the backend does not return them here.
 */
import { useParams, Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  partnerCards,
  partnerSubmissions,
  partnerErrorMessage,
  formatPence,
  type SubmissionCard,
} from "@/lib/partner-api";
import { usePartnerSession } from "@/hooks/use-partner-session";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { ArrowLeft, Upload, Image as ImageIcon, CheckCircle2 } from "lucide-react";

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  submitted_to_mintvault: "Submitted to MintVault",
  received: "Received",
  grading: "Grading",
  graded: "Graded",
  awaiting_settlement: "Awaiting settlement",
  completed: "Completed",
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
  const { hasPermission } = usePartnerSession();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["/api/partner/submissions", id],
    queryFn: () => partnerSubmissions.detail(id!),
    enabled: !!id,
  });

  if (isLoading) return <PartnerLoadingState label="Loading submission…" />;
  if (error) return <PartnerErrorState message={partnerErrorMessage(error)} onRetry={() => refetch()} />;
  if (!data) return null;

  const { submission, cards, events } = data;
  const canUploadImages =
    hasPermission("partner.orders.edit") && ["draft", "submitted_to_mintvault"].includes(submission.status);

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
                <CardImageControls
                  submissionId={submission.id}
                  card={c}
                  canUpload={canUploadImages}
                  onUploaded={() => qc.invalidateQueries({ queryKey: ["/api/partner/submissions", id] })}
                />
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

function CardImageControls({
  submissionId,
  card,
  canUpload,
  onUploaded,
}: {
  submissionId: string;
  card: SubmissionCard;
  canUpload: boolean;
  onUploaded: () => void;
}) {
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2" data-testid={`card-images-${card.id}`}>
      <CardImageSideControl
        submissionId={submissionId}
        cardId={card.id}
        side="front"
        label="Front image"
        hasImage={card.hasFrontImage}
        imageUrl={card.frontImageUrl}
        canUpload={canUpload}
        onUploaded={onUploaded}
      />
      <CardImageSideControl
        submissionId={submissionId}
        cardId={card.id}
        side="back"
        label="Back image"
        hasImage={card.hasBackImage}
        imageUrl={card.backImageUrl}
        canUpload={canUpload}
        onUploaded={onUploaded}
      />
    </div>
  );
}

function CardImageSideControl({
  submissionId,
  cardId,
  side,
  label,
  hasImage,
  imageUrl,
  canUpload,
  onUploaded,
}: {
  submissionId: string;
  cardId: string;
  side: "front" | "back";
  label: string;
  hasImage: boolean;
  imageUrl: string | null;
  canUpload: boolean;
  onUploaded: () => void;
}) {
  const mutation = useMutation({
    mutationFn: (file: File) => partnerCards.uploadImage(submissionId, cardId, side, file),
    onSuccess: onUploaded,
  });

  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium flex items-center gap-1.5">
          <ImageIcon className="h-4 w-4" aria-hidden="true" />
          {label}
        </p>
        {hasImage && (
          <Badge variant="outline" className="gap-1">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
            Uploaded
          </Badge>
        )}
      </div>
      {imageUrl && (
        <a href={imageUrl} target="_blank" rel="noreferrer" className="text-xs underline">
          Open uploaded image
        </a>
      )}
      {canUpload && (
        <div>
          <input
            id={`${cardId}-${side}-image`}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            disabled={mutation.isPending}
            data-testid={`input-upload-${side}-${cardId}`}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) mutation.mutate(file);
              event.currentTarget.value = "";
            }}
          />
          <Button asChild variant="outline" size="sm" disabled={mutation.isPending}>
            <label htmlFor={`${cardId}-${side}-image`} className="cursor-pointer">
              <Upload className="h-4 w-4 mr-1.5" aria-hidden="true" />
              {hasImage ? "Replace" : "Upload"}
            </label>
          </Button>
        </div>
      )}
      {mutation.error && (
        <p role="alert" className="text-xs text-destructive">
          {partnerErrorMessage(mutation.error)}
        </p>
      )}
    </div>
  );
}
