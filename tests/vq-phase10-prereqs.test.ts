/**
 * Phase 10A-0 — prerequisite pure modules: vq_config resolution (D4), R2 identity
 * guard (hardening), and the grading drizzle tablesFilter (hardening). No DB/R2.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolveVqCeilings, VQ_CONFIG_DEFAULTS } from "../server/vault-quest/lib/vq-config";
import { checkR2Identity, r2IdentityMessage } from "../server/vault-quest/lib/r2-identity";

describe("resolveVqCeilings — safe defaults + safe parse (D4)", () => {
  it("empty/missing config → conservative defaults (missing table degrades safely)", () => {
    expect(resolveVqCeilings(null)).toEqual(VQ_CONFIG_DEFAULTS);
    expect(resolveVqCeilings({})).toEqual(VQ_CONFIG_DEFAULTS);
  });
  it("daily spend ceiling is 1000 (founder decision, raised from 50) — the vq_config table has no override row, so this code default is the sole authoritative value", () => {
    expect(VQ_CONFIG_DEFAULTS.maxCreditsPerDay).toBe(1000);
    expect(resolveVqCeilings({}).maxCreditsPerDay).toBe(1000);
    expect(resolveVqCeilings(null).maxCreditsPerDay).toBe(1000);
  });
  it("parses provided values", () => {
    const r = resolveVqCeilings({ "spend.max_images_per_request": "5", "spend.max_credits_per_day": "100" });
    expect(r.maxImagesPerRequest).toBe(5);
    expect(r.maxCreditsPerDay).toBe(100);
    expect(r.maxCreditsPerBatch).toBe(VQ_CONFIG_DEFAULTS.maxCreditsPerBatch); // untouched key → default
  });
  it("rejects non-numeric / negative → falls back per-field (no magic-number leak)", () => {
    const r = resolveVqCeilings({ "spend.max_images_per_request": "abc", "spend.max_credits_per_request": "-3" });
    expect(r.maxImagesPerRequest).toBe(VQ_CONFIG_DEFAULTS.maxImagesPerRequest);
    expect(r.maxCreditsPerRequest).toBe(VQ_CONFIG_DEFAULTS.maxCreditsPerRequest);
  });
});

describe("checkR2Identity — fail-closed guard (never infers staging from DB)", () => {
  it("refuses when no expected bucket named (ambiguous)", () => {
    const r = checkR2Identity({ actualBucket: "mintvault-cards", actualEndpoint: "https://x.r2.cloudflarestorage.com" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_expected");
  });
  it("refuses on mismatch", () => {
    const r = checkR2Identity({ expectedBucket: "staging-bucket", actualBucket: "mintvault-cards" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("mismatch");
  });
  it("ok only when expected matches actual", () => {
    const r = checkR2Identity({ expectedBucket: "mintvault-cards", actualBucket: "mintvault-cards", actualEndpoint: "https://acc.r2.cloudflarestorage.com/x" });
    expect(r.ok).toBe(true);
    expect(r.bucket).toBe("mintvault-cards");
    expect(r.endpointHost).toBe("acc.r2.cloudflarestorage.com"); // host only, never full URL/creds
  });
  it("message never contains a credential", () => {
    const m = r2IdentityMessage(checkR2Identity({ expectedBucket: "a", actualBucket: "b" }));
    expect(m).toMatch(/REFUSED/);
    expect(m).not.toMatch(/secret|key|password|token/i);
  });
});

describe("grading drizzle config excludes vq_* (migration isolation hardening)", () => {
  it("drizzle.config.ts declares tablesFilter [\"!vq_*\"]; drizzle-vq.config keeps vq_*", () => {
    const grading = readFileSync("drizzle.config.ts", "utf8");
    expect(grading).toMatch(/tablesFilter:\s*\["!vq_\*"\]/);
    const vq = readFileSync("drizzle-vq.config.ts", "utf8");
    expect(vq).toMatch(/tablesFilter:\s*\["vq_\*"\]/);
  });
});
