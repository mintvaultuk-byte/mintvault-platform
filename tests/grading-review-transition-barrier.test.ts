import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  reviewBarrierAllowsAction,
  ReviewBarrierTimeoutError,
  runReviewTransitionBarrier,
  type PersistedReviewRevision,
} from "../shared/grading-review-barrier";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const snapshot = (revision: number, fingerprint = `payload-${revision}`): PersistedReviewRevision<string> => ({
  revision,
  certId: 41,
  payloadFingerprint: fingerprint,
  preview: `preview-${revision}`,
});

describe("authoritative Grade → Review barrier", () => {
  it("does not request preview or unlock Review until save succeeds", async () => {
    const save = deferred<PersistedReviewRevision<string>>();
    let previews = 0;
    const run = runReviewTransitionBarrier({
      persist: () => save.promise,
      preview: async () => {
        previews += 1;
        return true;
      },
      isCurrent: () => true,
    });
    await Promise.resolve();
    expect(previews).toBe(0);
    save.resolve(snapshot(1));
    await expect(run).resolves.toMatchObject({ ok: true });
    expect(previews).toBe(1);
  });

  it("keeps Review locked when the authoritative save fails", async () => {
    let previews = 0;
    const result = await runReviewTransitionBarrier({
      persist: async () => {
        throw new Error("save failed");
      },
      preview: async () => {
        previews += 1;
        return true;
      },
      isCurrent: () => true,
    });
    expect(result).toMatchObject({ ok: false, phase: "save" });
    expect(previews).toBe(0);
  });

  it("keeps Review locked when the exact preview revision fails", async () => {
    const result = await runReviewTransitionBarrier({
      persist: async () => snapshot(2),
      preview: async (saved) => saved.revision !== 2,
      isCurrent: () => true,
    });
    expect(result).toEqual({ ok: false, phase: "preview" });
  });

  it("discards a stale save response before preview starts", async () => {
    let current = true;
    let previews = 0;
    const save = deferred<PersistedReviewRevision<string>>();
    const run = runReviewTransitionBarrier({
      persist: () => save.promise,
      preview: async () => {
        previews += 1;
        return true;
      },
      isCurrent: () => current,
    });
    current = false;
    save.resolve(snapshot(3));
    await expect(run).resolves.toEqual({ ok: false, phase: "stale" });
    expect(previews).toBe(0);
  });

  it("discards a stale preview response and never unlocks the newer attempt", async () => {
    let attempt = 1;
    const preview = deferred<boolean>();
    const run = runReviewTransitionBarrier({
      persist: async () => snapshot(4),
      preview: () => preview.promise,
      isCurrent: () => attempt === 1,
    });
    await Promise.resolve();
    attempt = 2;
    preview.resolve(true);
    await expect(run).resolves.toEqual({ ok: false, phase: "stale" });
  });

  it("bounds a lost save response instead of preparing forever", async () => {
    vi.useFakeTimers();
    try {
      const run = runReviewTransitionBarrier({
        persist: () => new Promise(() => {}),
        preview: async () => true,
        isCurrent: () => true,
        timeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(50);
      const result = await run;
      expect(result).toMatchObject({ ok: false, phase: "save" });
      if (!result.ok) expect(result.error).toBeInstanceOf(ReviewBarrierTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a lost exact-preview acknowledgement", async () => {
    vi.useFakeTimers();
    try {
      const run = runReviewTransitionBarrier({
        persist: async () => snapshot(9),
        preview: () => new Promise(() => {}),
        isCurrent: () => true,
        timeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(50);
      const result = await run;
      expect(result).toMatchObject({ ok: false, phase: "preview" });
      if (!result.ok) expect(result.error).toBeInstanceOf(ReviewBarrierTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gates approval/submission to the exact persisted and previewed payload", () => {
    const ready = snapshot(5, "payload-current");
    expect(reviewBarrierAllowsAction({ certId: 41, currentPayloadFingerprint: "payload-current", ready })).toBe(true);
    expect(reviewBarrierAllowsAction({ certId: 41, currentPayloadFingerprint: "payload-edited", ready })).toBe(false);
    expect(reviewBarrierAllowsAction({ certId: 42, currentPayloadFingerprint: "payload-current", ready })).toBe(false);
    expect(reviewBarrierAllowsAction({ certId: 41, currentPayloadFingerprint: "payload-current", ready: null })).toBe(
      false
    );
  });

  it("is wired through the canonical workstation, exact preview acknowledgement, and approval action", () => {
    const workstation = readFileSync(
      join(process.cwd(), "client/src/components/grading-workflow/GradingWorkstation.tsx"),
      "utf8"
    );
    const preview = readFileSync(
      join(process.cwd(), "client/src/components/grading-workflow/CertificatePreviewPanel.tsx"),
      "utf8"
    );
    const panel = readFileSync(join(process.cwd(), "client/src/components/grading/grading-panel.tsx"), "utf8");
    expect(workstation).toContain("runReviewTransitionBarrier");
    expect(workstation).toContain("onRevisionComplete={handlePreviewRevisionComplete}");
    expect(preview).toContain("onRevisionComplete?.(revision, ok, requestFingerprint)");
    expect(preview).toContain("complete(false)");
    expect(panel).toContain("await autoSavePromiseRef.current");
    expect(panel).toContain("await saveDraftPromiseRef.current");
    expect(panel).toContain("latestReviewDraftRef.current");
    expect(panel).toContain("signal: controller.signal");
    expect(panel).toContain("if (!reviewActionReady)");
    expect(panel).toContain("disabled={approving || gradingWorkflowLocked || !reviewActionReady}");
  });
});
