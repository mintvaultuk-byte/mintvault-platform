import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const transfers = readFileSync(new URL("../server/routes/transfers.ts", import.meta.url), "utf8");
const publicRoutes = readFileSync(new URL("../server/routes/public.ts", import.meta.url), "utf8");

function routeBlock(source: string, start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  expect(startAt).toBeGreaterThanOrEqual(0);
  expect(endAt).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
}

describe("public collection and homepage-stat validity", () => {
  it("restricts public collection rows to canonical active, non-deleted, approved certificates", () => {
    const block = routeBlock(transfers, 'app.get("/api/public/collection/:userId"', "\n}");
    expect(block).toMatch(/c\.status\s*=\s*'active'/);
    expect(block).toMatch(/c\.deleted_at\s+IS\s+NULL/);
    expect(block).toMatch(/c\.grade_approved_at\s+IS\s+NOT\s+NULL/);
    expect(block).not.toMatch(/grade_approved_by\s+IS\s+NOT\s+NULL/);
  });

  it("derives every homepage counter from the same canonical public-valid population", () => {
    const block = routeBlock(publicRoutes, 'app.get("/api/v2/homepage-stats"', "// ── v2 Founding-members waitlist");
    expect(block).toMatch(/FROM certificates\s+WHERE status = 'active'/s);
    expect(block).toMatch(/deleted_at IS NULL/);
    expect(block).toMatch(/grade_approved_at IS NOT NULL/);
    expect(block).toContain("COUNT(*) FILTER (WHERE ownership_status = 'claimed') AS claimed_count");
    expect(block).not.toMatch(/COUNT\(\*\) FILTER \(WHERE deleted_at/);
  });
});
