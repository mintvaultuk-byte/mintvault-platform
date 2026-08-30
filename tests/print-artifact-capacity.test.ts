import { describe, expect, it } from "vitest";
import {
  CERTS_PER_PAGE,
  CRICUT_ARTIFACT_CAPACITY,
  MAX_CERTS_PER_MULTI_BATCH,
  printArtifactPlan,
} from "../server/print-batch";

describe("print artifact physical capacity", () => {
  it("keeps the Cricut and PDF capacities explicit and independent", () => {
    expect(CRICUT_ARTIFACT_CAPACITY).toBe(5);
    expect(CERTS_PER_PAGE).toBe(8);
    expect(MAX_CERTS_PER_MULTI_BATCH).toBe(48);
  });

  it.each([
    [4, false, false, 1],
    [5, false, false, 1],
    [6, true, false, 1],
    [8, true, false, 1],
    [9, true, true, 2],
    [48, true, true, 6],
  ])("classifies %i cards without advertising truncated artifacts", (count, pdfOnly, multiPage, pages) => {
    expect(printArtifactPlan(count)).toEqual({
      pdfOnly,
      isPdfMultiPage: multiPage,
      pageCount: pages,
    });
  });
});
