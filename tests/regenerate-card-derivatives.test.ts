/**
 * Regeneration-safety tests. Uses in-memory fakes (no R2, no DB, no network) so
 * the safety properties are asserted deterministically:
 *   dry run writes nothing, apply is idempotent, originals are never written,
 *   identity mismatches abort, and an implicit target set is refused.
 */
import { describe, it, expect } from "vitest";
import sharp from "sharp";
import {
  regenerateCertificate,
  parseRegenArgs,
  isProtectedKey,
  RegenerationError,
  type RegenDeps,
  type CertRow,
} from "../scripts/regenerate-card-derivatives";
import { emptyCropIntegrityReport, type CropIntegrityReport } from "../server/image-processing";

const ORIGINAL_FRONT_KEY = "images/grading/1061/front_original.jpg";
const ORIGINAL_BACK_KEY = "images/grading/1061/back_original.jpg";

async function tinyJpeg(w = 60, h = 84): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: "#cccccc" } }).jpeg().toBuffer();
}

interface Harness {
  deps: RegenDeps;
  store: Map<string, Buffer>;
  puts: string[];
  diagnostics: unknown[];
  audits: unknown[];
  logs: string[];
}

async function harness(overrides: Partial<CertRow> = {}): Promise<Harness> {
  const img = await tinyJpeg();
  const store = new Map<string, Buffer>([
    [ORIGINAL_FRONT_KEY, Buffer.from(img)],
    [ORIGINAL_BACK_KEY, Buffer.from(img)],
  ]);
  const puts: string[] = [];
  const diagnostics: unknown[] = [];
  const audits: unknown[] = [];
  const logs: string[] = [];
  const row: CertRow = {
    id: 1061,
    certificate_number: "MV602",
    grading_front_original: ORIGINAL_FRONT_KEY,
    grading_back_original: ORIGINAL_BACK_KEY,
    // Scheme A destinations (the 23% case).
    grading_front_cropped: "images/grading/1061/front_cropped.jpg",
    grading_front_display: "images/grading/1061/front_display.jpg",
    front_image_path: "images/MV602/front.png",
    grading_back_cropped: "images/grading/1061/back_cropped.jpg",
    grading_back_display: "images/grading/1061/back_display.jpg",
    back_image_path: "images/MV602/back.png",
    ...overrides,
  };
  const mkReport = (side: "front" | "back"): CropIntegrityReport => {
    const r = emptyCropIntegrityReport(side);
    r.pre = { w: 60, h: 84, aspect: 0.7143 };
    r.accepted = { w: 58, h: 81, aspect: 0.716 };
    r.proposed = r.accepted;
    r.decision = "accepted";
    r.fallback = "none";
    r.cropConfidence = "high";
    r.trimFraction = { horizontal: 0.03, vertical: 0.03 };
    return r;
  };
  const deps: RegenDeps = {
    async loadCert(n) {
      return n === row.certificate_number || n === "MV602" ? row : null;
    },
    async getObject(k) {
      const b = store.get(k);
      if (!b) throw new Error(`missing ${k}`);
      return b;
    },
    async putObject(k, body) {
      puts.push(k);
      store.set(k, Buffer.from(body));
    },
    async saveDiagnostics(_id, d) {
      diagnostics.push(d);
    },
    async audit(_id, _n, d) {
      audits.push(d);
    },
    async buildFace(original, _cert, side) {
      // Deterministic stand-in for the real pipeline: derive stable buffers.
      const tightened = await sharp(original).resize(58, 81, { fit: "fill" }).jpeg({ quality: 90 }).toBuffer();
      return {
        tightened,
        displayPng: await sharp(tightened).png().toBuffer(),
        displayJpeg: await sharp(tightened).jpeg({ quality: 85 }).toBuffer(),
        viewerJpeg: await sharp(tightened).jpeg({ quality: 80 }).toBuffer(),
        report: mkReport(side),
        before: { w: 60, h: 84 },
        after: { w: 58, h: 81 },
      };
    },
    crossFace() {
      return { consistent: true, aspectDelta: 0.001, reasons: [], rollback: null };
    },
    log(l) {
      logs.push(l);
    },
  };
  return { deps, store, puts, diagnostics, audits, logs };
}

describe("regeneration safety", () => {
  it("refuses an implicit target set", () => {
    expect(() => parseRegenArgs([])).toThrow(RegenerationError);
    expect(() => parseRegenArgs(["--apply"])).toThrow(RegenerationError);
    expect(parseRegenArgs(["MV602", "MV609"])).toEqual({ targets: ["MV602", "MV609"], apply: false });
    expect(parseRegenArgs(["MV602", "--apply"])).toEqual({ targets: ["MV602"], apply: true });
  });

  it("deny-lists every original and raw key", () => {
    expect(isProtectedKey("images/grading/1061/raw_front.jpg")).toBe(true);
    expect(isProtectedKey("images/grading/1061/raw_back.tif")).toBe(true);
    expect(isProtectedKey("images/grading/1061/front_original.jpg")).toBe(true);
    expect(isProtectedKey("images/grading/1061/back_original.jpg")).toBe(true);
    // Derivatives are writable.
    expect(isProtectedKey("images/grading/1061/front_cropped.jpg")).toBe(false);
    expect(isProtectedKey("images/MV602/front.png")).toBe(false);
  });

  it("dry run performs NO writes at all", async () => {
    const h = await harness();
    const before = new Map(h.store);
    const r = await regenerateCertificate("MV602", h.deps, { apply: false });
    expect(r.applied).toBe(false);
    expect(r.writtenKeys).toEqual([]);
    expect(h.puts).toEqual([]);
    expect(h.diagnostics).toEqual([]);
    expect(h.audits).toEqual([]);
    expect(h.store.size).toBe(before.size);
    for (const [k, v] of before) expect(h.store.get(k)!.equals(v)).toBe(true);
    expect(h.logs.join("\n")).toContain("DRY RUN would write");
  });

  it("apply writes only derivative keys and never touches originals", async () => {
    const h = await harness();
    const origFront = Buffer.from(h.store.get(ORIGINAL_FRONT_KEY)!);
    const origBack = Buffer.from(h.store.get(ORIGINAL_BACK_KEY)!);
    const r = await regenerateCertificate("MV602", h.deps, { apply: true });
    expect(r.applied).toBe(true);
    expect(r.writtenKeys.length).toBe(6);
    expect(r.verified.length).toBe(6);
    for (const k of r.writtenKeys) expect(isProtectedKey(k)).toBe(false);
    // Originals byte-identical afterwards.
    expect(h.store.get(ORIGINAL_FRONT_KEY)!.equals(origFront)).toBe(true);
    expect(h.store.get(ORIGINAL_BACK_KEY)!.equals(origBack)).toBe(true);
    expect(h.diagnostics.length).toBe(1);
    expect(h.audits.length).toBe(1);
  });

  it("apply is idempotent — a second run reproduces byte-equal derivatives", async () => {
    const h = await harness();
    await regenerateCertificate("MV602", h.deps, { apply: true });
    const afterFirst = new Map([...h.store].map(([k, v]) => [k, Buffer.from(v)]));
    h.puts.length = 0;
    await regenerateCertificate("MV602", h.deps, { apply: true });
    expect(h.puts.length).toBe(6);
    expect([...h.store.keys()].sort()).toEqual([...afterFirst.keys()].sort());
    for (const [k, v] of afterFirst) {
      expect(h.store.get(k)!.equals(v), `${k} must be byte-equal on re-run`).toBe(true);
    }
  });

  it("aborts on a certificate-identity mismatch", async () => {
    const h = await harness({ certificate_number: "MV999" });
    await expect(regenerateCertificate("MV602", h.deps, { apply: true })).rejects.toThrow(/identity mismatch/i);
    expect(h.puts).toEqual([]);
  });

  it("aborts when the original asset is missing", async () => {
    const h = await harness({ grading_front_original: null });
    await expect(regenerateCertificate("MV602", h.deps, { apply: true })).rejects.toThrow(
      /grading_front_original is missing/
    );
    expect(h.puts).toEqual([]);
  });

  it("aborts on an unknown certificate and on a malformed number", async () => {
    const h = await harness();
    await expect(regenerateCertificate("MV777", h.deps, { apply: true })).rejects.toThrow(/not found/);
    await expect(regenerateCertificate("../etc/passwd", h.deps, { apply: true })).rejects.toThrow(/non-normalised/);
    expect(h.puts).toEqual([]);
  });
});

describe("storage-key schemes (hostile-review Critical 1)", () => {
  const SCHEME_B: Partial<CertRow> = {
    grading_front_cropped: "grading/MV602/front_cropped.jpg",
    grading_front_display: "grading/MV602/front_display.jpg",
    front_image_path: "images/MV602/front.jpg",
    grading_back_cropped: "grading/MV602/back_cropped.jpg",
    grading_back_display: "grading/MV602/back_display.jpg",
    back_image_path: "images/MV602/back.jpg",
  };

  it("writes to the DB-referenced keys for scheme B (77% of production)", async () => {
    const h = await harness(SCHEME_B);
    const r = await regenerateCertificate("MV602", h.deps, { apply: true });
    expect(r.writtenKeys).toContain("grading/MV602/front_cropped.jpg");
    expect(r.writtenKeys).toContain("images/MV602/front.jpg");
    // The hardcoded scheme-A key must NOT be written.
    expect(r.writtenKeys).not.toContain("images/grading/1061/front_cropped.jpg");
    expect(r.verified.length).toBe(r.writtenKeys.length);
  });

  it("honours the destination extension (scheme B public path is .jpg, not .png)", async () => {
    const h = await harness(SCHEME_B);
    await regenerateCertificate("MV602", h.deps, { apply: true });
    expect(h.store.has("images/MV602/front.jpg")).toBe(true);
    expect(h.store.has("images/MV602/front.png")).toBe(false);
  });

  it("dry run reports the RESOLVED keys without writing", async () => {
    const h = await harness(SCHEME_B);
    const r = await regenerateCertificate("MV602", h.deps, { apply: false });
    expect(h.puts).toEqual([]);
    expect(r.resolvedKeys.join(" ")).toContain("grading/MV602/front_cropped.jpg");
    expect(h.logs.join("\n")).toContain("DRY RUN would write");
  });

  it("fails closed on an unknown key scheme belonging to another certificate", async () => {
    const h = await harness({ grading_front_cropped: "grading/MV999/front_cropped.jpg" });
    await expect(regenerateCertificate("MV602", h.deps, { apply: true })).rejects.toThrow(/Unrecognised key scheme/);
    expect(h.puts).toEqual([]);
  });

  it("refuses a destination that is a protected original, in any format", async () => {
    for (const bad of ["images/grading/1061/front_original.tif", "images/grading/1061/front_original.webp",
                       "images/grading/1061/raw_front.tiff"]) {
      expect(isProtectedKey(bad), bad).toBe(true);
      const h = await harness({ grading_front_cropped: bad });
      await expect(regenerateCertificate("MV602", h.deps, { apply: true })).rejects.toThrow(/protected/i);
      expect(h.puts).toEqual([]);
    }
  });

  it("refuses when the front has no destination keys at all", async () => {
    const h = await harness({ grading_front_cropped: null, grading_front_display: null, front_image_path: null });
    await expect(regenerateCertificate("MV602", h.deps, { apply: true })).rejects.toThrow(/no front destination keys/);
  });
});
