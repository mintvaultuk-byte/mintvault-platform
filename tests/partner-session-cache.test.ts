import { describe, it, expect, vi, afterEach } from "vitest";
import { apiRequest } from "../client/src/lib/queryClient";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Partner session cache boundary", () => {
  it("bypasses any stale browser cache for the cookie-bound session response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ mfaPassed: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("GET", "/api/partner/session");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/partner/session",
      expect.objectContaining({ credentials: "include", cache: "no-store" })
    );
  });

  it("does not change the cache policy of unrelated API requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("GET", "/api/partner/dashboard/submissions");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/partner/dashboard/submissions",
      expect.not.objectContaining({ cache: "no-store" })
    );
  });
});
