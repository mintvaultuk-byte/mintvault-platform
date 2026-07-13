/**
 * Vault Quest generation request-lifecycle (client/src/lib/vq-generation-lifecycle.ts).
 * Pure — no DOM, no jsdom, no real network. Small millisecond timeouts are used
 * instead of vi.useFakeTimers() so these stay fast without mocking global timers.
 *
 * Fixes proven here: a slow-but-successful request must not look like a failure or
 * invite a second paid submission; a client-side timeout must keep re-asking the
 * SAME question (the caller's `post` closure is bound to one idempotencyKey) rather
 * than ever being treated as a failure; a hard network error must surface as a real,
 * immediate failure rather than being silently retried forever.
 */
import { describe, it, expect } from "vitest";
import { classifyGenerationResponse, runGenerationWithRecovery } from "../client/src/lib/vq-generation-lifecycle";

const fastSleep = () => Promise.resolve();

describe("classifyGenerationResponse — pure decision table", () => {
  it("202 + pending:true → still-processing", () => {
    expect(classifyGenerationResponse(202, { pending: true, message: "running" }).phase).toBe("still-processing");
  });
  it("200 + replayed:true → replayed", () => {
    const o = classifyGenerationResponse(200, { replayed: true, candidateId: 5, chargedCredits: 1 });
    expect(o.phase).toBe("replayed");
  });
  it("201 with real data → completed", () => {
    expect(classifyGenerationResponse(201, { candidateId: 12, width: 1184, height: 864 }).phase).toBe("completed");
  });
  it("200 without replayed/pending → completed", () => {
    expect(classifyGenerationResponse(200, { ok: true }).phase).toBe("completed");
  });
  it("422/500 → failed, with a real error message from the body", () => {
    const o = classifyGenerationResponse(422, { error: "studio background rejected (too scenic)" });
    expect(o.phase).toBe("failed");
    expect(o.error).toBeInstanceOf(Error);
    expect((o.error as Error).message).toMatch(/studio background rejected/);
  });
  it("failure with no body error still produces a real Error, never a silent undefined", () => {
    const o = classifyGenerationResponse(500, null);
    expect(o.phase).toBe("failed");
    expect((o.error as Error).message).toMatch(/request failed \(500\)/);
  });
});

describe("runGenerationWithRecovery — fast paths (no client timeout hit)", () => {
  it("immediate success: exactly ONE post() call, no polling, phase events are generating only", async () => {
    let calls = 0;
    const phases: string[] = [];
    const outcome = await runGenerationWithRecovery({
      post: async () => { calls++; return { status: 201, json: { candidateId: 12 } }; },
      onPhase: (p) => phases.push(p),
      initialTimeoutMs: 200,
    });
    expect(calls).toBe(1);
    expect(outcome.phase).toBe("completed");
    expect(phases).toEqual(["generating"]);
  });

  it("immediate replay (D10 says already completed): ONE post() call, terminal replayed, no polling", async () => {
    let calls = 0;
    const outcome = await runGenerationWithRecovery({
      post: async () => { calls++; return { status: 200, json: { replayed: true, candidateId: 9, chargedCredits: 1 } }; },
      initialTimeoutMs: 200,
    });
    expect(calls).toBe(1);
    expect(outcome.phase).toBe("replayed");
  });

  it("a hard network/parse error surfaces immediately as failed — never silently retried", async () => {
    let calls = 0;
    const outcome = await runGenerationWithRecovery({
      post: async () => { calls++; throw new Error("network down"); },
      initialTimeoutMs: 200,
    });
    expect(calls).toBe(1); // NOT retried — a real thrown error is a known outcome, not a timeout
    expect(outcome.phase).toBe("failed");
    expect((outcome.error as Error).message).toMatch(/network down/);
  });

  it("server reports 202 pending on the very first response (e.g. a concurrent tab already running it) → moves straight to polling, then succeeds", async () => {
    let calls = 0;
    const outcome = await runGenerationWithRecovery({
      post: async () => {
        calls++;
        if (calls === 1) return { status: 202, json: { pending: true } };
        return { status: 201, json: { candidateId: 7 } };
      },
      initialTimeoutMs: 200,
      pollIntervalMs: 1,
      sleep: fastSleep,
    });
    expect(calls).toBe(2);
    expect(outcome.phase).toBe("completed");
  });
});

describe("runGenerationWithRecovery — client-side timeout recovery (the actual fix)", () => {
  it("a request that never resolves within the client bound is recovered by re-asking with the SAME post() closure, not treated as failure", async () => {
    let calls = 0;
    const outcome = await runGenerationWithRecovery({
      post: () => {
        calls++;
        if (calls === 1) return new Promise(() => {}); // never resolves — simulates the real 26s+ generation outliving the client bound
        return Promise.resolve({ status: 201, json: { candidateId: 12 } });
      },
      initialTimeoutMs: 5, // tiny bound so attempt 1 "times out" almost instantly in the test
      pollIntervalMs: 1,
      sleep: fastSleep,
    });
    expect(calls).toBe(2); // the abandoned attempt-1 call + exactly one poll — never a THIRD paid-shaped call
    expect(outcome.phase).toBe("completed");
  });

  it("phase callback reports generating → still-processing (with attempt numbers) → never reports a false failure mid-flight", async () => {
    let calls = 0;
    const phases: { phase: string; attempt?: number }[] = [];
    await runGenerationWithRecovery({
      post: () => {
        calls++;
        if (calls <= 2) return new Promise(() => {}); // attempt 1 (initial) + attempt 2 (poll 1) both hang
        return Promise.resolve({ status: 201, json: { candidateId: 1 } });
      },
      initialTimeoutMs: 5,
      pollIntervalMs: 1,
      sleep: fastSleep,
      onPhase: (phase, meta) => phases.push({ phase, attempt: meta?.attempt }),
    });
    expect(phases[0]).toEqual({ phase: "generating", attempt: undefined });
    expect(phases.some((p) => p.phase === "still-processing")).toBe(true);
    expect(phases.every((p) => p.phase !== "failed" && p.phase !== "completed")).toBe(true); // onPhase never fires terminal phases — only the return value does
  });

  it("a completed generation that finished on the server AFTER the client gave up is recovered on the first poll (background-request recovery)", async () => {
    let calls = 0;
    const outcome = await runGenerationWithRecovery({
      post: () => {
        calls++;
        // attempt 1: client times out waiting: simulate by never resolving in time
        if (calls === 1) return new Promise((resolve) => setTimeout(() => resolve({ status: 201, json: { candidateId: 42 } }), 50));
        // the poll re-asks and the server now reports the SAME request already completed (replay)
        return Promise.resolve({ status: 200, json: { replayed: true, candidateId: 42, chargedCredits: 1 } });
      },
      initialTimeoutMs: 5,
      pollIntervalMs: 1,
      sleep: fastSleep,
    });
    expect(outcome.phase).toBe("replayed");
    expect((outcome.data as { candidateId: number }).candidateId).toBe(42);
  });

  it("a genuinely failed generation surfaces on the first poll after a timeout — real error, not silently swallowed", async () => {
    let calls = 0;
    const outcome = await runGenerationWithRecovery({
      post: () => {
        calls++;
        if (calls === 1) return new Promise(() => {});
        return Promise.resolve({ status: 422, json: { error: "studio background rejected (too scenic)" } });
      },
      initialTimeoutMs: 5,
      pollIntervalMs: 1,
      sleep: fastSleep,
    });
    expect(outcome.phase).toBe("failed");
    expect((outcome.error as Error).message).toMatch(/studio background rejected/);
  });

  it("still-processing on EVERY poll exhausts the budget without ever becoming a failure — caller must keep the idempotency key", async () => {
    let calls = 0;
    const outcome = await runGenerationWithRecovery({
      post: async () => { calls++; return { status: 202, json: { pending: true } }; },
      initialTimeoutMs: 5,
      pollIntervalMs: 1,
      maxPollAttempts: 3,
      sleep: fastSleep,
    });
    expect(calls).toBe(4); // initial + 3 polls, never a 4th/unbounded poll
    expect(outcome.phase).toBe("still-processing");
    expect((outcome.data as { exhausted?: boolean }).exhausted).toBe(true);
  });

  it("respects a custom pollIntervalMs/maxPollAttempts (bounded, not hardcoded)", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    await runGenerationWithRecovery({
      post: async () => { calls++; return { status: 202, json: { pending: true } }; },
      initialTimeoutMs: 5,
      pollIntervalMs: 250,
      maxPollAttempts: 2,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(calls).toBe(3); // initial + exactly 2 polls
    expect(sleeps).toEqual([250, 250]);
  });
});
