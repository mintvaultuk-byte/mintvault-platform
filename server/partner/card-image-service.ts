import crypto from "node:crypto";
import type { PoolClient } from "pg";
import { fileTypeFromBuffer } from "file-type";
import { deleteFromR2, getR2SignedUrl, uploadToR2 } from "../r2";
import { validateImageMagicBytes } from "../lib/card-identification/mime";
import { withTenant } from "./db";
import { writePartnerAudit } from "./audit";
import type { PartnerPrincipal } from "./session";

export type CardImageSide = "front" | "back";

const MAX_PARTNER_IMAGE_BYTES = 12 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PARTNER_IMAGE_KEY_RE =
  /^partner-submissions\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/(front|back)\/\d+-[0-9a-f-]{36}\.(jpg|png|webp)$/i;

export class CardImageError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function assertSide(side: string): CardImageSide {
  if (side === "front" || side === "back") return side;
  throw new CardImageError("validation", "Choose a valid image side.");
}

function keyColumn(side: CardImageSide): "front_image_key" | "back_image_key" {
  return side === "front" ? "front_image_key" : "back_image_key";
}

function safeExt(ext: string | undefined): string {
  if (ext === "jpg" || ext === "jpeg" || ext === "png" || ext === "webp") return ext === "jpeg" ? "jpg" : ext;
  return "jpg";
}

function assertUuid(value: string, name: string): void {
  if (!UUID_RE.test(value)) throw new CardImageError("not_found", `${name} not found.`);
}

async function buildPartnerImageKey(
  tenantId: string,
  submissionId: string,
  cardId: string,
  side: CardImageSide,
  buffer: Buffer
): Promise<string> {
  const detected = await fileTypeFromBuffer(buffer);
  const ext = safeExt(detected?.ext);
  return [
    "partner-submissions",
    tenantId,
    submissionId,
    cardId,
    side,
    `${Date.now()}-${crypto.randomUUID()}.${ext}`,
  ].join("/");
}

export interface PartnerCardImageState {
  frontImageUrl: string | null;
  backImageUrl: string | null;
  hasFrontImage: boolean;
  hasBackImage: boolean;
}

function validScopedKey(
  key: string | null,
  expected: { tenantId: string; submissionId: string; cardId: string; side: CardImageSide }
): key is string {
  if (!key) return false;
  const match = PARTNER_IMAGE_KEY_RE.exec(key);
  return (
    !!match &&
    match[1].toLowerCase() === expected.tenantId.toLowerCase() &&
    match[2].toLowerCase() === expected.submissionId.toLowerCase() &&
    match[3].toLowerCase() === expected.cardId.toLowerCase() &&
    match[4] === expected.side
  );
}

async function maybeSignedUrl(
  key: string | null,
  expected: { tenantId: string; submissionId: string; cardId: string; side: CardImageSide }
): Promise<string | null> {
  if (!key) return null;
  if (!validScopedKey(key, expected)) return null;
  try {
    return await getR2SignedUrl(key, 600);
  } catch {
    return null;
  }
}

export async function toCardImageState(row: {
  tenant_id?: string | null;
  submission_id?: string | null;
  id?: string | null;
  front_image_key?: string | null;
  back_image_key?: string | null;
}): Promise<PartnerCardImageState> {
  const frontKey = row.front_image_key ?? null;
  const backKey = row.back_image_key ?? null;
  const tenantId = row.tenant_id ?? null;
  const submissionId = row.submission_id ?? null;
  const cardId = row.id ?? null;
  const canSign = Boolean(tenantId && submissionId && cardId);
  return {
    frontImageUrl: canSign
      ? await maybeSignedUrl(frontKey, {
          tenantId: tenantId!,
          submissionId: submissionId!,
          cardId: cardId!,
          side: "front",
        })
      : null,
    backImageUrl: canSign
      ? await maybeSignedUrl(backKey, {
          tenantId: tenantId!,
          submissionId: submissionId!,
          cardId: cardId!,
          side: "back",
        })
      : null,
    hasFrontImage: Boolean(frontKey),
    hasBackImage: Boolean(backKey),
  };
}

export async function uploadPartnerCardImage(
  principal: PartnerPrincipal,
  submissionId: string,
  cardId: string,
  sideRaw: string,
  file: Express.Multer.File | undefined
): Promise<PartnerCardImageState> {
  const side = assertSide(sideRaw);
  assertUuid(submissionId, "Submission");
  assertUuid(cardId, "Card");
  if (!file?.buffer?.length) throw new CardImageError("validation", "Choose an image to upload.");
  if (file.buffer.length > MAX_PARTNER_IMAGE_BYTES) {
    throw new CardImageError("validation", "The image is too large. Use an image under 12 MB.");
  }
  const mimeError = await validateImageMagicBytes(file.buffer);
  if (mimeError) throw new CardImageError("validation", "Upload a JPEG, PNG or WebP image.");

  return await withTenant({ tenantId: principal.tenantId }, async (c: PoolClient) => {
    const submission = await c.query<{ id: string; location_id: string; status: string }>(
      `SELECT id, location_id, status
           FROM partner_submissions
          WHERE id=$1 AND tenant_id=$2
          FOR UPDATE`,
      [submissionId, principal.tenantId]
    );
    if (submission.rowCount !== 1) throw new CardImageError("not_found", "Submission not found.");
    if (!principal.orgWide) {
      const own = await c.query(
        `SELECT 1
             FROM partner_user_locations
            WHERE user_id=$1 AND location_id=$2 AND tenant_id=$3`,
        [principal.userId, submission.rows[0].location_id, principal.tenantId]
      );
      if (own.rowCount !== 1) throw new CardImageError("not_found", "Submission not found.");
    }
    if (submission.rows[0].status !== "draft") {
      throw new CardImageError("not_draft", "Images can no longer be changed for this submission.");
    }

    const column = keyColumn(side);
    const existing = await c.query<{
      id: string;
      tenant_id: string;
      submission_id: string;
      front_image_key: string | null;
      back_image_key: string | null;
    }>(
      `SELECT id, tenant_id, submission_id, front_image_key, back_image_key
           FROM partner_submission_cards
          WHERE id=$1 AND submission_id=$2 AND tenant_id=$3 AND removed_at IS NULL
          FOR UPDATE`,
      [cardId, submissionId, principal.tenantId]
    );
    if (existing.rowCount !== 1) throw new CardImageError("not_found", "Card not found.");
    const oldKey = existing.rows[0][column] ?? null;
    const digest = sha256(file.buffer);
    const key = await buildPartnerImageKey(
      existing.rows[0].tenant_id,
      existing.rows[0].submission_id,
      existing.rows[0].id,
      side,
      file.buffer
    );
    const contentType = (await fileTypeFromBuffer(file.buffer))?.mime ?? file.mimetype ?? "image/jpeg";
    await uploadToR2(key, file.buffer, contentType);

    try {
      const updated = await c.query<{
        id: string;
        tenant_id: string;
        submission_id: string;
        front_image_key: string | null;
        back_image_key: string | null;
      }>(
        `UPDATE partner_submission_cards
              SET ${column}=$4, updated_at=now()
            WHERE id=$1 AND submission_id=$2 AND tenant_id=$3 AND removed_at IS NULL
            RETURNING id, tenant_id, submission_id, front_image_key, back_image_key`,
        [cardId, submissionId, principal.tenantId, key]
      );
      await c.query(
        `INSERT INTO partner_submission_events
             (tenant_id, submission_id, actor_user_id, event_type, reason)
           VALUES ($1,$2,$3,$4,$5)`,
        [principal.tenantId, submissionId, principal.userId, "card_image_uploaded", side]
      );
      await writePartnerAudit(c, {
        tenantId: principal.tenantId,
        locationId: submission.rows[0].location_id,
        actorUserId: principal.userId,
        action: "submission_card.image_uploaded",
        recordType: "partner_submission_card",
        recordId: cardId,
        before: { side, hadImage: Boolean(oldKey) },
        after: {
          side,
          contentSha256: digest,
          bytes: file.buffer.length,
          contentType,
          pathChanged: oldKey !== key,
        },
      });
      return toCardImageState(updated.rows[0]);
    } catch (err) {
      await deleteFromR2(key).catch(() => {});
      throw err;
    }
  });
}
