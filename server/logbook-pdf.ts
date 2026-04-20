/**
 * MintVault Ownership Logbook — absolute-positioned single-page A4 PDF.
 * Every text/image call uses explicit (x, y) coordinates with fixed advance.
 * Never relies on pdfkit auto-pagination — all y values clamped to HARD_MAX_Y.
 * Owner variant includes Document Reference Number + forensic watermark.
 */
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import path from "path";
import sharp from "sharp";
import { buildLogbookData } from "./logbook-service";

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 40;
const CW = PAGE_W - M * 2;
const HARD_MAX_Y = 815; // absolute limit — nothing renders below this
const GOLD = "#D4AF37";
const GOLD_DARK = "#B8960C";
const CHARCOAL = "#1A1A1A";
const GRAY = "#888888";
const MUTED = "#555555";
const TEXT = "#222222";
const LOGO_PATH = path.join(process.cwd(), "public", "brand", "logo.png");

const s = (v: any, fb = "\u2014") => (v == null || v === "") ? fb : String(v);

function titleCase(str: string | null | undefined): string {
  if (!str) return "\u2014";
  const specials: Record<string, string> = { pokemon: "Pok\u00e9mon", "pokémon": "Pok\u00e9mon" };
  return str.split(" ").map(w => specials[w.toLowerCase()] || (w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(" ");
}

async function qr(url: string): Promise<Buffer> {
  return QRCode.toBuffer(url, { width: 140, margin: 1, color: { dark: "#000", light: "#fff" }, errorCorrectionLevel: "H" });
}

/**
 * Resize card scan images before embedding in the PDF.
 * Card scans are typically 3000-5000px wide at 2-5MB each; pdfkit embeds them
 * uncompressed, so without this resize logbooks balloon to 10-20MB.
 *
 * Target: 1500px longest edge, JPEG quality 82 → typically ~200-400KB.
 * Preserves aspect ratio, strips EXIF, converts to sRGB.
 *
 * Returns the original buffer on any sharp error (graceful degradation —
 * customer still gets a working PDF, just a larger one).
 */
async function resizeForPdf(buf: Buffer): Promise<Buffer> {
  try {
    return await sharp(buf)
      .rotate() // respect EXIF orientation before strip
      .resize({
        width: 1500,
        height: 1500,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 82, mozjpeg: true, progressive: true })
      .toBuffer();
  } catch (err: any) {
    console.error("[logbook-pdf] image resize failed, using original:", err?.message);
    return buf;
  }
}

export interface LogbookPdfOptions { includeReferenceNumber?: boolean; }

export async function generateLogbookPdf(certIdInput: string, opts: LogbookPdfOptions = {}): Promise<Buffer | null> {
  const data = await buildLogbookData(certIdInput);
  if (!data) return null;

  const { certId, card, grades, centering, defects, images, provenance, verification } = data;
  const ownership = (data as any).ownership;
  const gradeStr = String(grades.overall);
  const gradeLabel = grades.gradeLabel;

  return new Promise(async (resolve, reject) => {
    try {
      const qrBuf = await qr(verification.verifyUrl + `?sig=${verification.signature}`);
      let fBuf: Buffer | null = null, bBuf: Buffer | null = null;
      if (images.front) {
        try {
          const raw = Buffer.from(await (await fetch(images.front)).arrayBuffer());
          fBuf = await resizeForPdf(raw);
        } catch {}
      }
      if (images.back) {
        try {
          const raw = Buffer.from(await (await fetch(images.back)).arrayBuffer());
          bBuf = await resizeForPdf(raw);
        } catch {}
      }

      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 25, bottom: 20, left: M, right: M },
        info: { Title: `MintVault Logbook \u2014 ${certId}`, Author: "MintVault UK" },
        bufferPages: true,
      });

      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => {
        const pdfBuffer = Buffer.concat(chunks);
        console.log(`[logbook-pdf] ${certId}: generated ${Math.round(pdfBuffer.length / 1024)} KB`);
        resolve(pdfBuffer);
      });
      doc.on("error", reject);

      let y = 25;
      const clipped: string[] = [];

      // Hard clamp — returns false if section won't fit, logs warning
      function fits(need: number, name: string): boolean {
        if (y + need > HARD_MAX_Y) { clipped.push(name); console.warn(`[logbook-pdf] ${certId}: clipped at "${name}" (y=${Math.round(y)}, need=${need}, max=${HARD_MAX_Y})`); return false; }
        return true;
      }
      function hr() { y += 3; doc.save().rect(M, y, CW, 0.35).fill(GOLD).restore(); y += 5; }
      function hd(t: string) { doc.font("Helvetica-Bold").fontSize(5.5).fillColor(GOLD).text(t.toUpperCase(), M, y, { width: CW, height: 8, characterSpacing: 1.5 }); y += 8; }
      function rw(l: string, v: string) { doc.font("Helvetica").fontSize(5).fillColor(GRAY).text(l, M, y, { width: 85, height: 8 }); doc.font("Helvetica-Bold").fontSize(6).fillColor(TEXT).text(v, M + 85, y - 0.5, { width: CW - 85, height: 8 }); y += 9; }
      function sm(t: string, col = GRAY, sz = 4.5) { doc.font("Helvetica").fontSize(sz).fillColor(col).text(t, M, y, { width: CW, height: 40, ellipsis: true, lineGap: 0.5 }); y += Math.min(35, Math.ceil(t.length / 130) * 6 + 3); }

      // ── COVER (budget: ~130pt) ─────────────────────────────────────────────
      try { doc.image(LOGO_PATH, (PAGE_W - 32) / 2, y, { width: 32, height: 32 }); } catch {}
      y += 38; // clear logo + embedded subtext
      doc.font("Helvetica").fontSize(4.5).fillColor(GOLD).text("OWNERSHIP LOGBOOK", M, y, { width: CW, align: "center", height: 7, characterSpacing: 3.5 }); y += 8;
      doc.save().rect(M + CW * 0.35, y, CW * 0.3, 0.35).fill(GOLD).restore(); y += 6;
      doc.font("Helvetica-Bold").fontSize(12).fillColor(CHARCOAL).text(titleCase(card.name), M, y, { width: CW, align: "center", height: 15 }); y += 15;
      doc.font("Helvetica").fontSize(6.5).fillColor(GRAY).text(`${s(card.set)} ${card.number ? `#${card.number}` : ""} ${card.year ? `(${card.year})` : ""}`.trim(), M, y, { width: CW, align: "center", height: 9 }); y += 10;
      doc.font("Helvetica-Bold").fontSize(22).fillColor(GOLD).text(gradeStr, M, y, { width: CW, align: "center", height: 25 }); y += 26;
      doc.font("Helvetica-Bold").fontSize(6).fillColor(GOLD_DARK).text(gradeLabel, M, y, { width: CW, align: "center", height: 8, characterSpacing: 1.5 }); y += 8;
      if (grades.isBlackLabel) { doc.font("Helvetica-Bold").fontSize(5).fillColor(CHARCOAL).text("BLACK LABEL", M, y, { width: CW, align: "center", height: 7, characterSpacing: 2.5 }); y += 7; }
      doc.font("Courier-Bold").fontSize(7).fillColor(TEXT).text(certId, M, y, { width: CW, align: "center", height: 9 }); y += 9;
      const ver = (data as any).logbookVersion || 1;
      const iDate = provenance.issuedAt ? new Date(provenance.issuedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : null;
      doc.font("Helvetica").fontSize(4.5).fillColor(GRAY).text(`Logbook v${ver}${iDate ? ` \u00B7 Issued ${iDate}` : ""}`, M, y, { width: CW, align: "center", height: 7 }); y += 6;

      // ── CARD IDENTITY (budget: ~80pt) ──────────────────────────────────────
      if (fits(80, "Card Identity")) {
        hr(); hd("Card Identity");
        rw("Card Name", titleCase(card.name)); rw("Game", titleCase(card.game)); rw("Set", s(card.set));
        rw("Number", s(card.number)); rw("Year", s(card.year));
        if (card.variant) rw("Variant", card.variant);
        rw("Rarity", s(card.rarity)); rw("Language", s(card.language));
      }

      // ── GRADE ANALYSIS (budget: ~45pt) ─────────────────────────────────────
      const hasSubgrades = grades.centering != null || grades.corners != null || grades.edges != null || grades.surface != null;
      if (fits(hasSubgrades ? 45 : 30, "Grade Analysis")) {
        hr(); hd("Grade Analysis");
        doc.font("Helvetica-Bold").fontSize(14).fillColor(GOLD).text(gradeStr, M, y, { width: hasSubgrades ? 40 : CW, align: "center", height: 16 });
        doc.font("Helvetica").fontSize(4).fillColor(GOLD_DARK).text(gradeLabel, M, y + 16, { width: hasSubgrades ? 40 : CW, align: "center", height: 6 });
        if (hasSubgrades) {
          const sx = M + 55; const sw = (CW - 55) / 4;
          ["Centering", "Corners", "Edges", "Surface"].forEach((l, i) => {
            const v = [grades.centering, grades.corners, grades.edges, grades.surface][i];
            doc.font("Helvetica").fontSize(4).fillColor(GRAY).text(l.toUpperCase(), sx + i * sw, y, { width: sw, align: "center", height: 6 });
            doc.font("Helvetica-Bold").fontSize(10).fillColor(TEXT).text(s(v), sx + i * sw, y + 5, { width: sw, align: "center", height: 12 });
          });
        }
        y += 24;
        // Centering single line (only if subgrades exist)
        if (hasSubgrades) {
          const cp = [centering.frontLR && `Front L/R: ${centering.frontLR}`, centering.frontTB && `T/B: ${centering.frontTB}`, centering.backLR && `Back L/R: ${centering.backLR}`, centering.backTB && `T/B: ${centering.backTB}`].filter(Boolean);
          if (cp.length) { doc.font("Helvetica").fontSize(4.5).fillColor(MUTED).text(cp.join("  \u00B7  "), M, y, { width: CW, height: 7 }); y += 7; }
        }
      }

      // ── AUTH + CONDITION (budget: ~30pt) ────────────────────────────────────
      if (fits(25, "Auth & Condition")) {
        hr(); hd("Authentication & Condition");
        const al = data.authentication.status === "genuine" ? "Genuine" : data.authentication.status === "authentic_altered" ? "Authentic Altered" : "Not Original";
        rw("Auth Status", al);
        if (defects.length === 0) { rw("Defects", "None recorded"); }
        else {
          rw("Defects", `${defects.length} detected`);
          for (const d of defects.slice(0, 2)) { doc.font("Helvetica").fontSize(4.5).fillColor(TEXT).text(`\u2022 ${d.type} (${d.location}, ${d.severity})`, M + 6, y, { width: CW - 10, height: 7 }); y += 7; }
          if (defects.length > 2) { doc.font("Helvetica").fontSize(4).fillColor(MUTED).text(`+ ${defects.length - 2} more`, M + 6, y, { height: 6 }); y += 6; }
        }
      }

      // ── CARD IMAGES (budget: 165pt) ────────────────────────────────────────
      if ((fBuf || bBuf) && fits(165, "Card Images")) {
        hr(); hd("Card Images");
        const imgBoxH = 150; const imgBoxW = (CW - 10) / 2;
        if (fBuf && bBuf) {
          try { doc.image(fBuf, M, y, { fit: [imgBoxW, imgBoxH], align: "center", valign: "center" }); } catch {}
          try { doc.image(bBuf, M + imgBoxW + 10, y, { fit: [imgBoxW, imgBoxH], align: "center", valign: "center" }); } catch {}
        } else {
          const buf = fBuf || bBuf;
          if (buf) try { doc.image(buf, M + CW * 0.2, y, { fit: [CW * 0.6, imgBoxH], align: "center", valign: "center" }); } catch {}
        }
        y += imgBoxH + 5;
      }

      // ── OWNERSHIP (budget: ~20pt) ──────────────────────────────────────────
      if (ownership?.chain?.length > 0 && fits(18, "Ownership")) {
        hr(); hd("Ownership History");
        for (const o of (ownership.chain as any[]).slice(0, 3)) {
          if (y > HARD_MAX_Y - 10) break;
          const mk = o.isCurrent ? "\u25CF" : "\u25CB";
          const dt = new Date(o.claimedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
          const end = o.releasedAt ? ` to ${new Date(o.releasedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : " (Current)";
          doc.font("Helvetica").fontSize(5).fillColor(o.isCurrent ? GOLD : TEXT).text(`${mk} Owner ${o.ownerNumber} \u2014 ${dt}${end}`, M + 2, y, { width: CW - 4, height: 7 }); y += 8;
        }
      }

      // ── REGISTRATION DETAILS (budget: ~30pt) ───────────────────────────────
      if (fits(28, "Registration")) {
        hr(); hd("Registration Details");
        rw("Former Keepers", String(Math.max(0, (ownership?.chain?.length || 1) - 1)));
        rw("Declared new", "Not declared");
        if (provenance.issuedAt) rw("First registration", new Date(provenance.issuedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }));
      }

      // ── TRANSFER / LOSS (budget: ~35pt combined) ───────────────────────────
      if (fits(18, "Transfer")) {
        hr(); hd("Transfer Process");
        sm("To transfer ownership, the Registered Keeper must initiate at mintvaultuk.com/transfer using Certificate ID and Document Reference Number. New keeper confirms via email. Transfers finalise after 14-day dispute window.");
      }
      if (fits(14, "Loss/Theft")) {
        hr(); hd("Loss, Theft or Dispute");
        sm("Report loss, theft, or unauthorised transfer to support@mintvaultuk.com. Disputes within 14 days of transfer initiation.");
      }

      // ── OWNER-ONLY: REFERENCE NUMBER ───────────────────────────────────────
      if (opts.includeReferenceNumber) {
        const refNum = (data as any).referenceNumber;
        if (refNum && fits(40, "Reference Number")) {
          hr(); hd("Document Reference Number");
          const ry = y;
          doc.font("Courier-Bold").fontSize(13).fillColor(GOLD).text(refNum, M, y, { width: CW, align: "center", height: 16 }); y += 18;
          sm("Keep this number secret. Required to transfer ownership. Treat like a V5C. Report compromise to support@mintvaultuk.com.", MUTED, 4);
          // Forensic watermark
          const wm = `${(data as any).ownerEmail || "owner"} \u00B7 v${ver} \u00B7 ${new Date().toISOString().slice(0, 16)}`;
          doc.save(); doc.opacity(0.07); doc.translate(PAGE_W / 2, ry + 12); doc.rotate(-25);
          doc.font("Helvetica-Bold").fontSize(8).fillColor(CHARCOAL).text(wm, -CW / 2, 0, { width: CW, align: "center", height: 12 });
          doc.restore();
        }
      }

      // ── VERIFICATION (budget: ~50pt) ───────────────────────────────────────
      if (fits(48, "Verification")) {
        hr(); hd("Verification");
        try { doc.image(qrBuf, M, y, { width: 40, height: 40 }); } catch {}
        const vx = M + 50;
        doc.font("Helvetica").fontSize(4).fillColor(MUTED).text("SIGNATURE", vx, y, { height: 6 });
        doc.font("Courier").fontSize(3.5).fillColor(TEXT).text(verification.signature || "\u2014", vx, y + 5, { width: CW - 55, height: 6 });
        doc.font("Helvetica").fontSize(4).fillColor(MUTED).text("VERIFY", vx, y + 13, { height: 6 });
        doc.font("Courier").fontSize(3.5).fillColor(GOLD_DARK).text(verification.verifyUrl, vx, y + 18, { width: CW - 55, height: 6 });
        y += 42;
      }

      // ── BUYER BEWARE (budget: ~30pt) ───────────────────────────────────────
      if (fits(28, "Buyer Beware")) {
        hr(); hd("Buyer Beware");
        sm("Before accepting transfer: (1) Verify signature via QR. (2) Confirm Logbook Version matches seller's copy. (3) Do not pay until you receive a MintVault transfer email. (4) Report fraud to support@mintvaultuk.com.", TEXT, 4.5);
      }

      // ── DISCLAIMER ─────────────────────────────────────────────────────────
      if (fits(18, "Disclaimer")) {
        doc.font("Helvetica-Oblique").fontSize(3.5).fillColor(GRAY).text(
          "This logbook is the official record of grading, authentication, and registered keeper history. The Registered Keeper is recognised by MintVault as responsible for the card; distinct from legal ownership which may depend on external factors.",
          M, y, { width: CW, align: "center", height: 20, lineGap: 0.3 }
        );
      }

      // ── PAGE 1 BORDER + FOOTER (via bufferPages — always page 1) ──────────
      doc.switchToPage(0);
      doc.rect(0, 0, PAGE_W, 2).fill(GOLD);
      doc.rect(0, PAGE_H - 2, PAGE_W, 2).fill(GOLD);
      doc.rect(0, 0, 2, PAGE_H).fill(GOLD);
      doc.rect(PAGE_W - 2, 0, 2, PAGE_H).fill(GOLD);
      doc.font("Helvetica").fontSize(4).fillColor(MUTED)
        .text(`MintVault Logbook \u2014 ${certId}`, M, PAGE_H - 15, { width: CW / 2, align: "left", height: 6 })
        .text("mintvaultuk.com", M + CW / 2, PAGE_H - 15, { width: CW / 2, align: "right", height: 6 });

      // Diagnostic
      const range = doc.bufferedPageRange();
      if (range.count > 1) {
        console.error(`[logbook-pdf] ${certId}: OVERFLOW \u2014 ${range.count} pages generated despite clamp. Final y=${Math.round(y)}.`);
      }
      console.log(`[logbook-pdf] ${certId}: final y=${Math.round(y)}, pages=${range.count}, includeRef=${!!opts.includeReferenceNumber}${clipped.length ? `, clipped=[${clipped.join(",")}]` : ""}`);

      doc.end();
    } catch (err) { reject(err); }
  });
}
