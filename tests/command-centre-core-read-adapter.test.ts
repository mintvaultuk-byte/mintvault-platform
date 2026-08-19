import { describe, expect, it } from "vitest";
import { summariseCommandCentreSubmissionStatuses } from "../server/command-centre/submission-status";
import { normaliseCommandCentreTimestamp } from "../server/command-centre/timestamp";

describe("Command Centre core-read adapter normalisation", () => {
  it("normalises PostgreSQL Date values to sortable ISO timestamps and rejects invalid timestamps", () => {
    expect(normaliseCommandCentreTimestamp(new Date("2026-08-19T01:02:03.000Z"))).toBe("2026-08-19T01:02:03.000Z");
    expect(normaliseCommandCentreTimestamp("not-a-date")).toBeNull();
    expect(normaliseCommandCentreTimestamp(null)).toBeNull();
  });

  it("counts canonical new and ready-to-return rows, excludes terminal states, and rejects only unknown statuses", () => {
    expect(summariseCommandCentreSubmissionStatuses([
      { status: "new", count: 2 },
      { status: "ready_to_return", count: 3 },
      { status: "completed", count: 5 },
      { status: "shipped", count: 7 },
      { status: "cancelled", count: 11 },
    ])).toEqual({ unknownStatus: false, nonTerminal: 5 });
    expect(summariseCommandCentreSubmissionStatuses([{ status: "unknown_deployed_state", count: 1 }]))
      .toEqual({ unknownStatus: true, nonTerminal: 1 });
  });
});
