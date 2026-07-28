import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupCard } from "../server/services/tcgdex";
import {
  finishByValue,
  isLowerInformationRarityChange,
  languageLabel,
  normalizePokemonLanguage,
  rarityByValue,
  tcgdexLanguageCode,
} from "../shared/pokemon-rarity-catalogue";
import { GradeDraftValidationError, validateGradeDraftIdentityAndVariant } from "../shared/grading-draft-validation";
import { formatVariantLine } from "../shared/variant-line";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const localizedSet: Record<string, string> = {
  en: "Chilling Reign",
  es: "Reinado Escalofriante",
  fr: "Règne de Glace",
  de: "Schaurige Herrschaft",
  it: "Regno Glaciale",
  pt: "Reinado Arrepiante",
};

function mockTcgdex({ variants = { holo: true, normal: false, reverse: false } }: { variants?: Record<string, boolean> } = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      const match = url.match(/\/v2\/([^/]+)\/sets\/swsh6$/);
      if (match) {
        const lang = decodeURIComponent(match[1]);
        return jsonResponse(200, {
          id: "swsh6",
          name: localizedSet[lang] ?? localizedSet.en,
          serie: { id: "swsh", name: lang === "en" ? "Sword & Shield" : "Sword & Shield Local" },
          releaseDate: "2021-06-18",
          cardCount: { official: 198, total: 233 },
          tcgOnline: "CRE",
          abbreviation: { official: "CRE" },
        });
      }
      if (url.endsWith("/cards/swsh6-045")) return jsonResponse(404, {});
      if (url.includes("/cards/swsh6-45")) {
        const lang = decodeURIComponent(url.match(/\/v2\/([^/]+)\/cards\//)?.[1] ?? "en");
        return jsonResponse(200, {
          id: "swsh6-45",
          localId: "45",
          name: lang === "es" ? "Calyrex Jinete Glacial V" : "Ice Rider Calyrex V",
          set: { id: "swsh6", name: localizedSet[lang] ?? localizedSet.en, cardCount: { official: 198, total: 233 } },
          rarity: lang === "es" ? "Holo Rara V" : "Holo Rare V",
          variants,
        });
      }
      return jsonResponse(404, {});
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MV700 TCGdex identification regression", () => {
  it("maps Spanish CRE / 045 to canonical Chilling Reign, CRE, Holo Rare V and Holo finish", async () => {
    const calls = mockTcgdex();
    const result = await lookupCard("CRE", "045/198", "es");

    expect(result).toMatchObject({
      card_name: "Calyrex Jinete Glacial V",
      card_name_local: "Calyrex Jinete Glacial V",
      set_id: "swsh6",
      canonical_set_id: "swsh6",
      set_name: "Chilling Reign",
      set_name_local: "Reinado Escalofriante",
      set_code: "CRE",
      canonical_mapping_status: "mapped",
      canonical_mapping_unresolved: false,
      release_date: "2021-06-18",
      total_cards: 198,
      external_card_id: "swsh6-45",
      rarity: "Holo Rara V",
      rarity_code: "holo_rare_v",
      rarity_label: "Holo Rare V",
      finish_variant: "holo",
      resolved_lang: "es",
    });
    expect(calls.some((url) => url.endsWith("/es/cards/swsh6-045"))).toBe(true);
    expect(calls.some((url) => url.endsWith("/es/cards/swsh6-45"))).toBe(true);
  });

  it.each(["en", "es", "fr", "de", "it", "pt"])("%s editions resolve to the same canonical catalogue set", async (lang) => {
    mockTcgdex();
    const result = await lookupCard("CRE", "045/198", lang);
    expect(result?.canonical_set_id).toBe("swsh6");
    expect(result?.set_name).toBe("Chilling Reign");
    expect(result?.set_code).toBe("CRE");
  });

  it("unresolved non-English canonical mapping stays usable and visibly marked", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/ja/sets")) return jsonResponse(200, [{ id: "sv5K", name: "ワイルドフォース" }]);
        if (url.endsWith("/ja/sets/sv5K")) {
          return jsonResponse(200, {
            id: "sv5K",
            name: "ワイルドフォース",
            serie: { id: "SV", name: "スカーレット&バイオレット" },
            cardCount: { official: 71, total: 100 },
          });
        }
        if (url.endsWith("/en/sets/sv5K")) return jsonResponse(404, {});
        if (url.endsWith("/ja/cards/sv5K-075")) {
          return jsonResponse(200, { id: "sv5K-075", localId: "075", name: "テストex", rarity: "RR", variants: { normal: true } });
        }
        return jsonResponse(404, {});
      }),
    );

    const result = await lookupCard("sv5K", "075", "ja");
    expect(result?.set_name).toBe("Wild Force");
    expect(result?.set_name_local).toBe("ワイルドフォース");
    expect(result?.canonical_mapping_status).toBe("unresolved");
    expect(result?.canonical_mapping_unresolved).toBe(true);
  });
});

describe("MV700 language, rarity and finish precedence", () => {
  it("shared language registry normalises TCGdex and UI values", () => {
    expect(normalizePokemonLanguage("es")?.label).toBe("Spanish");
    expect(languageLabel("Spanish")).toBe("Spanish");
    expect(tcgdexLanguageCode("Traditional Chinese")).toBe("zh-tw");
  });

  it("Holo Rare V remains higher-information than a printed single-silver-star symbol", () => {
    expect(rarityByValue("holo_rare_v")?.label).toBe("Holo Rare V");
    expect(rarityByValue("holo_rare_v")?.symbol).toMatchObject({ colour: "silver", count: 1 });
    expect(isLowerInformationRarityChange("holo_rare_v", "silver_star_rare")).toBe(true);
    expect(formatVariantLine({ rarityCode: "holo_rare_v", finishVariant: "holo" })).toBe("Holo Rare V · Holo");
  });

  it("server-side validation blocks unconfirmed lower-information rarity downgrades", () => {
    expect(() =>
      validateGradeDraftIdentityAndVariant(
        { language: "Spanish", rarityCode: "holo_rare_v", finishVariant: "holo", promoType: null },
        { rarity_code: "silver_star_rare", language: "Spanish" },
      ),
    ).toThrow(GradeDraftValidationError);
    expect(
      validateGradeDraftIdentityAndVariant(
        { language: "Spanish", rarityCode: "holo_rare_v", finishVariant: "holo", promoType: null },
        { rarity_code: "silver_star_rare", language: "es", rarity_override_confirmed: true },
      ),
    ).toMatchObject({ nextLanguage: "Spanish", nextRarityCode: "silver_star_rare" });
  });

  it("server-side validation rejects unsupported certificate languages", () => {
    expect(() =>
      validateGradeDraftIdentityAndVariant({ language: "English", rarityCode: "rare" }, { language: "Klingon" }),
    ).toThrow(/Unsupported language/);
  });

  it("generic Rare is still available for genuinely plain Rare cards", () => {
    expect(rarityByValue("rare")?.label).toBe("Rare");
    expect(isLowerInformationRarityChange(null, "rare")).toBe(false);
  });

  it("finish proposal is only inferred when provider print availability is unambiguous", async () => {
    mockTcgdex({ variants: { normal: true, reverse: true } });
    await expect(lookupCard("CRE", "045/198", "en")).resolves.toMatchObject({ finish_variant: null });

    vi.unstubAllGlobals();
    mockTcgdex({ variants: { normal: true, reverse: false, holo: false } });
    await expect(lookupCard("CRE", "045/198", "en")).resolves.toMatchObject({ finish_variant: "non_holo" });
  }, 15_000);

  it("proposal finish labels render the actual finish value", () => {
    expect(finishByValue("holo")?.label).toBe("Holo");
    expect(finishByValue("reverse_holo")?.label).toBe("Reverse Holo");
    expect(finishByValue("non_holo")?.label).toBe("Non-Holo");
  });
});
