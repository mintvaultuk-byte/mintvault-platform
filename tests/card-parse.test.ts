/** Deterministic card-text parsers (pure). Tests 6/16-17/25 (collector number,
 *  set code, language, era) — the "AI second" layer that resolves facts a
 *  machine genuinely can. No provider, no DB, no network. */
import { describe, it, expect } from "vitest";
import { parseCollectorNumber, parseSetCode, parseYear, detectLanguage, eraFromRegulationMark } from "../shared/card-parse";

describe("collector number parsing (Phase 6)", () => {
  it("parses main-set numbers with totals", () => {
    expect(parseCollectorNumber("176/191")).toMatchObject({ number: "176", total: "191", subsetPrefix: null, looksLikePromo: false });
    expect(parseCollectorNumber("001/025")).toMatchObject({ number: "001", total: "025" });
  });
  it("detects Trainer Gallery / Galarian Gallery subset prefixes", () => {
    expect(parseCollectorNumber("TG12/TG30")).toMatchObject({ number: "TG12", subsetPrefix: "TG" });
    expect(parseCollectorNumber("GG35/GG70")).toMatchObject({ number: "GG35", subsetPrefix: "GG" });
  });
  it("treats a single token (no denominator) as promo-style", () => {
    expect(parseCollectorNumber("SWSH123")).toMatchObject({ number: "SWSH123", total: null, looksLikePromo: true });
    expect(parseCollectorNumber("SVP045")).toMatchObject({ number: "SVP045", looksLikePromo: true });
  });
  it("never invents data from junk", () => {
    expect(parseCollectorNumber("not a number")).toMatchObject({ number: null, total: null });
    expect(parseCollectorNumber("")).toMatchObject({ number: null });
  });
});

describe("set code + year", () => {
  it("normalises set codes and rejects non-codes", () => {
    expect(parseSetCode("SV8")).toBe("sv8");
    expect(parseSetCode("swsh12pt5")).toBe("swsh12pt5");
    expect(parseSetCode("sv2a")).toBe("sv2a");
    expect(parseSetCode("this is a long sentence not a code")).toBeNull();
  });
  it("extracts a plausible TCG year only", () => {
    expect(parseYear("©2024 Pokémon")).toBe("2024");
    expect(parseYear("1999")).toBe("1999");
    expect(parseYear("no year here")).toBeNull();
    expect(parseYear("1850")).toBeNull(); // outside TCG range
  });
});

describe("language detection (Phase 10) — never forces an unsafe guess", () => {
  it("kana → high-confidence Japanese", () => {
    expect(detectLanguage("ピカチュウ")).toMatchObject({ language: "ja", confidence: "high" });
  });
  it("hangul → Korean, Thai → Thai", () => {
    expect(detectLanguage("피카츄").language).toBe("ko");
    expect(detectLanguage("ปิกาจู").language).toBe("th");
  });
  it("Han without kana → LOW confidence, Simplified vs Traditional unresolved", () => {
    const r = detectLanguage("寶可夢");
    expect(r.language).toBeNull();
    expect(r.confidence).toBe("low");
    expect(r.alternatives).toEqual(["zh-Hans", "zh-Hant"]);
  });
  it("Latin → medium English (could be a European edition)", () => {
    const r = detectLanguage("Pikachu Basic Pokémon");
    expect(r.language).toBe("en");
    expect(r.confidence).toBe("medium");
    expect(r.alternatives).toContain("other");
  });
});

describe("regulation mark → era hint", () => {
  it("maps D/E/F to SWSH and G/H to SV", () => {
    expect(eraFromRegulationMark("F")).toBe("swsh");
    expect(eraFromRegulationMark("H")).toBe("sv");
    expect(eraFromRegulationMark("Z")).toBeNull();
  });
});
