/**
 * R2 → B2 archival: a certificate may never be marked backed up without its required objects.
 *
 * THE DEFECT THIS PINS. The worker enumerated three prefixes per certificate —
 * images/{certNumber}/, grading/{certNumber}/, images/grading/{certId}/ — which encode the
 * pre-partner assumption about where a certificate's images live. Partner-origin certificates do
 * not live there: connector import writes `partner-submissions/{tenant}/{sub}/{card}/{side}-…` into
 * front_image_path, back_image_path, grading_front_original AND grading_back_original, and that key
 * matches none of the three. The worker listed nothing, took the "no R2 objects found — marking
 * archived (nothing to copy)" branch, and stamped archived_to_b2_at on a certificate with ZERO
 * copies in B2.
 *
 * archived_to_b2_at is the durable record of "this is backed up", is surfaced to operators as
 * `archived`, and is the documented input to a future R2 tier-down. A false stamp there converts a
 * reporting error into permanent customer-image loss.
 *
 * WHY THE SUCCESS BRANCH IS TESTED TOO (T3). Fixing only the empty branch is half a fix: a partner
 * certificate that ALSO has a label or derivative under images/{certNumber}/ takes the success
 * path — non-empty result set, everything found was copied — and is still marked archived with its
 * partner originals untouched. T1 and T2 both pass with that half-fix; only T3 catches it.
 *
 * MUTATION TARGET: BACKUP1 — removing the partner keys from the enumeration, or restoring the
 * unconditional mark on zero/partial copies, must turn this red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Objects that "exist" in R2, keyed by object key. */
const r2Store = vi.hoisted(() => new Map<string, Buffer>());
/** Objects that have landed in B2. */
const b2Store = vi.hoisted(() => new Set<string>());
const uploadToB2Spy = vi.hoisted(() =>
  vi.fn(async (key: string) => {
    b2Store.add(key);
    return key;
  })
);
/** Rows the fake DB hands back as archival candidates, and what the worker wrote. */
const dbState = vi.hoisted(() => ({
  candidates: [] as Record<string, unknown>[],
  archivedUpdates: [] as string[],
  audits: [] as string[],
}));

vi.mock("../server/b2", () => ({
  uploadToB2: uploadToB2Spy,
  existsInB2: vi.fn(async (key: string) => b2Store.has(key)),
}));

// The worker consumes getR2Client() plus raw S3 commands, not the named r2.ts helpers, so the
// module must be replaced with a fake client rather than partially overridden.
vi.mock("../server/r2", () => ({
  getR2Client: () => ({
    send: async (cmd: { constructor: { name: string }; input: Record<string, string> }) => {
      if (cmd.constructor.name === "ListObjectsV2Command") {
        const prefix = cmd.input.Prefix ?? "";
        const Contents = [...r2Store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([Key, buf]) => ({ Key, Size: buf.length }));
        return { Contents, IsTruncated: false };
      }
      const buf = r2Store.get(cmd.input.Key);
      if (!buf) {
        const err = new Error("NoSuchKey") as Error & { name: string };
        err.name = "NoSuchKey";
        throw err;
      }
      return { Body: [buf], ContentType: "image/jpeg" };
    },
  }),
}));

vi.mock("../server/db", () => ({
  db: {
    execute: async (q: unknown) => {
      const text = renderSql(q);
      if (/UPDATE certificates/i.test(text)) {
        dbState.archivedUpdates.push(text);
        return { rows: [] };
      }
      if (/audit_log/i.test(text)) {
        dbState.audits.push(text);
        return { rows: [] };
      }
      if (/FROM certificates/i.test(text)) return { rows: dbState.candidates };
      return { rows: [] };
    },
  },
}));

/** Flatten a Drizzle sql`` template back to inspectable text. */
function renderSql(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return String(q);
  return chunks
    .map((c) => {
      if (typeof c === "string") return c;
      const v = (c as { value?: unknown })?.value;
      return Array.isArray(v) ? v.join("") : typeof v === "string" ? v : "";
    })
    .join(" ");
}

const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";
const SUB = "bbbbbbbb-0000-4000-8000-000000000001";
const CARD = "cccccccc-0000-4000-8000-000000000001";
const PARTNER_FRONT = `partner-submissions/${TENANT}/${SUB}/${CARD}/front-seed.jpg`;
const PARTNER_BACK = `partner-submissions/${TENANT}/${SUB}/${CARD}/back-seed.jpg`;

/** A partner certificate: all four image columns hold the partner keys, as connector import writes them. */
function partnerCert(id = 9001, certNumber = "MV9001") {
  return {
    id,
    certificate_number: certNumber,
    grade_approved_at: new Date("2026-01-01T00:00:00Z"),
    front_image_path: PARTNER_FRONT,
    back_image_path: PARTNER_BACK,
    grading_front_original: PARTNER_FRONT,
    grading_back_original: PARTNER_BACK,
  };
}

async function runArchival(opts: Record<string, unknown> = {}) {
  const { archiveStaleImages } = await import("../server/workers/r2-to-b2-archival");
  return archiveStaleImages({ dryRun: false, batchSize: 10, ageDays: 90, ...opts });
}

describe("R2 → B2 archival never records a false backup", () => {
  beforeEach(() => {
    process.env.R2_BUCKET_NAME = "test-bucket";
    r2Store.clear();
    b2Store.clear();
    uploadToB2Spy.mockClear();
    dbState.candidates = [];
    dbState.archivedUpdates = [];
    dbState.audits = [];
  });
  afterEach(() => vi.resetModules());

  it("T1: copies a partner certificate's front and back originals", async () => {
    dbState.candidates = [partnerCert()];
    r2Store.set(PARTNER_FRONT, Buffer.from("front-bytes"));
    r2Store.set(PARTNER_BACK, Buffer.from("back-bytes"));

    const summary = await runArchival();

    const copied = uploadToB2Spy.mock.calls.map((c) => c[0]);
    expect(copied).toContain(PARTNER_FRONT);
    expect(copied).toContain(PARTNER_BACK);
    expect(summary.errors).toBe(0);
    expect(dbState.archivedUpdates).toHaveLength(1);
  });

  it("T2: refuses when expected objects exist on the row but not in storage", async () => {
    dbState.candidates = [partnerCert()];
    // r2Store deliberately empty — the row names two keys that are not there.

    const summary = await runArchival();

    expect(uploadToB2Spy).not.toHaveBeenCalled();
    // The single most important assertion in this file.
    expect(dbState.archivedUpdates).toHaveLength(0);
    expect(summary.errors).toBe(1);
    expect(dbState.audits.join(" ")).toContain("archive_failed");
  });

  it("T3: refuses when a decoy object is present but the partner originals are not", async () => {
    dbState.candidates = [partnerCert()];
    // A label under the legacy prefix makes the result set NON-empty, so this takes the SUCCESS
    // path. Without the success-branch gate the certificate is marked archived here.
    r2Store.set("images/MV9001/label.png", Buffer.from("label"));

    const summary = await runArchival();

    expect(dbState.archivedUpdates).toHaveLength(0);
    expect(summary.errors).toBe(1);
    expect(dbState.audits.join(" ")).toContain("expected_keys_not_copied");
  });

  it("T4: an HQ certificate under the legacy prefix still archives (no over-correction)", async () => {
    dbState.candidates = [
      {
        id: 42,
        certificate_number: "MV42",
        grade_approved_at: new Date("2026-01-01T00:00:00Z"),
        front_image_path: "images/MV42/front.jpg",
        back_image_path: null,
        grading_front_original: null,
        grading_back_original: null,
      },
    ];
    r2Store.set("images/MV42/front.jpg", Buffer.from("hq-front"));

    const summary = await runArchival();

    expect(uploadToB2Spy.mock.calls.map((c) => c[0])).toContain("images/MV42/front.jpg");
    expect(dbState.archivedUpdates).toHaveLength(1);
    expect(summary.errors).toBe(0);
  });

  it("T5: a genuinely imageless certificate is still marked archived", async () => {
    dbState.candidates = [
      {
        id: 7,
        certificate_number: "MV7",
        grade_approved_at: new Date("2026-01-01T00:00:00Z"),
        front_image_path: null,
        back_image_path: null,
        grading_front_original: null,
        grading_back_original: null,
      },
    ];

    const summary = await runArchival();

    expect(dbState.archivedUpdates).toHaveLength(1);
    expect(dbState.audits.join(" ")).toContain("no_images_expected");
    expect(summary.errors).toBe(0);
  });

  it("T6: a failed destination copy leaves the row retryable", async () => {
    dbState.candidates = [partnerCert()];
    r2Store.set(PARTNER_FRONT, Buffer.from("front-bytes"));
    r2Store.set(PARTNER_BACK, Buffer.from("back-bytes"));
    // Accept the upload but never actually store it, so post-upload verification fails.
    uploadToB2Spy.mockImplementationOnce(async (key: string) => key);

    const summary = await runArchival();

    expect(dbState.archivedUpdates).toHaveLength(0);
    expect(summary.errors).toBe(1);
  });

  it("T7: a dry run copies nothing and marks nothing", async () => {
    dbState.candidates = [partnerCert()];
    await runArchival({ dryRun: true });
    expect(uploadToB2Spy).not.toHaveBeenCalled();
    expect(dbState.archivedUpdates).toHaveLength(0);
  });

  it("T8: a mixed batch archives the HQ cert and refuses the partner cert", async () => {
    dbState.candidates = [
      partnerCert(9002, "MV9002"),
      {
        id: 43,
        certificate_number: "MV43",
        grade_approved_at: new Date("2026-01-01T00:00:00Z"),
        front_image_path: "images/MV43/front.jpg",
        back_image_path: null,
        grading_front_original: null,
        grading_back_original: null,
      },
    ];
    r2Store.set("images/MV43/front.jpg", Buffer.from("hq"));

    const summary = await runArchival();

    // Exactly one archived (the HQ cert), one refused (the partner cert).
    expect(dbState.archivedUpdates).toHaveLength(1);
    expect(summary.errors).toBe(1);
  });
});
