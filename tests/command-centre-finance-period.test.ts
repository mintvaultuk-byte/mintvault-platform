import { describe, expect, it } from "vitest";
import { vi } from "vitest";
vi.mock("../server/db", () => ({ db: { execute: vi.fn() } }));
import { buildPaidSubmissionAggregateQuery } from "../server/command-centre/core-read-adapter";

describe("Command Centre paid-submission London period query", () => {
  it("uses London-local timestamp bounds for the today window without session-zone coercion", () => {
    const query = buildPaidSubmissionAggregateQuery("today");
    expect(query).toContain("payment_timestamp >= date_trunc('day', now() AT TIME ZONE 'Europe/London')");
    expect(query).toContain("payment_timestamp < (now() AT TIME ZONE 'Europe/London')");
    expect(query).not.toContain("Europe/London') AT TIME ZONE");
  });

  it("uses the London month boundary and makes NULL or non-GBP currency UNKNOWN upstream", () => {
    const query = buildPaidSubmissionAggregateQuery("month_to_date");
    expect(query).toContain("payment_timestamp >= date_trunc('month', now() AT TIME ZONE 'Europe/London')");
    expect(query).toContain("payment_currency IS DISTINCT FROM 'GBP'");
  });
});
