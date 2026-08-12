/** Authoritative Grade → Review transition, kept pure for race testing. */

export interface PersistedReviewRevision<TPreview> {
  revision: number;
  certId: number;
  payloadFingerprint: string;
  preview: TPreview;
}

export type ReviewBarrierResult<TPreview> =
  | { ok: true; snapshot: PersistedReviewRevision<TPreview> }
  | { ok: false; phase: "save" | "preview" | "stale"; error?: unknown };

export class ReviewBarrierTimeoutError extends Error {
  constructor(
    public readonly phase: "save" | "preview",
    public readonly timeoutMs: number
  ) {
    super(`${phase === "save" ? "Grade save" : "Certificate preview"} timed out after ${timeoutMs}ms`);
    this.name = "ReviewBarrierTimeoutError";
  }
}

async function withinBarrierDeadline<T>(promise: Promise<T>, phase: "save" | "preview", timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ReviewBarrierTimeoutError(phase, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runReviewTransitionBarrier<TPreview>(args: {
  persist: () => Promise<PersistedReviewRevision<TPreview>>;
  preview: (snapshot: PersistedReviewRevision<TPreview>) => Promise<boolean>;
  isCurrent: () => boolean;
  /** Prevents a lost network response or acknowledgement from locking Review forever. */
  timeoutMs?: number;
}): Promise<ReviewBarrierResult<TPreview>> {
  const timeoutMs = args.timeoutMs ?? 15_000;
  let snapshot: PersistedReviewRevision<TPreview>;
  try {
    snapshot = await withinBarrierDeadline(args.persist(), "save", timeoutMs);
  } catch (error) {
    return { ok: false, phase: "save", error };
  }
  if (!args.isCurrent()) return { ok: false, phase: "stale" };

  let previewed: boolean;
  try {
    previewed = await withinBarrierDeadline(args.preview(snapshot), "preview", timeoutMs);
  } catch (error) {
    return { ok: false, phase: "preview", error };
  }
  if (!args.isCurrent()) return { ok: false, phase: "stale" };
  if (!previewed) return { ok: false, phase: "preview" };
  return { ok: true, snapshot };
}

/**
 * The authoritative clean baseline: the grading payload as the server last
 * confirmed it, and the revision that state is bound to.
 */
export interface ReviewCleanBaseline {
  certId: number;
  fingerprint: string;
  revision: number;
}

export type ReviewPersistDecision = { mode: "reuse"; revision: number } | { mode: "persist" };

/**
 * OWNER-AUTHORISED REPAIR (2026-08-11) — does entering Review need to WRITE?
 *
 * Reading a review must not mutate the record. Entering Review used to always
 * PUT the entire grading payload (grade, sub-grades, centering, defects) merely
 * because the reviewer opened the card, and that write carried no optimistic
 * lock — so reviewer A simply *looking* at a card could overwrite reviewer B's
 * newer work from another tab or session.
 *
 * The decision is a byte comparison against the baseline, because the
 * fingerprint is `JSON.stringify(buildPayload())` — precisely the bytes that
 * would be sent. That gives three properties we want:
 *   • it covers exactly the fields this save owns, so unrelated UI state (stage,
 *     zoom, which side is showing) can never make a clean card look dirty;
 *   • an edit that is reverted to its original value is clean again, so no
 *     pointless write is issued;
 *   • an unknown or mismatched baseline falls through to `persist`, i.e. it
 *     fails toward the previous always-write behaviour rather than toward
 *     silently skipping a save the operator needed.
 *
 * `reuse` does NOT weaken the P0 revision binding. The caller still previews and
 * still requires an exact revision match before Review becomes ready; LOAD
 * simply takes the place of SAVE as the origin of the revision for a card that
 * was never modified.
 */
export function decideReviewPersist(args: {
  baseline: ReviewCleanBaseline | null | undefined;
  certId: number;
  payloadFingerprint: string;
}): ReviewPersistDecision {
  const baseline = args.baseline;
  if (!baseline) return { mode: "persist" };
  if (baseline.certId !== args.certId) return { mode: "persist" };
  if (baseline.fingerprint !== args.payloadFingerprint) return { mode: "persist" };
  if (!Number.isFinite(baseline.revision) || baseline.revision < 1) return { mode: "persist" };
  return { mode: "reuse", revision: baseline.revision };
}

export function reviewBarrierAllowsAction(args: {
  certId: number;
  currentPayloadFingerprint: string;
  ready: PersistedReviewRevision<unknown> | null;
}): boolean {
  return args.ready?.certId === args.certId && args.ready.payloadFingerprint === args.currentPayloadFingerprint;
}
