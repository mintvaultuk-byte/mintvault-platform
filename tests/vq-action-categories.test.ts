/**
 * Action-category rotation — pure list + chooser. No network, no DOM.
 */
import { describe, it, expect } from "vitest";
import {
  VQ_ACTION_CATEGORIES,
  VQ_ACTION_CATEGORY_OPTIONS,
  chooseActionCategory,
  findActionCategory,
} from "../shared/vq-action-categories";

describe("VQ_ACTION_CATEGORIES / options", () => {
  it("has 12 categories, each with value/label/prompt", () => {
    expect(VQ_ACTION_CATEGORIES.length).toBe(12);
    for (const c of VQ_ACTION_CATEGORIES) {
      expect(c.value).toBeTruthy();
      expect(c.label).toBeTruthy();
      expect(c.prompt.length).toBeGreaterThan(10);
    }
  });
  it("values are unique", () => {
    const values = VQ_ACTION_CATEGORIES.map((c) => c.value);
    expect(new Set(values).size).toBe(values.length);
  });
  it("dropdown options = Auto first, then every category", () => {
    expect(VQ_ACTION_CATEGORY_OPTIONS[0].value).toBe("auto");
    expect(VQ_ACTION_CATEGORY_OPTIONS.length).toBe(VQ_ACTION_CATEGORIES.length + 1);
  });
  it("findActionCategory resolves a value, undefined for auto/unknown", () => {
    expect(findActionCategory("roaring")?.label).toBe("Roaring");
    expect(findActionCategory("auto")).toBeUndefined();
    expect(findActionCategory(null)).toBeUndefined();
    expect(findActionCategory("nonsense")).toBeUndefined();
  });
});

describe("chooseActionCategory", () => {
  it("honours an explicit, valid requested category verbatim", () => {
    expect(chooseActionCategory({ requested: "roaring" }).value).toBe("roaring");
    // even if it equals the excluded one — an explicit founder choice wins
    expect(chooseActionCategory({ requested: "roaring", excludeCategory: "roaring" }).value).toBe("roaring");
  });
  it("Auto excludes the existing approved action's category", () => {
    const existing = "sprinting"; // the first in the list
    const chosen = chooseActionCategory({ requested: "auto", excludeCategory: existing, attempt: 1 });
    expect(chosen.value).not.toBe(existing);
  });
  it("Auto (blank/unknown request) rotates to a DIFFERENT category on a retry", () => {
    const a1 = chooseActionCategory({ requested: "auto", excludeCategory: "sprinting", attempt: 1 });
    const a2 = chooseActionCategory({ requested: "auto", excludeCategory: "sprinting", attempt: 2 });
    expect(a1.value).not.toBe(a2.value);
    expect(a1.value).not.toBe("sprinting");
    expect(a2.value).not.toBe("sprinting");
  });
  it("treats an unknown requested value as Auto", () => {
    const chosen = chooseActionCategory({ requested: "not-a-category", excludeCategory: "sprinting" });
    expect(chosen.value).not.toBe("sprinting");
    expect(VQ_ACTION_CATEGORIES.some((c) => c.value === chosen.value)).toBe(true);
  });
  it("is deterministic (same inputs → same output)", () => {
    const a = chooseActionCategory({ requested: "auto", excludeCategory: "leaping_up", attempt: 3 });
    const b = chooseActionCategory({ requested: "auto", excludeCategory: "leaping_up", attempt: 3 });
    expect(a.value).toBe(b.value);
  });
});
