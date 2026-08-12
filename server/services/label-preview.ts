/**
 * Side-effect-free live label preview composition.
 *
 * The caller must first authorise and load the saved certificate. This module
 * only combines that row with bounded, label-relevant workstation fields and
 * invokes the canonical print renderer. It never persists, allocates a number,
 * changes lifecycle state, touches NFC/claims, or settles Partner credit.
 */
import type { CertificateRecord } from "@shared/schema";
import { buildPreviewFields } from "@shared/label-preview-fields";
import { applyStructuredVariantFromBody } from "../lib/structured-variant";
import { getCatalogueSnapshot } from "../lib/catalogue-provider";
import { generateLabelPNG } from "../labels";

const MUTABLE_PREVIEW_FIELDS = [
  "cardName",
  "setName",
  "year",
  "cardNumber",
  "variant",
  "variantOther",
  "rarity",
  "rarityOther",
  "labelType",
  "language",
] as const;

/** Build an in-memory preview certificate without mutating the saved row. */
export async function buildLabelPreviewCertificate(
  saved: CertificateRecord | null,
  body: Record<string, unknown>
): Promise<CertificateRecord> {
  const preview = buildPreviewFields(body) as unknown as CertificateRecord;
  const cert = (saved ? { ...saved } : preview) as CertificateRecord;
  const target = cert as unknown as Record<string, unknown>;
  const values = preview as unknown as Record<string, unknown>;
  // Existing-certificate previews overlay only fields actually posted by the
  // workstation. Grade, subgrade, defect and Pristine inputs remain exclusively
  // server-authoritative from the saved row; omitted metadata stays saved, and
  // certId/certificate number is never client-overridable after the access check.
  if (saved) {
    for (const key of MUTABLE_PREVIEW_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, key)) target[key] = values[key];
    }
  }

  try {
    applyStructuredVariantFromBody(
      body,
      target,
      await getCatalogueSnapshot(),
      (cert as unknown as { structuredVariantVersion?: number | null }).structuredVariantVersion
    );
  } catch {
    // Half-entered structured variants use the saved/legacy label line.
  }
  return cert;
}

/** The one live-preview render path, shared by Admin, Staff and Partner. */
export async function generateLabelPreviewPNG(cert: CertificateRecord): Promise<Buffer> {
  return generateLabelPNG(cert, "front");
}
