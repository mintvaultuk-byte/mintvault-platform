import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hasDraftChanges, hasUnsavedDraftChanges } from "../client/src/pages/admin-sets";

const source = readFileSync("client/src/pages/admin-sets.tsx", "utf8");

const row = {
  uid: "custom:mv1",
  source: "custom",
  setId: "mv1",
  setName: "Original Set",
  tcg: "pokemon",
  series: "Promo",
  releaseYear: 2024,
  totalCards: 10,
  subset: "",
  archived: false,
  updatedAt: null,
  publishedCardCount: null,
  linkedCards: 0,
  linkedCertificates: 0,
  issueLabels: [],
  suggestions: [],
} as const;

const draft = {
  setId: "mv1",
  setName: "Original Set",
  tcg: "pokemon",
  series: "Promo",
  releaseYear: "2024",
  totalCards: "10",
  subset: "",
  archived: false,
  reason: "",
} as const;

describe("admin set editor action bar", () => {
  it("renders a sticky footer with visible save and cancel actions", () => {
    expect(source).toContain('data-testid="set-editor-sticky-footer"');
    expect(source).toContain("sticky bottom-0");
    expect(source).toContain("Save Changes");
    expect(source).toContain("Cancel");
    expect(source).toContain('data-testid="set-editor-save"');
  });

  it("keeps approve and reject suggestion actions limited to review items", () => {
    expect(source).toContain("{editingSuggestion &&");
    expect(source).toContain("Reject Suggestion");
    expect(source).toContain("{editingCanApprove &&");
    expect(source).toContain("Approve Suggestion");
  });

  it("warns before closing with unsaved changes, including Escape", () => {
    expect(source).toContain("Discard unsaved set changes?");
    expect(source).toContain('event.key !== "Escape"');
    expect(source).toContain("closeEditor();");
    expect(source).toContain('window.addEventListener("beforeunload"');
  });

  it("prevents double-save while an edit is already being saved", () => {
    expect(source).toContain("const savingRef = useRef(false);");
    expect(source).toContain("if (!editing || savingRef.current) return;");
    expect(source).toContain("savingRef.current = true;");
    expect(source).toContain("disabled={saving || !editingHasChanges}");
    expect(source).toContain('saving ? "Saving..." : "Save Changes"');
  });

  it("tracks save eligibility separately from audit-only text", () => {
    expect(hasDraftChanges(row, draft)).toBe(false);
    expect(hasDraftChanges(row, { ...draft, setName: "Corrected Set" })).toBe(true);
    expect(hasDraftChanges(row, { ...draft, setId: " MV 2 " })).toBe(true);
    expect(hasUnsavedDraftChanges(row, { ...draft, reason: "checking" })).toBe(true);
  });

  it("keeps the editor reachable by keyboard through native buttons and dialog semantics", () => {
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain('aria-labelledby="set-editor-title"');
    expect(source).toContain('aria-label="Close editor"');
    expect(source).not.toContain('tabIndex="-1"');
  });
});
