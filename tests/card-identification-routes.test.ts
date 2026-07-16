/**
 * Route safety — flag gate, permissions, no-provider-when-disabled, generic
 * errors, and static regression proofs (Phase 19 / tests 9-16, 43-53). The
 * provider is never reached: we mock feature-flags OFF and spy that the provider
 * selector is never called; other tests are source-grep proofs (the DB/SSL env
 * can't run the app db in-process, matching the repo's other route tests).
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";

// Keep db inert + provider a spy; feature flag OFF.
vi.mock("../server/db", () => ({ db: {}, pool: { end: () => Promise.resolve(), query: () => Promise.resolve({ rows: [] }) } }));
const { selectProviderSpy } = vi.hoisted(() => ({ selectProviderSpy: vi.fn() }));
vi.mock("../server/lib/card-identification/provider", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, selectProvider: selectProviderSpy };
});
vi.mock("../server/config/feature-flags", () => ({
  getFeatureFlag: vi.fn(async () => false), // AI_CARD_IDENTIFICATION_ENABLED OFF
}));

import { handleIdentify, safeImageKey } from "../server/routes/card-identification";
import { requireAdmin } from "../server/auth";

interface MockRes {
  statusCode: number | null;
  body: unknown;
  status: (c: number) => MockRes;
  json: (b: unknown) => MockRes;
}
const makeRes = (): MockRes => {
  const res: MockRes = { statusCode: null, body: null, status(c) { res.statusCode = c; return res; }, json(b) { res.body = b; return res; } };
  return res;
};

const ROUTE_SRC = fs.readFileSync("server/routes/card-identification.ts", "utf8");
const PROVIDER_SRC = fs.readFileSync("server/lib/card-identification/provider.ts", "utf8");
const STORE_SRC = fs.readFileSync("server/lib/card-identification/store.ts", "utf8");
const PIPELINE_SRC = fs.readFileSync("server/lib/card-identification/pipeline.ts", "utf8");

describe("feature flag OFF (Phase 11 / tests 9-10, 16)", () => {
  it("returns 503 and NEVER selects a provider when the flag is off", async () => {
    selectProviderSpy.mockClear();
    const res = makeRes();
    await handleIdentify({ body: { idempotencyKey: "k1" }, session: { adminEmail: "a" } } as never, res as never);
    expect(res.statusCode).toBe(503);
    expect((res.body as { unavailable?: boolean }).unavailable).toBe(true);
    expect(selectProviderSpy).not.toHaveBeenCalled(); // zero provider calls in disabled state
  });
  it("the flag defaults OFF in the env const", () => {
    const flagsSrc = fs.readFileSync("server/config/feature-flags.ts", "utf8");
    expect(flagsSrc).toMatch(/AI_CARD_IDENTIFICATION_ENABLED:\s*process\.env\.AI_CARD_IDENTIFICATION_ENABLED === "true"/);
    expect(flagsSrc).toContain('"AI_CARD_IDENTIFICATION_ENABLED"'); // togglable
  });
});

describe("permissions (Phase 19)", () => {
  it("requireAdmin rejects unauthenticated (401) and grader (403)", async () => {
    const r1 = makeRes();
    await requireAdmin({ session: undefined, path: "/x" } as never, r1 as never, vi.fn() as never);
    expect(r1.statusCode).toBe(401);
    const r2 = makeRes();
    await requireAdmin({ session: { isGrader: true }, path: "/x" } as never, r2 as never, vi.fn() as never);
    expect(r2.statusCode).toBe(403);
  });
  it("every mutation route is auth-gated + rate-limited (admin + staff mirrors)", () => {
    expect(ROUTE_SRC).toMatch(/post\("\/api\/admin\/card-identification",\s*identifyLimit,\s*requireAdmin/);
    expect(ROUTE_SRC).toMatch(/post\("\/api\/staff\/card-identification",\s*identifyLimit,\s*requireCapability\("grade"\)/);
    expect(ROUTE_SRC).toMatch(/accuracy",\s*requireAdmin/);
  });
});

describe("safety invariants (tests 12-14, 43-53)", () => {
  it("one explicit click → one call; idempotency dedups a repeat (no double charge)", () => {
    expect(ROUTE_SRC).toContain("findByIdempotencyKey");
    expect(ROUTE_SRC).toMatch(/deduped:\s*true/);
    // The pipeline (the single spend) is invoked exactly once — no retry loop.
    expect((ROUTE_SRC.match(/runIdentificationPipeline\(\{/g) ?? []).length).toBe(1);
    // No loop constructs around the provider call (no auto-retry).
    expect(ROUTE_SRC).not.toMatch(/\bfor\s*\(|\bwhile\s*\(|\.catch\([^)]*identify/);
  });
  it("spend ceiling is checked BEFORE the provider call", () => {
    const idx = ROUTE_SRC.indexOf("spendDecision(await");
    const pidx = ROUTE_SRC.indexOf("runIdentificationPipeline({");
    expect(idx).toBeGreaterThan(0);
    expect(idx).toBeLessThan(pidx); // spend gate precedes the pipeline call
  });
  it("provider is unavailable without a key — never a real call by default", () => {
    expect(PROVIDER_SRC).toMatch(/if \(!apiKey\) return unavailableProvider/);
    expect(PROVIDER_SRC).toContain("mockVisionProvider");
  });
  it("the route NEVER writes a certificate / grade / cert number (suggestion only)", () => {
    for (const src of [ROUTE_SRC, STORE_SRC, PIPELINE_SRC]) {
      expect(src).not.toMatch(/updateCertificate|insert\(certificates\)|from\(certificates\)|createCertificate/);
      expect(src).not.toMatch(/gradeOverall|cert_counter|certificate_number/i);
    }
  });
  it("stores no raw provider output/images/PII — only the validated suggestion", () => {
    // recordRequest persists the assembled suggestion (short evidence), not raw AI text or image bytes.
    expect(STORE_SRC).not.toMatch(/frontBase64|backBase64|image bytes|rawResponse|choices\[/i);
    expect(ROUTE_SRC).not.toMatch(/writeFileSync|console\.log\(.*base64/i);
  });
  it("errors are generic — no provider prompt/token/secret leak", () => {
    expect(ROUTE_SRC).toMatch(/Identification failed\. Please try again or enter manually\./);
    expect(ROUTE_SRC).not.toMatch(/ANTHROPIC_API_KEY|x-api-key|IDENTIFY_PROMPT/);
    expect(PROVIDER_SRC).not.toMatch(/res\.json\(.*IDENTIFY_PROMPT|return.*IDENTIFY_PROMPT/); // prompt never returned
  });
  it("touches no protected/unrelated subsystem (grading/labels/payments/VQ/social)", () => {
    const all = ROUTE_SRC + STORE_SRC + PIPELINE_SRC + PROVIDER_SRC;
    const imports = all.match(/from\s+"[^"]+"/g) ?? [];
    for (const imp of imports) {
      expect(imp).not.toMatch(/grader|mvgs|scoring|labels|certificate-document|stripe|vault-quest|social|instagram/i);
    }
  });
});

describe("review fixes F1/F2/F3", () => {
  it("F1: arbitrary R2 keys are rejected; only this cert's card image is accepted", () => {
    // No cert → no key accepted.
    expect(safeImageKey("images/MV1/front.jpg", null)).toBeNull();
    // This cert's card image accepted — both normalised + stored certId forms.
    expect(safeImageKey("images/MV1/front.jpg", "MV1")).toBe("images/MV1/front.jpg");
    expect(safeImageKey("images/MV-0000000001/front.jpg", "MV1")).toBe("images/MV-0000000001/front.jpg");
    expect(safeImageKey("images/MV1/back.png", "MV-0000000001")).toBe("images/MV1/back.png");
    // Cross-cert / other-namespace / traversal / non-image all rejected.
    expect(safeImageKey("images/MV999/front.jpg", "MV1")).toBeNull();
    expect(safeImageKey("vq/cards/secret.png", "MV1")).toBeNull();
    expect(safeImageKey("logbooks/v5/MV1.pdf", "MV1")).toBeNull();
    expect(safeImageKey("images/MV1/../../etc/passwd", "MV1")).toBeNull();
    expect(safeImageKey("/images/MV1/front.jpg", "MV1")).toBeNull();
    expect(safeImageKey("images/MV1/notes.txt", "MV1")).toBeNull();
  });
  it("F2: the idempotency key stored is actor-namespaced (no cross-user replay)", () => {
    expect(ROUTE_SRC).toMatch(/const idempotencyKey = `\$\{actorOf\(req\)\}::\$\{clientKey\}`/);
    // The lookup uses the namespaced key, not the raw client key.
    expect(ROUTE_SRC).toMatch(/findByIdempotencyKey\(idempotencyKey\)/);
  });
  it("F3: correction analytics values are charset-restricted (no free-text PII)", () => {
    expect(STORE_SRC).toMatch(/SAFE_CODE = \/\^\[A-Za-z0-9/);
    expect(STORE_SRC).toContain("suggestedValue: safeCode(");
    expect(STORE_SRC).toContain("correctedValue: safeCode(");
  });
});
