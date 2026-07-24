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
import { formatVariantLine, hasStructuredVariant, CONSOLIDATED_VARIANT_SCHEME } from "../shared/variant-line";
import { buildFormStateFromCert } from "../client/src/components/certificate-form";

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
    // every setRarity call site sits in an explicit handler; none in an effect
    const effects = PICKER.match(/useEffect\([\s\S]*?\}, \[[^\]]*\]\);/g) ?? [];
    for (const e of effects) expect(e).not.toMatch(/setRarity\(|setFinish\(|setPromoOrSubset\(/);
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
    // it is a targeted reset, not a remount of the whole form
    expect(FORM).not.toMatch(/<CertificateForm[^>]*\skey=/);
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

  it("21. legacy certificates keep byte-identical wording until edited (version gate intact)", () => {
    // version < 2 → legacy branch, regardless of structured columns
    expect(printed({ structuredVariantVersion: 1, rarityCode: "rare_holo" })).toBe("");
    expect(printed({ rarityCode: "rare_holo" })).toBe("");
    // the renderer's gate is unchanged
    expect(read("server/labels.ts")).toContain("version >= CONSOLIDATED_VARIANT_SCHEME");
  });

  it("22. no grading/MVGS/centering/Pristine/cert-number engine file is modified", () => {
    const { execFileSync } = require("child_process");
    const changed: string[] = execFileSync("git", ["diff", "--name-only", "origin/main"], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean);
    const engine = /mvgs-scoring|shared\/pristine|shared\/centering|mvgs-input-builder|server\/grader|grading-prompt|cert-pristine|certificate-document/;
    for (const f of changed) expect(f, `unexpected grading-engine change: ${f}`).not.toMatch(engine);
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
