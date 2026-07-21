/**
 * Session-scoped, non-sensitive context for the grader's "Same as last card" shortcut.
 *
 * This deliberately stores only card-identification fields required by the shortcut. It
 * never receives a certificate object, customer data, grading data, images, or credentials.
 */
export const LAST_CARD_CONTEXT_STORAGE_KEY = "mv.lastCardContext";

export interface LastCardContext {
  cardGame: string;
  setName: string;
  setId: string;
  year: string;
  language: string;
}

type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const LAST_CARD_CONTEXT_FIELDS = ["cardGame", "setName", "setId", "year", "language"] as const;

function clearInvalidContext(storage: SessionStorageLike): void {
  try {
    storage.removeItem(LAST_CARD_CONTEXT_STORAGE_KEY);
  } catch {
    // Storage may be unavailable in a privacy-restricted browser. The in-memory form state remains usable.
  }
}

function normalizeLastCardContext(value: unknown): LastCardContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (LAST_CARD_CONTEXT_FIELDS.some((field) => typeof record[field] !== "string")) return null;
  return {
    cardGame: record.cardGame as string,
    setName: record.setName as string,
    setId: record.setId as string,
    year: record.year as string,
    language: record.language as string,
  };
}

/** Reject unknown fields and non-string values instead of retaining a stale wider payload. */
export function parseLastCardContext(value: unknown): LastCardContext | null {
  const context = normalizeLastCardContext(value);
  if (!context || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  const expected = [...LAST_CARD_CONTEXT_FIELDS].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]) ? context : null;
}

export function readLastCardContext(storage: SessionStorageLike | null | undefined): LastCardContext | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(LAST_CARD_CONTEXT_STORAGE_KEY);
    if (!raw) return null;
    const context = parseLastCardContext(JSON.parse(raw));
    if (!context) clearInvalidContext(storage);
    return context;
  } catch {
    clearInvalidContext(storage);
    return null;
  }
}

/**
 * Persists the exact five-field allowlist to session storage. Returning the normalized context
 * lets the UI preserve the current-session shortcut even when storage is unavailable.
 */
export function writeLastCardContext(
  storage: SessionStorageLike | null | undefined,
  value: unknown
): LastCardContext | null {
  // UI callers may pass a broader form object. Normalize it to the explicit
  // allowlist before serializing, while reads remain strict about persisted data.
  const context = normalizeLastCardContext(value);
  if (!context) {
    if (storage) clearInvalidContext(storage);
    return null;
  }
  try {
    storage?.setItem(LAST_CARD_CONTEXT_STORAGE_KEY, JSON.stringify(context));
  } catch {
    // Storage is an enhancement only; the caller still keeps the safe context in React state.
  }
  return context;
}
