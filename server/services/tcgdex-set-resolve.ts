/**
 * server/services/tcgdex-set-resolve.ts
 *
 * Resolve a card's SET from name + number against the imported English TCGdex
 * catalogue (tcgdex_sets), for when the AI can't read the printed set code.
 *
 * ENGLISH ONLY (this phase). Anti-hallucination: returns a set ONLY when the
 * (name, number) — disambiguated by the printed total when present — maps to
 * EXACTLY ONE set in our catalogue. Ambiguous (>1) or no match (0) → null, so
 * the caller leaves the Set field blank. A blank set beats a wrong one.
 *
 * tcgdex_sets is set-level only (no card rows), so the card→set link comes from
 * the live TCGdex card API (searchCardsByName); tcgdex_sets then confirms the set
 * is in our English catalogue AND supplies the canonical name.
 */
import { db } from "../db";
import { sql } from "drizzle-orm";
import { searchCardsByName } from "./tcgdex";
import { parseCollectorNumber, stripZeros } from "./collector-number";

export interface ResolvedSet {
  set_id: string;
  set_name: string;
  release_date: string | null;
}

/** Same normalization custom_sets / tcgdex_sets use. */
const normSetId = (id: string): string =>
  String(id ?? "")
    .replace(/\s+/g, "")
    .toLowerCase()
    .trim();

/** Derive the set id from a card id "{setId}-{localId}" (setIds can contain
 *  dashes/dots, so strip exactly the "-{localId}" suffix). */
function setIdFromCard(cardId: string, localId: string): string {
  const suffix = "-" + String(localId);
  return cardId.endsWith(suffix) ? cardId.slice(0, -suffix.length) : cardId.replace(/-[^-]*$/, "");
}

export async function resolveEnglishSetByNameAndNumber(name: string, rawNumber: string): Promise<ResolvedSet | null> {
  const nm = String(name || "").trim();
  const numRaw = String(rawNumber || "").trim();
  if (nm.length < 2 || !numRaw) return null;

  const { localKey, total } = parseCollectorNumber(numRaw);

  const cards = await searchCardsByName(nm, "en");
  if (!cards.length) return null;

  // Candidate set ids: cards whose printed number (localId) matches.
  const setIds = Array.from(
    new Set(
      cards
        .filter((c) => stripZeros(c.localId) === localKey)
        .map((c) => normSetId(setIdFromCard(c.id, c.localId)))
        .filter(Boolean)
    )
  );
  if (!setIds.length) return null;

  // Confirm against OUR imported English catalogue (also yields the canonical name).
  const inList = sql.join(
    setIds.map((s) => sql`${s}`),
    sql`, `
  );
  const rows = (
    await db.execute(sql`
      SELECT set_id, set_name, release_date, total_cards
      FROM tcgdex_sets
      WHERE set_id IN (${inList})
    `)
  ).rows as any[];

  // Disambiguate by the printed total (card count) when the AI supplied it, but
  // never do WORSE than the no-total case: if the total narrows to a non-empty
  // subset use it; otherwise fall back to all candidate rows (a prefixed subset
  // such as TG (30) may be catalogued under the parent set's count).
  const byTotal = total != null ? rows.filter((r) => Number(r.total_cards) === total) : [];
  const filtered = byTotal.length > 0 ? byTotal : rows;

  // Exactly one → confirmed. 0 (not in English catalogue) or >1 (ambiguous) → blank.
  if (filtered.length !== 1) return null;
  const r = filtered[0];
  return {
    set_id: r.set_id,
    set_name: r.set_name,
    release_date: r.release_date ? new Date(r.release_date).toISOString().split("T")[0] : null,
  };
}
