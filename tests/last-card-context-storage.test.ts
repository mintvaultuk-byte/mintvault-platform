import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LAST_CARD_CONTEXT_STORAGE_KEY,
  readLastCardContext,
  writeLastCardContext,
} from "../client/src/lib/last-card-context";

class MemorySessionStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("Same as last card session context", () => {
  it("stores only the five approved card-identification fields", () => {
    const storage = new MemorySessionStorage();
    const context = writeLastCardContext(storage, {
      cardGame: "pokemon",
      setName: "Base Set",
      setId: "base1",
      year: "1999",
      language: "English",
      cardName: "Charizard",
      cardNumber: "4/102",
      customerEmail: "customer@example.test",
      claimCode: "secret-claim-code",
      grade: "10",
    });

    expect(context).toEqual({
      cardGame: "pokemon",
      setName: "Base Set",
      setId: "base1",
      year: "1999",
      language: "English",
    });
    expect(JSON.parse(storage.getItem(LAST_CARD_CONTEXT_STORAGE_KEY)!)).toEqual(context);
  });

  it("rejects malformed, widened, and non-string stored payloads and clears them", () => {
    const storage = new MemorySessionStorage();
    storage.setItem(LAST_CARD_CONTEXT_STORAGE_KEY, '{"setName":"Base Set"');
    expect(readLastCardContext(storage)).toBeNull();
    expect(storage.getItem(LAST_CARD_CONTEXT_STORAGE_KEY)).toBeNull();

    storage.setItem(
      LAST_CARD_CONTEXT_STORAGE_KEY,
      JSON.stringify({
        cardGame: "pokemon",
        setName: "Base Set",
        setId: "base1",
        year: "1999",
        language: "English",
        customerEmail: "customer@example.test",
      })
    );
    expect(readLastCardContext(storage)).toBeNull();
    expect(storage.getItem(LAST_CARD_CONTEXT_STORAGE_KEY)).toBeNull();

    storage.setItem(
      LAST_CARD_CONTEXT_STORAGE_KEY,
      JSON.stringify({ cardGame: "pokemon", setName: "Base Set", setId: "base1", year: 1999, language: "English" })
    );
    expect(readLastCardContext(storage)).toBeNull();
    expect(storage.getItem(LAST_CARD_CONTEXT_STORAGE_KEY)).toBeNull();
  });

  it("uses session storage in the form and never persistent local storage for this context", () => {
    const form = readFileSync(join(process.cwd(), "client/src/components/certificate-form.tsx"), "utf8");
    const storage = readFileSync(join(process.cwd(), "client/src/lib/last-card-context.ts"), "utf8");

    expect(form).toContain("window.sessionStorage");
    expect(form).not.toContain('localStorage.getItem("mv.lastCardContext")');
    expect(form).not.toContain('localStorage.setItem("mv.lastCardContext")');
    expect(storage).not.toContain("localStorage");
  });
});
