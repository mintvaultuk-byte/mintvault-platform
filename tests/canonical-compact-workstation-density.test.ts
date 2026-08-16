/**
 * Owner acceptance guard for the compact canonical grading workstation.
 *
 * This is deliberately source-level as the real dev harness is browser-tested
 * separately. It locks the shared geometry and proves this density pass cannot
 * silently grow into a scoring, authority, transport, or role-specific fork.
 */
import { describe, expect, it } from "vitest";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const SHELL = read("client/src/components/grading-workflow/CanonicalGradingWorkstationShell.tsx");
const ASIDE = read("client/src/components/grading-workflow/WorkstationPreviewAside.tsx");
const CERTIFICATE = read("client/src/components/grading-workflow/CertificatePreviewPanel.tsx");
const BAR = read("client/src/components/grading-workflow/GradingWorkflowBar.tsx");
const VIEWER = read("client/src/components/grading/image-viewer.tsx");
const DISPLAY = read("client/src/components/grading/grade-display.tsx");
const CENTERING = read("client/src/components/grading/centering-input.tsx");
const PANEL = read("client/src/components/grading/grading-panel.tsx");
const HARNESS = read("client/src/pages/dev-canonical-workstation-harness.tsx");

describe("compact rail geometry", () => {
  it("keeps one responsive canonical shell with a 35% desktop rail and one scroll surface", () => {
    expect(SHELL).toContain("flex min-h-0 flex-1 flex-col gap-2 md:flex-row");
    expect(SHELL).toContain('WORKSTATION_BODY_SCROLL_CLASS = "min-h-0 flex-1 space-y-2 overflow-y-auto md:pr-1"');
    expect(ASIDE).toContain('WORKSTATION_PREVIEW_WIDTH_CLASS = "md:w-[45%] md:shrink-0"');
    expect(ASIDE).toContain('data-testid="grading-preview-panel"');
    expect(ASIDE).toContain('data-testid="grading-interactive-card-host"');
  });

  it("makes the real certificate preview a bare 205px ratio-correct secondary reference", () => {
    // 205px (was 230px) — owner evidence 2026-08-16: the certificate was consuming rail
    // height the card needed. Display width only; the printed label is unchanged.
    expect(CERTIFICATE).toContain("max-w-[190px]");
    // RESERVED, STATE-INDEPENDENT BOX. Owner evidence 2026-08-16 (MV360, /staff):
    // the card was whole while the preview was not ready and lost its bottom the
    // moment the preview rendered, because this panel's height depended on state.
    // Pinning the printed label's 827x236 ratio makes it identical in every state,
    // so it reserves its space BEFORE the card is sized and the card cannot jump.
    expect(CERTIFICATE).toContain('aspectRatio: "827 / 236"');
    expect(CERTIFICATE).toContain("width={231}");
    expect(CERTIFICATE).toContain("height={66}");
    expect(CERTIFICATE).toContain('data-preview-presentation={url ? "bare-image"');
  });

  it("removes all normal image-filter controls without removing the image-processing contract", () => {
    expect(VIEWER).not.toContain('label: "Original"');
    expect(VIEWER).not.toContain('label: "Greyscale"');
    expect(VIEWER).not.toContain('label: "Hi-Contrast"');
    expect(VIEWER).not.toContain('label: "Edge"');
    expect(VIEWER).not.toContain('label: "Inverted"');
    expect(VIEWER).not.toContain("setVariant(");
    expect(VIEWER).toContain('type Variant = "original" | "greyscale" | "highcontrast" | "edgeenhanced" | "inverted"');
    expect(VIEWER).toContain("function getUrl(urls: ImageUrls, side: Side, variant: Variant)");
    expect(VIEWER).toContain("front_greyscale?: string | null");
    expect(VIEWER).toContain("front_highcontrast?: string | null");
    // The INLINE grid keeps the 525px cap (it has no definite height to resolve
    // against). The RAIL path must instead be bounded by its real parent, or the
    // card is capped well below the space the rail actually offers — measured at
    // 1280x800 the card was 361.6x511.6 with the constant vs 434.6x613.8 when
    // parent-bounded, i.e. ~20% of the card's linear size was being thrown away.
    expect(VIEWER).toContain('renderImageArea(fillHost ? "100%" : 525)');
    expect(VIEWER).toContain("h-8 w-8");
    expect(PANEL).toContain("rounded-l px-3 py-1 text-[10px]");
    expect(PANEL).toContain("btn-generate-description");
    expect(PANEL).toContain("text-xs font-bold uppercase px-3 py-1.5 rounded transition-all");
  });
});

describe("compact professional controls", () => {
  it("uses compact stage buttons while retaining real three-stage buttons", () => {
    expect(BAR).toContain("min-h-8");
    expect(BAR).toContain("h-6 w-6");
    expect(BAR).toContain("GRADING_STAGES.map((stage, i)");
    expect(BAR).toContain("onStageClick?.(i, stage)");
  });

  it("reduces grade and MVGS display allocation without changing their values", () => {
    expect(DISPLAY).toContain("text-3xl font-black text-[#1A1400]");
    expect(DISPLAY).not.toContain("text-5xl font-black");
    expect(DISPLAY).toContain("grid grid-cols-4 gap-1");
    expect(PANEL).toContain('data-testid="mvgs-controls"');
    expect(PANEL).toContain("rounded-lg p-2 space-y-2");
    expect(PANEL).toContain('data-testid="text-mvgs-score"');
  });

  it("keeps centering visible but moves secondary thresholds behind a closed native disclosure", () => {
    expect(CENTERING).toContain("Server-issued subgrade");
    expect(PANEL).toContain('data-testid="centering-threshold-reference"');
    expect(PANEL).toContain('<details className="group pt-0.5"');
    expect(PANEL).toContain("Threshold reference");
    expect(PANEL).not.toContain('centering-threshold-reference" open');
  });
});

describe("five-role and protected-boundary negative proof", () => {
  it("keeps all five roles in the real shared browser harness and exposes every required viewport", () => {
    for (const role of ["super-admin", "staff", "grader", "partner", "admin-review"]) {
      expect(HARNESS).toContain(`key: "${role}"`);
    }
    for (const viewport of ["1440x900", "1280x800", "1024x768", "800x700"]) {
      expect(HARNESS).toContain(`"${viewport}"`);
      expect(HARNESS).toContain(`harness-viewport-\${key}`);
    }
  });

  /**
   * DE-DRIFTED to the density pass's OWN immutable commit range (2026-08-14).
   *
   * This guard originally compared `git diff --name-only origin/main`. On the density topic branch
   * that range WAS exactly this pass's changes, so the check was correct — but the moment the test
   * merged into main it began running on every branch, where the same expression means "whatever
   * this branch changed". On a release branch carrying the Partner programme it therefore tripped
   * on unrelated files (`.claude/…/tasks/partner-auth-onboarding/…`, `server/`, `migrations/`),
   * and on main itself it passed VACUOUSLY because the diff is empty — i.e. it protected nothing
   * exactly where it was meant to keep protecting.
   *
   * That is the identical bug tests/helpers/grading-release-scope.ts was written to fix for PR #214
   * ("once PR #214 merged these tests into main… any unrelated future feature that legitimately
   * touches server/ or migrations/ then falsely tripped them"). The established repair is to pin
   * the scope proof to the task's own fixed range, making it a stable historical fact rather than a
   * moving window. `839edd9c..144fffa8` contains ONLY this pass's files.
   *
   * The ONGOING protection is unchanged and lives in the seven current-code assertions above (plus
   * the MVGS regression suite) — this test answers "did the density pass stay in its lane?", not
   * "is grading safe right now".
   */
  const DENSITY_PASS = {
    base: "839edd9c", // main immediately BEFORE the compact-workstation density pass
    final: "144fffa8", // the density pass's own commit
  } as const;

  it("changed only the explicitly owner-approved presentation and evidence surfaces", () => {
    // UNION, not replacement (origin/main's convention, preserved): the allowlist below carries the
    // density pass's surfaces AND the Gold Star classification-safety surfaces, so an earlier
    // owner authorisation is never silently dropped by a later one.
    //
    // MERGE RESOLUTION (2026-08-15). origin/main still compared `git diff --name-only origin/main`;
    // this side had already de-drifted that to the fixed range above (RC-F8). The fixed range is
    // kept, because the branch-relative form is what rots: on main it evaluates an EMPTY diff and
    // passes vacuously, and on any release branch it trips on unrelated files. The Gold Star entries
    // main added stay in the allowlist as the record of that authorisation; the Gold Star change has
    // its own scope proof in tests/gold-star-classification-safety.test.ts, so nothing is left
    // unguarded by preferring the pinned range here.
    const allowed = new Set([
      // ── Compact canonical workstation density pass (PR #299, commit 144fffa8) ──
      "client/src/components/grading-workflow/CanonicalGradingWorkstationShell.tsx",
      "client/src/components/grading-workflow/WorkstationPreviewAside.tsx",
      "client/src/components/grading-workflow/CertificatePreviewPanel.tsx",
      "client/src/components/grading-workflow/GradingWorkflowBar.tsx",
      "client/src/components/grading/image-viewer.tsx",
      "client/src/components/grading/grade-display.tsx",
      "client/src/components/grading/centering-input.tsx",
      "client/src/components/grading/grading-panel.tsx",
      "client/src/pages/dev-canonical-workstation-harness.tsx",
      // ── Left-rail fit repair (owner evidence 2026-08-16) ──────────────────────
      // Compact Front/Back controls and a tighter control->card gap, so the card-fit
      // box regains the height the chrome was consuming. Presentation only: no
      // scoring, no authority, no transport, no printed-label change.
      "client/src/components/grading-workflow/CardPreviewPanel.tsx",
      // Rail card sizing: the portaled ImageViewer must be bounded by its real
      // parent instead of a fixed 525px cap. Presentation only.
      "client/src/components/grading/image-viewer.tsx",
      "client/src/components/grading/grading-panel.tsx",
      // ── Gold Star classification-safety repair (owner-commissioned) ────────────
      // A vintage EX-era card could be classified as a MODERN Illustration Rare,
      // because rarity search carried no card context and the EX Gold Star had no
      // structured value at all. The repair is confined to the rarity catalogue data
      // and the single canonical picker that reads it. Neither file is a scoring,
      // authority or transport surface, so this widens the presentation allowlist
      // WITHOUT relaxing the hard prohibition asserted immediately below — that
      // prohibition still bars shared/mvgs-scoring.ts, shared/centering.ts,
      // shared/pristine.ts, shared/schema.ts, server/ and migrations/ outright.
      "shared/pokemon-rarity-catalogue.ts",
      "client/src/components/rarity-picker/RarityVariantPicker.tsx",
      // ── Certificate label-snapshot authority (owner-commissioned) ──────────────
      // A rarity published through the Catalogue Manager — i.e. everything the Partner
      // contribution approval workflow will create — printed a humanised CODE instead of
      // the label Super Admin approved, because this formatter only resolved against the
      // compiled-in seed. The repair makes it prefer the immutable `rarity_label` snapshot
      // already persisted on the certificate. Pure display resolution: no scoring, no
      // authority, no transport. The hard prohibition asserted below is unchanged.
      "shared/variant-line.ts",
    ]);
    // FAIL-CLOSED, as grading-release-scope.ts requires: a scope proof that cannot be evaluated
    // must error rather than silently pass on a shallow clone.
    const changed = execSync(`git diff --name-only ${DENSITY_PASS.base} ${DENSITY_PASS.final}`, {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    expect(changed.length, "density-pass scope range resolved to nothing — the pin has rotted").toBeGreaterThan(0);
    for (const path of changed) {
      if (
        path.startsWith("tests/") ||
        // Documentation is not a runtime surface. This guard exists to bound which
        // PRESENTATION and EVIDENCE code a branch may touch; a markdown file under
        // docs/ ships in no bundle and executes nowhere, so exempting it cannot widen
        // the blast radius the guard protects. Same reasoning as the tests/ exemption
        // directly above and the governance-evidence path below.
        path.startsWith("docs/") ||
        path.startsWith(".claude/controlled-code-lead/tasks/canonical-compact-workstation-density-20260814/")
      )
        continue;
      expect(allowed.has(path), `unexpected non-test change: ${path}`).toBe(true);
      expect(path).not.toMatch(
        /^(shared\/mvgs-scoring\.ts|shared\/centering\.ts|shared\/pristine\.ts|shared\/schema\.ts|server\/|migrations\/)/
      );
    }
  });
});
