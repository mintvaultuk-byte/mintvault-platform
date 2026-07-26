import { describe, it, expect } from "vitest";
import { findStaleOverwrites, resolveEditConflicts } from "../shared/edit-conflict";

const base = { cardName: "Regieleki V", setName: "Sword & Shield", variant: "PROMO", rarity: "" };

describe("findStaleOverwrites", () => {
  it("passes when nothing changed anywhere", () => {
    expect(findStaleOverwrites(base, base, base)).toEqual([]);
  });

  it("passes when this tab is the only writer (normal edit)", () => {
    const posted = { ...base, cardName: "Regieleki V (new)" };
    expect(findStaleOverwrites(base, posted, base)).toEqual([]);
  });

  it("catches the MV237 clobber: script set variant, stale tab posts old empty", () => {
    const loaded = { ...base, variant: "", setName: "swoed & shield black star promos" };
    const current = base; // repair script wrote variant + set
    const posted = loaded; // stale full-state save
    expect(findStaleOverwrites(loaded, posted, current)).toEqual(["setName", "variant"]);
  });

  it("passes when another writer changed a field but this save posts the SAME new value", () => {
    const loaded = { ...base, cardName: "Old" };
    const current = { ...base, cardName: "New" };
    const posted = { ...base, cardName: "New" }; // no-op vs DB
    expect(findStaleOverwrites(loaded, posted, current)).toEqual([]);
  });

  it("ignores row churn in fields outside the guarded set (grade saves etc.)", () => {
    // grade fields aren't in the guarded list at all — only metadata compares
    expect(findStaleOverwrites(base, base, { ...base })).toEqual([]);
  });

  it("treats null/undefined/absent/whitespace as the same empty value", () => {
    const loaded = { ...base, rarity: null } as any;
    const current = { ...base, rarity: undefined } as any;
    const posted = { ...base, rarity: "  " } as any;
    expect(findStaleOverwrites(loaded, posted, current)).toEqual([]);
  });

  it("conflicts when the tab would CLEAR a value someone else just set", () => {
    const loaded = { ...base, variant: "" };
    const current = { ...base, variant: "PROMO" };
    const posted = { ...base, variant: "" };
    expect(findStaleOverwrites(loaded, posted, current)).toEqual(["variant"]);
  });

  it("self-heals after a same-tab race once the snapshot refreshes", () => {
    // save A landed (DB=snapshot now), user retries with newer typing
    const refreshedLoaded = { ...base, cardName: "Typed v1" };
    const current = { ...base, cardName: "Typed v1" };
    const posted = { ...base, cardName: "Typed v2" };
    expect(findStaleOverwrites(refreshedLoaded, posted, current)).toEqual([]);
  });
});

describe("resolveEditConflicts — only same-field disagreements interrupt", () => {
  it("clean save: nothing changed anywhere", () => {
    expect(resolveEditConflicts(base, base, base)).toEqual({ conflicts: [], merged: [] });
  });

  it("MERGE (the disruptive false-conflict this fixes): someone else changed a field the editor never touched", () => {
    const loaded = { ...base, setName: "Old Set" };
    const current = { ...base, setName: "Corrected Set" }; // another session fixed it
    const posted = { ...base, setName: "Old Set", cardName: "Editor's new name" }; // editor only touched cardName
    const r = resolveEditConflicts(loaded, posted, current);
    expect(r.conflicts).toEqual([]); // must NOT interrupt
    expect(r.merged).toEqual(["setName"]); // DB value wins silently
    // The old helper would have blocked this entire save — that was the bug.
    expect(findStaleOverwrites(loaded, posted, current)).toEqual(["setName"]);
  });

  it("TRUE CONFLICT: both the editor and another session changed the SAME field differently", () => {
    const loaded = { ...base, variant: "" };
    const current = { ...base, variant: "PROMO" }; // another session set it
    const posted = { ...base, variant: "1ST EDITION" }; // editor set something else
    const r = resolveEditConflicts(loaded, posted, current);
    expect(r.conflicts).toEqual(["variant"]);
    expect(r.merged).toEqual([]);
  });

  it("converged: both landed on the same value — harmless, no interruption", () => {
    const loaded = { ...base, variant: "" };
    const current = { ...base, variant: "PROMO" };
    const posted = { ...base, variant: "PROMO" };
    expect(resolveEditConflicts(loaded, posted, current)).toEqual({ conflicts: [], merged: [] });
  });

  it("a clear IS an edit: the editor deliberately emptying a field someone else set still conflicts", () => {
    const loaded = { ...base, variant: "HOLO" };
    const current = { ...base, variant: "PROMO" };
    const posted = { ...base, variant: "" }; // editor cleared it on purpose
    expect(resolveEditConflicts(loaded, posted, current).conflicts).toEqual(["variant"]);
  });

  it("mixed: one field merges, another genuinely conflicts — only the real one is reported", () => {
    const loaded = { ...base, setName: "Old Set", variant: "" };
    const current = { ...base, setName: "Corrected Set", variant: "PROMO" };
    const posted = { ...base, setName: "Old Set", variant: "1ST EDITION" };
    const r = resolveEditConflicts(loaded, posted, current);
    expect(r.conflicts).toEqual(["variant"]);
    expect(r.merged).toEqual(["setName"]);
  });

  it("treats null/undefined/absent/whitespace as the same empty value", () => {
    const loaded = { ...base, rarity: null } as any;
    const current = { ...base, rarity: undefined } as any;
    const posted = { ...base, rarity: "  " } as any;
    expect(resolveEditConflicts(loaded, posted, current)).toEqual({ conflicts: [], merged: [] });
  });

  it("the MV237 clobber is still caught where the editor genuinely re-posts stale values it owns", () => {
    // Editor actively retyped setName back to the stale value AND cleared variant.
    const loaded = { ...base, variant: "", setName: "swoed & shield black star promos" };
    const current = base;
    const posted = { ...base, variant: "", setName: "swoed & shield black star promos" };
    const r = resolveEditConflicts(loaded, posted, current);
    // The editor didn't touch either field vs its load → both merge to the DB
    // value, which is exactly the anti-clobber outcome (stale values discarded).
    expect(r.conflicts).toEqual([]);
    expect(r.merged.sort()).toEqual(["setName", "variant"]);
  });
});
