import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Phase 1 contract guard: client code must not point a URL literal at a route
 * that no longer exists, and the dashboard must not expose document bearer
 * tokens. (Phase 7 adds the full consumer/producer comparison.)
 */
const ROOT = process.cwd();

function clientFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
    }
  };
  walk(path.join(ROOT, "client/src"));
  return out;
}

describe("client endpoint contract (Phase 1)", () => {
  const sources = clientFiles().map((f) => ({ f: path.relative(ROOT, f), src: fs.readFileSync(f, "utf8") }));

  it("no client URL literal points at the removed /api/admin/printing/reprint route", () => {
    // Prose/comments are fine; flag only URL-literal usage (quote/backtick prefix).
    const offenders = sources.filter(({ src }) => /["'`]\/api\/admin\/printing\/reprint/.test(src)).map((s) => s.f);
    expect(offenders, `Remove URL references to the removed route:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("the dashboard no longer exposes packing-slip / shipping-label bearer tokens", () => {
    const dash = sources.find((s) => s.f.endsWith("dashboard.tsx"));
    expect(dash, "dashboard.tsx not found").toBeDefined();
    expect(dash!.src).not.toMatch(/packingSlipToken|shippingLabelToken/);
  });
});
