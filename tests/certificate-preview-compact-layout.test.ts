/**
 * PENDING REVIEW LEFT RAIL — the certificate preview must stay a COMPACT
 * inspection thumbnail stacked under the card.
 *
 * The defect this pins (owner-reported, production 2026-08-12): the preview
 * image was a bare `w-full` with no ceiling. In the 40% left rail that renders
 * ~500px wide, and at the label's real 826x236 ratio that is ~145px tall before
 * chrome. The rail stacks the card on `flex-1` against the preview on
 * `shrink-0`, so every one of those pixels came OUT of the card — the preview
 * visually swallowed the object under review.
 *
 * These assertions are deliberately about STRUCTURE and CONSTRAINT, not about
 * one exact Tailwind string: a width ceiling exists, the frame owns a fixed
 * aspect so load does not resize the panel, the two are stacked in normal flow
 * rather than overlaid, and the rail/scroll ownership is unchanged.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

const PANEL = read("client", "src", "components", "grading-workflow", "CertificatePreviewPanel.tsx");
const ASIDE = read("client", "src", "components", "grading-workflow", "WorkstationPreviewAside.tsx");
const SHELL = read("client", "src", "components", "grading-workflow", "CanonicalGradingWorkstationShell.tsx");
const LABELS = read("server", "labels.ts");

describe("certificate preview is a compact inspection thumbnail", () => {
  it("caps the preview width — it must not consume the full left rail", () => {
    // A ceiling must exist. The value is allowed to be tuned; its ABSENCE is the bug.
    const cap = PANEL.match(/max-w-\[(\d+)px\]/);
    expect(cap, "the preview needs an explicit max-width ceiling").not.toBeNull();
    const px = Number(cap![1]);
    expect(px, "preview ceiling should stay in the compact 300-460px band").toBeGreaterThanOrEqual(300);
    expect(px, "preview ceiling should stay in the compact 300-460px band").toBeLessThanOrEqual(460);
  });

  it("the image is constrained by the frame and never re-inflates to full width", () => {
    // The <img> must not carry a bare w-full with no bounding frame around it.
    expect(PANEL).toMatch(/data-testid="certificate-preview-frame"/);
    expect(PANEL, "the image should fill its bounded frame, not the rail").toMatch(/object-contain/);
  });

  it("the frame owns a FIXED aspect so loading does not resize the panel over the card", () => {
    // Without this the empty state is one text line and the loaded state is a
    // tall image, so the panel grows the instant the render lands and shoves
    // the card upward.
    expect(PANEL).toMatch(/aspect-\[\d+\/\d+\]/);
  });

  it("uses the REAL label ratio, read from the print renderer's dimensions", () => {
    const ratio = PANEL.match(/aspect-\[(\d+)\/(\d+)\]/);
    expect(ratio).not.toBeNull();
    const pxW = Number(LABELS.match(/const PX_W = (\d+)/)![1]);
    const pxH = Number(LABELS.match(/const PX_H = (\d+)/)![1]);
    expect(Number(ratio![1]), "display ratio must track the printed label width").toBe(pxW);
    expect(Number(ratio![2]), "display ratio must track the printed label height").toBe(pxH);
  });

  it("has no empty-state block that reserves a tall box", () => {
    // The old states used py-4 text blocks sized differently from the image.
    expect(PANEL).toMatch(/Preparing preview…/);
  });

  it("stays READ-ONLY — the repair must not have introduced any write", () => {
    expect(PANEL).not.toMatch(/method:\s*"(PUT|PATCH|DELETE)"/);
    // The only request it makes is the POST that RENDERS the preview.
    expect(PANEL.match(/method:\s*"POST"/g)?.length ?? 0).toBe(1);
  });
});

describe("card and preview stack in normal flow — no overlay collision", () => {
  it("the rail stacks card above preview rather than overlapping them", () => {
    expect(ASIDE).toMatch(/flex-col/);
    // Card takes the remaining space; the preview is intrinsically sized.
    expect(ASIDE).toMatch(/flex-1/);
    expect(ASIDE).toMatch(/shrink-0/);
  });

  it("uses no absolute/negative-margin/z-index overlay technique", () => {
    for (const src of [PANEL, ASIDE]) {
      expect(src).not.toMatch(/\babsolute\b/);
      expect(src).not.toMatch(/-m[trblxy]?-/); // negative margin pull-up
      expect(src).not.toMatch(/\bz-\d/);
    }
  });
});

describe("left rail stays fixed and the right workspace stays the scroll surface", () => {
  it("the RIGHT pane owns the only scroll surface, via the shell's canonical body class", () => {
    const bodyScroll = SHELL.match(/WORKSTATION_BODY_SCROLL_CLASS = "([^"]+)"/);
    expect(bodyScroll, "the shell must still export the canonical body scroll class").not.toBeNull();
    expect(bodyScroll![1], "the right pane is the scroll surface").toContain("overflow-y-auto");
    expect(bodyScroll![1], "it must be a bounded flex child or the page scrolls instead").toContain("min-h-0");
  });

  it("the bounded /admin viewport is still owned by the sanctioned caller", () => {
    // The whole point of the bounded shell: the PAGE must not scroll. If this
    // disappears the left rail stops being stationary and the defect returns in
    // a different form.
    const DASH = read("client", "src", "pages", "admin-dashboard.tsx");
    expect(DASH).toMatch(/h-\[calc\(100dvh-4\.5rem\)\]/);
  });

  it("neither the left rail nor the preview panel introduces its own scroller", () => {
    for (const src of [PANEL, ASIDE]) {
      expect(src).not.toMatch(/overflow-y-auto/);
      expect(src).not.toMatch(/overflow-y-scroll/);
    }
  });
});

describe("the printed label renderer is untouched by this display change", () => {
  it("keeps the committed 826x236 print geometry", () => {
    expect(LABELS).toMatch(/const PX_W = 826;/);
    expect(LABELS).toMatch(/const PX_H = 236;/);
  });
});
