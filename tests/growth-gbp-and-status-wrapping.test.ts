import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { formatMetricValue, kpiValueClass } from "../client/src/pages/admin/growth";

const page = fs.readFileSync("client/src/pages/admin/growth.tsx", "utf8");
const server = fs.readFileSync("server/growth-intelligence-service.ts", "utf8");
const infrastructure = fs.readFileSync("server/growth-infrastructure-intelligence.ts", "utf8");

describe("money is transported in pence but never presented in pence", () => {
  it("renders the server's GBP pence unit as sterling", () => {
    // The live defect: livePulse.revenuePence arrives as { value: 0, unit: "GBP pence" }
    // and rendered literally as "0 GBP pence".
    expect(formatMetricValue({ value: 0, unit: "GBP pence" })).toBe("£0.00");
    expect(formatMetricValue({ value: 124800, unit: "GBP pence" })).toBe("£1,248.00");
  });

  it("keeps a rate suffix while converting the amount", () => {
    expect(formatMetricValue({ value: 124800, unit: "GBP pence/hour" })).toBe("£1,248.00/hour");
  });

  it("also converts a bare pence unit", () => {
    expect(formatMetricValue({ value: 5, unit: "pence" })).toBe("£0.05");
  });

  it("leaves every non-money unit untouched", () => {
    expect(formatMetricValue({ value: 6.6, unit: "requests/min" })).toBe("6.6 requests/min");
    expect(formatMetricValue({ value: 46, unit: "count" })).toBe("46 count");
    expect(formatMetricValue({ value: 241, unit: "ms" })).toBe("241 ms");
    expect(formatMetricValue({ value: "Operational", unit: "" })).toBe("Operational");
  });

  it("does not mistake a word merely containing 'pence' for money", () => {
    expect(formatMetricValue({ value: 3, unit: "pending" })).toBe("3 pending");
    expect(formatMetricValue({ value: 3, unit: "expenditure" })).toBe("3 expenditure");
  });

  it("leaves a non-numeric value alone even under a pence unit", () => {
    expect(formatMetricValue({ value: "NOT CONNECTED", unit: "GBP pence" })).toBe("NOT CONNECTED GBP pence");
  });

  it("no rendered surface prints a raw pence figure", () => {
    // text() is the single renderer for every metric on the page.
    expect(page).toContain("`${formatMetricValue(metric)}");
    expect(page).not.toMatch(/\$\{metric\.value\}\$\{metric\.unit \? ` \$\{metric\.unit\}`/);
  });

  it("the server still denominates in pence, so no payment maths moved to the client", () => {
    expect(server).toContain('"GBP pence"');
    expect(infrastructure).toContain('"GBP pence/hour"');
  });
});

describe("important statuses never split a word", () => {
  it("sizes the Search Console states so the word survives", () => {
    for (const status of ["NOT CONNECTED", "NOT INSTRUMENTED", "INSUFFICIENT DATA"]) {
      expect(kpiValueClass(status)).not.toContain("text-2xl");
    }
  });

  it("gives the Search Console panel a column wide enough for its longest word", () => {
    // Four cards in two columns inside a third-width column left ~93px per value,
    // narrower than "INSTRUMENTED" at any legible size.
    expect(page).toContain('className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2"');
  });

  it("gives the narrow Site Health telemetry cards room for an unconnected state", () => {
    expect(page).toContain('className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2"');
    expect(page).toContain('className="mt-2 grid gap-2 sm:grid-cols-2 2xl:grid-cols-4"');
  });

  it("gives the compact provider tiles room for an unconnected state", () => {
    // "NOT INSTRUMENTED" is the widest state these tiles ever carry, and
    // "INSTRUMENTED" does not fit an 81px cell at any legible size, so the
    // three-across provider grids became two-across.
    expect(page).toContain(
      '<div className="grid grid-cols-2 divide-x divide-y divide-[var(--admin-line,#333)]">'
    );
    expect(page).not.toMatch(/divide-\[var\(--admin-line,#333\)\]\s+sm:grid-cols-3/);
    expect(page).not.toContain('<div className="grid gap-2 sm:grid-cols-3">');
    expect(page).not.toContain('<div className="mt-2 grid gap-2 sm:grid-cols-3">');
  });

  it("routes every metric card through the one shared sizing rule", () => {
    // CompactDigital previously carried its own length threshold, which is how
    // its cells drifted back to a size that split "NOT CONNECTED".
    expect(page).not.toContain("const compactValue = value.length > 14");
    expect(page.match(/kpiValueClass\(/g) ?? []).not.toHaveLength(0);
  });
});
