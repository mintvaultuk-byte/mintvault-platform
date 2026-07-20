/**
 * Rarity single-selection regression (2026-07-20).
 *
 * BUG: the printed-rarity-symbol field ("Choose the symbol printed on the card")
 * in the canonical grading workstation felt like it kept multiple rarities
 * selected — the selected chip is highlighted in BOTH the main grid and
 * "Recently used", and clicking the already-selected rarity did NOT clear it
 * (pickRarity always called setRarity(v), never toggled), so zero-selection was
 * unreachable once a rarity was picked.
 *
 * The rarity MODEL was already single (`useState<string | null>`), and the
 * active-chip styling is single (`rarity === rr.value`) — so this is NOT an
 * array-schema / multi-value bug. The fix is a toggle-to-clear in the single
 * shared RarityVariantPicker, exposed as the pure `nextCatalogueRarity` helper
 * so the optional-single-select contract is unit-testable without a DOM (the
 * repo has no jsdom/RTL — see tests/partner-submission-wizard-ui.test.ts).
 *
 * No schema / migration / MVGS-scoring / label / grading-engine change.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { nextCatalogueRarity } from "../client/src/components/rarity-picker/RarityVariantPicker";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const PICKER = read("client/src/components/rarity-picker/RarityVariantPicker.tsx");
const FORM = read("client/src/components/certificate-form.tsx");

describe("rarity single-select contract (nextCatalogueRarity — behavioural, pure)", () => {
  it("1. a rarity can be selected from empty (ACE SPEC)", () => {
    expect(nextCatalogueRarity(null, "ace_spec", false)).toBe("ace_spec");
  });
  it("2. selecting a different rarity REPLACES the previous one (ACE SPEC → Rare)", () => {
    expect(nextCatalogueRarity("ace_spec", "rare", false)).toBe("rare");
  });
  it("3. clicking the currently-selected rarity again CLEARS it", () => {
    expect(nextCatalogueRarity("rare", "rare", false)).toBeNull();
  });
  it("4. zero selection is valid / reachable (toggle-off yields null)", () => {
    expect(nextCatalogueRarity("ace_spec", "ace_spec", false)).toBeNull();
    // and a fresh pick from null is still just the clicked value
    expect(nextCatalogueRarity(null, "rare", false)).toBe("rare");
  });
  it("at most ONE rarity is ever the result — the return is a single value or null, never a list", () => {
    const r = nextCatalogueRarity("rare", "uncommon", false);
    expect(typeof r === "string" || r === null).toBe(true);
    expect(Array.isArray(r)).toBe(false);
  });
  it("when a CUSTOM rarity is active, clicking a catalogue chip switches to it (not a same-value toggle)", () => {
    // rarity holds the CUSTOM sentinel; a catalogue click is never that sentinel,
    // and the hasCustomSelected guard prevents a spurious clear.
    expect(nextCatalogueRarity("__custom__", "rare", true)).toBe("rare");
  });
});

describe("rarity picker structure — single model, separate controls, toggle handlers", () => {
  it("rarity is a single nullable value (string | null), never an array", () => {
    expect(PICKER).toMatch(/const \[rarity, setRarity\] = useState<string \| null>/);
    expect(PICKER).not.toMatch(/const \[rarity, setRarity\] = useState<string\[\]>/);
  });
  it("6+7. finish and promo/gallery are SEPARATE single-value controls (not the rarity field)", () => {
    expect(PICKER).toMatch(/const \[finish, setFinish\] = useState<string \| null>/);
    expect(PICKER).toMatch(/const \[promoOrSubset, setPromoOrSubset\] = useState<string \| null>/);
  });
  it("3+4. pickRarity uses the toggle-to-clear helper and can setRarity(null)", () => {
    expect(PICKER).toContain("nextCatalogueRarity(rarity, v, !!selectedCustomId)");
    const pick = PICKER.slice(PICKER.indexOf("const pickRarity"), PICKER.indexOf("const pickCustomRarity"));
    expect(pick).toContain("setRarity(null)");
  });
  it("3+4. pickCustomRarity also clears when the same custom entry is re-clicked", () => {
    const pickC = PICKER.slice(PICKER.indexOf("const pickCustomRarity"), PICKER.indexOf("function resetAddForm"));
    expect(pickC).toMatch(/rarity === CUSTOM_RARITY_VALUE && selectedCustomId === entry\.id/);
    expect(pickC).toContain("setRarity(null)");
  });
  it("3. a chip's ACTIVE state is single — derived from `rarity === rr.value`, not membership in a list", () => {
    expect(PICKER).toMatch(/const selected = rarity === rr\.value;/);
    expect(PICKER).not.toMatch(/selected = .*recent.*\.includes/);
  });
  it("8. Recently-used is a history list (persistent), NOT the selection source", () => {
    expect(PICKER).toMatch(/usePersistentList\("mv\.rarityRecent"/);
    // recent chips render through the SAME `chip` fn, so only rarity===value is active
    expect(PICKER).toContain("recentRarities.map(chip)");
  });
  it("9. existing single-value records hydrate: rarity seeds from value?.rarity", () => {
    expect(PICKER).toMatch(/useState<string \| null>\(value\?\.rarity \?\? null\)/);
  });
});

describe("10. one canonical shared rarity picker — Admin/Staff/Grader consistency", () => {
  it("the fix lives in the single shared RarityVariantPicker (no duplicate rarity-selection component)", () => {
    // exactly one component owns printed-rarity selection; the canonical grading
    // workstation (certificate-form) consumes it.
    expect(FORM).toContain('import { RarityVariantPicker } from "@/components/rarity-picker/RarityVariantPicker"');
    expect(FORM).toContain("<RarityVariantPicker");
  });
  it("the shared picker exports the pure single-select decision used by its click handler", () => {
    expect(PICKER).toMatch(/export function nextCatalogueRarity\(/);
  });
});
