/**
 * THE SINGLE AUTHORITY for which image a side's Card Tool measures from.
 *
 * This exists because the enable gate and the launch payload were two separate expressions, and
 * they drifted: ImageViewer gained a working -> review fallback for DISPLAY while the Card Tool
 * button and the ManualCardTool mount still hard-required working evidence. The result was a
 * visible card with a permanently disabled tool. Both callers now read this one function, so the
 * button cannot be enabled for an image the tool would refuse, nor the reverse.
 *
 * Priority is unchanged and deliberate:
 *   working evidence (stricter, full-resolution derivative)
 *   -> authoritative certificate-bound review image
 *   -> unavailable
 *
 * AUTHORISATION IS NOT DECIDED HERE. `reviewEvidence` is emitted only by
 * buildSuperAdminCertImagesPayload, so it reaches the client solely on authorised Super Admin
 * surfaces; the grader and Partner payloads come from buildCertImagesPayload and never carry it.
 * That keeps those routes working-evidence-only without a second client-side rule to maintain.
 *
 * SIDE SAFETY: `side` selects its own keys explicitly. There is no first-available fallback, so a
 * FRONT tool can never be handed a BACK image (or vice versa), and a missing side resolves to
 * null rather than borrowing the other one.
 */
export type CardToolSide = "front" | "back";

type AdmissionMap = Partial<Record<CardToolSide, { available?: boolean } | undefined>> | undefined;

/**
 * Only the four keys this decision reads. Structural, so both the ImageViewer's typed `ImageUrls`
 * and the panel's `Record<string, string | null>` satisfy it without either being widened.
 */
export type CardToolUrls = {
  front_working?: string | null;
  back_working?: string | null;
  front_review?: string | null;
  back_review?: string | null;
};

export function cardToolImageSource(args: {
  side: CardToolSide;
  urls: CardToolUrls | undefined;
  workingEvidence?: AdmissionMap;
  reviewEvidence?: AdmissionMap;
}): string | null {
  const { side, urls, workingEvidence, reviewEvidence } = args;
  if (!urls) return null;
  // A URL alone is never an admission decision — the companion server status must agree, so a
  // stale query, an older endpoint, or a UI race cannot present a derivative as admitted.
  if (workingEvidence?.[side]?.available === true) {
    const working = side === "front" ? urls.front_working : urls.back_working;
    if (working) return working;
  }
  if (reviewEvidence?.[side]?.available === true) {
    const review = side === "front" ? urls.front_review : urls.back_review;
    if (review) return review;
  }
  return null;
}

/** Card Tool is enabled for a side iff that side resolves to an admitted image. */
export function cardToolEnabled(args: {
  side: CardToolSide;
  urls: CardToolUrls | undefined;
  workingEvidence?: AdmissionMap;
  reviewEvidence?: AdmissionMap;
}): boolean {
  return cardToolImageSource(args) !== null;
}
