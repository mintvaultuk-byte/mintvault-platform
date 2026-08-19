import { describe, expect, it } from "vitest";
import { vi } from "vitest";
vi.mock("../server/db", () => ({ pool: { connect: vi.fn() } }));
import { buildPaidSubmissionAggregateQuery } from "../server/command-centre/core-read-adapter";

describe("Command Centre paid-submission London period query", () => {
  it("converts the London day boundary to the UTC-naive storage representation", () => {
    const query = buildPaidSubmissionAggregateQuery("today");
    expect(query).toContain(
      "payment_timestamp >= ((date_trunc('day', now() AT TIME ZONE 'Europe/London') AT TIME ZONE 'Europe/London') AT TIME ZONE 'UTC')"
    );
    expect(query).toContain("payment_timestamp < (now() AT TIME ZONE 'UTC')");
  });

  it("uses the London month boundary and makes NULL or non-GBP currency UNKNOWN upstream", () => {
    const query = buildPaidSubmissionAggregateQuery("month_to_date");
    expect(query).toContain(
      "payment_timestamp >= ((date_trunc('month', now() AT TIME ZONE 'Europe/London') AT TIME ZONE 'Europe/London') AT TIME ZONE 'UTC')"
    );
    expect(query).toContain("payment_currency IS DISTINCT FROM 'GBP'");
  });
});
