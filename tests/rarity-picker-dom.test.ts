import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RarityVariantPicker } from "../client/src/components/rarity-picker/RarityVariantPicker";
import type { StructuredCardVariant } from "../shared/pokemon-rarity-catalogue";

let windowRef: Window;
let container: HTMLElement;
let root: Root;

function installDom() {
  windowRef = new Window({ url: "http://localhost/" });
  const win = windowRef as unknown as Window & typeof globalThis;
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLSelectElement: win.HTMLSelectElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    Node: win.Node,
    Event: win.Event,
    MouseEvent: win.MouseEvent,
    localStorage: win.localStorage,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  });
  Object.defineProperty(globalThis, "navigator", { value: win.navigator, configurable: true });
  container = document.createElement("div");
  document.body.appendChild(container);
}

async function renderPicker(options: {
  value?: Partial<StructuredCardVariant>;
  onChange?: (v: StructuredCardVariant) => void;
  onCustomRarityNote?: (note: string | null) => void;
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  await act(async () => {
    root = createRoot(container);
    root.render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(RarityVariantPicker, {
          value: {
            language: options.value?.language ?? "en",
            era: options.value?.era ?? "swsh",
            rarity: options.value?.rarity ?? null,
            finish: options.value?.finish ?? null,
            promo: options.value?.promo ?? null,
            subset: options.value?.subset ?? null,
          },
          onChange: options.onChange,
          onCustomRarityNote: options.onCustomRarityNote,
        }),
      ),
    );
  });
}

async function renderHarness(options: {
  initial?: Partial<StructuredCardVariant>;
  onChange?: (v: StructuredCardVariant) => void;
  onCustomRarityNote?: (note: string | null) => void;
} = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  function Harness() {
    const [value, setValue] = useState<Partial<StructuredCardVariant>>({
      language: options.initial?.language ?? "en",
      era: options.initial?.era ?? "swsh",
      rarity: options.initial?.rarity ?? null,
      finish: options.initial?.finish ?? null,
      promo: options.initial?.promo ?? null,
      subset: options.initial?.subset ?? null,
    });
    (window as unknown as { setPickerValue: (next: Partial<StructuredCardVariant>) => void }).setPickerValue = (next) =>
      setValue((current) => ({ ...current, ...next }));
    return React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(RarityVariantPicker, {
        value,
        onChange: options.onChange,
        onCustomRarityNote: options.onCustomRarityNote,
      }),
    );
  }
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(Harness));
  });
}

async function click(testId: string) {
  const el = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  if (!el) throw new Error(`Missing test id ${testId}`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  installDom();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  act(() => root?.unmount());
  windowRef?.close();
  vi.restoreAllMocks();
});

describe("RarityVariantPicker DOM emissions", () => {
  it("first rarity selection emits exactly once", async () => {
    const changes: StructuredCardVariant[] = [];
    await renderPicker({ onChange: (v) => changes.push(v) });
    await click("rarity-chip-silver_star_rare");
    expect(changes.map((c) => c.rarity)).toEqual(["silver_star_rare"]);
  });

  it("first finish selection emits exactly once", async () => {
    const changes: StructuredCardVariant[] = [];
    await renderPicker({ onChange: (v) => changes.push(v) });
    await click("pill-holo");
    expect(changes.filter((c) => c.finish === "holo")).toHaveLength(1);
  });

  it("first promo selection emits exactly once", async () => {
    const changes: StructuredCardVariant[] = [];
    await renderPicker({ onChange: (v) => changes.push(v) });
    await click("pill-black_star_promo");
    expect(changes.map((c) => c.promo)).toEqual(["black_star_promo"]);
  });

  it("parent language-only change does not swallow next rarity click", async () => {
    const changes: StructuredCardVariant[] = [];
    await renderHarness({ initial: { language: "en" }, onChange: (v) => changes.push(v) });
    await act(async () => (window as unknown as { setPickerValue: (next: Partial<StructuredCardVariant>) => void }).setPickerValue({ language: "es" }));
    expect(changes).toHaveLength(0);
    await click("rarity-chip-silver_star_rare");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ rarity: "silver_star_rare", language: "es" });
  });

  it("parent echo of same structured value does not duplicate or swallow next click", async () => {
    const changes: StructuredCardVariant[] = [];
    await renderHarness({ initial: { rarity: "rare" }, onChange: (v) => changes.push(v) });
    await act(async () => (window as unknown as { setPickerValue: (next: Partial<StructuredCardVariant>) => void }).setPickerValue({ rarity: "rare" }));
    expect(changes).toHaveLength(0);
    await click("rarity-chip-silver_star_rare");
    expect(changes.map((c) => c.rarity)).toEqual(["silver_star_rare"]);
  });

  it("Spanish accepted, then silver-star click emits while language stays Spanish", async () => {
    const changes: StructuredCardVariant[] = [];
    await renderHarness({ initial: { language: "es", rarity: "holo_rare_v" }, onChange: (v) => changes.push(v) });
    await click("rarity-chip-silver_star_rare");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ rarity: "silver_star_rare", language: "es" });
  });

  it("save/refetch echo does not swallow next click", async () => {
    const changes: StructuredCardVariant[] = [];
    await renderHarness({ initial: { rarity: "rare" }, onChange: (v) => changes.push(v) });
    await act(async () => (window as unknown as { setPickerValue: (next: Partial<StructuredCardVariant>) => void }).setPickerValue({ rarity: "rare", finish: "holo" }));
    await click("rarity-chip-silver_star_rare");
    expect(changes.map((c) => c.rarity)).toEqual(["silver_star_rare"]);
  });

  it("custom rarity survives an unrelated parent echo", async () => {
    const changes: StructuredCardVariant[] = [];
    const notes: Array<string | null> = [];
    localStorage.setItem(
      "mv.customRarities",
      JSON.stringify([
        {
          id: "custom-blue-star",
          displayName: "Blue Star Test",
          code: "BST",
          symbolDescription: "single blue star",
          symbolType: "silver",
          starCount: 1,
          category: "custom_other",
          note: "",
          dedupeKey: "blue star test|bst|silver|1",
          composedNote: "Custom rarity: Blue Star Test (BST) - single blue star - Category: Custom / Other",
        },
      ]),
    );
    await renderHarness({ onChange: (v) => changes.push(v), onCustomRarityNote: (n) => notes.push(n) });
    await click("rarity-chip-custom-custom-blue-star");
    expect(changes.at(-1)?.rarity).toBe("custom_unlisted");
    expect(notes.at(-1)).toContain("Blue Star Test");
    await act(async () => (window as unknown as { setPickerValue: (next: Partial<StructuredCardVariant>) => void }).setPickerValue({ language: "es" }));
    expect(changes.filter((c) => c.rarity === "custom_unlisted")).toHaveLength(1);
    expect(notes.at(-1)).toContain("Blue Star Test");
  });
});
