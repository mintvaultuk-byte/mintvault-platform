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

export function reviewBarrierAllowsAction(args: {
  certId: number;
  currentPayloadFingerprint: string;
  ready: PersistedReviewRevision<unknown> | null;
}): boolean {
  return args.ready?.certId === args.certId && args.ready.payloadFingerprint === args.currentPayloadFingerprint;
}
