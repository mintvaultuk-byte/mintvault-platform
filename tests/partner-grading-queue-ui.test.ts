import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const page = readFileSync("client/src/pages/partner/grading.tsx", "utf8");
const queueCards = () => page.slice(page.indexOf("cards.map(({ item, card })"));

describe("Partner grading queue evidence UI", () => {
  it("renders server-derived FRONT/BACK evidence before the open action", () => {
    const card = queueCards();
    expect(card).toContain('<QueueEvidenceTile certId={card.certId} side="front" evidence={card.evidence.front} />');
    expect(card).toContain('<QueueEvidenceTile certId={card.certId} side="back" evidence={card.evidence.back} />');
    expect(card.indexOf("QueueEvidenceTile")).toBeLessThan(card.indexOf("onClick={() => setActive({ item, card })}"));
  });

  it("uses only the server-supplied admitted working URL for a queue thumbnail", () => {
    const tile = page.slice(
      page.indexOf("function QueueEvidenceTile"),
      page.indexOf("function PartnerCaptureControls")
    );
    expect(tile).toContain("evidence.thumbnailUrl");
    expect(tile).toContain('evidence.state !== "admitted"');
    expect(tile).not.toMatch(/front_display|back_display|front_original|back_original/);
  });

  it("does not leave a disabled misleading Open button for an incomplete or invalid card", () => {
    const card = queueCards();
    expect(card).toContain('"Capture at approved Scanner"');
    expect(card).toContain('"Resolve evidence"');
    expect(card).toContain('"Awaiting capture acceptance"');
    expect(card).toContain("partner-queue-unavailable-action-${card.certId}");
    expect(card).not.toContain("disabled={!card.openable}");
  });
});
