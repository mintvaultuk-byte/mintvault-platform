import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearSearchConsoleCache,
  getSearchConsoleSnapshot,
  searchConsoleDateWindows,
} from "../server/growth-search-console";

const original = { ...process.env };
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const serviceAccount = JSON.stringify({
  client_email: "mintvault-growth-read@mintvault-ops.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});

beforeEach(() => {
  process.env.SEARCH_CONSOLE_PROPERTY = "sc-domain:mintvaultuk.com";
  process.env.SEARCH_CONSOLE_SERVICE_ACCOUNT_JSON = serviceAccount;
  clearSearchConsoleCache();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  clearSearchConsoleCache();
});

function okFetcher(): typeof fetch {
  let call = 0;
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    call += 1;
    if (call === 1) {
      expect(init?.method).toBe("POST");
      expect(String(init?.body)).toContain("jwt-bearer");
      return new Response(JSON.stringify({ access_token: "read-only-test-token-long-enough" }), { status: 200 });
    }
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer read-only-test-token-long-enough");
    if (call === 2) {
      return new Response(JSON.stringify({ rows: [{ clicks: 12, impressions: 240, ctr: 0.05, position: 8.25 }] }));
    }
    if (call === 3) {
      return new Response(JSON.stringify({ rows: [{ keys: ["card grading uk"] }, { keys: ["mintvault"] }] }));
    }
    if (call === 4) {
      return new Response(JSON.stringify({ rows: [{ keys: ["https://mintvaultuk.com/submit"] }] }));
    }
    return new Response(JSON.stringify({ rows: [{ clicks: 8, impressions: 200, ctr: 0.04, position: 9 }] }));
  }) as typeof fetch;
}

describe("GB-04D Search Console read adapter", () => {
  it("stays disconnected when the dedicated server authority is absent", async () => {
    delete process.env.SEARCH_CONSOLE_SERVICE_ACCOUNT_JSON;
    expect(await getSearchConsoleSnapshot("30d")).toMatchObject({
      state: "NOT_CONNECTED",
      property: null,
      lastUpdated: null,
    });
  });

  it("fails closed when the property is outside the fixed MintVault allowlist", async () => {
    process.env.SEARCH_CONSOLE_PROPERTY = "sc-domain:attacker.example";
    const snapshot = await getSearchConsoleSnapshot("30d");
    expect(snapshot).toMatchObject({ state: "ERROR", property: null });
    expect(JSON.stringify(snapshot)).not.toContain("private_key");
  });

  it("returns bounded final aggregates, top five lists and prior-period trend", async () => {
    const now = new Date("2026-08-20T12:00:00.000Z");
    const snapshot = await getSearchConsoleSnapshot("30d", { fetcher: okFetcher(), now, force: true });
    expect(snapshot).toMatchObject({
      state: "REAL",
      property: "MINTVAULT_CANONICAL",
      clicks: 12,
      impressions: 240,
      ctrPercent: 5,
      averagePosition: 8.25,
      clickTrendPercent: 50,
      topQueries: ["card grading uk", "mintvault"],
      topPages: ["https://mintvaultuk.com/submit"],
    });
    expect(snapshot.sourceWindow).toEqual({ startDate: "2026-07-22", endDate: "2026-08-20" });
    expect(JSON.stringify(snapshot)).not.toMatch(/serviceaccount|private.?key|access.?token/i);
  });

  it("serves a bounded stale snapshot when refresh fails", async () => {
    const first = new Date("2026-08-20T12:00:00.000Z");
    expect((await getSearchConsoleSnapshot("7d", { fetcher: okFetcher(), now: first, force: true })).state).toBe(
      "REAL"
    );
    const failedFetcher = (async () => {
      throw new Error("provider unavailable");
    }) as typeof fetch;
    const stale = await getSearchConsoleSnapshot("7d", {
      fetcher: failedFetcher,
      now: new Date(first.getTime() + 16 * 60 * 1000),
      force: true,
    });
    expect(stale).toMatchObject({ state: "STALE", clicks: 12, impressions: 240 });
  });

  it("uses like-for-like bounded London date windows", () => {
    expect(searchConsoleDateWindows("today", new Date("2026-08-20T12:00:00.000Z"))).toEqual({
      current: { startDate: "2026-08-20", endDate: "2026-08-20" },
      previous: { startDate: "2026-08-19", endDate: "2026-08-19" },
    });
  });
});
