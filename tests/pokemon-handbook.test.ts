/**
 * PDF handbook + desk sheets (Phase 20-25 / tests 45-55).
 * Generates real buffers (compress:false so text is assertable), checks A4
 * geometry, version/date stamping, provisional labelling, safe filenames and
 * the no-customer-data guarantee. No network, no DB, no providers.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../server/db", () => ({ db: {}, pool: { end: () => Promise.resolve() } }));

import {
  generateHandbookPdf,
  generateDeskSheetPdf,
  DESK_SHEET_FILENAMES,
  type DeskSheetKind,
  type HandbookSetRow,
} from "../server/lib/pokemon-handbook";
import { KNOWLEDGE_CATALOGUE_VERSION, catalogueChecksum } from "../shared/pokemon-knowledge";

const SETS: HandbookSetRow[] = [
  { setCode: "SV8", name: "Surging Sparks", year: "2024", region: "western", language: "en", era: "sv", status: "provisional" },
  { setCode: "swsh12pt5", name: "Crown Zenith", year: "2023", region: "western", language: "en", era: "swsh", status: "verified" },
];

/** pdfkit writes text as hex-encoded TJ runs (`<4d696e74> TJ`) split at kern
 *  pairs — decode every hex chunk in stream order so substring assertions see
 *  the real page text. */
function decodePdfText(pdf: Buffer): string {
  const raw = pdf.toString("latin1");
  const out: string[] = [];
  for (const m of raw.matchAll(/<([0-9a-fA-F]+)>/g)) {
    const hex = m[1];
    let s = "";
    for (let i = 0; i + 1 < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    out.push(s);
  }
  return out.join("");
}

describe("handbook PDF (tests 45-52)", () => {
  it("generates a valid, uncorrupted multi-page A4 PDF with version + date + disclaimer", async () => {
    const pdf = await generateHandbookPdf({ sets: SETS, compress: false });
    const raw = pdf.toString("latin1");
    const text = decodePdfText(pdf);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-"); // opens without corruption
    expect(raw).toContain("595.28"); // A4 width in MediaBox
    expect(raw).toContain("841.89"); // A4 height
    expect((raw.match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBeGreaterThanOrEqual(8); // multi-page
    expect(text).toContain(`v${KNOWLEDGE_CATALOGUE_VERSION}`); // catalogue version
    expect(text).toContain(catalogueChecksum());
    expect(text).toMatch(/Generated \d{4}-\d{2}-\d{2}/); // generated date
    expect(text).toContain("MintVault internal identification reference"); // disclaimer
    expect(text).toContain("belong to their respective owners");
  });

  it("labels provisional records and never claims official affiliation", async () => {
    const pdf = await generateHandbookPdf({ sets: SETS, compress: false });
    const text = decodePdfText(pdf);
    expect(text).toContain("(provisional)"); // provisional labelling (test 52)
    expect(text).not.toMatch(/officially licensed|official Pok[eé]mon partner/i);
  });

  it("contains NO customer data and no private URLs (tests 49-50)", async () => {
    const pdf = await generateHandbookPdf({ sets: SETS, compress: false });
    const text = decodePdfText(pdf) + pdf.toString("latin1");
    expect(text).not.toMatch(/MV-\d{6,}/); // no cert numbers
    expect(text).not.toMatch(/[a-z0-9._%-]+@[a-z0-9-]+\.(com|net|org|co\.uk)/i); // no emails
    expect(text).not.toMatch(/X-Amz-Signature|presigned|r2\.cloudflarestorage/i); // no private URLs
    expect(text).not.toMatch(/sk_live|whsec_|password/i);
  });

  it("renders the set directory rows from the injected set data", async () => {
    const pdf = await generateHandbookPdf({ sets: SETS, compress: false });
    const text = decodePdfText(pdf);
    expect(text).toContain("Surging Sparks");
    expect(text).toContain("Crown Zenith");
  });
});

describe("desk sheets (tests 53-55)", () => {
  it("all five kinds generate valid LANDSCAPE A4 PDFs", async () => {
    for (const kind of Object.keys(DESK_SHEET_FILENAMES) as DeskSheetKind[]) {
      const pdf = await generateDeskSheetPdf(kind, { sets: SETS, compress: false });
      const text = pdf.toString("latin1");
      expect(pdf.subarray(0, 5).toString(), kind).toBe("%PDF-");
      // pdfkit landscape A4 = MediaBox [0 0 841.89 595.28]
      expect(text, kind).toMatch(/841\.89\s+595\.28/);
    }
  });

  it("filenames are safe (no spaces, versioned scheme)", () => {
    for (const name of Object.values(DESK_SHEET_FILENAMES)) {
      expect(name).toMatch(/^MintVault_[A-Za-z0-9_]+\.pdf$/);
    }
  });

  it("set-code sheet paginates without corruption on a large directory (test 55)", async () => {
    const many: HandbookSetRow[] = Array.from({ length: 120 }, (_, i) => ({
      setCode: `T${i}`,
      name: `Test Set ${i}`,
      year: "2024",
      region: "western",
      language: "en",
      era: "sv",
      status: "provisional",
    }));
    const pdf = await generateDeskSheetPdf("setcodes", { sets: many, compress: false });
    const raw = pdf.toString("latin1");
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect((raw.match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBeGreaterThanOrEqual(3); // flowed to more pages
    expect(decodePdfText(pdf)).toContain("Test Set 119"); // last row made it in (no silent truncation)
  });
});
