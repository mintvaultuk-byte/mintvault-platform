/**
 * Client-side half of Vault Quest double-pay protection (Phase 10A D10).
 *
 * The server reserves a paid generation by an `idempotencyKey` the CLIENT supplies,
 * but a key minted fresh on every click gives no protection against a reload, a
 * second tab, or a network retry while the first request is still in flight — those
 * are new page loads / new tabs, so a per-click-only random id would never be resent.
 *
 * This persists the key in localStorage, scoped by a stable "what is this click"
 * signature (e.g. `character:GNV-F01-S1:master_portrait:nano_banana`), NOT by a
 * random per-click id:
 *   - localStorage survives a reload and is shared across tabs of the same origin,
 *     so a reload or a second tab reusing the same context reuses the SAME key —
 *     the server then sees a duplicate and replies "already running" / "already done"
 *     instead of charging twice.
 *   - Once a response is TERMINAL (success, replay, failure, conflict, manual-review)
 *     the key is cleared, so the NEXT deliberate click for the same character/type/
 *     model gets a FRESH key and is allowed to charge again — this is what lets a
 *     genuine "generate again for a new roll" or a real retry-after-failure through,
 *     matching how the server's idempotency decision table already treats a fresh key.
 *   - Only a 202 ("still running") response keeps the stored key — an impatient
 *     reload/second-tab click while the first is in flight reuses it and does not
 *     spend twice.
 *
 * Falls back to sessionStorage if localStorage is unavailable (e.g. private mode),
 * and to an in-memory-only random key if neither is available (Safari extreme
 * lockdown, iframes) — degrading to "same protection as no key" in that rare case,
 * never throwing and never blocking the click.
 */

const TTL_MS = 15 * 60 * 1000; // matches the generation route's own timeout order of magnitude
const PREFIX = "vq:idem:";

interface StoredKey {
  key: string;
  expiresAt: number;
}

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    window.localStorage.setItem("__vq_probe__", "1");
    window.localStorage.removeItem("__vq_probe__");
    return window.localStorage;
  } catch {
    try {
      window.sessionStorage.setItem("__vq_probe__", "1");
      window.sessionStorage.removeItem("__vq_probe__");
      return window.sessionStorage;
    } catch {
      return null;
    }
  }
}

function mintKey(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** Get the stable key for this action-context, minting one if none stored or the
 *  stored one expired. Safe to call on every click — reuse only happens if a prior
 *  attempt for the SAME context is genuinely still pending. */
export function getOrCreateIdempotencyKey(scopeKey: string): string {
  const store = storage();
  const storageKey = PREFIX + scopeKey;
  if (store) {
    try {
      const raw = store.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as StoredKey;
        if (parsed?.key && parsed.expiresAt > Date.now()) return parsed.key;
      }
    } catch {
      /* corrupt entry — fall through and mint a fresh one */
    }
  }
  const key = mintKey();
  if (store) {
    try {
      store.setItem(storageKey, JSON.stringify({ key, expiresAt: Date.now() + TTL_MS } satisfies StoredKey));
    } catch {
      /* storage full/blocked — key still works for THIS request, just not persisted */
    }
  }
  return key;
}

/** Clear the stored key for this context — call after any TERMINAL response
 *  (success, replay, failure, conflict, manual-review) so the next deliberate click
 *  gets a fresh key. Do NOT call after a 202/pending response. */
export function clearIdempotencyKey(scopeKey: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(PREFIX + scopeKey);
  } catch {
    /* ignore */
  }
}
