import { describe, it, expect } from "vitest";
import { findStaleOverwrites } from "../shared/edit-conflict";

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
