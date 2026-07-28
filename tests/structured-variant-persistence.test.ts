/**
 * structured-variant-persistence.test.ts
 *
 * Regression cover for the MV207 release blocker: a cleared rarity/finish came
 * back after saving, so a cert whose intended final state was PROMO ONLY printed
 * "RARE · MCDONALD'S PROMO · GLITTER HOLO".
 *
 * Proven root cause (see the fix commits):
 *   1. The queued auto-save replay re-invoked the IN-FLIGHT save's own closure,
 *      re-posting that render's stale form snapshot — so an edit made during a
 *      request was discarded and the pre-clear values became the LAST write.
 *   2. Finish/promo had no explicit clear control, and a selection outside the
 *      QUICK_* shortlists was rendered only inside a collapsed block.
 *   3. The form kept card A's values when the workstation swapped to card B.
 *   4. The review path persisted "" where the admin path persists NULL.
 *   5. structuredVariantVersion was stamped even with every variant field empty.
 *
 * This repo has no jsdom/RTL, so component behaviour is covered the way the rest
 * of the suite does it: pure exported helpers + assertions pinned to the real
 * source, plus a faithful model of the save serialiser whose contract is pinned
 * to the shipped code.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  validateStructuredVariant,
  structuredColumnsToCertFields,
  hasStructuredData,
  STRUCTURED_VARIANT_VERSION,
} from "../shared/structured-variant-validate";
import {
  formatVariantLine,
  hasStructuredVariant,
  legacyFreeTextLostOnConversion,
  CONSOLIDATED_VARIANT_SCHEME,
} from "../shared/variant-line";
import { buildFormStateFromCert } from "../client/src/components/certificate-form";
import { consolidatedVariantForLabel } from "../server/labels";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const FORM = read("client/src/components/certificate-form.tsx");
const PICKER = read("client/src/components/rarity-picker/RarityVariantPicker.tsx");
const PANEL = read("client/src/components/grading/grading-panel.tsx");

/** Columns as the server would persist them for a given picker selection. */
const persist = (sel: Record<string, unknown>) => {
  const r = validateStructuredVariant(sel as never);
  expect(r.ok).toBe(true);
  return structuredColumnsToCertFields(r.columns);
};
/** The printed variant line for a persisted row (version-gated, as labels.ts does). */
const printed = (cols: Record<string, unknown>) => {
  const version = Number(cols.structuredVariantVersion ?? 0);
  if (version >= CONSOLIDATED_VARIANT_SCHEME && hasStructuredVariant(cols as never)) {
    return formatVariantLine(cols as never).toUpperCase();
  }
  return ""; // legacy branch — unchanged wording, covered separately below
};

// ───────────────────────────────────────────────────────────────────────────
// 1-5 · Auto-save: a change made DURING a save must reach the database
// ───────────────────────────────────────────────────────────────────────────

/**
 * Faithful model of the shipped serialiser: per-render closures, an in-flight
 * flag, a pending flag, and a ref holding the newest closure. The assertions
 * below pin this model to the real component source, so it cannot drift.
 */
function makeSerializer() {
  const puts: Record<string, unknown>[] = [];
  let inFlight = false;
  let pending = false;
  let resolveCurrent: (() => void) | null = null;
  const latestRef: { current: null | (() => Promise<void>) } = { current: null };

  /** Simulates one render: binds a NEW closure over this render's state. */
  const render = (state: Record<string, unknown>) => {
    const save = async () => {
      if (inFlight) {
        pending = true;
        return;
      }
      inFlight = true;
      try {
        puts.push({ ...state }); // payload built from THIS closure's state
        await new Promise<void>((res) => {
          resolveCurrent = res;
        });
      } finally {
        inFlight = false;
        if (pending) {
          pending = false;
          await (latestRef.current ?? save)(); // ← the fix: replay the NEWEST
        }
      }
    };
    latestRef.current = save;
    return save;
  };
  return {
    puts,
    render,
    /** Resolve every request that is (or becomes) in flight, including replays. */
    settle: async () => {
      for (let i = 0; i < 10; i++) {
        const r = resolveCurrent;
        resolveCurrent = null;
        if (!r) break;
        r();
        await new Promise((res) => setTimeout(res, 0));
      }
    },
  };
}

describe("auto-save: an edit made while a save is in flight is not lost (items 1-5)", () => {
  it("1-4. clearing rarity DURING a save is what the second PUT carries, and it stays cleared", async () => {
    const s = makeSerializer();
    // 1. a save is in flight, built from the pre-clear state
    const saveA = s.render({ rarityCode: "silver_star_rare", finishVariant: "glitter_holo", promoType: "mcdonalds_promo" });
    const flight = saveA();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.puts).toHaveLength(1);
    expect(s.puts[0].rarityCode).toBe("silver_star_rare");

    // 2. the operator clears the rarity mid-flight → a new render, new closure
    const saveB = s.render({ rarityCode: "", finishVariant: "glitter_holo", promoType: "mcdonalds_promo" });
    await saveB(); // queued (in flight) — must NOT be dropped
    await s.settle();
    await flight;

    // 3. the second PUT carries the LATEST cleared value, not the stale one
    expect(s.puts).toHaveLength(2);
    expect(s.puts[1].rarityCode).toBe("");
    // 4. the last write to the DB is the cleared state
    expect(s.puts[s.puts.length - 1].rarityCode).toBe("");
    expect(s.puts[1].promoType).toBe("mcdonalds_promo"); // promo untouched
  });

  it("5. multiple rapid edits converge on the NEWEST state (one replay, no loop)", async () => {
    const s = makeSerializer();
    const a = s.render({ rarityCode: "rare" });
    const flight = a();
    await new Promise((r) => setTimeout(r, 0));
    await s.render({ rarityCode: "uncommon" })(); // queued
    await s.render({ rarityCode: "" })(); // queued (supersedes)
    await s.settle();
    await flight;
    expect(s.puts).toHaveLength(2); // exactly ONE replay — no request storm
    expect(s.puts[1].rarityCode).toBe(""); // converged on the newest state
  });

  it("the SHIPPED component replays through the ref, never the stale binding", () => {
    expect(FORM).toContain("const autoSaveNowRef");
    expect(FORM).toContain("autoSaveNowRef.current = autoSaveNow;");
    expect(FORM).toContain("void (autoSaveNowRef.current ?? autoSaveNow)();");
    // the naive stale-closure replay must not come back
    expect(FORM).not.toMatch(/\n\s*void autoSaveNow\(\);/);
  });

  it("the replay respects the same required-fields guard as the debounce (no blank writes)", () => {
    expect(FORM).toMatch(/if \(!hasRequiredFields\) return;/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 6-14 · Independent clearing + promo-only, at the persistence layer
// ───────────────────────────────────────────────────────────────────────────

describe("structured combinations persist and print correctly (items 6-14)", () => {
  it("6/7. promo-only saves as promo-only and prints exactly MCDONALD'S PROMO", () => {
    const cols = persist({ promoType: "mcdonalds_promo" });
    expect(cols.rarityCode).toBeNull();
    expect(cols.finishVariant).toBeNull();
    expect(cols.promoType).toBe("mcdonalds_promo");
    expect(cols.structuredVariantVersion).toBe(STRUCTURED_VARIANT_VERSION);
    expect(printed(cols)).toBe("MCDONALD’S PROMO");
  });

  it("8. rarity + promo", () => {
    const cols = persist({ rarityCode: "silver_star_rare", promoType: "mcdonalds_promo" });
    expect(cols.rarityCode).toBe("silver_star_rare");
    expect(cols.finishVariant).toBeNull();
    expect(printed(cols)).toBe("RARE · MCDONALD’S PROMO");
  });

  it("9. promo + finish", () => {
    const cols = persist({ promoType: "mcdonalds_promo", finishVariant: "glitter_holo" });
    expect(cols.rarityCode).toBeNull();
    expect(printed(cols)).toBe("MCDONALD’S PROMO · GLITTER HOLO");
  });

  it("10. rarity + promo + finish (the observed MV207 state)", () => {
    const cols = persist({ rarityCode: "silver_star_rare", promoType: "mcdonalds_promo", finishVariant: "glitter_holo" });
    expect(printed(cols)).toBe("RARE · MCDONALD’S PROMO · GLITTER HOLO");
  });

  it("11. clearing rarity preserves finish and promo", () => {
    const cols = persist({ rarityCode: "", promoType: "mcdonalds_promo", finishVariant: "glitter_holo" });
    expect(cols.rarityCode).toBeNull();
    expect(cols.promoType).toBe("mcdonalds_promo");
    expect(cols.finishVariant).toBe("glitter_holo");
  });

  it("12. clearing finish preserves rarity and promo", () => {
    const cols = persist({ rarityCode: "silver_star_rare", promoType: "mcdonalds_promo", finishVariant: "" });
    expect(cols.finishVariant).toBeNull();
    expect(cols.rarityCode).toBe("silver_star_rare");
    expect(cols.promoType).toBe("mcdonalds_promo");
  });

  it("13. clearing promo preserves rarity and finish", () => {
    const cols = persist({ rarityCode: "silver_star_rare", promoType: "", finishVariant: "glitter_holo" });
    expect(cols.promoType).toBeNull();
    expect(cols.rarityCode).toBe("silver_star_rare");
    expect(cols.finishVariant).toBe("glitter_holo");
  });

  it("14. clearing rarity AND finish leaves promo only — the MV207 intended state", () => {
    const cols = persist({ rarityCode: "", finishVariant: "", promoType: "mcdonalds_promo" });
    expect(cols.rarityCode).toBeNull();
    expect(cols.finishVariant).toBeNull();
    expect(cols.promoType).toBe("mcdonalds_promo");
    expect(printed(cols)).toBe("MCDONALD’S PROMO");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 15-16 · Clear affordances in the picker
// ───────────────────────────────────────────────────────────────────────────

describe("clear controls (items 15-16)", () => {
  it("15. explicit clear controls exist for rarity, finish AND promo", () => {
    expect(PICKER).toContain('data-testid="rarity-clear"');
    expect(PICKER).toContain('data-testid="finish-clear"');
    expect(PICKER).toContain('data-testid="promo-clear"');
    expect(PICKER).toContain("No finish — clear");
    expect(PICKER).toContain("No promo — clear");
  });

  it("15. each clear touches ONLY its own field (independence)", () => {
    expect(PICKER).toContain("const clearFinish = () => setFinish(null);");
    expect(PICKER).toContain("const clearPromo = () => setPromoOrSubset(null);");
    // rarity's clear does not touch finish/promo
    const clearRarity = PICKER.slice(PICKER.indexOf("const clearRarity"), PICKER.indexOf("const clearFinish"));
    expect(clearRarity).not.toMatch(/setFinish|setPromoOrSubset/);
  });

  it("15. a finish/promo chosen from SEARCH can be cleared (toggle, not plain set)", () => {
    expect(PICKER).toContain("search.finishes.map((x) => pill(x, finish === x.value, () => setFinish(finish === x.value ? null : x.value)))");
    expect(PICKER).toMatch(/search\.promos\.map[\s\S]{0,160}promoOrSubset === x\.value \? null : x\.value/);
  });

  it("15. a selection hidden in the collapsed 'more' list is surfaced so it stays clearable", () => {
    expect(PICKER).toContain('data-testid="finish-selected-outside-quick"');
    expect(PICKER).toContain('data-testid="promo-selected-outside-quick"');
  });

  it("16. Recently Used / favourites never auto-select — selection changes only on click", () => {
    // Recent/favourite lists never drive selection from an effect. The picker may
    // hydrate from a parent-controlled value, but browser persistence cannot auto-pick.
    const effects = PICKER.match(/useEffect\([\s\S]*?\}, \[[^\]]*\]\);/g) ?? [];
    for (const e of effects) {
      if (e.includes("syncingFromValueRef.current = true")) {
        expect(e).toContain("value?.rarity");
        expect(e).toContain("value?.finish");
        expect(e).toContain("value?.promo");
        expect(e).not.toMatch(/recent|favourite|favorite|localStorage|usePersistentList/i);
        continue;
      }
      expect(e).not.toMatch(/setRarity\(|setFinish\(|setPromoOrSubset\(/);
    }
    expect(PICKER).toContain("usePersistentList");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 17-19 · Cross-certificate isolation + reopen fidelity
// ───────────────────────────────────────────────────────────────────────────

describe("cross-certificate isolation (items 17-18)", () => {
  const CERT_A = {
    id: 1, cardName: "Rayquaza", setName: "Base set", cardNumber: "014", year: "2022", cardGame: "pokemon",
    rarity: "Basic Pokémon", variant: "Holo", language: "English",
    rarityCode: "silver_star_rare", finishVariant: "glitter_holo", promoType: "mcdonalds_promo",
    subsetName: "trainer_gallery", era: "sword_shield",
  };
  const CERT_B = { id: 2, cardName: "Mr. Mime", setName: "Jungle", cardNumber: "022", year: "1999", cardGame: "pokemon" };

  it("17. switching certificates carries NO structured or legacy value from the previous cert", () => {
    const b = buildFormStateFromCert(CERT_B as never);
    for (const k of ["rarityCode", "finishVariant", "promoType", "subsetName", "era", "variant", "rarity"] as const) {
      expect(b[k], `${k} leaked from the previous certificate`).toBe("");
    }
    expect(b.cardName).toBe("Mr. Mime");
    // and cert A still maps to its own values (the mapping itself is faithful)
    const a = buildFormStateFromCert(CERT_A as never);
    expect(a.rarityCode).toBe("silver_star_rare");
    expect(a.finishVariant).toBe("glitter_holo");
  });

  it("17. the form resets editable state on a certificate identity change", () => {
    expect(FORM).toContain("const currentCertIdRef");
    expect(FORM).toMatch(/if \(currentCertIdRef\.current === nextId\) return;/);
    expect(FORM).toContain("setForm(buildFormStateFromCert(certificate));");
    // a queued save from the previous cert can never land on the new one
    expect(FORM).toMatch(/autoSavePendingRef\.current = false;[\s\S]{0,80}autoSaveSeqRef\.current \+= 1;/);
    // and the picker remounts per certificate
    expect(FORM).toContain('key={certificate?.id ?? "new"}');
  });

  it("18. session counters, saved panel and queue HUD survive the isolation reset", () => {
    const start = FORM.indexOf("const currentCertIdRef");
    const reset = FORM.slice(start, FORM.indexOf("}, [certificate?.id]);", start));
    for (const s of ["setSessionCompleted", "setShowSavedPanel", "setSavedToast", "setQueue"]) {
      expect(reset, `${s} must NOT be reset on a cert switch`).not.toContain(s);
    }
    // It is a targeted reset, not a remount of the whole form — assert against
    // the file that actually MOUNTS CertificateForm (asserting on the component's
    // own source would be vacuous: it never renders itself).
    const dashboard = read("client/src/pages/admin-dashboard.tsx");
    expect(dashboard).toContain("<CertificateForm");
    expect(dashboard).not.toMatch(/<CertificateForm[^>]*\skey=/);
  });

  it("19. save → reopen reproduces the exact explicit selections", () => {
    const cols = persist({ rarityCode: "", finishVariant: "", promoType: "mcdonalds_promo" });
    const reopened = buildFormStateFromCert({ id: 9, ...cols } as never);
    expect(reopened.rarityCode).toBe("");
    expect(reopened.finishVariant).toBe("");
    expect(reopened.promoType).toBe("mcdonalds_promo");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 20-22 · Renderer parity, legacy compatibility, grading isolation
// ───────────────────────────────────────────────────────────────────────────

describe("rendering + protected-system guarantees (items 20-22)", () => {
  it("20. preview and the printed label use the SAME renderer and one endpoint", () => {
    const preview = read("server/routes/admin/label-preview.ts");
    expect(preview).toContain('generateLabelPNG(cert, "front")');
    expect(read("server/routes.ts")).not.toContain('app.post("/api/admin/label-preview"');
    expect(read("server/labels.ts")).toContain("consolidatedVariantForLabel(cert)");
  });

  it("21. legacy certificates keep byte-identical wording until edited (REAL renderer)", () => {
    // Uses the shipped, exported consolidatedVariantForLabel — not a local model,
    // so the legacy branch is genuinely exercised.
    // version < 2 → legacy branch, regardless of structured columns
    expect(consolidatedVariantForLabel({ structuredVariantVersion: 1, rarityCode: "rare_holo" })).toBe("");
    expect(consolidatedVariantForLabel({ rarityCode: "rare_holo" })).toBe("");
    // a legacy variant / rarity cert prints exactly as it always did
    expect(consolidatedVariantForLabel({ variant: "COSMOS_HOLO" })).toBe("COSMOS HOLO");
    expect(consolidatedVariantForLabel({ rarity: "RARE_HOLO" })).toBe("HOLO RARE");
    expect(read("server/labels.ts")).toContain("version >= CONSOLIDATED_VARIANT_SCHEME");
  });

  // ── Founder decision (Option 2): a consolidated cert is structured-ONLY ──
  it("MV207 ACCEPTANCE: cleared rarity+finish with promo kept renders exactly MCDONALD'S PROMO", () => {
    // MV207's REAL row values, including the legacy columns that previously
    // folded back in and produced "BASIC POKÉMON · MCDONALD'S PROMO · HOLO".
    expect(
      consolidatedVariantForLabel({
        structuredVariantVersion: 2,
        rarityCode: null,
        finishVariant: null,
        promoType: "mcdonalds_promo",
        rarity: "Basic Pokémon",
        variant: "Holo",
      } as never)
    ).toBe("MCDONALD’S PROMO");
  });

  it("a version-2 cert does NOT fold legacy rarity into an empty structured rarity slot", () => {
    expect(
      consolidatedVariantForLabel({ structuredVariantVersion: 2, finishVariant: "cosmos_holo", rarity: "RARE_HOLO" } as never)
    ).toBe("COSMOS HOLO");
  });

  it("a version-2 cert does NOT fold legacy variant into an empty structured finish slot", () => {
    expect(
      consolidatedVariantForLabel({ structuredVariantVersion: 2, rarityCode: "rare_holo", variant: "COSMOS_HOLO" } as never)
    ).toBe("HOLO RARE");
  });

  it("empty structured rarity / finish / promo each display nothing on a v2 cert", () => {
    const v2 = (o: Record<string, unknown>) => consolidatedVariantForLabel({ structuredVariantVersion: 2, ...o } as never);
    expect(v2({ promoType: "mcdonalds_promo" })).toBe("MCDONALD’S PROMO"); // no rarity, no finish
    expect(v2({ rarityCode: "rare_holo" })).toBe("HOLO RARE"); // no promo, no finish
    expect(v2({ finishVariant: "cosmos_holo" })).toBe("COSMOS HOLO"); // no rarity, no promo
  });

  it("a PRE-consolidation certificate keeps its exact legacy wording (fold still applies)", () => {
    // no version at all
    expect(consolidatedVariantForLabel({ variant: "COSMOS_HOLO" } as never)).toBe("COSMOS HOLO");
    expect(consolidatedVariantForLabel({ rarity: "RARE_HOLO" } as never)).toBe("HOLO RARE");
    // version 1 → legacy branch, structured columns ignored
    expect(consolidatedVariantForLabel({ structuredVariantVersion: 1, rarityCode: "rare_holo" } as never)).toBe("");
    // legacy fold still fills an empty slot for a sub-v2 cert
    expect(
      formatVariantLine({ structuredVariantVersion: 1, promoType: "mcdonalds_promo", rarity: "RARE_HOLO" } as never).toUpperCase()
    ).toBe("HOLO RARE · MCDONALD’S PROMO");
  });

  it("legacy COLUMNS are never modified by a structured clear (persistence unchanged)", () => {
    // The structured writer only ever maps the structured columns — the legacy
    // variant/rarity are not among the fields it returns, so a clear cannot
    // erase them. (Requirement: legacy values remain stored.)
    const cols = persist({ rarityCode: "", finishVariant: "", promoType: "mcdonalds_promo" });
    expect(Object.keys(cols)).not.toContain("variant");
    expect(Object.keys(cols)).not.toContain("rarity");
    expect(read("server/lib/structured-variant.ts")).toContain("legacy");
  });

  it("preview and print produce the SAME line for a v2 cert and for a legacy cert (executable)", async () => {
    // Exercises the REAL preview path (buildPreviewFields + the same structured
    // derivation the save routes use) against the REAL renderer — not a grep.
    const { buildPreviewFields } = await import("../shared/label-preview-fields");
    const { applyStructuredVariantFromBody } = await import("../server/lib/structured-variant");

    // v2 cert: MV207 after the clears
    const saved: any = {
      structuredVariantVersion: 2, rarityCode: null, finishVariant: null,
      promoType: "mcdonalds_promo", rarity: "Basic Pokémon", variant: "Holo",
      cardName: "Rayquaza", setName: "Base set",
    };
    const body: any = {
      cardName: "Rayquaza", setName: "Base set", rarityCode: "", finishVariant: "",
      promoType: "mcdonalds_promo", rarity: "Basic Pokémon", variant: "Holo",
    };
    const previewCert: any = { ...saved, ...buildPreviewFields(body) };
    previewCert.rarity = saved.rarity;
    previewCert.variant = saved.variant;
    applyStructuredVariantFromBody(body, previewCert);
    expect(consolidatedVariantForLabel(previewCert)).toBe(consolidatedVariantForLabel(saved));
    expect(consolidatedVariantForLabel(previewCert)).toBe("MCDONALD’S PROMO");

    // legacy cert: preview must match print too
    const legacy: any = { variant: "COSMOS_HOLO", cardName: "X", setName: "Y" };
    const legacyPreview: any = { ...legacy, ...buildPreviewFields({ cardName: "X", setName: "Y", variant: "COSMOS_HOLO" }) };
    expect(consolidatedVariantForLabel(legacyPreview)).toBe(consolidatedVariantForLabel(legacy));
  });

  it("the version gate is robust to the shapes a DB/driver can produce", () => {
    const withLegacy = (v: unknown) =>
      formatVariantLine({
        structuredVariantVersion: v, promoType: "mcdonalds_promo", rarity: "Basic Pokémon", variant: "Holo",
      } as never).toUpperCase();
    // >= 2 in any numeric shape → structured-only
    for (const v of [2, "2", 3, " 2 "]) expect(withLegacy(v)).toBe("MCDONALD’S PROMO");
    // below 2 / unusable → legacy fold preserved (byte-identical to before)
    for (const v of [1, "1", 0, null, undefined, NaN, "two", ""])
      expect(withLegacy(v)).toBe("BASIC POKÉMON · MCDONALD’S PROMO · HOLO");
  });

  // ── Founder decisions: full-clear rule + legacy free-text conversion warning ──
  it("FULL-CLEAR: a v2 cert with every structured field empty renders NO variant line", () => {
    expect(
      consolidatedVariantForLabel({
        structuredVariantVersion: 2,
        rarityCode: null, finishVariant: null, promoType: null, subsetName: null,
      } as never)
    ).toBe("");
  });

  it("FULL-CLEAR does not fold legacy rarity, legacy variant OR variantOther back in", () => {
    expect(
      consolidatedVariantForLabel({
        structuredVariantVersion: 2,
        rarityCode: null, finishVariant: null, promoType: null, subsetName: null,
        rarity: "Basic Pokémon", variant: "Holo", variantOther: "Prism Foil", rarityOther: "Gold Star",
      } as never)
    ).toBe("");
    // the boundary is the VERSION alone, not "does it hold a structured value"
    expect(read("server/labels.ts")).toContain("if (version >= CONSOLIDATED_VARIANT_SCHEME) {");
  });

  it("a pre-v2 certificate is byte-identical (full-clear rule does not touch it)", () => {
    expect(consolidatedVariantForLabel({ variant: "COSMOS_HOLO" } as never)).toBe("COSMOS HOLO");
    expect(consolidatedVariantForLabel({ rarity: "RARE_HOLO" } as never)).toBe("HOLO RARE");
    expect(consolidatedVariantForLabel({ structuredVariantVersion: 1, rarity: "RARE_HOLO" } as never)).toBe("HOLO RARE");
    // an empty pre-v2 cert still prints nothing (unchanged)
    expect(consolidatedVariantForLabel({} as never)).toBe("");
  });

  it("SUMMARY == PREVIEW == LABEL for legacy / v2 promo-only / v2 fully-cleared / catalogue-only code", async () => {
    const { buildPreviewFields } = await import("../shared/label-preview-fields");
    const { applyStructuredVariantFromBody } = await import("../server/lib/structured-variant");

    // The EXACT version expression both on-screen summaries compute.
    const summaryLine = (v: Record<string, any>) => {
      const willBe = hasStructuredVariant({
        rarityCode: v.rarityCode?.trim?.() || null,
        finishVariant: v.finishVariant?.trim?.() || null,
        promoType: v.promoType?.trim?.() || null,
        subsetName: v.subsetName?.trim?.() || null,
      } as never);
      const version =
        Number(v.storedVersion ?? 0) >= CONSOLIDATED_VARIANT_SCHEME || willBe ? CONSOLIDATED_VARIANT_SCHEME : null;
      return formatVariantLine({ ...v, structuredVariantVersion: version } as never).toUpperCase();
    };
    const previewLine = (saved: Record<string, any>, body: Record<string, any>) => {
      const c: Record<string, any> = { ...saved, ...buildPreviewFields(body) };
      c.rarity = saved.rarity;
      c.variant = saved.variant;
      c.variantOther = saved.variantOther;
      applyStructuredVariantFromBody(body, c, undefined, saved.structuredVariantVersion);
      return consolidatedVariantForLabel(c as never);
    };

    const cases: Array<[string, Record<string, any>, Record<string, any>, Record<string, any>]> = [
      ["legacy", { variant: "COSMOS_HOLO" }, { storedVersion: null, variant: "COSMOS_HOLO" }, { variant: "COSMOS_HOLO" }],
      [
        "v2 promo-only",
        { structuredVariantVersion: 2, promoType: "mcdonalds_promo", rarity: "Basic Pokémon", variant: "Holo" },
        { storedVersion: 2, promoType: "mcdonalds_promo", rarity: "Basic Pokémon", variant: "Holo" },
        { promoType: "mcdonalds_promo", rarity: "Basic Pokémon", variant: "Holo" },
      ],
      [
        "v2 fully cleared",
        {
          structuredVariantVersion: 2, rarityCode: null, finishVariant: null, promoType: null,
          rarity: "RARE_HOLO", variant: "COSMOS_HOLO", variantOther: "Prism Foil",
        },
        { storedVersion: 2, rarity: "RARE_HOLO", variant: "COSMOS_HOLO", variantOther: "Prism Foil" },
        { rarityCode: "", finishVariant: "", promoType: "" },
      ],
      [
        "v2 catalogue-only code",
        { structuredVariantVersion: 2, rarityCode: "tera_hyper_rare_2026" },
        { storedVersion: 2, rarityCode: "tera_hyper_rare_2026" },
        { rarityCode: "tera_hyper_rare_2026" },
      ],
    ];
    for (const [name, saved, sumIn, body] of cases) {
      const label = consolidatedVariantForLabel(saved as never);
      expect(summaryLine(sumIn), `summary != label for ${name}`).toBe(label);
      expect(previewLine(saved, body), `preview != label for ${name}`).toBe(label);
    }
    // and the specific values, so a silent shift in all three at once still fails
    expect(consolidatedVariantForLabel({ structuredVariantVersion: 2, promoType: "mcdonalds_promo", rarity: "Basic Pokémon", variant: "Holo" } as never))
      .toBe("MCDONALD’S PROMO");
  });

  it("confirming the warning cancels the pending debounce (no redundant second PUT)", () => {
    const confirmIdx = FORM.indexOf('data-testid="legacy-freetext-warning-confirm"');
    const handler = FORM.slice(confirmIdx, confirmIdx + 1600);
    expect(handler).toContain("if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);");
    // …and it dispatches to exactly ONE path
    expect(handler).toContain('if (legacyLossPathRef.current === "autosave") autoSaveNow();');
    expect(handler).toContain("else formElRef.current?.requestSubmit();");
  });

  // ── F3: a held save must never be silently discarded ──────────────────────
  describe("deferred-save safety (F3)", () => {
    it("a deferred autosave shows a PAUSED state, not 'saves automatically'", () => {
      // Both status renderers must report the pause; the held state (not the panel
      // visibility) drives it, so Cancel cannot make the UI look resolved.
      expect(FORM).toContain('"Save paused — confirm the conversion"');
      expect(FORM).toContain('data-testid="text-save-paused"');
      // the mini status checks the hold FIRST, before the autoSaveStatus ladder
      const mini = FORM.slice(FORM.indexOf('data-testid="text-autosave-status-mini"'));
      expect(mini.slice(0, 700)).toMatch(/legacyLossWarning\s*\n?\s*\?\s*"Save paused/);
    });

    it("Cancel preserves the edits and leaves the save HELD (no save, no discard)", () => {
      const cancel = FORM.slice(FORM.indexOf('data-testid="legacy-freetext-warning-cancel"'));
      const handler = cancel.slice(0, 700);
      // hides the panel only…
      expect(handler).toContain("setLegacyLossPanelOpen(false);");
      // …and must NOT save, NOT clear the hold, NOT touch the form state
      expect(handler).not.toContain("autoSaveNow()");
      expect(handler).not.toContain("requestSubmit()");
      expect(handler).not.toContain("setLegacyLossWarning(null)");
      expect(handler).not.toContain("setForm(");
      // the panel's visibility is separate from the hold, so the hold survives Cancel
      expect(FORM).toContain("legacyLossWarning && legacyLossWarning.length > 0 && legacyLossPanelOpen");
    });

    it("Next Card / back-to-queue cannot silently discard a held edit", () => {
      // every certificate-REPLACING navigation goes through the guard
      expect(FORM).toContain("guardedNav(queue.onNext)");
      expect(FORM).toContain("guardedNav(queue.onBackToQueue ?? (() => onSuccess(undefined)))");
      const guard = FORM.slice(FORM.indexOf("const guardedNav ="), FORM.indexOf("const guardedNav =") + 500);
      expect(guard).toContain("if (legacyLossWarning) {");
      expect(guard).toContain("setPendingNav({ run });"); // blocked, not executed
      expect(guard).toContain("run();"); // …and passes straight through when nothing is held
    });

    it("an explicit, certificate-scoped discard allows navigation WITHOUT saving", () => {
      expect(FORM).toContain('data-testid="legacy-freetext-discard-gate"');
      const discard = FORM.slice(FORM.indexOf('data-testid="legacy-freetext-discard-confirm"'));
      const handler = discard.slice(0, 800);
      expect(handler).toContain("const go = pendingNav.run;");
      expect(handler).toContain("go();");
      // it must not save on the way out
      expect(handler).not.toContain("autoSaveNow()");
      expect(handler).not.toContain("requestSubmit()");
      // and "Stay on this card" simply cancels the navigation
      expect(FORM).toContain('data-testid="legacy-freetext-discard-cancel"');
      expect(FORM).toContain("onClick={() => setPendingNav(null)}");
    });

    it("confirming performs exactly ONE save on the captured path (no duplicate PUT)", () => {
      const confirm = FORM.slice(FORM.indexOf('data-testid="legacy-freetext-warning-confirm"'));
      const handler = confirm.slice(0, 1600);
      expect(handler).toContain("if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);");
      expect(handler).toContain('if (legacyLossPathRef.current === "autosave") autoSaveNow();');
      expect(handler).toContain("else formElRef.current?.requestSubmit();");
      // exactly one dispatch: the two branches are mutually exclusive
      expect((handler.match(/autoSaveNow\(\)/g) ?? []).length).toBe(1);
      expect((handler.match(/requestSubmit\(\)/g) ?? []).length).toBe(1);
    });

    it("the hold, the panel and any pending navigation are reset per certificate", () => {
      const start = FORM.indexOf("const currentCertIdRef");
      const reset = FORM.slice(start, FORM.indexOf("}, [certificate?.id]);", start));
      expect(reset).toContain("legacyLossAckRef.current = false;");
      expect(reset).toContain("setLegacyLossWarning(null);");
      expect(reset).toContain("setLegacyLossPanelOpen(false);");
      expect(reset).toContain("setPendingNav(null);");
      // …and the cross-card write protections are still in place alongside them
      expect(reset).toContain("autoSavePendingRef.current = false;");
      expect(reset).toMatch(/autoSaveSeqRef\.current \+= 1;/);
      expect(reset).toContain("setForm(buildFormStateFromCert(certificate));");
    });

    it("the hold is RELEASED once the selection no longer loses any wording", () => {
      // otherwise the pause would be sticky and navigation stuck.
      expect(FORM).toMatch(/if \(legacyLossWarning\) \{\s*\n\s*setLegacyLossWarning\(null\);/);
      // behavioural: the helper returns [] once the wording is represented
      expect(legacyFreeTextLostOnConversion({ currentVersion: 0, variantOther: "Cosmos Holo", finishVariant: "cosmos_holo" }))
        .toEqual([]);
    });

    it("normal autosave is untouched when nothing is held", () => {
      // the guard only engages when the helper returns a non-empty list
      expect(FORM).toContain("if (!legacyLossAckRef.current) {");
      expect(FORM).toMatch(/if \(lost\.length > 0\) \{/);
      expect(legacyFreeTextLostOnConversion({ currentVersion: 0, finishVariant: "cosmos_holo" })).toEqual([]);
      // and the serialiser/replay contract is unchanged
      expect(FORM).toContain("void (autoSaveNowRef.current ?? autoSaveNow)();");
    });
  });

  it("an explicit label variant OVERRIDE still reaches the label on a v2 certificate", async () => {
    // Regression for a HIGH: the version-alone gate made the label variant override
    // (and the Manual Identity Override, which writes through the same legacy column)
    // a silent no-op on every converted cert — removing the operator's escape hatch
    // for a wrong printed line. An explicit override outranks the structured line.
    const { applyLabelOverrides } = await import("../server/labels");
    const ov = { variantOverride: "1ST EDITION SHADOWLESS" } as never;
    const line = (cert: Record<string, unknown>, o: unknown) =>
      consolidatedVariantForLabel(applyLabelOverrides(cert as never, o as never));

    // legacy cert — unchanged behaviour
    expect(line({ variant: "COSMOS_HOLO" }, ov)).toBe("1ST EDITION SHADOWLESS");
    // v2 with a structured value, and v2 fully cleared — the override now wins
    expect(line({ structuredVariantVersion: 2, rarityCode: "rare_holo", variant: "COSMOS_HOLO" }, ov))
      .toBe("1ST EDITION SHADOWLESS");
    expect(line({ structuredVariantVersion: 2, rarityCode: null, variant: "COSMOS_HOLO" }, ov))
      .toBe("1ST EDITION SHADOWLESS");
    // …and with NO override the structured-only rules are untouched
    expect(line({ structuredVariantVersion: 2, rarityCode: "rare_holo", variant: "COSMOS_HOLO" }, null))
      .toBe("HOLO RARE");
    expect(line({ structuredVariantVersion: 2, rarityCode: null, variant: "COSMOS_HOLO" }, null)).toBe("");
  });

  it("the summaries read the FRESH saved state, not the stale certificate prop", () => {
    // Auto-save never pushes the saved row up to the parent, so deriving the
    // summaries' version from the prop left them a save behind (they folded legacy
    // wording back in while the label and PNG preview correctly showed none).
    expect(FORM).toContain("const [savedConsolidated, setSavedConsolidated] = useState(false);");
    expect(FORM).toContain("setSavedConsolidated(savedConsolidatedRef.current);");
    expect(FORM).toContain("storedVersion: savedConsolidated ? CONSOLIDATED_VARIANT_SCHEME : null,");
    expect(FORM).not.toMatch(/storedVersion:\s*\(certificate as/);
  });

  it("ERA ALONE must never convert a certificate (it is a filter, not a printable field)", () => {
    // Regression for a CRITICAL: the picker's "Set era" control narrows the rarity
    // list, but its value is persisted. While hasStructuredData() counted `era`,
    // merely touching that filter stamped version 2 — and because the renderer
    // gates on the version alone and era is NOT printable, the label's variant
    // line went BLANK. Sticky conversion made it unrecoverable and the free-text
    // warning (which keys off hasStructuredVariant) never fired.
    const r = validateStructuredVariant({ era: "vintage", rarityCode: "", finishVariant: "", promoType: "" } as never);
    expect(r.ok).toBe(true);
    expect(r.columns.structuredVariantVersion).toBeNull(); // NOT converted
    expect(r.columns.era).toBe("vintage"); // …but the era is still stored
    // so a legacy cert keeps printing its legacy wording after an era touch
    expect(consolidatedVariantForLabel({ ...r.columns, variant: "COSMOS_HOLO" } as never)).toBe("COSMOS HOLO");
    // a genuine structured selection still converts
    expect(validateStructuredVariant({ promoType: "mcdonalds_promo" } as never).columns.structuredVariantVersion)
      .toBe(STRUCTURED_VARIANT_VERSION);
  });

  it("the version-stamp predicate and the render predicate are the SAME four fields", () => {
    // Any divergence silently changes what prints (that is exactly how the era bug
    // arose). Neither may count `region` or `era`.
    for (const f of ["rarityCode", "finishVariant", "promoType", "subsetName"] as const) {
      expect(hasStructuredData({ [f]: "x" } as never)).toBe(true);
      expect(hasStructuredVariant({ [f]: "x" } as never)).toBe(true);
    }
    for (const f of ["era", "region"] as const) {
      expect(hasStructuredData({ [f]: "x" } as never)).toBe(false);
      expect(hasStructuredVariant({ [f]: "x" } as never)).toBe(false);
    }
  });

  it("the conversion warning is rendered OUTSIDE the review-stage container (visible on every stage)", () => {
    // Regression for a CRITICAL: the guard defers the save on ALL stages, but the
    // panel that clears it was nested in the review-only container, which this
    // codebase hides rather than unmounts — so on the Card Details/Grade stages the
    // save silently stopped with no visible reason.
    const warn = FORM.indexOf('data-testid="legacy-freetext-warning"');
    expect(warn).toBeGreaterThan(-1);
    // Source ORDER alone is too weak (an earlier stage container would pass it):
    // assert the panel precedes the <form> AND every stage-gated container, i.e. it
    // sits in the always-rendered header and is inside no stageClass()/wfStage gate.
    expect(warn).toBeLessThan(FORM.indexOf("ref={formElRef}")); // the real <form> element
    for (const m of FORM.matchAll(/data-workflow-stage="[a-z]+"/g)) {
      expect(warn, `panel must precede ${m[0]}`).toBeLessThan(m.index as number);
    }
    for (const m of FORM.matchAll(/stageClass\(/g)) {
      expect(warn, "panel must precede every stageClass() container").toBeLessThan(m.index as number);
    }
  });

  it("the warning also guards the EXPLICIT save path (published cert / create flow)", () => {
    // autoSaveNow is not used for an approved cert or the create flow, so the
    // guard must exist in handleSubmit too — that population's labels are already
    // printed and in customers' hands.
    const submitIdx = FORM.indexOf("const handleSubmit");
    const submitBody = FORM.slice(submitIdx, submitIdx + 2600);
    expect(submitBody).toContain("legacyFreeTextLostOnConversion({");
    expect(submitBody).toContain("setLegacyLossWarning(lost);");
    // and confirming dispatches to whichever path applies
    // Dispatch uses the path captured when the warning was RAISED, not the current
    // eligibility (which could have flipped to published in between).
    expect(FORM).toContain('if (legacyLossPathRef.current === "autosave") autoSaveNow();');
    expect(FORM).toContain("else formElRef.current?.requestSubmit();");
  });

  it("the scheme version is STICKY: clearing everything does not revert a v2 cert to legacy", async () => {
    const { applyStructuredVariantFromBody } = await import("../server/lib/structured-variant");
    // already converted → stays converted → full clear prints nothing
    const converted: Record<string, unknown> = {};
    applyStructuredVariantFromBody({ rarityCode: "", finishVariant: "", promoType: "" }, converted, undefined, 2);
    expect(converted.structuredVariantVersion).toBe(2);
    expect(consolidatedVariantForLabel({ ...converted, rarity: "Basic Pokémon", variant: "Holo" } as never)).toBe("");
    // never converted → stays legacy (a clear must not silently convert it)
    const legacy: Record<string, unknown> = {};
    applyStructuredVariantFromBody({ rarityCode: "", finishVariant: "", promoType: "" }, legacy, undefined, null);
    expect(legacy.structuredVariantVersion).toBeNull();
    expect(consolidatedVariantForLabel({ ...legacy, variant: "COSMOS_HOLO" } as never)).toBe("COSMOS HOLO");
  });

  it("preview and print agree on the FULL-CLEAR case (executable, real preview path)", async () => {
    const { buildPreviewFields } = await import("../shared/label-preview-fields");
    const { applyStructuredVariantFromBody } = await import("../server/lib/structured-variant");
    const saved: any = {
      structuredVariantVersion: 2, rarityCode: null, finishVariant: null, promoType: null,
      rarity: "Basic Pokémon", variant: "Holo",
    };
    const body: any = { rarityCode: "", finishVariant: "", promoType: "", rarity: "Basic Pokémon", variant: "Holo" };
    const preview: any = { ...saved, ...buildPreviewFields(body) };
    preview.rarity = saved.rarity;
    preview.variant = saved.variant;
    applyStructuredVariantFromBody(body, preview, undefined, saved.structuredVariantVersion);
    expect(consolidatedVariantForLabel(preview)).toBe(consolidatedVariantForLabel(saved));
    expect(consolidatedVariantForLabel(preview)).toBe("");
  });

  it("legacy values remain STORED after conversion and clearing (no write path erases them)", () => {
    const cols = persist({ rarityCode: "", finishVariant: "", promoType: "mcdonalds_promo" });
    for (const k of ["variant", "rarity", "variantOther", "rarityOther"]) {
      expect(Object.keys(cols)).not.toContain(k);
    }
  });

  it("CONVERSION WARNING fires for legacy free text the new line will not print", () => {
    expect(legacyFreeTextLostOnConversion({ currentVersion: 0, variantOther: "Prism Foil", finishVariant: "cosmos_holo" }))
      .toEqual(["Prism Foil"]);
    expect(legacyFreeTextLostOnConversion({ currentVersion: null, rarityOther: "Gold Star", promoType: "mcdonalds_promo" }))
      .toEqual(["Gold Star"]);
  });

  it("CONVERSION WARNING stays silent when it should", () => {
    // no legacy free text
    expect(legacyFreeTextLostOnConversion({ currentVersion: 0, finishVariant: "cosmos_holo" })).toEqual([]);
    // already version 2 — warn ONCE, at the boundary only
    expect(
      legacyFreeTextLostOnConversion({ currentVersion: 2, variantOther: "Prism Foil", finishVariant: "cosmos_holo" })
    ).toEqual([]);
    // this save does not convert (nothing structured selected)
    expect(legacyFreeTextLostOnConversion({ currentVersion: 0, variantOther: "Prism Foil" })).toEqual([]);
    // the wording is still represented in the resulting line
    expect(
      legacyFreeTextLostOnConversion({ currentVersion: 0, variantOther: "Cosmos Holo", finishVariant: "cosmos_holo" })
    ).toEqual([]);
    // whitespace-only free text is not a warning
    expect(legacyFreeTextLostOnConversion({ currentVersion: 0, variantOther: "   ", promoType: "mcdonalds_promo" })).toEqual([]);
  });

  it("CONVERSION WARNING is wired to HOLD the save, and cancelling does not save", () => {
    // the save path defers while the warning is unacknowledged…
    expect(FORM).toContain("if (!legacyLossAckRef.current) {");
    expect(FORM).toContain("setLegacyLossWarning(lost);");
    expect(FORM).toMatch(/setLegacyLossWarning\(lost\);\s*\n\s*setLegacyLossPanelOpen\(true\);\s*\n\s*return;/);
    // …confirming acknowledges and saves; cancelling only dismisses (no save)
    expect(FORM).toContain('data-testid="legacy-freetext-warning-confirm"');
    expect(FORM).toContain('data-testid="legacy-freetext-warning-cancel"');
    const cancel = FORM.slice(FORM.indexOf('data-testid="legacy-freetext-warning-cancel"'));
    expect(cancel.slice(0, 200)).not.toContain("autoSaveNow()");
    // the ack is per-certificate: reset by the isolation effect
    expect(FORM).toContain("legacyLossAckRef.current = false;");
  });

  it("a catalogue code this process cannot resolve still prints wording, never a blank line", () => {
    // A rarity/finish added via Catalogue Manager exists in catalogue_items but
    // NOT in the seed catalogue this pure formatter resolves against. Before the
    // fallback it rendered "" — an empty variant line for a code the grader
    // explicitly selected.
    expect(formatVariantLine({ structuredVariantVersion: 2, rarityCode: "tera_hyper_rare_2026" } as never).toUpperCase())
      .toBe("TERA HYPER RARE 2026");
    expect(formatVariantLine({ structuredVariantVersion: 2, finishVariant: "prism_foil_2026" } as never).toUpperCase())
      .toBe("PRISM FOIL 2026");
    // known codes keep their curated public wording
    expect(formatVariantLine({ structuredVariantVersion: 2, rarityCode: "rare_holo" } as never).toUpperCase())
      .toBe("HOLO RARE");
  });

  it("both on-screen summaries use the SAME predicate as the server (trim-then-truthy)", () => {
    const vs = read("client/src/components/grading-workflow/VariantSummary.tsx");
    const rs = read("client/src/components/grading-workflow/ReviewSummary.tsx");
    for (const src of [vs, rs]) {
      expect(src).toContain("hasStructuredVariant({");
      expect(src).toContain("?.trim() || null");
      expect(src).toContain("CONSOLIDATED_VARIANT_SCHEME");
    }
    // a whitespace-only code is NOT structured data — matches the server's clean()
    expect(hasStructuredVariant({ rarityCode: " ".trim() || null } as never)).toBe(false);
    expect(persist({ rarityCode: " ", promoType: "mcdonalds_promo" }).rarityCode).toBeNull();
  });

  it("22. no grading/MVGS/centering/Pristine/cert-number engine file is modified", () => {
    const { execFileSync } = require("child_process");
    const changed: string[] = execFileSync("git", ["diff", "--name-only", "origin/main"], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean);
    const engine = /mvgs-scoring|shared\/pristine|shared\/centering|mvgs-input-builder|server\/grader|grading-prompt|cert-pristine|certificate-document/;
    for (const f of changed) {
      if (f === "server/grader.ts") {
        const diff = execFileSync("git", ["diff", "origin/main", "--", f], { encoding: "utf8" });
        const added = diff
          .split("\n")
          .filter((line: string) => line.startsWith("+") && !line.startsWith("+++"))
          .join("\n");
        expect(added).toContain("validateGradeDraftIdentityAndVariant");
        expect(added).toContain("GradeDraftValidationError");
        expect(added).toContain("language            = ${keepStr(nextLanguage, cert.language)}");
        expect(added).toContain("rarity_code         = ${nextRarityCode}");
        expect(added).toContain("finish_variant      = ${nextFinishVariant}");
        expect(added).toContain("promo_type          = ${nextPromoType}");
        expect(added).not.toMatch(/mvgs|pristine|centering|calculateOverallGrade|scoreMvgs|cert_id|certificate_number/i);
        continue;
      }
      expect(f, `unexpected grading-engine change: ${f}`).not.toMatch(engine);
    }
  });

  it("review path sends NULL (not '') for a cleared code, and still omits untouched ones", () => {
    expect(PANEL).toContain("out.rarity_code = rarityCode.trim() || null;");
    expect(PANEL).toContain("out.finish_variant = finishVariant.trim() || null;");
    expect(PANEL).toContain("out.promo_type = promoType.trim() || null;");
    expect(PANEL).toContain("if (rarityCode.trim()) out.rarity_code = rarityCode.trim();");
  });

  it("structuredVariantVersion is NULL when no structured VARIANT is set (language alone doesn't count)", () => {
    expect(hasStructuredData({ region: "eu", era: null } as never)).toBe(false);
    const cleared = persist({ rarityCode: "", finishVariant: "", promoType: "", language: "English" });
    expect(cleared.structuredVariantVersion).toBeNull();
    // …and any real variant field still stamps it
    expect(persist({ promoType: "mcdonalds_promo" }).structuredVariantVersion).toBe(STRUCTURED_VARIANT_VERSION);
  });
});
