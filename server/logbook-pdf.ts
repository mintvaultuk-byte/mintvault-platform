/**
 * MintVault Ownership Logbook — compact single-page A4 PDF.
 * All content flows naturally. No forced page breaks.
 * pdfkit auto-paginates only if content genuinely overflows.
 */
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import path from "path";
import { buildLogbookData } from "./logbook-service";

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 40; // tighter margins than before
const CW = PAGE_W - M * 2;
const GOLD = "#D4AF37";
const GOLD_DARK = "#B8960C";
const CHARCOAL = "#1A1A1A";
const GRAY = "#888888";
const MUTED = "#555555";
const TEXT = "#222222";
const LOGO_PATH = path.join(process.cwd(), "public", "brand", "logo.png");

const s = (v: any, fb = "\u2014") => (v === null || v === undefined || v === "") ? fb : String(v);

async function qr(url: string): Promise<Buffer> {
  return QRCode.toBuffer(url, { width: 150, margin: 1, color: { dark: "#000", light: "#fff" }, errorCorrectionLevel: "H" });
}

export async function generateLogbookPdf(certIdInput: string): Promise<Buffer | null> {
  const data = await buildLogbookData(certIdInput);
  if (!data) return null;

  const { certId, card, grades, centering, defects, gradingReport, images, provenance, verification } = data;
  const ownership = (data as any).ownership;
  const gradeStr = String(grades.overall);
  const gradeLabel = grades.gradeLabel;

  return new Promise(async (resolve, reject) => {
    try {
      const qrBuf = await qr(verification.verifyUrl + `?sig=${verification.signature}`);
      let frontBuf: Buffer | null = null, backBuf: Buffer | null = null;
      if (images.front) { try { frontBuf = Buffer.from(await (await fetch(images.front)).arrayBuffer()); } catch {} }
      if (images.back) { try { backBuf = Buffer.from(await (await fetch(images.back)).arrayBuffer()); } catch {} }

      const doc = new PDFDocument({
        size: "A4", margins: { top: 30, bottom: 25, left: M, right: M },
        info: { Title: `MintVault Logbook \u2014 ${certId}`, Author: "MintVault UK" },
        autoFirstPage: true,
      });

      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // Gold border frame (page 1 only — drawn at fixed coords)
      doc.rect(0, 0, PAGE_W, 2.5).fill(GOLD);
      doc.rect(0, PAGE_H - 2.5, PAGE_W, 2.5).fill(GOLD);
      doc.rect(0, 0, 2.5, PAGE_H).fill(GOLD);
      doc.rect(PAGE_W - 2.5, 0, 2.5, PAGE_H).fill(GOLD);

      let y = 28;

      // ── COVER ──────────────────────────────────────────────────────────────
      try { doc.image(LOGO_PATH, (PAGE_W - 50) / 2, y, { width: 50 }); y += 30; } catch { y += 8; }
      doc.font("Helvetica").fontSize(5.5).fillColor(GOLD).text("OWNERSHIP LOGBOOK", M, y, { width: CW, align: "center", characterSpacing: 4 }); y += 10;
      doc.save().rect(M + CW * 0.35, y, CW * 0.3, 0.4).fill(GOLD).restore(); y += 8;
      doc.font("Helvetica-Bold").fontSize(14).fillColor(CHARCOAL).text(s(card.name, "Certificate"), M, y, { width: CW, align: "center" }); y += 18;
      doc.font("Helvetica").fontSize(7.5).fillColor(GRAY).text(`${s(card.set)} ${card.number ? `#${card.number}` : ""} ${card.year ? `(${card.year})` : ""}`.trim(), M, y, { width: CW, align: "center" }); y += 12;
      doc.font("Helvetica-Bold").fontSize(28).fillColor(GOLD).text(gradeStr, M, y, { width: CW, align: "center" }); y += 32;
      doc.font("Helvetica-Bold").fontSize(7).fillColor(GOLD_DARK).text(gradeLabel, M, y, { width: CW, align: "center", characterSpacing: 2 }); y += 10;
      if (grades.isBlackLabel) { doc.font("Helvetica-Bold").fontSize(6).fillColor(CHARCOAL).text("BLACK LABEL", M, y, { width: CW, align: "center", characterSpacing: 3 }); y += 9; }
      doc.font("Courier-Bold").fontSize(8).fillColor(TEXT).text(certId, M, y, { width: CW, align: "center" }); y += 10;
      if (provenance.issuedAt) { doc.font("Helvetica").fontSize(5.5).fillColor(GRAY).text(`Issued ${new Date(provenance.issuedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`, M, y, { width: CW, align: "center" }); y += 8; }

      // ── Hairline helper ────────────────────────────────────────────────────
      function hr() { y += 5; doc.save().rect(M, y, CW, 0.4).fill(GOLD).restore(); y += 7; }
      function heading(t: string) { doc.font("Helvetica-Bold").fontSize(6).fillColor(GOLD).text(t.toUpperCase(), M, y, { characterSpacing: 2 }); y += 10; }
      function row(label: string, value: string) { doc.font("Helvetica").fontSize(6).fillColor(GRAY).text(label, M, y); doc.font("Helvetica-Bold").fontSize(7).fillColor(TEXT).text(value, M + 95, y - 0.5); y += 11; }

      // ── CARD IDENTITY ──────────────────────────────────────────────────────
      hr(); heading("Card Identity");
      row("Card Name", s(card.name)); row("Game", s(card.game)); row("Set", s(card.set));
      row("Number", s(card.number)); row("Year", s(card.year));
      if (card.variant) row("Variant", card.variant);
      row("Rarity", s(card.rarity)); row("Language", s(card.language));
      if (card.designations.length > 0) row("Designations", card.designations.join(", "));

      // ── GRADE ANALYSIS ─────────────────────────────────────────────────────
      hr(); heading("Grade Analysis");
      // Overall left, subgrades right
      doc.font("Helvetica-Bold").fontSize(18).fillColor(GOLD).text(gradeStr, M, y, { width: 50, align: "center" });
      doc.font("Helvetica").fontSize(5).fillColor(GOLD_DARK).text(gradeLabel, M, y + 20, { width: 50, align: "center" });
      const sx0 = M + 65; const sw = (CW - 65) / 4;
      ["Centering", "Corners", "Edges", "Surface"].forEach((lbl, i) => {
        const val = [grades.centering, grades.corners, grades.edges, grades.surface][i];
        doc.font("Helvetica").fontSize(5).fillColor(GRAY).text(lbl.toUpperCase(), sx0 + i * sw, y, { width: sw, align: "center" });
        doc.font("Helvetica-Bold").fontSize(12).fillColor(TEXT).text(s(val), sx0 + i * sw, y + 7, { width: sw, align: "center" });
      });
      y += 30;

      if (centering.frontLR || centering.backLR) {
        doc.font("Helvetica").fontSize(5).fillColor(MUTED).text("CENTERING", M, y, { characterSpacing: 1 }); y += 8;
        if (centering.frontLR) row("Front L/R", centering.frontLR);
        if (centering.frontTB) row("Front T/B", centering.frontTB);
        if (centering.backLR) row("Back L/R", centering.backLR);
        if (centering.backTB) row("Back T/B", centering.backTB);
      }

      // Grader notes (compact)
      const notes = [["Centering", gradingReport.centering], ["Corners", gradingReport.corners], ["Edges", gradingReport.edges], ["Surface", gradingReport.surface], ["Overall", gradingReport.overall]].filter(([, v]) => v) as [string, string][];
      if (notes.length > 0) {
        doc.font("Helvetica").fontSize(5).fillColor(MUTED).text("GRADER NOTES", M, y, { characterSpacing: 1 }); y += 8;
        for (const [k, v] of notes) { doc.font("Helvetica").fontSize(5.5).fillColor(TEXT).text(`${k}: ${v}`, M, y, { width: CW }); y += 9; }
      }

      // ── AUTH + CONDITION ────────────────────────────────────────────────────
      hr(); heading("Authentication & Condition");
      const al = data.authentication.status === "genuine" ? "Genuine" : data.authentication.status === "authentic_altered" ? "Authentic Altered" : "Not Original";
      row("Auth Status", al);
      if (defects.length === 0) { row("Defects", "None recorded"); }
      else {
        row("Defects", `${defects.length} detected`);
        for (const d of defects.slice(0, 6)) { // cap at 6 to save space
          doc.font("Helvetica").fontSize(5.5).fillColor(TEXT).text(`\u2022 ${d.type} (${d.location}, ${d.severity})`, M + 10, y, { width: CW - 15 }); y += 9;
        }
        if (defects.length > 6) { doc.font("Helvetica").fontSize(5).fillColor(MUTED).text(`+ ${defects.length - 6} more`, M + 10, y); y += 8; }
      }

      // ── CARD IMAGES ────────────────────────────────────────────────────────
      if (frontBuf || backBuf) {
        hr(); heading("Card Images");
        const imgH = 155;
        const imgW = (CW - 10) / 2;
        if (frontBuf && backBuf) {
          try { doc.image(frontBuf, M, y, { fit: [imgW, imgH] }); } catch {}
          try { doc.image(backBuf, M + imgW + 10, y, { fit: [imgW, imgH] }); } catch {}
        } else {
          const buf = frontBuf || backBuf;
          if (buf) try { doc.image(buf, M + CW * 0.2, y, { fit: [CW * 0.6, imgH] }); } catch {}
        }
        y += imgH + 3;
      }

      // ── OWNERSHIP ──────────────────────────────────────────────────────────
      if (ownership?.chain?.length > 0) {
        hr(); heading("Ownership History");
        for (const o of ownership.chain as any[]) {
          const mk = o.isCurrent ? "\u25CF" : "\u25CB";
          const dt = new Date(o.claimedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
          const end = o.releasedAt ? ` to ${new Date(o.releasedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : " (Current)";
          doc.font("Helvetica").fontSize(6).fillColor(o.isCurrent ? GOLD : TEXT).text(`${mk} Owner ${o.ownerNumber} \u2014 ${dt}${end}`, M + 3, y, { width: CW - 6 }); y += 10;
        }
      }

      // ── VERIFICATION ───────────────────────────────────────────────────────
      hr(); heading("Verification");
      doc.font("Helvetica").fontSize(5).fillColor(GRAY).text("Cryptographically signed. Scan QR or visit URL to verify.", M, y, { width: CW }); y += 8;
      try { doc.image(qrBuf, M, y, { width: 55 }); } catch {}
      const vx = M + 65;
      doc.font("Helvetica").fontSize(5).fillColor(MUTED).text("SIGNATURE", vx, y);
      doc.font("Courier").fontSize(4.5).fillColor(TEXT).text(verification.signature || "\u2014", vx, y + 7, { width: CW - 70 });
      doc.font("Helvetica").fontSize(5).fillColor(MUTED).text("VERIFY URL", vx, y + 17);
      doc.font("Courier").fontSize(4.5).fillColor(GOLD_DARK).text(verification.verifyUrl, vx, y + 24, { width: CW - 70 });
      y += 58;

      // Legal
      doc.font("Helvetica").fontSize(4.5).fillColor(GRAY).text(
        "This Ownership Logbook is an official record issued by MintVault Ltd. The cryptographic signature covers the certificate ID, card identity, and all grade data. Any modification invalidates the signature.",
        M, y, { width: CW, align: "center", lineGap: 1 }
      );

      // Footer
      doc.font("Helvetica").fontSize(5).fillColor(MUTED)
        .text(`MintVault Logbook \u2014 ${certId}`, M, PAGE_H - 20, { width: CW / 2, align: "left" })
        .text("mintvaultuk.com", M + CW / 2, PAGE_H - 20, { width: CW / 2, align: "right" });

      doc.end();
    } catch (err) { reject(err); }
  });
}
