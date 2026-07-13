/**
 * Pure request-lifecycle orchestration for Vault Quest's paid single-reference
 * generation (Character Bible "Generate ..." buttons / ReusePanel "Generate New
 * Anyway"). No DOM, no React, no real timers required to test it.
 *
 * Root cause this fixes: the UI awaited one fetch with no client-side bound and no
 * "still working" state. When a real generation legitimately took longer than a
 * human (or browser automation) was willing to wait, the page looked frozen with no
 * feedback — and because there was no safe way to check "is my request still
 * running?", the only apparent way forward was to click again, risking a SECOND
 * paid generation. The server's own D10 idempotency guard (reserveOrDecide) already
 * makes a REPEAT POST with the SAME idempotencyKey free (202 pending / 200 replayed,
 * never a second charge) — so "recovery" here is simply: keep re-asking the SAME
 * question with the SAME key on a bounded schedule, instead of ever minting a new one.
 */

export type GenerationPhase = "generating" | "still-processing" | "completed" | "replayed" | "failed";

export interface GenerationOutcome {
  phase: "completed" | "replayed" | "failed" | "still-processing";
  status: number;
  data: unknown;
  error?: unknown;
}

/** Pure — classify one already-fetched HTTP response (status + parsed JSON body)
 *  into an outcome kind. This is the exact decision table the poll loop below uses,
 *  isolated so it can be tested without any network or timers at all. Mirrors the
 *  server's idempotencyResponseFor() shapes (202 pending / 200 replayed / terminal). */
export function classifyGenerationResponse(status: number, body: unknown): GenerationOutcome {
  const b = (body ?? {}) as { pending?: boolean; replayed?: boolean; error?: string };
  if (status === 202 && b.pending) return { phase: "still-processing", status, data: body };
  if (status === 200 && b.replayed) return { phase: "replayed", status, data: body };
  if (status >= 200 && status < 300) return { phase: "completed", status, data: body };
  return { phase: "failed", status, data: body, error: new Error(b.error || `request failed (${status})`) };
}

export interface RawResponse {
  status: number;
  json: unknown;
}

export interface RunGenerationOptions {
  /** Sends the SAME request (same URL, body, idempotencyKey) every time it's called.
   *  Never mint a new idempotencyKey inside this — that is the caller's job, done
   *  ONCE before the first call, exactly so every retry here is a free, server-
   *  deduped replay of the SAME reservation, never a new paid attempt. */
  post: () => Promise<RawResponse>;
  /** Bounded wait for the FIRST attempt before moving to "still-processing" and
   *  polling. Real generation can legitimately take ~15-30s (an action-pose retry
   *  doubles that), so this is a safety bound, not the expected/common case. */
  initialTimeoutMs?: number;
  /** Wait between polls once in "still-processing". */
  pollIntervalMs?: number;
  /** Caps total wall-clock spent polling — after this many attempts with no
   *  terminal answer, give up WITHOUT ever treating that as failure or clearing
   *  the idempotency key (see runGenerationWithRecovery's return contract). */
  maxPollAttempts?: number;
  onPhase?: (phase: GenerationPhase, meta?: { attempt?: number }) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Race a promise against a bounded timeout WITHOUT aborting/rejecting the
 *  underlying promise — the server has already reserved (and may have already
 *  charged) by the time this races, so giving up client-side must never look like
 *  the request itself failed; the real answer, once it lands, is just ignored here
 *  if the timeout already fired (the caller re-asks via `post()` again instead). */
function raceWithTimeout(p: Promise<RawResponse>, ms: number): Promise<{ timedOut: true } | { timedOut: false; value: RawResponse }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, ms);
    p.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false, value });
    }).catch((error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A hard network/parse error is a real, known outcome (not a timeout) —
      // surface it as a failed response so the caller shows the real error rather
      // than silently retrying forever.
      resolve({ timedOut: false, value: { status: 0, json: { error: error instanceof Error ? error.message : String(error) } } });
    });
  });
}

/**
 * Drives ONE logical generation request to a terminal outcome. Never issues more
 * than one underlying `post()` call per attempt slot (initial + each poll), and
 * NEVER treats a client-side timeout as failure — only as "keep asking, on the
 * same reservation". If every poll attempt is exhausted with no terminal answer,
 * returns `{ phase: "still-processing", ... }` — the caller must treat this the
 * same as a fresh "still-processing" state (keep the idempotency key, don't show a
 * failure, let the founder check back later; a later click safely re-asks the same
 * question instead of starting a new paid attempt).
 */
export async function runGenerationWithRecovery(opts: RunGenerationOptions): Promise<GenerationOutcome> {
  const { post, initialTimeoutMs = 45_000, pollIntervalMs = 5_000, maxPollAttempts = 6, onPhase, sleep = defaultSleep } = opts;

  onPhase?.("generating");
  const first = await raceWithTimeout(post(), initialTimeoutMs);
  if (!first.timedOut) {
    const outcome = classifyGenerationResponse(first.value.status, first.value.json);
    if (outcome.phase !== "still-processing") return outcome;
    // Server itself reports "already running" (e.g. a concurrent tab/reload) — poll.
  }

  onPhase?.("still-processing");
  for (let attempt = 1; attempt <= maxPollAttempts; attempt++) {
    await sleep(pollIntervalMs);
    onPhase?.("still-processing", { attempt });
    const polled = await raceWithTimeout(post(), initialTimeoutMs);
    if (polled.timedOut) continue; // no answer yet — keep polling within budget
    const outcome = classifyGenerationResponse(polled.value.status, polled.value.json);
    if (outcome.phase !== "still-processing") return outcome;
  }

  return { phase: "still-processing", status: 0, data: { pending: true, exhausted: true } };
}
