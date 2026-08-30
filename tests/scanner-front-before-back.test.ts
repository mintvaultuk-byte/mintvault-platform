/**
 * FRONT-before-BACK ordering invariant (owner requirement §23) and successful-
 * side preservation (§33).
 *
 * The rule is enforced in application code at the evidence-admission boundary,
 * with NO database constraint or trigger behind it. Before this suite existed,
 * deleting either guard left the entire test suite green — the invariant was
 * load-bearing and completely uncovered.
 *
 * These are code-shape assertions over the real shipped source, deliberately:
 * the guards are single statements whose presence and POSITION are the whole
 * property, and exercising them end to end would require a live R2 bucket and a
 * 128 MiB TIFF corpus that this environment does not have (recorded as an
 * external blocker in the P23 issue register). They are written to fail if a
 * guard is removed, weakened to a non-BACK branch, or moved back behind the
 * expensive TIFF decode.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
/**
 * Raw source deliberately: the strip-non-code helper blanks string-literal and
 * template TEXT (it exists to judge code, not prose), which is exactly the
 * content these guards are made of — a thrown message and a SQL predicate.
 */
const read = (p: string) => readFileSync(p, "utf8");

describe("§23 FRONT-before-BACK is enforced server-side", () => {
  it("the staged-upload finalise path refuses a BACK master with no current FRONT", () => {
    const src = read("server/scanner-evidence-finalisation.ts");
    expect(src).toMatch(/side\s*===\s*["']back["']/);
    expect(src).toMatch(/side\s*=\s*['"]front['"]/);
    expect(src).toMatch(/is_current\s*=\s*true/);
    expect(src).toMatch(/Back capture refused until an immutable front master exists/);
  });

  it("the multipart compatibility route delegates to the same finalisation authority", () => {
    const src = read("server/routes.ts");
    expect(src).toMatch(/finaliseScannerEvidence\(/);
    expect(src).toMatch(/reconcileAcceptedScannerEvidence\(/);
  });

  it("the staged BACK-before-FRONT refusal is retryable, so a valid BACK upload is not discarded", () => {
    const src = read("server/routes.ts");
    expect(src).toMatch(/until an immutable front master exists/);
    expect(src).toMatch(/failScannerEvidenceFinalisation\(stagingId, reason, retryable\)/);
    expect(src).toMatch(/finishScannerCapture\(sessionId, false, reason, retryable\)/);
  });

  it("the ordering check runs BEFORE the expensive TIFF decode, not after", () => {
    const src = read("server/scanner-evidence-finalisation.ts");
    const guard = src.indexOf("Back capture refused");
    const decode = src.indexOf("inspectScannerEvidence(input.buffer)");
    expect(guard).toBeGreaterThan(-1);
    expect(decode).toBeGreaterThan(-1);
    // A BACK-first capture must be refused by one indexed SELECT, not after
    // decoding up to 128 MiB of TIFF and running card-boundary analysis on it.
    expect(guard).toBeLessThan(decode);
  });

  it("the legacy staff upload route refuses a BACK-only request", () => {
    const src = read("server/routes/staff.ts");
    // This route writes the display image columns directly and never reaches the
    // immutable-master guard, so it needs its own front-first precondition.
    expect(src).toMatch(/front_image_path IS NOT NULL/);
    expect(src).toMatch(/Scan the front of this card before the back/);
  });
});

describe("§33 a committed FRONT survives a BACK failure", () => {
  it("evidence rows are never deleted — no DELETE against the evidence ledger exists", () => {
    for (const file of [
      "server/scan-ingest-service.ts",
      "server/scanner-evidence-finalisation.ts",
      "server/scanner-evidence-staging-service.ts",
      "server/scanner-capture-service.ts",
      "server/routes.ts",
    ]) {
      const src = read(file);
      expect(src, `${file} must not DELETE from the evidence ledger`).not.toMatch(
        /DELETE\s+FROM\s+certificate_image_evidence/i
      );
    }
  });

  it("a supersede is scoped to one side, so a BACK write cannot retire the FRONT", () => {
    const src = read("server/lib/scanner-evidence-persistence.ts");
    // The current-row lookup that feeds the supersede is bound to a single side.
    expect(src).toMatch(/certificate_id\s*=\s*\$1\s+AND\s+side\s*=\s*\$2\s+AND\s+is_current\s*=\s*true/i);
  });

  it("the per-side advisory lock keys on the side, so the two sides never contend", () => {
    const src = read("server/lib/scanner-evidence-persistence.ts");
    expect(src).toMatch(/evidence:\$\{intent\.certificateId\}:\$\{intent\.side\}/);
  });
});

describe("SFAP-015 staged finalise convergence is retryable after immutable evidence commit", () => {
  it("the already-accepted staged path reconciles the post-commit tail before returning", () => {
    const src = read("server/routes.ts");
    const alreadyAccepted = src.indexOf("if (prepared.alreadyAccepted)");
    const reconcile = src.indexOf("reconcileAcceptedScannerEvidence", alreadyAccepted);
    const response = src.indexOf("return res.json", alreadyAccepted);
    expect(alreadyAccepted).toBeGreaterThan(-1);
    expect(reconcile).toBeGreaterThan(alreadyAccepted);
    expect(response).toBeGreaterThan(reconcile);
  });

  it("the convergence helper reloads session-bound immutable evidence and replays every idempotent tail step", () => {
    const src = read("server/scanner-evidence-finalisation.ts");
    expect(src).toMatch(/capture_metadata\s*->>\s*'captureSessionId'\s*=\s*\$\{session\.id\}/);
    expect(src).toMatch(/export async function reconcileAcceptedScannerEvidence/);
    expect(src).toMatch(/enqueueScannerProcessing\(input\.session\.certificateId, input\.session\.stationId\)/);
    expect(src).toMatch(/finishScannerCapture\(input\.session\.id, true\)/);
    expect(src).toMatch(/recordAcceptedScannerEvidence/);
    expect(src).toMatch(/completeScannerEvidenceFinalisation\(input\.stagingId\)/);
  });

  it("retry reconciliation does not write duplicate scanner-accepted audit rows", () => {
    const src = read("server/scanner-evidence-finalisation.ts");
    expect(src).toMatch(/scannerAcceptanceAuditExists/);
    expect(src).toMatch(/action\s*=\s*'scanner_capture_accepted'/);
    expect(src).toMatch(/details\s*->>\s*'capture_session_id'\s*=\s*\$\{session\.id\}/);
    expect(src).toMatch(/if \(!\(await scannerAcceptanceAuditExists\(input\.session\)\)\)/);
  });
});
