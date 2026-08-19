export interface PaidSubmissionConfirmation {
  submissionId: string;
  status: "paid";
  serviceTier: string | null;
  serviceType: string | null;
  cardCount: number | null;
  totalPrice: string | number | null;
  createdAt: unknown;
}

interface SubmissionConfirmationCandidate {
  submissionId?: string | null;
  status?: string | null;
  serviceTier?: string | null;
  serviceType?: string | null;
  cardCount?: number | null;
  totalPrice?: string | number | null;
  createdAt?: unknown;
}

/**
 * The success-page capability may reveal only payment-confirmation facts, and
 * only after the authoritative fulfilment transition has marked the submission
 * paid. Keep customer contact, delivery, and card-detail fields out of this
 * allowlist even though the accompanying token also authorises a PDF download.
 */
export function paidSubmissionConfirmation(
  submission: SubmissionConfirmationCandidate | null | undefined
): PaidSubmissionConfirmation | null {
  if (!submission || submission.status !== "paid" || !submission.submissionId) return null;
  return {
    submissionId: submission.submissionId,
    status: "paid",
    serviceTier: submission.serviceTier || null,
    serviceType: submission.serviceType || null,
    cardCount: submission.cardCount ?? null,
    totalPrice: submission.totalPrice ?? null,
    createdAt: submission.createdAt,
  };
}
