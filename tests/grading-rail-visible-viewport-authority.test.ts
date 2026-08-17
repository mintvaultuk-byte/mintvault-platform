/**
 * THE VISIBLE SCREEN IS THE CEILING — NOT THE CONTAINER.
 *
 * Owner P0, real staging screenshot: roughly half the card sat BELOW the bottom of the
 * MacBook screen, while every measurement this codebase took said it fitted.
 *
 * Both were true, and that is the whole defect. The card is in flow, so it makes its own
 * container taller. That container sits inside a page that can scroll. So `clientHeight`
 * cheerfully reported a box far taller than the physical display: the card fitted its
 * container, and the container ran off the screen. No amount of measuring the container
 * can catch this, because the container is the thing being inflated — which is why every
 * previous pass reported healthy clearances against a box the owner could not fully see.
 *
 * `railAvailableHeight` moves the authority to the real visible viewport. Every input is
 * card-independent: the card cannot move its own top (fixed-height header above it) and
 * cannot change the height of the controls below it.
 *
 * The decisive case is the last describe block: a right pane with a huge scrollHeight
 * must not change the left card by a single pixel.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  railAvailableHeight,
  RAIL_VISIBLE_BOTTOM_SAFETY_PX,
} from "../client/src/components/grading/image-viewer";

const VIEWER = fs.readFileSync(
  path.resolve(process.cwd(), "client/src/components/grading/image-viewer.tsx"),
  "utf8"
);

/** A MacBook-ish visible viewport, the card viewport starting below the header. */
const VISIBLE = 685;
const TOP = 120;
const CONTROLS = 44;

describe("the card is sized by the visible screen, not by its container", () => {
  it("ignores a container taller than the physical screen", () => {
    // This is the reported failure: the rail's container measured 1400px inside a
    // scrollable page on a 685px screen, so the card was fitted to 1400 and half of it
    // was off-display.
    const available = railAvailableHeight({
      containerH: 1400,
      visibleH: VISIBLE,
      top: TOP,
      controlsH: CONTROLS,
    });
    expect(available).toBe(VISIBLE - TOP - CONTROLS - RAIL_VISIBLE_BOTTOM_SAFETY_PX);
    expect(available).toBeLessThan(VISIBLE);
  });

  it("still honours a BOUNDED container when that is the tighter ceiling", () => {
    // A genuinely short host must not be overflowed either. Lower ceiling wins.
    const available = railAvailableHeight({ containerH: 300, visibleH: VISIBLE, top: TOP, controlsH: CONTROLS });
    expect(available).toBe(300);
  });

  it("leaves a real gap at the bottom of the screen", () => {
    const available = railAvailableHeight({ containerH: 9999, visibleH: VISIBLE, top: TOP, controlsH: CONTROLS });
    // Card bottom + controls must land clear of the screen edge.
    expect(TOP + available + CONTROLS).toBeLessThanOrEqual(VISIBLE - RAIL_VISIBLE_BOTTOM_SAFETY_PX);
    expect(RAIL_VISIBLE_BOTTOM_SAFETY_PX).toBeGreaterThanOrEqual(12);
  });

  it("reserves space for the controls rendered beneath the card", () => {
    const withControls = railAvailableHeight({ containerH: 9999, visibleH: VISIBLE, top: TOP, controlsH: 44 });
    const without = railAvailableHeight({ containerH: 9999, visibleH: VISIBLE, top: TOP, controlsH: 0 });
    expect(without - withControls).toBe(44);
  });

  it("falls back to the container when there is no usable visible height", () => {
    // Server render / detached measurement must not produce a negative or zero card.
    expect(railAvailableHeight({ containerH: 500, visibleH: 0, top: 0, controlsH: 0 })).toBe(500);
    expect(railAvailableHeight({ containerH: 500, visibleH: NaN, top: 0, controlsH: 0 })).toBe(500);
  });
});

describe("a long right pane cannot resize the left card", () => {
  // The owner's named regression. The right pane owns its own scrolling; the left card
  // must be identical whether that pane holds 600px or 3000px of content.
  const shortPane = { clientHeight: 600, scrollHeight: 600 };
  const longPane = { clientHeight: 600, scrollHeight: 3000 };

  /**
   * Models what the DOM does with each pane: a long right pane grows the DOCUMENT, and
   * therefore the left rail's own container, but it cannot change the visible screen,
   * the card viewport's top, or the controls' height.
   */
  const leftCardHeight = (pane: { clientHeight: number; scrollHeight: number }) =>
    railAvailableHeight({
      containerH: Math.max(600, pane.scrollHeight), // the inflated container
      visibleH: VISIBLE,
      top: TOP,
      controlsH: CONTROLS,
    });

  it("gives the same card height for a short and a very long right pane", () => {
    expect(leftCardHeight(longPane)).toBe(leftCardHeight(shortPane));
  });

  it("keeps the card inside the visible screen even at 3000px of right-pane content", () => {
    const h = leftCardHeight(longPane);
    expect(TOP + h + CONTROLS).toBeLessThanOrEqual(VISIBLE - RAIL_VISIBLE_BOTTOM_SAFETY_PX);
  });

  it("would have FAILED under the old container-measured rule", () => {
    // Proof this test is not vacuous: the previous authority was the container height,
    // and it produces a card taller than the entire screen.
    const oldRule = Math.max(600, longPane.scrollHeight);
    expect(oldRule).toBeGreaterThan(VISIBLE);
    expect(leftCardHeight(longPane)).toBeLessThan(oldRule);
  });
});

describe("the implementation uses the visible viewport, and reacts to it changing", () => {
  it("prefers visualViewport over innerHeight", () => {
    expect(VIEWER).toMatch(/window\.visualViewport\?\.height \?\? window\.innerHeight/);
  });

  it("never derives the card height from document or scroll height", () => {
    expect(VIEWER).not.toMatch(/documentElement\.scrollHeight/);
    expect(VIEWER).not.toMatch(/body\.scrollHeight/);
  });

  it("re-fits when the visible viewport changes, including on pinch-zoom scroll", () => {
    expect(VIEWER).toMatch(/vv\?\.addEventListener\("resize", bump\)/);
    expect(VIEWER).toMatch(/vv\?\.addEventListener\("scroll", bump\)/);
    expect(VIEWER).toMatch(/visibleViewportTick\]/);
  });

  it("measures the controls row it has to leave room for", () => {
    expect(VIEWER).toMatch(/railControlsRef/);
    expect(VIEWER).toMatch(/controlsH: railControlsRef\.current\?\.getBoundingClientRect\(\)\.height \?\? 0/);
  });
});
