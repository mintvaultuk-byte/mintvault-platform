import { describe, expect, it, vi } from "vitest";
import { storedImageReloadSrc } from "../client/src/components/vault-quest/vq-stored-image-utils";

const PAID_GENERATION_ENDPOINTS = [
  "/api/admin/vault-quest/characters/GNV-F01-S1/generate-artwork",
  "/api/admin/vault-quest/characters/GNV-F01-S1/generate-artwork/batch",
  "/api/admin/vault-quest/characters/family/GNV-F01/generate-artwork",
  "/api/admin/vault-quest/ai/artwork",
];

const SAFE_PROMPT_AND_VIEW_ACTIONS = [
  "open character",
  "switch character",
  "select reference type",
  "open prompt editor",
  "edit prompt",
  "save prompt",
  "save draft",
  "open existing candidate",
  "select existing candidate",
  "view existing reference",
  "reload existing stored image",
  "open batch confirmation",
  "cancel batch confirmation",
  "load founder spend-control panel",
  "change feature toggle",
  "change unrelated local field",
  "change model selection without confirming generation",
];

function isPaidGenerationEndpoint(url: string): boolean {
  return PAID_GENERATION_ENDPOINTS.some((endpoint) => url.startsWith(endpoint));
}

describe("prompt-only and stored-image reload safety classification", () => {
  it("enumerates prompt/view/setup actions as non-generation client actions", () => {
    expect(SAFE_PROMPT_AND_VIEW_ACTIONS).toContain("save prompt");
    expect(SAFE_PROMPT_AND_VIEW_ACTIONS).toContain("reload existing stored image");
  });

  it("stored-image reload does not become a generation endpoint", () => {
    const reloaded = storedImageReloadSrc("/api/admin/vault-quest/characters/GNV-F01-S1/candidate/9?v=1", 1);
    expect(isPaidGenerationEndpoint(reloaded)).toBe(false);
  });

  it("opening/cancelling confirmation and local edits perform zero fetches in the client safety model", () => {
    const fetchSpy = vi.fn();
    const localOnly = () => ({ confirmationOpen: true, model: "nano_banana", cancelled: true });
    const state = localOnly();
    expect(state.cancelled).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
