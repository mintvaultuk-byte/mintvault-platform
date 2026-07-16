/**
 * Deterministic card-text parsing — the "AI second" principle: anything that can
 * be resolved from printed text/format (collector number, set code, language
 * script) is resolved HERE, before any AI call, so the AI is only asked what a
 * machine genuinely can't derive. Pure + shared: no DOM, no network, no DB.
 *
 * These parsers turn OCR text (or a human-typed value) into structured hints the
 * Knowledge Engine can query. They NEVER invent data — an unparseable input
 * returns nulls, not a guess.
 */

// ── Collector number ──────────────────────────────────────────────────────────
export interface ParsedCollectorNumber {
  /** The local number as printed, e.g. "176", "GG35", "TG12", "SV107", "SWSH123". */
  number: string | null;
  /** The set total, e.g. "191", "GG70", "TG30" — null when not printed (promos). */
  total: string | null;
  /** Subset prefix detected on the number itself: TG | GG | SV | GALLERY | null. */
  subsetPrefix: "TG" | "GG" | "SV" | null;
  /** True when the number has no denominator (typical of Black Star Promos). */
  looksLikePromo: boolean;
  raw: string;
}

const NUM_TOKEN = /[A-Za-z]{0,5}\d{1,4}[A-Za-z]?/;

/** Parse "176/191", "GG35/GG70", "TG12/TG30", "SV107", "SWSH123", "001/025". */
export function parseCollectorNumber(input: string | null | undefined): ParsedCollectorNumber {
  const raw = String(input ?? "").trim();
  const empty: ParsedCollectorNumber = { number: null, total: null, subsetPrefix: null, looksLikePromo: false, raw };
  if (!raw) return empty;

  const slash = raw.match(new RegExp(`^\\s*(${NUM_TOKEN.source})\\s*/\\s*(${NUM_TOKEN.source})\\s*$`));
  if (slash) {
    const number = slash[1].toUpperCase();
    const total = slash[2].toUpperCase();
    return { number, total, subsetPrefix: subsetPrefixOf(number), looksLikePromo: false, raw };
  }
  // No denominator — promo-style single token (SWSH123, SVP045, XY52, 001).
  const single = raw.match(new RegExp(`^\\s*(${NUM_TOKEN.source})\\s*$`));
  if (single) {
    const number = single[1].toUpperCase();
    return { number, total: null, subsetPrefix: subsetPrefixOf(number), looksLikePromo: true, raw };
  }
  return empty;
}

function subsetPrefixOf(numberToken: string): ParsedCollectorNumber["subsetPrefix"] {
  const m = numberToken.match(/^(TG|GG|SV)\d/i);
  if (!m) return null;
  return m[1].toUpperCase() as "TG" | "GG" | "SV";
}

// ── Set code ──────────────────────────────────────────────────────────────────
/** Normalise a printed set code / PTCGO code to the Knowledge Engine set_key form
 *  (lowercase, whitespace-stripped). Returns null for clearly-not-a-code input. */
export function parseSetCode(input: string | null | undefined): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  // A set code is short and alphanumeric-ish (sv8, swsh12pt5, sv2a, base1, TG).
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,14}$/.test(raw)) return null;
  return raw.replace(/\s+/g, "").toLowerCase();
}

// ── Year ──────────────────────────────────────────────────────────────────────
/** Extract a plausible 4-digit Pokémon-TCG year (1999–2039) from free text. */
export function parseYear(input: string | null | undefined): string | null {
  const raw = String(input ?? "");
  const m = raw.match(/\b(199\d|20[0-3]\d)\b/);
  return m ? m[1] : null;
}

// ── Language / script detection ───────────────────────────────────────────────
export interface LanguageDetection {
  /** Catalogue language value, or null if unresolved. */
  language: string | null;
  /** Lower when a script maps to more than one language (Simplified vs Traditional). */
  confidence: "high" | "medium" | "low";
  evidence: string;
  /** Candidate languages when ambiguous (e.g. both Chinese variants). */
  alternatives: string[];
}

/** Detect language from card text by script. NEVER forces a guess: Latin text is
 *  medium-confidence English (could be a European language → "other"); Han script
 *  is low-confidence because Simplified vs Traditional Chinese can't be told apart
 *  safely from a small sample. */
export function detectLanguage(text: string | null | undefined): LanguageDetection {
  const s = String(text ?? "");
  if (!s.trim()) return { language: null, confidence: "low", evidence: "no text", alternatives: [] };

  if (/[぀-ゟ゠-ヿ]/.test(s)) {
    // Kana is unambiguous Japanese.
    return { language: "ja", confidence: "high", evidence: "Japanese kana script", alternatives: [] };
  }
  if (/[가-힣]/.test(s)) {
    return { language: "ko", confidence: "high", evidence: "Korean hangul script", alternatives: [] };
  }
  if (/[฀-๿]/.test(s)) {
    return { language: "th", confidence: "high", evidence: "Thai script", alternatives: [] };
  }
  if (/[一-鿿]/.test(s) && !/[぀-ヿ]/.test(s)) {
    // Han without kana → Chinese, but Simplified vs Traditional is NOT safe from a sample.
    return {
      language: null,
      confidence: "low",
      evidence: "Han script — Simplified vs Traditional Chinese cannot be resolved safely",
      alternatives: ["zh-Hans", "zh-Hant"],
    };
  }
  // Latin script → most likely English, but could be a European language edition.
  return { language: "en", confidence: "medium", evidence: "Latin script (could be a European-language edition)", alternatives: ["other"] };
}

// ── Regulation mark → era hint (modern English) ───────────────────────────────
/** Map a Scarlet&Violet/SWSH regulation mark letter to an era hint. Unknown → null. */
export function eraFromRegulationMark(mark: string | null | undefined): string | null {
  const m = String(mark ?? "").trim().toUpperCase();
  if (/^[DEF]$/.test(m)) return "swsh"; // D/E/F appeared on SWSH-era cards
  if (/^[GH]$/.test(m)) return "sv"; // G/H are Scarlet & Violet
  return null;
}
