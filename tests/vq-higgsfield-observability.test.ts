/**
 * Phase 10A-3 — proves generateHiggsfieldArtwork itself calls recordHiggsfieldOutcome
 * at the right points (not just that the pure derivation composes correctly). Mocks
 * global.fetch with a scripted response sequence; no real network/secrets.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import sharp from "sharp";
import { __resetHiggsfieldOutcomeForTests, getLastHiggsfieldOutcome } from "../server/vault-quest/ai/provider-status";
// Static import (NOT dynamic per-test) — dynamic import() after vi.resetModules() would
// load a SEPARATE provider-status.ts instance than the one this file imports above,
// splitting the observation state across two module copies. One shared instance only.
import { generateHiggsfieldArtwork } from "../server/vault-quest/ai/higgsfield";

// A real 64x64 PNG (the app's own floor — normaliseGeneratedImage rejects anything
// smaller as "too small to use").
let TEST_PNG: Buffer;
beforeAll(async () => {
  TEST_PNG = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toBuffer();
});

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function bytesRes(status: number, bytes: Buffer): Response {
  return new Response(bytes, { status });
}

beforeEach(() => {
  __resetHiggsfieldOutcomeForTests();
  process.env.HIGGSFIELD_API_KEY = "oat_test_key";
  process.env.HIGGSFIELD_WORKSPACE_ID = "ws-1"; // skips the workspace-resolution GET entirely
  process.env.HIGGSFIELD_MODEL = "nano_banana";
});

describe("generateHiggsfieldArtwork — real observability wiring", () => {
  it("a full success sequence records {ok:true}", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(200, { id: "job-1" })) // create
      .mockResolvedValueOnce(jsonRes(200, { status: "completed", result_url: "https://cdn.example/x.png" })) // poll
      .mockResolvedValueOnce(bytesRes(200, TEST_PNG)); // download
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateHiggsfieldArtwork({ prompt: "a test subject", mode: "main", slot: "main" });
    expect(result.jobId).toBe("job-1");
    expect(getLastHiggsfieldOutcome()).toEqual({ ok: true });
    vi.unstubAllGlobals();
  });

  it("a 401 on create records {ok:false, kind:'auth_expired'} and throws", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonRes(401, { error: "expired" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateHiggsfieldArtwork({ prompt: "x", mode: "main", slot: "main" })).rejects.toThrow(/401/);
    expect(getLastHiggsfieldOutcome()).toEqual({ ok: false, kind: "auth_expired" });
    vi.unstubAllGlobals();
  });

  it("a 402 on create records insufficient_credits — deriveHiggsfieldStatus later reports this as still connected", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonRes(402, { error: "no credits" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateHiggsfieldArtwork({ prompt: "x", mode: "main", slot: "main" })).rejects.toThrow(/credits/);
    expect(getLastHiggsfieldOutcome()).toEqual({ ok: false, kind: "insufficient_credits" });
    vi.unstubAllGlobals();
  });

  it("a download failure after a successful create still records the failure (charge already presumed)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonRes(200, { id: "job-2" })) // create
      .mockResolvedValueOnce(jsonRes(200, { status: "completed", result_url: "https://cdn.example/y.png" })) // poll
      .mockResolvedValueOnce(new Response("", { status: 503 })); // download fails
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateHiggsfieldArtwork({ prompt: "x", mode: "main", slot: "main" })).rejects.toThrow(/download failed/);
    expect(getLastHiggsfieldOutcome()).toEqual({ ok: false, kind: "provider_unavailable" });
    vi.unstubAllGlobals();
  });
});
