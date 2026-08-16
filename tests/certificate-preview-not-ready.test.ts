/**
 * AN UNGRADED CARD IS NOT A PREVIEW FAILURE.
 *
 * Owner reproduction on live production (2026-08-16, Super Admin /admin): the live
 * certificate preview showed "Preview unavailable · Retry".
 *
 * Root cause was NOT the request chain — it was this panel discarding the server's
 * answer. The preview route replies 422 with deliberately concise, grader-facing
 * wording ("Not graded yet — the preview appears once a grade is set."), and the panel
 * rendered a single fixed failure string for EVERY non-ok response, so a routine
 * expected state was presented as a system fault. At the time of diagnosis 125 of 836
 * production certificates were numeric-but-ungraded, i.e. ~15% of the estate could
 * trigger it.
 *
 * These tests pin the distinction:
 *   - 422 + a server message  -> that message is shown, and NO Retry control (retrying
 *     cannot help; grading the card is what makes the preview appear)
 *   - any genuine fault       -> the unchanged "Preview unavailable · Retry" control
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(
  path.resolve(process.cwd(), "client/src/components/grading-workflow/CertificatePreviewPanel.tsx"),
  "utf8"
);

describe("the preview panel distinguishes 'not graded yet' from a fault", () => {
  it("treats a 422 with a server message as an informational not-ready state", () => {
    expect(SRC).toMatch(/res\.status === 422/);
    expect(SRC).toMatch(/setNotReady\(data\.error\)/);
  });

  it("renders the server's own wording verbatim rather than a generic string", () => {
    // The message must come from state, not be re-invented client-side.
    expect(SRC).toMatch(/\{notReady\}/);
  });

  it("offers NO retry control for a not-ready card — retrying cannot make a grade exist", () => {
    // The not-ready branch is a <p>, not the retry <button>.
    const branch = SRC.slice(SRC.indexOf("): notReady ?"), SRC.indexOf("): error ?"));
    expect(branch).not.toMatch(/<button/);
  });

  it("keeps the unavailable + Retry control for every GENUINE fault", () => {
    expect(SRC).toContain("Preview unavailable · Retry");
    // A non-422 response still throws into the error path.
    expect(SRC).toMatch(/throw new Error\(data\.error \|\| `Certificate preview failed/);
  });

  it("clears the not-ready state on a new request, on retry, and when waiting for a revision", () => {
    // Three call sites plus the declaration and the 422 setter = 5 references.
    expect((SRC.match(/setNotReady\(/g) || []).length).toBeGreaterThanOrEqual(4);
  });

  it("exposes the not-ready state for runtime assertions without conflating it with error", () => {
    expect(SRC).toMatch(/data-preview-state=\{error \? "error" : notReady \? "not-ready"/);
  });

  it("never presents an unsaved/unknown reason as authoritative wording", () => {
    // Only a string body.error from the server may become the displayed message.
    expect(SRC).toMatch(/typeof data\.error === "string" && data\.error/);
  });
});
