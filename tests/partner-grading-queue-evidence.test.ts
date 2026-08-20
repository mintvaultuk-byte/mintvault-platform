import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

let projectPartnerQueueEvidence: typeof import("../server/partner/grading-routes").projectPartnerQueueEvidence;

beforeAll(async () => {
  process.env.MINTVAULT_DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/mintvault_test";
  ({ projectPartnerQueueEvidence } = await import("../server/partner/grading-routes"));
});

const admitted = () => ({
  state: "admitted" as const,
  available: true,
  reason: null,
  recovery: null,
  master: { dpi: 1200, width: 4724, height: 6136 },
  working: { width: 4724, height: 6136, format: "jpeg" },
});

const missing = () => ({
  state: "missing" as const,
  available: false,
  reason: "No current immutable Canon master is recorded for BACK.",
  recovery: "Capture or restore BACK at the locked Canon 1200-DPI profile.",
  master: null,
  working: null,
});

describe("Partner grading queue evidence projection", () => {
  it("preserves the canonical admission verdict through the Partner images adapter", () => {
    const routes = readFileSync("server/partner/grading-routes.ts", "utf8");
    const adapter = routes.slice(
      routes.indexOf("async function imagesForPartnerCert"),
      routes.indexOf("type PartnerQueueEvidenceSide")
    );
    expect(adapter).toContain("workingEvidence: payload.workingEvidence");
    expect(adapter).not.toContain("front_display: payload.workingEvidence");
  });

  it("shows both admitted canonical sides before a ready card is opened", () => {
    const evidence = projectPartnerQueueEvidence({
      workingEvidence: { front: admitted(), back: admitted() },
      urls: {
        front_working: "https://evidence.test/MV279/front-working.jpg",
        back_working: "https://evidence.test/MV279/back-working.jpg",
      },
      cardJobStatus: "READY_TO_GRADE",
      gradingStatus: "assigned",
    });

    expect(evidence).toMatchObject({
      workflow: "READY_TO_GRADE",
      front: { state: "admitted", label: "FRONT ✓", thumbnailUrl: "https://evidence.test/MV279/front-working.jpg" },
      back: { state: "admitted", label: "BACK ✓", thumbnailUrl: "https://evidence.test/MV279/back-working.jpg" },
    });
  });

  it("shows missing evidence explicitly and never fabricates a thumbnail from a URL", () => {
    const evidence = projectPartnerQueueEvidence({
      workingEvidence: { front: admitted(), back: missing() },
      urls: {
        front_working: "https://evidence.test/MV278/front-working.jpg",
        // This simulates a stale client/CDN URL. The server admission result wins.
        back_working: "https://stale.test/MV278/back-working.jpg",
      },
      cardJobStatus: "NEEDS_SCAN",
      gradingStatus: "assigned",
    });

    expect(evidence.workflow).toBe("INCOMPLETE_EVIDENCE");
    expect(evidence.front.thumbnailUrl).toBe("https://evidence.test/MV278/front-working.jpg");
    expect(evidence.back).toMatchObject({ state: "missing", label: "BACK MISSING", thumbnailUrl: null });
    expect(evidence.back.reason).toContain("No current immutable Canon master");
  });

  it("does not call a Card Job ready until both admitted sides and its captured lifecycle agree", () => {
    const evidence = projectPartnerQueueEvidence({
      workingEvidence: { front: admitted(), back: admitted() },
      urls: {
        front_working: "https://evidence.test/MV277/front-working.jpg",
        back_working: "https://evidence.test/MV277/back-working.jpg",
      },
      cardJobStatus: "CAPTURING",
      gradingStatus: "assigned",
    });

    expect(evidence.workflow).toBe("AWAITING_CAPTURE_ACCEPTANCE");
  });

  it("requires the same admitted workflow before the server may offer a grading lease", () => {
    const routes = readFileSync("server/partner/grading-routes.ts", "utf8");
    const queue = routes.slice(routes.indexOf("const lifecycleOpenable"), routes.indexOf("if (!byGroup.has"));
    expect(queue).toContain('evidence.workflow === "READY_TO_GRADE" || evidence.workflow === "IN_GRADING"');
    expect(queue).toContain("const openable =");
  });

  it("keeps working URLs and side labels bound to their exact card and side", () => {
    const first = projectPartnerQueueEvidence({
      workingEvidence: { front: admitted(), back: admitted() },
      urls: {
        front_working: "https://evidence.test/MV279/front-working.jpg",
        back_working: "https://evidence.test/MV279/back-working.jpg",
      },
      cardJobStatus: "READY_TO_GRADE",
      gradingStatus: "assigned",
    });
    const second = projectPartnerQueueEvidence({
      workingEvidence: { front: admitted(), back: admitted() },
      urls: {
        front_working: "https://evidence.test/MV278/front-working.jpg",
        back_working: "https://evidence.test/MV278/back-working.jpg",
      },
      cardJobStatus: "READY_TO_GRADE",
      gradingStatus: "assigned",
    });

    expect(first.front.thumbnailUrl).toBe("https://evidence.test/MV279/front-working.jpg");
    expect(first.back.thumbnailUrl).toBe("https://evidence.test/MV279/back-working.jpg");
    expect(second.front.thumbnailUrl).toBe("https://evidence.test/MV278/front-working.jpg");
    expect(second.back.thumbnailUrl).toBe("https://evidence.test/MV278/back-working.jpg");
    expect(first.front.thumbnailUrl).not.toBe(second.front.thumbnailUrl);
    expect(first.front.thumbnailUrl).not.toBe(first.back.thumbnailUrl);
  });
});
