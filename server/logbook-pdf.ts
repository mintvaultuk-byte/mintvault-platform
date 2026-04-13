/**
 * MintVault Ownership Logbook — continuous-flow PDF generator.
 * Single document with thin gold hairline dividers between sections.
 * Content flows across pages naturally — no forced page breaks.
 */
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import path from "path";
import { buildLogbookData } from "./logbook-service";

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 50;
const CW = PAGE_W - M * 2;

const GOLD = "#D4AF37";
const GOLD_DARK = "#B8960C";
const CHARCOAL = "#1A1A1A";
const GRAY = "#888888";
const MUTED = "#555555";
const TEXT = "#222222";

const LOGO_PATH = path.join(process.cwd(), "public", "brand", "logo.png");

function safe(v: any, fallback = "\u2014"): string {
  if (v === null || v === undefined || v === "") return fallback;
  return String(v);
}

async function generateQR(url: string, size: number): Promise<Buffer> {
  return QRCode.toBuffer(url, { width: size, margin: 1, color: { dark: "#000000", light: "#FFFFFF" }, errorCorrectionLevel: "H" });
}

/** Check if we need a new page — if y is within bottomMargin of page bottom, add page and reset y */
function ensureSpace(doc: PDFKit.PDFDocument, y: number, needed: number): number {
  if (y + needed > PAGE_H - 60) {
    doc.addPage();
    return M;
  }
  return y;
}

/** Thin gold hairline divider with spacing */
function divider(doc: PDFKit.PDFDocument, y: number): number {
  y += 8;
  doc.save().rect(M, y, CW, 0.5).fill(GOLD).restore();
  return y + 12;
}

/** Section title — small caps gold with underline */
function section(doc: PDFKit.PDFDocument, y: number, title: string): number {
  y = ensureSpace(doc, y, 30);
  doc.font("Helvetica-Bold").fontSize(7).fillColor(GOLD).text(title.toUpperCase(), M, y, { characterSpacing: 2.5 });
  return y + 14;
}

/** Label:value field row */
function field(doc: PDFKit.PDFDocument, y: number, label: string, value: string): number {
  y = ensureSpace(doc, y, 14);
  doc.font("Helvetica").fontSize(6.5).fillColor(GRAY).text(label, M, y);
  doc.font("Helvetica-Bold").fontSize(8).fillColor(TEXT).text(value, M + 110, y - 0.5);
  return y + 13;
}

export async function generateLogbookPdf(certIdInput: string): Promise<Buffer | null> {
  const data = await buildLogbookData(certIdInput);
  if (!data) return null;

  const { certId, card, grades, centering, defects, gradingReport, images, provenance, verification } = data;
  const ownership = (data as any).ownership;

  return new Promise(async (resolve, reject) => {
    try {
      const qrBuf = await generateQR(verification.verifyUrl + `?sig=${verification.signature}`, 180);

      let frontImgBuf: Buffer | null = null;
      let backImgBuf: Buffer | null = null;
      if (images.front) { try { const r = await fetch(images.front); frontImgBuf = Buffer.from(await r.arrayBuffer()); } catch {} }
      if (images.back) { try { const r = await fetch(images.back); backImgBuf = Buffer.from(await r.arrayBuffer()); } catch {} }

      const doc = new PDFDocument({
        size: "A4",
        margins: { top: M, bottom: 40, left: M, right: M },
        info: {
          Title: `MintVault Logbook \u2014 ${certId}`,
          Author: "MintVault UK",
          Subject: `${safe(card.name)} \u2014 Grade ${safe(grades.overall)}`,
        },
        bufferPages: true,
      });

      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const gradeStr = String(grades.overall);
      const gradeLabel = grades.gradeLabel;
      let y = M;

      // ── COVER BLOCK ──────────────────────────────────────────────────────────
      // Outer gold frame on page 1 only
      const bw = 3;
      doc.rect(0, 0, PAGE_W, bw).fill(GOLD);
      doc.rect(0, PAGE_H - bw, PAGE_W, bw).fill(GOLD);
      doc.rect(0, 0, bw, PAGE_H).fill(GOLD);
      doc.rect(PAGE_W - bw, 0, bw, PAGE_H).fill(GOLD);

      // Logo
      try {
        doc.image(LOGO_PATH, (PAGE_W - 80) / 2, y, { width: 80 });
        y += 45;
      } catch { y += 10; }

      // Wordmark — well below logo
      doc.font("Helvetica").fontSize(6).fillColor(GOLD).text("OWNERSHIP LOGBOOK", M, y, { width: CW, align: "center", characterSpacing: 5 });
      y += 18;

      // Thin hairline
      doc.save().rect(M + CW * 0.3, y, CW * 0.4, 0.5).fill(GOLD).restore();
      y += 14;

      // Card name
      doc.font("Helvetica-Bold").fontSize(18).fillColor(CHARCOAL)
        .text(safe(card.name, "Certificate"), M, y, { width: CW, align: "center" });
      y += 24;

      // Set + number subtitle
      doc.font("Helvetica").fontSize(9).fillColor(GRAY)
        .text(`${safe(card.set)} ${card.number ? `#${card.number}` : ""} ${card.year ? `(${card.year})` : ""}`.trim(), M, y, { width: CW, align: "center" });
      y += 18;

      // Grade
      doc.font("Helvetica-Bold").fontSize(36).fillColor(GOLD)
        .text(gradeStr, M, y, { width: CW, align: "center" });
      y += 42;
      doc.font("Helvetica-Bold").fontSize(8).fillColor(GOLD_DARK)
        .text(gradeLabel, M, y, { width: CW, align: "center", characterSpacing: 2 });
      y += 12;
      if (grades.isBlackLabel) {
        doc.font("Helvetica-Bold").fontSize(7).fillColor(CHARCOAL)
          .text("BLACK LABEL", M, y, { width: CW, align: "center", characterSpacing: 3 });
        y += 12;
      }

      // Cert ID + date
      y += 6;
      doc.font("Courier-Bold").fontSize(9).fillColor(TEXT)
        .text(certId, M, y, { width: CW, align: "center" });
      y += 14;
      if (provenance.issuedAt) {
        doc.font("Helvetica").fontSize(6.5).fillColor(GRAY)
          .text(`Issued ${new Date(provenance.issuedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`, M, y, { width: CW, align: "center" });
        y += 10;
      }

      // ── CARD IDENTITY ──────────────────────────────────────────────────────────
      y = divider(doc, y);
      y = section(doc, y, "Card Identity");
      y = field(doc, y, "Card Name", safe(card.name));
      y = field(doc, y, "Game", safe(card.game));
      y = field(doc, y, "Set", safe(card.set));
      y = field(doc, y, "Card Number", safe(card.number));
      y = field(doc, y, "Year", safe(card.year));
      if (card.variant) y = field(doc, y, "Variant", card.variant);
      y = field(doc, y, "Rarity", safe(card.rarity));
      y = field(doc, y, "Language", safe(card.language));
      if (card.designations.length > 0) y = field(doc, y, "Designations", card.designations.join(", "));

      // ── GRADE ANALYSIS ─────────────────────────────────────────────────────────
      y = divider(doc, y);
      y = section(doc, y, "Grade Analysis");
      y = ensureSpace(doc, y, 45);

      // Overall + subgrades in a row
      doc.font("Helvetica-Bold").fontSize(22).fillColor(GOLD).text(gradeStr, M, y, { width: 60, align: "center" });
      doc.font("Helvetica").fontSize(6).fillColor(GOLD_DARK).text(gradeLabel, M, y + 26, { width: 60, align: "center" });

      const subX = M + 80;
      const subW = (CW - 80) / 4;
      const subLabels = ["Centering", "Corners", "Edges", "Surface"];
      const subValues = [grades.centering, grades.corners, grades.edges, grades.surface];
      for (let i = 0; i < 4; i++) {
        const sx = subX + i * subW;
        doc.font("Helvetica").fontSize(5.5).fillColor(GRAY).text(subLabels[i].toUpperCase(), sx, y, { width: subW, align: "center" });
        doc.font("Helvetica-Bold").fontSize(14).fillColor(TEXT).text(safe(subValues[i]), sx, y + 8, { width: subW, align: "center" });
      }
      y += 38;

      // Centering ratios
      if (centering.frontLR || centering.backLR) {
        y = ensureSpace(doc, y, 50);
        doc.font("Helvetica").fontSize(6).fillColor(MUTED).text("CENTERING", M, y, { characterSpacing: 1 }); y += 10;
        if (centering.frontLR) y = field(doc, y, "Front L/R", centering.frontLR);
        if (centering.frontTB) y = field(doc, y, "Front T/B", centering.frontTB);
        if (centering.backLR) y = field(doc, y, "Back L/R", centering.backLR);
        if (centering.backTB) y = field(doc, y, "Back T/B", centering.backTB);
      }

      // Grader notes
      const hasNotes = gradingReport.overall || gradingReport.centering || gradingReport.corners || gradingReport.edges || gradingReport.surface;
      if (hasNotes) {
        y += 4;
        doc.font("Helvetica").fontSize(6).fillColor(MUTED).text("GRADER NOTES", M, y, { characterSpacing: 1 }); y += 10;
        for (const [k, v] of [["Centering", gradingReport.centering], ["Corners", gradingReport.corners], ["Edges", gradingReport.edges], ["Surface", gradingReport.surface], ["Overall", gradingReport.overall]] as const) {
          if (v) {
            y = ensureSpace(doc, y, 12);
            doc.font("Helvetica").fontSize(6.5).fillColor(TEXT).text(`${k}: ${v}`, M, y, { width: CW }); y += 11;
          }
        }
      }

      // ── AUTHENTICATION ─────────────────────────────────────────────────────────
      y = divider(doc, y);
      y = section(doc, y, "Authentication");
      const authLabel = data.authentication.status === "genuine" ? "Genuine" : data.authentication.status === "authentic_altered" ? "Authentic Altered" : "Not Original";
      y = field(doc, y, "Status", authLabel);
      if (data.authentication.notes) {
        y = ensureSpace(doc, y, 14);
        doc.font("Helvetica").fontSize(6.5).fillColor(TEXT).text(data.authentication.notes, M, y, { width: CW }); y += 14;
      }

      // ── CONDITION ──────────────────────────────────────────────────────────────
      y = divider(doc, y);
      y = section(doc, y, "Condition Report");
      if (defects.length === 0) {
        doc.font("Helvetica").fontSize(7).fillColor(GRAY).text("No defects recorded.", M, y); y += 12;
      } else {
        doc.font("Helvetica").fontSize(6.5).fillColor(GRAY).text(`${defects.length} defect${defects.length !== 1 ? "s" : ""} detected:`, M, y); y += 11;
        for (const d of defects) {
          y = ensureSpace(doc, y, 14);
          doc.font("Helvetica-Bold").fontSize(6.5).fillColor(TEXT).text(d.type, M + 5, y);
          doc.font("Helvetica").fontSize(6.5).fillColor(GRAY).text(`${d.location} \u2014 ${d.severity}`, M + 100, y);
          y += 11;
        }
      }

      // ── CARD IMAGES ────────────────────────────────────────────────────────────
      if (frontImgBuf || backImgBuf) {
        y = divider(doc, y);
        y = section(doc, y, "Card Images");
        // Images need space — check if we should start a new page
        y = ensureSpace(doc, y, 250);
        const imgH = 220;
        const imgW = (CW - 15) / 2;
        if (frontImgBuf && backImgBuf) {
          try { doc.image(frontImgBuf, M, y, { fit: [imgW, imgH] }); } catch {}
          try { doc.image(backImgBuf, M + imgW + 15, y, { fit: [imgW, imgH] }); } catch {}
        } else {
          const buf = frontImgBuf || backImgBuf;
          if (buf) try { doc.image(buf, M + CW * 0.15, y, { fit: [CW * 0.7, imgH] }); } catch {}
        }
        y += imgH + 5;
      }

      // ── OWNERSHIP HISTORY ──────────────────────────────────────────────────────
      if (ownership?.chain?.length > 0) {
        y = divider(doc, y);
        y = section(doc, y, "Ownership History");
        doc.font("Helvetica").fontSize(6.5).fillColor(GRAY)
          .text(`${ownership.previousOwnersCount} previous owner${ownership.previousOwnersCount !== 1 ? "s" : ""}`, M, y);
        y += 11;
        for (const owner of ownership.chain as any[]) {
          y = ensureSpace(doc, y, 12);
          const marker = owner.isCurrent ? "\u25CF" : "\u25CB";
          const name = owner.displayName ? ` \u2014 ${owner.displayName}` : "";
          const dateStr = new Date(owner.claimedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
          const endStr = owner.releasedAt
            ? ` to ${new Date(owner.releasedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} (${owner.durationDays}d)`
            : " (Current)";
          doc.font("Helvetica").fontSize(7).fillColor(owner.isCurrent ? GOLD : TEXT)
            .text(`${marker} Owner ${owner.ownerNumber}${name} \u2014 ${dateStr}${endStr}`, M + 5, y, { width: CW - 10 });
          y += 12;
        }
      }

      // ── VERIFICATION ───────────────────────────────────────────────────────────
      y = divider(doc, y);
      y = section(doc, y, "Verification");
      y = ensureSpace(doc, y, 130);

      doc.font("Helvetica").fontSize(6).fillColor(GRAY)
        .text("This logbook is cryptographically signed. Verify at the URL or scan the QR code.", M, y, { width: CW });
      y += 12;

      // QR + signature side by side
      try { doc.image(qrBuf, M, y, { width: 70 }); } catch {}

      const sigX = M + 85;
      doc.font("Helvetica").fontSize(5.5).fillColor(MUTED).text("SIGNATURE", sigX, y);
      doc.font("Courier").fontSize(5.5).fillColor(TEXT).text(verification.signature || "\u2014", sigX, y + 9, { width: CW - 90 });
      doc.font("Helvetica").fontSize(5.5).fillColor(MUTED).text("VERIFY", sigX, y + 22);
      doc.font("Courier").fontSize(5.5).fillColor(GOLD_DARK).text(verification.verifyUrl, sigX, y + 31, { width: CW - 90 });
      y += 75;

      y = ensureSpace(doc, y, 40);
      doc.font("Helvetica").fontSize(5).fillColor(GRAY).text(
        "This Ownership Logbook is an official record issued by MintVault Ltd. The cryptographic signature covers the certificate ID, card identity, and all grade data. Any modification invalidates the signature. This document does not constitute a guarantee of future value.",
        M, y, { width: CW, align: "center", lineGap: 1.5 }
      );

      // Page footers
      const totalPages = doc.bufferedPageRange().count;
      for (let i = 0; i < totalPages; i++) {
        doc.switchToPage(i);
        doc.font("Helvetica").fontSize(5.5).fillColor(MUTED)
          .text(`MintVault Logbook \u2014 ${certId}`, M, PAGE_H - 25, { width: CW / 2, align: "left" })
          .text(`${i + 1} / ${totalPages}`, M + CW / 2, PAGE_H - 25, { width: CW / 2, align: "right" });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
