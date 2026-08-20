import { beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { createHash } from "node:crypto";

let assessWorkingEvidence: typeof import("../server/grader").assessWorkingEvidence;
let makeNativeWorkingEvidence: typeof import("../server/scan-ingest-service").makeNativeWorkingEvidence;
let assertLide400WorkingDimensions: typeof import("../server/scan-ingest-service").assertLide400WorkingDimensions;

beforeAll(async () => {
  // The functions under test are pure/byte-local, but their production modules also declare the
  // database pool. No connection is opened by this test.
  process.env.MINTVAULT_DATABASE_URL ||= "postgresql://test:test@127.0.0.1:5432/mintvault_test";
  ({ assessWorkingEvidence } = await import("../server/grader"));
  ({ makeNativeWorkingEvidence, assertLide400WorkingDimensions } = await import("../server/scan-ingest-service"));
});

const canonicalRow = (overrides: Record<string, unknown> = {}) => ({
  side: "front",
  working_object_key: "evidence/working/1/front/example.v1.jpg",
  format: "tiff",
  pixel_width: 4724,
  pixel_height: 6136,
  dpi: 1200,
  working_width: 4724,
  working_height: 6136,
  working_format: "jpeg",
  working_settings: { version: "v1", resize: null, quality: 95, chromaSubsampling: "4:4:4" },
  scanner_profile_version: "mintvault-canon-lide-400-v3",
  ...overrides,
});

describe("full-resolution Canon working evidence admission", () => {
  it("admits only an exact-dimension, no-resize derivative of a verified 1200-DPI Canon master", () => {
    const status = assessWorkingEvidence(canonicalRow());
    expect(status).toMatchObject({
      available: true,
      reason: null,
      master: { dpi: 1200, width: 4724, height: 6136 },
      working: { width: 4724, height: 6136, format: "jpeg" },
    });
  });

  it("fails closed when a compact/downsampled derivative is offered as working evidence", () => {
    const status = assessWorkingEvidence(canonicalRow({ working_width: 1600, working_height: 2079 }));
    expect(status.available).toBe(false);
    expect(status.reason).toContain("dimensions do not match");
    expect(status.recovery).toContain("immutable 1200-DPI master");
  });

  it("fails closed when resize metadata is changed even if dimensions were forged", () => {
    const status = assessWorkingEvidence(canonicalRow({ working_settings: { resize: { width: 2000 } } }));
    expect(status.available).toBe(false);
    expect(status.reason).toContain("undownsampled");
  });

  it("fails closed for a non-1200-DPI master or missing working key", () => {
    expect(assessWorkingEvidence(canonicalRow({ dpi: 900 })).available).toBe(false);
    expect(assessWorkingEvidence(canonicalRow({ working_object_key: null })).available).toBe(false);
  });

  it("fails closed when a Partner row lacks the authoritative captured-session and active-station proof", () => {
    const status = assessWorkingEvidence(canonicalRow({ capture_provenance_valid: false }));
    expect(status.available).toBe(false);
    expect(status.reason).toContain("active authorised station");
    expect(status.recovery).toContain("approved station");
  });

  it("fails closed when a metadata-shaped row is not backed by an immutable TIFF master", () => {
    const status = assessWorkingEvidence(canonicalRow({ format: "jpeg" }));
    expect(status.available).toBe(false);
    expect(status.reason).toContain("immutable TIFF");
  });

  it("derives an actual Canon-sized working JPEG without resizing the immutable TIFF", async () => {
    const master = await sharp({
      create: { width: 4724, height: 6136, channels: 3, background: { r: 30, g: 80, b: 140 } },
    })
      .tiff({ compression: "lzw" })
      .withMetadata({ density: 1200 })
      .toBuffer();
    const masterHash = createHash("sha256").update(master).digest("hex");

    const working = await makeNativeWorkingEvidence(master, true);
    const metadata = await sharp(working.buffer).metadata();
    expect({ width: working.width, height: working.height }).toEqual({ width: 4724, height: 6136 });
    expect({ width: metadata.width, height: metadata.height, format: metadata.format }).toEqual({
      width: 4724,
      height: 6136,
      format: "jpeg",
    });
    expect(createHash("sha256").update(master).digest("hex")).toBe(masterHash);

    // Mutation proof: a future resize must trip the production guard, not merely a fixture check.
    expect(() => assertLide400WorkingDimensions({ width: 4724, height: 6136 }, { width: 1600, height: 2079 })).toThrow(
      "Refusing resized LiDE 400 working evidence"
    );
  }, 60_000);
});
