import { normalizeCertId } from "./lib/cert-id";

type PublicCertificateCandidate = {
  certId: string;
  status?: unknown;
  gradeApprovedAt?: unknown;
};

export type PublicCertificateValidity = "active" | "voided" | "hidden";

/** Public certificate validity is explicit and fail closed. */
export function classifyPublicCertificate(candidate: PublicCertificateCandidate | null): PublicCertificateValidity {
  if (!candidate || candidate.gradeApprovedAt == null) return "hidden";
  const status = typeof candidate.status === "string" ? candidate.status.trim().toLowerCase() : "";
  if (status === "active") return "active";
  if (status === "voided") return "voided";
  return "hidden";
}

/** Apply the same fail-closed validity boundary to list/search projections. */
export function filterPublicCertificates<T extends PublicCertificateCandidate>(candidates: readonly T[]): T[] {
  return candidates.filter((candidate) => classifyPublicCertificate(candidate) === "active");
}

/**
 * A revocation response proves the historical id is known without returning any
 * stale grade, card, owner, image, or navigation authority.
 */
export function buildVoidedVerificationResponse(candidate: PublicCertificateCandidate) {
  return {
    verified: false as const,
    reason: "voided" as const,
    certId: normalizeCertId(candidate.certId),
    status: "voided" as const,
  };
}
