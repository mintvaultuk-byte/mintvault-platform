import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findStaleOverwrites,
  resolveEditConflicts,
  canonicalArray,
  canonicalArrayValue,
  fieldPresence,
  isSubmitted,
  isExplicitClear,
  GUARDED_FIELD_SPECS,
  CONFLICT_GUARDED_FIELDS,
} from "../shared/edit-conflict";

const base = { cardName: "Regieleki V", setName: "Sword & Shield", variant: "PROMO", rarity: "" };

/** A full posted body: the editor's tab echoes everything it loaded. */
const post = (loaded: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  ...loaded,
  ...overrides,
});

describe("findStaleOverwrites (retained legacy helper)", () => {
  it("passes when nothing changed anywhere", () => {
    expect(findStaleOverwrites(base, base, base)).toEqual([]);
  });

  it("passes when this tab is the only writer (normal edit)", () => {
    expect(findStaleOverwrites(base, { ...base, cardName: "Regieleki V (new)" }, base)).toEqual([]);
  });

  it("catches the MV237 clobber: script set variant, stale tab posts old empty", () => {
    const loaded = { ...base, variant: "", setName: "swoed & shield black star promos" };
    expect(findStaleOverwrites(loaded, loaded, base).sort()).toEqual(["setName", "variant"]);
  });

  it("treats null/undefined/absent/whitespace as the same empty value", () => {
    const loaded = { ...base, rarity: null } as any;
    const current = { ...base, rarity: undefined } as any;
    const posted = { ...base, rarity: "  " } as any;
    expect(findStaleOverwrites(loaded, posted, current)).toEqual([]);
  });

  it("has NO production caller — it is documented as a deliberate contract retention", () => {
    // Guard the documentation, so removing the rationale is a test failure.
    const src = readFileSync(join(process.cwd(), "shared/edit-conflict.ts"), "utf8");
    expect(src).toContain("@deprecated");
    expect(src).toContain("RETAINED DELIBERATELY");
    expect(src).toContain("NO production caller");
    const routes = readFileSync(join(process.cwd(), "server/routes.ts"), "utf8");
    expect(routes).not.toContain("findStaleOverwrites");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MEDIUM — absent vs clear
// ─────────────────────────────────────────────────────────────────────────────

describe("presence: absent / null / empty-string / empty-array / value are distinct", () => {
  it("isSubmitted uses real property presence, not falsiness", () => {
    expect(isSubmitted({ cardName: "" }, "cardName")).toBe(true);
    expect(isSubmitted({ cardName: null }, "cardName")).toBe(true);
    expect(isSubmitted({}, "cardName")).toBe(false);
  });

  it("classifies every representation distinctly", () => {
    expect(fieldPresence({}, "cardName")).toBe("absent");
    expect(fieldPresence({ cardName: undefined }, "cardName")).toBe("absent");
    expect(fieldPresence({ cardName: null }, "cardName")).toBe("null");
    expect(fieldPresence({ cardName: "" }, "cardName")).toBe("emptyString");
    expect(fieldPresence({ cardName: "  " }, "cardName")).toBe("emptyString");
    expect(fieldPresence({ cardName: "Pikachu" }, "cardName")).toBe("value");
    expect(fieldPresence({ designations: [] }, "designations")).toBe("emptyArray");
    expect(fieldPresence({ designations: "[]" }, "designations")).toBe("emptyArray");
    expect(fieldPresence({ designations: ["PROMO"] }, "designations")).toBe("value");
  });

  it("defines the valid CLEAR representation per field kind — and absence is never one", () => {
    expect(isExplicitClear({ cardName: "" }, "cardName")).toBe(true);
    expect(isExplicitClear({ cardName: null }, "cardName")).toBe(true);
    expect(isExplicitClear({}, "cardName")).toBe(false);
    expect(isExplicitClear({ designations: [] }, "designations")).toBe(true);
    expect(isExplicitClear({ designations: "[]" }, "designations")).toBe(true);
    expect(isExplicitClear({ designations: ["PROMO"] }, "designations")).toBe(false);
    expect(isExplicitClear({}, "designations")).toBe(false);
  });

  it("an OMITTED field is never written and never counted as a change", () => {
    const loaded = { ...base };
    const current = { ...base };
    // Body carries only cardName — every other guarded field is absent.
    const r = resolveEditConflicts(loaded, { cardName: "New Name" }, current);
    expect(r.blocked).toBe(false);
    expect(r.omitted).toContain("setName");
    expect(r.omitted).toContain("variant");
    // Absent fields are NOT in valuesToPersist → the caller writes nothing for them.
    expect(Object.keys(r.valuesToPersist)).toEqual(["cardName"]);
    expect(r.changes.map((c) => c.key)).toEqual(["cardName"]);
  });

  it("an omitted field is NOT treated as a clear even when the stored value is non-empty", () => {
    const loaded = { ...base, variant: "PROMO" };
    const current = { ...base, variant: "PROMO" };
    const r = resolveEditConflicts(loaded, { cardName: "X" }, current);
    const variant = r.fields.find((f) => f.key === "variant")!;
    expect(variant.provenance).toBe("omitted");
    expect(variant.next).toBe("PROMO"); // preserved, not cleared
    expect(variant.changed).toBe(false);
  });

  it("an EXPLICIT clear is applied and recorded as a real change", () => {
    const loaded = { ...base, variant: "PROMO" };
    const current = { ...base, variant: "PROMO" };
    const r = resolveEditConflicts(loaded, post(loaded, { variant: "" }), current);
    expect(r.blocked).toBe(false);
    expect(r.valuesToPersist.variant).toBe("");
    expect(r.changes.find((c) => c.key === "variant")).toMatchObject({ previous: "PROMO", next: "" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H5 — designations as a set
// ─────────────────────────────────────────────────────────────────────────────

describe("H5: designations is guarded and compared as a SET", () => {
  it("designations is in the guarded field list, typed as an array", () => {
    expect(CONFLICT_GUARDED_FIELDS).toContain("designations");
    const spec = GUARDED_FIELD_SPECS.find((f) => f.key === "designations")!;
    expect(spec.kind).toBe("stringArray");
  });

  it("canonicalisation is deterministic, order-insensitive and duplicate-safe", () => {
    expect(canonicalArray(["B", "A"])).toBe(canonicalArray(["A", "B"]));
    expect(canonicalArray(["A", "A", "B"])).toBe(canonicalArray(["B", "A"]));
    expect(canonicalArray([" A ", "B"])).toBe(canonicalArray(["A", "B"]));
    expect(canonicalArray([])).toBe("");
    expect(canonicalArray(null)).toBe("");
    expect(canonicalArray(undefined)).toBe("");
    expect(canonicalArray("[]")).toBe("");
    // JSON-string wire format (multipart) must give the same verdict as an array.
    expect(canonicalArray('["B","A"]')).toBe(canonicalArray(["A", "B"]));
    expect(canonicalArrayValue(["B", "A", "A"])).toEqual(["A", "B"]);
  });

  it("REGRESSION: an unrelated edit cannot erase designations", () => {
    const loaded = { ...base, designations: ["PROMO", "FIRST_EDITION"] };
    const current = { ...base, designations: ["PROMO", "FIRST_EDITION"] };
    // The editor changes only the card name; designations echo unchanged.
    const r = resolveEditConflicts(loaded, post(loaded, { cardName: "New" }), current);
    expect(r.blocked).toBe(false);
    expect(canonicalArrayValue(r.valuesToPersist.designations)).toEqual(["FIRST_EDITION", "PROMO"]);
    expect(r.changes.map((c) => c.key)).toEqual(["cardName"]);
  });

  it("a stale editor who did not modify designations preserves the CURRENT database value", () => {
    const loaded = { ...base, designations: ["PROMO"] };
    const current = { ...base, designations: ["PROMO", "STAFF"] }; // someone else added STAFF
    const r = resolveEditConflicts(loaded, post(loaded, { cardName: "New" }), current);
    expect(r.conflicts).toEqual([]);
    expect(r.merged).toContain("designations");
    expect(canonicalArrayValue(r.valuesToPersist.designations)).toEqual(["PROMO", "STAFF"]); // DB wins
  });

  it("reordered identical designation arrays do NOT conflict", () => {
    const loaded = { ...base, designations: ["PROMO", "STAFF"] };
    const current = { ...base, designations: ["STAFF", "PROMO"] };
    const r = resolveEditConflicts(loaded, post(loaded, { designations: ["STAFF", "PROMO"] }), current);
    expect(r.blocked).toBe(false);
    expect(r.conflicts).toEqual([]);
    expect(r.changes.find((c) => c.key === "designations")).toBeUndefined();
  });

  it("duplicate entries normalise safely and do not register as a change", () => {
    const loaded = { ...base, designations: ["PROMO"] };
    const current = { ...base, designations: ["PROMO"] };
    const r = resolveEditConflicts(loaded, post(loaded, { designations: ["PROMO", "PROMO", " PROMO "] }), current);
    expect(r.conflicts).toEqual([]);
    expect(r.changes.find((c) => c.key === "designations")).toBeUndefined();
    expect(canonicalArrayValue(r.valuesToPersist.designations)).toEqual(["PROMO"]);
  });

  it("two users making DIFFERENT designation edits genuinely conflict", () => {
    const loaded = { ...base, designations: ["PROMO"] };
    const current = { ...base, designations: ["PROMO", "STAFF"] }; // other user added STAFF
    const posted = post(loaded, { designations: ["PROMO", "PRERELEASE"] }); // this user added PRERELEASE
    const r = resolveEditConflicts(loaded, posted, current);
    expect(r.conflicts).toContain("designations");
    expect(r.blocked).toBe(true);
    expect(r.valuesToPersist).toEqual({}); // nothing may be written
  });

  it("an intentional clear-to-empty succeeds and is distinguishable from omission", () => {
    const loaded = { ...base, designations: ["PROMO"] };
    const current = { ...base, designations: ["PROMO"] };
    const cleared = resolveEditConflicts(loaded, post(loaded, { designations: [] }), current);
    expect(cleared.blocked).toBe(false);
    expect(canonicalArrayValue(cleared.valuesToPersist.designations)).toEqual([]);
    expect(cleared.changes.find((c) => c.key === "designations")).toMatchObject({
      previous: ["PROMO"],
      next: [],
    });

    // Omission is a DIFFERENT outcome: preserved, not cleared.
    const { designations: _drop, ...withoutDesignations } = post(loaded);
    const omittedResult = resolveEditConflicts(loaded, withoutDesignations, current);
    expect(omittedResult.omitted).toContain("designations");
    expect(omittedResult.valuesToPersist.designations).toBeUndefined();
  });

  it("legacy designation codes survive a round trip untouched", () => {
    const legacy = ["FIRST_EDITION", "ERROR_MISCUT", "JAPANESE_PRINT"];
    const loaded = { ...base, designations: legacy };
    const current = { ...base, designations: legacy };
    const r = resolveEditConflicts(loaded, post(loaded), current);
    expect(r.blocked).toBe(false);
    expect(canonicalArrayValue(r.valuesToPersist.designations).sort()).toEqual([...legacy].sort());
    expect(r.changes).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Same-field conflicts + safe merges
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveEditConflicts — only same-field disagreements interrupt", () => {
  it("clean save: nothing changed anywhere", () => {
    const r = resolveEditConflicts(base, post(base), base);
    expect(r).toMatchObject({ conflicts: [], merged: [], blocked: false });
    expect(r.changes).toEqual([]);
  });

  it("MERGE: another session changed a field the editor never edited", () => {
    const loaded = { ...base, setName: "Old Set" };
    const current = { ...base, setName: "Corrected Set" };
    const posted = post(loaded, { cardName: "Editor's new name" });
    const r = resolveEditConflicts(loaded, posted, current);
    expect(r.conflicts).toEqual([]);
    expect(r.merged).toEqual(["setName"]);
    expect(r.valuesToPersist.setName).toBe("Corrected Set");
    expect(r.fields.find((f) => f.key === "setName")!.provenance).toBe("merged");
  });

  it("TRUE CONFLICT: both changed the SAME field differently", () => {
    const loaded = { ...base, variant: "" };
    const current = { ...base, variant: "PROMO" };
    const posted = post(loaded, { variant: "1ST EDITION" });
    const r = resolveEditConflicts(loaded, posted, current);
    expect(r.conflicts).toEqual(["variant"]);
    expect(r.blocked).toBe(true);
  });

  it("converged: both landed on the same value — harmless", () => {
    const loaded = { ...base, variant: "" };
    const current = { ...base, variant: "PROMO" };
    const r = resolveEditConflicts(loaded, post(loaded, { variant: "PROMO" }), current);
    expect(r.blocked).toBe(false);
    expect(r.conflicts).toEqual([]);
  });

  it("a blocked resolution yields NO values to persist and NO changes", () => {
    const loaded = { ...base, variant: "" };
    const current = { ...base, variant: "PROMO" };
    const r = resolveEditConflicts(loaded, post(loaded, { variant: "OTHER" }), current);
    expect(r.blocked).toBe(true);
    expect(r.valuesToPersist).toEqual({});
    expect(r.changes).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MEDIUM — related-field (compound) consistency
// ─────────────────────────────────────────────────────────────────────────────

describe("compound related-field conflicts", () => {
  it("editing Variant while the SET moved elsewhere is a compound conflict, not a hybrid", () => {
    // The founder's exact scenario: a Variant/Finish combination must not be
    // preserved against a set that changed underneath the editor.
    const loaded = { ...base, setName: "Base Set", rarityCode: "" };
    const current = { ...base, setName: "Jungle", rarityCode: "" }; // set corrected elsewhere
    const posted = post(loaded, { rarityCode: "rare_holo" }); // editor set a variant
    const r = resolveEditConflicts(loaded, posted, current);
    expect(r.blocked).toBe(true);
    expect(r.compoundConflicts).toHaveLength(1);
    expect(r.compoundConflicts[0].group).toBe("variant");
    expect(r.compoundConflicts[0].editorEdited).toContain("rarityCode");
    expect(r.compoundConflicts[0].movedElsewhere).toContain("setName");
    expect(r.valuesToPersist).toEqual({});
  });

  it("editing Finish while another Variant field moved elsewhere is a compound conflict", () => {
    const loaded = { ...base, finishVariant: "", promoType: "" };
    const current = { ...base, finishVariant: "", promoType: "black_star" }; // promo set elsewhere
    const posted = post(loaded, { finishVariant: "holo" });
    const r = resolveEditConflicts(loaded, posted, current);
    expect(r.blocked).toBe(true);
    expect(r.compoundConflicts[0].group).toBe("variant");
  });

  it("CROSS-GROUP edits still merge freely — no unnecessary interruption", () => {
    // Editor changes an identity field; a VARIANT field moved elsewhere.
    // Different groups, no governing relationship → safe merge.
    const loaded = { ...base, cardName: "Old", finishVariant: "" };
    const current = { ...base, cardName: "Old", finishVariant: "holo" };
    const posted = post(loaded, { cardName: "New" });
    const r = resolveEditConflicts(loaded, posted, current);
    expect(r.blocked).toBe(false);
    expect(r.compoundConflicts).toEqual([]);
    expect(r.merged).toEqual(["finishVariant"]);
    expect(r.valuesToPersist.finishVariant).toBe("holo");
    expect(r.valuesToPersist.cardName).toBe("New");
  });

  it("editing two fields in the same group is fine when nothing moved elsewhere", () => {
    const loaded = { ...base, rarityCode: "", finishVariant: "" };
    const current = { ...base, rarityCode: "", finishVariant: "" };
    const posted = post(loaded, { rarityCode: "rare", finishVariant: "holo" });
    const r = resolveEditConflicts(loaded, posted, current);
    expect(r.blocked).toBe(false);
    expect(r.compoundConflicts).toEqual([]);
    expect(r.changes.map((c) => c.key).sort()).toEqual(["finishVariant", "rarityCode"]);
  });

  it("designations participate in the variant consistency group", () => {
    const loaded = { ...base, designations: [], rarityCode: "" };
    const current = { ...base, designations: [], rarityCode: "rare_holo" }; // variant set elsewhere
    const posted = post(loaded, { designations: ["PROMO"] });
    const r = resolveEditConflicts(loaded, posted, current);
    expect(r.blocked).toBe(true);
    expect(r.compoundConflicts[0].group).toBe("variant");
    expect(r.compoundConflicts[0].editorEdited).toContain("designations");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H6 — the audit diff the resolver feeds
// ─────────────────────────────────────────────────────────────────────────────

describe("H6: the resolution carries a truthful field diff", () => {
  it("records previous AND next for each genuine change, and nothing for unchanged fields", () => {
    const loaded = { ...base, cardName: "Old", year: "1999" };
    const current = { ...base, cardName: "Old", year: "1999" };
    const posted = post(loaded, { cardName: "New" });
    const r = resolveEditConflicts(loaded, posted, current);
    expect(r.changes).toEqual([
      { key: "cardName", provenance: "request", previous: "Old", next: "New", changed: true },
    ]);
    // year was submitted but unchanged → not a change
    expect(r.changes.find((c) => c.key === "year")).toBeUndefined();
  });

  it("distinguishes request-sourced from safely-merged values", () => {
    const loaded = { ...base, cardName: "Old", setName: "Old Set" };
    const current = { ...base, cardName: "Old", setName: "Corrected Set" };
    const posted = post(loaded, { cardName: "New" });
    const r = resolveEditConflicts(loaded, posted, current);
    expect(r.fields.find((f) => f.key === "cardName")!.provenance).toBe("request");
    expect(r.fields.find((f) => f.key === "setName")!.provenance).toBe("merged");
    // The merged field is NOT reported as a change — the DB already held it.
    expect(r.changes.map((c) => c.key)).toEqual(["cardName"]);
  });

  it("records canonical previous and next ARRAYS for designations", () => {
    const loaded = { ...base, designations: ["B", "A"] };
    const current = { ...base, designations: ["B", "A"] };
    const r = resolveEditConflicts(loaded, post(loaded, { designations: ["C", "A"] }), current);
    const change = r.changes.find((c) => c.key === "designations")!;
    expect(change.previous).toEqual(["A", "B"]);
    expect(change.next).toEqual(["A", "C"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// M-1 — converged governing field must not raise a false compound conflict
// ─────────────────────────────────────────────────────────────────────────────

describe("M-1: convergence is not disagreement", () => {
  it("converged SET change + Variant edit succeeds", () => {
    // Original "Base"; the editor moves it to "Jungle" AND picks a variant;
    // another writer independently moved it to the same "Jungle".
    const loaded = { ...base, setName: "Base", rarityCode: "" };
    const current = { ...base, setName: "Jungle", rarityCode: "" };
    const posted = post(loaded, { setName: "Jungle", rarityCode: "rare_holo" });
    const r = resolveEditConflicts(loaded, posted, current);
    expect(r.blocked).toBe(false);
    expect(r.compoundConflicts).toEqual([]);
    expect(r.valuesToPersist.rarityCode).toBe("rare_holo");
    expect(r.valuesToPersist.setName).toBe("Jungle");
  });

  it("DIFFERENT set changes + Variant edit still conflicts", () => {
    const loaded = { ...base, setName: "Base", rarityCode: "" };
    const current = { ...base, setName: "Fossil", rarityCode: "" };
    const posted = post(loaded, { setName: "Jungle", rarityCode: "rare_holo" });
    const r = resolveEditConflicts(loaded, posted, current);
    expect(r.blocked).toBe(true);
    // setName itself is a genuine same-field conflict here.
    expect(r.conflicts).toContain("setName");
  });

  it("converged GAME change does not create a false conflict", () => {
    const loaded = { ...base, cardGame: "pokemon", finishVariant: "" };
    const current = { ...base, cardGame: "lorcana", finishVariant: "" };
    const posted = post(loaded, { cardGame: "lorcana", finishVariant: "holo" });
    const r = resolveEditConflicts(loaded, posted, current);
    expect(r.blocked).toBe(false);
    expect(r.compoundConflicts).toEqual([]);
  });

  it("converged ERA change does not create a false conflict", () => {
    const loaded = { ...base, era: "swsh", promoType: "" };
    const current = { ...base, era: "sv", promoType: "" };
    const posted = post(loaded, { era: "sv", promoType: "black_star" });
    const r = resolveEditConflicts(loaded, posted, current);
    expect(r.blocked).toBe(false);
    expect(r.valuesToPersist.promoType).toBe("black_star");
  });

  it("a DIVERGENT governing field still produces a compound conflict when the editor did not touch it", () => {
    // Editor edits only the variant; the set moved elsewhere and still disagrees
    // with what this tab loaded → the hybrid risk is real.
    const loaded = { ...base, setName: "Base", finishVariant: "" };
    const current = { ...base, setName: "Jungle", finishVariant: "" };
    const posted = post(loaded, { finishVariant: "holo" }); // setName echoes "Base"
    const r = resolveEditConflicts(loaded, posted, current);
    expect(r.blocked).toBe(true);
    expect(r.compoundConflicts[0].group).toBe("variant");
    expect(r.compoundConflicts[0].movedElsewhere).toContain("setName");
  });

  it("canonicalisation does not manufacture false convergence", () => {
    // Casing differs → NOT the same canonical value → still a real conflict.
    const loaded = { ...base, setName: "Base" };
    const current = { ...base, setName: "Jungle" };
    const posted = post(loaded, { setName: "JUNGLE" });
    const r = resolveEditConflicts(loaded, posted, current);
    expect(r.conflicts).toContain("setName"); // scalar comparison is case-SENSITIVE
  });

  it("array ordering DOES converge safely (designations are a set)", () => {
    const loaded = { ...base, designations: ["A"] };
    const current = { ...base, designations: ["B", "A"] };
    const posted = post(loaded, { designations: ["A", "B"] }); // same set, other order
    const r = resolveEditConflicts(loaded, posted, current);
    expect(r.blocked).toBe(false);
    expect(r.conflicts).toEqual([]);
  });
});
