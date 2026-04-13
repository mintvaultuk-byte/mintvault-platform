/**
 * MintVault Ownership Logbook — multi-page PDF generator.
 * Uses pdfkit (already installed). Mirrors certificate-document.ts patterns.
 */
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import path from "path";
import { buildLogbookData } from "./logbook-service";

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 50; // margin
const CW = PAGE_W - M * 2; // content width

const GOLD = "#D4AF37";
const GOLD_DARK = "#B8960C";
const BLACK = "#0A0A0A";
const CHARCOAL = "#1A1A1A";
const GRAY = "#888888";
const MUTED = "#555555";
const TEXT = "#222222";

const LOGO_PATH = path.join(process.cwd(), "public", "brand", "logo.png");

function safe(v: any, fallback = "—"): string {
  if (v === null || v === undefined || v === "") return fallback;
  return String(v);
}

async function generateQR(url: string, size: number): Promise<Buffer> {
  return QRCode.toBuffer(url, { width: size, margin: 1, color: { dark: "#000000", light: "#FFFFFF" }, errorCorrectionLevel: "H" });
}

function goldLine(doc: PDFKit.PDFDocument, y: number) {
  doc.save().rect(M, y, CW, 0.5).fill(GOLD).restore();
}

function sectionTitle(doc: PDFKit.PDFDocument, y: number, title: string): number {
  doc.font("Helvetica-Bold").fontSize(8).fillColor(GOLD).text(title.toUpperCase(), M, y, { characterSpacing: 3 });
  goldLine(doc, y + 14);
  return y + 22;
}

function fieldRow(doc: PDFKit.PDFDocument, y: number, label: string, value: string): number {
  doc.font("Helvetica").fontSize(7).fillColor(GRAY).text(label, M, y);
  doc.font("Helvetica-Bold").fontSize(9).fillColor(TEXT).text(value, M + 120, y - 1);
  return y + 16;
}

function drawBorder(doc: PDFKit.PDFDocument) {
  const bw = 4;
  doc.rect(0, 0, PAGE_W, bw).fill(GOLD);
  doc.rect(0, PAGE_H - bw, PAGE_W, bw).fill(GOLD);
  doc.rect(0, 0, bw, PAGE_H).fill(GOLD);
  doc.rect(PAGE_W - bw, 0, bw, PAGE_H).fill(GOLD);
}

function pageFooter(doc: PDFKit.PDFDocument, pageNum: number, totalPages: number, certId: string) {
  doc.font("Helvetica").fontSize(6).fillColor(MUTED)
    .text(`MintVault Ownership Logbook — ${certId}`, M, PAGE_H - 30, { width: CW / 2, align: "left" })
    .text(`Page ${pageNum} of ${totalPages}`, M + CW / 2, PAGE_H - 30, { width: CW / 2, align: "right" });
}

export async function generateLogbookPdf(certIdInput: string): Promise<Buffer | null> {
  const data = await buildLogbookData(certIdInput);
  if (!data) return null;

  const { certId, card, grades, centering, defects, gradingReport, images, population, provenance, verification } = data;

  return new Promise(async (resolve, reject) => {
    try {
      const qrBuf = await generateQR(verification.verifyUrl + `?sig=${verification.signature}`, 200);

      // Fetch card images as buffers for embedding
      let frontImgBuf: Buffer | null = null;
      let backImgBuf: Buffer | null = null;
      if (images.front) {
        try { const r = await fetch(images.front); frontImgBuf = Buffer.from(await r.arrayBuffer()); } catch {}
      }
      if (images.back) {
        try { const r = await fetch(images.back); backImgBuf = Buffer.from(await r.arrayBuffer()); } catch {}
      }

      const doc = new PDFDocument({
        size: "A4",
        margins: { top: M, bottom: M, left: M, right: M },
        info: {
          Title: `MintVault Ownership Logbook — ${certId}`,
          Author: "MintVault UK",
          Subject: `${safe(card.name)} — Grade ${safe(grades.overall)}`,
        },
        bufferPages: true,
      });

      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // ── PAGE 1: Cover ──────────────────────────────────────────────────────
      drawBorder(doc);
      let y = 60;

      // Logo
      try { doc.image(LOGO_PATH, (PAGE_W - 100) / 2, y, { width: 100 }); y += 55; } catch { y += 20; }

      doc.font("Helvetica").fontSize(7).fillColor(GOLD).text("OWNERSHIP LOGBOOK", M, y, { width: CW, align: "center", characterSpacing: 6 });
      y += 25;

      goldLine(doc, y); y += 15;

      // Card name large
      doc.font("Helvetica-Bold").fontSize(22).fillColor(CHARCOAL)
        .text(safe(card.name, "Certificate"), M, y, { width: CW, align: "center" });
      y += 30;

      // Set + number
      doc.font("Helvetica").fontSize(10).fillColor(GRAY)
        .text(`${safe(card.set)} ${card.number ? `#${card.number}` : ""}`, M, y, { width: CW, align: "center" });
      y += 20;

      // Grade badge
      const gradeStr = String(grades.overall);
      const gradeLabel = grades.gradeLabel;
      doc.font("Helvetica-Bold").fontSize(48).fillColor(GOLD)
        .text(gradeStr, M, y + 20, { width: CW, align: "center" });
      doc.font("Helvetica-Bold").fontSize(10).fillColor(GOLD_DARK)
        .text(gradeLabel, M, y + 75, { width: CW, align: "center", characterSpacing: 3 });
      if (grades.isBlackLabel) {
        doc.font("Helvetica-Bold").fontSize(8).fillColor(CHARCOAL)
          .text("BLACK LABEL", M, y + 92, { width: CW, align: "center", characterSpacing: 4 });
      }
      y += 115;

      goldLine(doc, y); y += 20;

      // Cert ID
      doc.font("Courier-Bold").fontSize(11).fillColor(TEXT)
        .text(certId, M, y, { width: CW, align: "center" });
      y += 18;
      doc.font("Helvetica").fontSize(7).fillColor(GRAY)
        .text(`Issued ${safe(provenance.issuedAt ? new Date(provenance.issuedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : null)}`, M, y, { width: CW, align: "center" });

      // ── PAGE 2: Card Details + Grades ──────────────────────────────────────
      doc.addPage(); drawBorder(doc);
      y = 40;

      y = sectionTitle(doc, y, "Card Identity");
      y = fieldRow(doc, y, "Card Name", safe(card.name));
      y = fieldRow(doc, y, "Game", safe(card.game));
      y = fieldRow(doc, y, "Set", safe(card.set));
      y = fieldRow(doc, y, "Card Number", safe(card.number));
      y = fieldRow(doc, y, "Year", safe(card.year));
      y = fieldRow(doc, y, "Variant", safe(card.variant));
      y = fieldRow(doc, y, "Rarity", safe(card.rarity));
      y = fieldRow(doc, y, "Language", safe(card.language));
      if (card.designations.length > 0) {
        y = fieldRow(doc, y, "Designations", card.designations.join(", "));
      }
      y += 10;

      y = sectionTitle(doc, y, "Grade Analysis");
      // Overall
      doc.font("Helvetica-Bold").fontSize(28).fillColor(GOLD)
        .text(gradeStr, M, y, { width: 80, align: "center" });
      doc.font("Helvetica-Bold").fontSize(9).fillColor(GOLD_DARK)
        .text(gradeLabel, M, y + 35, { width: 80, align: "center" });

      // Subgrades table
      const subX = M + 100;
      const subW = (CW - 100) / 4;
      const subLabels = ["Centering", "Corners", "Edges", "Surface"];
      const subValues = [grades.centering, grades.corners, grades.edges, grades.surface];
      for (let i = 0; i < 4; i++) {
        const sx = subX + i * subW;
        doc.font("Helvetica").fontSize(6).fillColor(GRAY).text(subLabels[i].toUpperCase(), sx, y, { width: subW, align: "center" });
        doc.font("Helvetica-Bold").fontSize(18).fillColor(TEXT).text(safe(subValues[i]), sx, y + 10, { width: subW, align: "center" });
      }
      y += 55;

      // Centering ratios
      if (centering.frontLR || centering.backLR) {
        y = sectionTitle(doc, y, "Centering Measurement");
        if (centering.frontLR) y = fieldRow(doc, y, "Front L/R", centering.frontLR);
        if (centering.frontTB) y = fieldRow(doc, y, "Front T/B", centering.frontTB);
        if (centering.backLR) y = fieldRow(doc, y, "Back L/R", centering.backLR);
        if (centering.backTB) y = fieldRow(doc, y, "Back T/B", centering.backTB);
        y += 10;
      }

      // Grading commentary
      if (gradingReport.overall || gradingReport.centering || gradingReport.corners || gradingReport.edges || gradingReport.surface) {
        y = sectionTitle(doc, y, "Grader Notes");
        if (gradingReport.centering) { doc.font("Helvetica").fontSize(7).fillColor(TEXT).text(`Centering: ${gradingReport.centering}`, M, y, { width: CW }); y += 12; }
        if (gradingReport.corners) { doc.font("Helvetica").fontSize(7).fillColor(TEXT).text(`Corners: ${gradingReport.corners}`, M, y, { width: CW }); y += 12; }
        if (gradingReport.edges) { doc.font("Helvetica").fontSize(7).fillColor(TEXT).text(`Edges: ${gradingReport.edges}`, M, y, { width: CW }); y += 12; }
        if (gradingReport.surface) { doc.font("Helvetica").fontSize(7).fillColor(TEXT).text(`Surface: ${gradingReport.surface}`, M, y, { width: CW }); y += 12; }
        if (gradingReport.overall) { doc.font("Helvetica").fontSize(7).fillColor(TEXT).text(`Overall: ${gradingReport.overall}`, M, y, { width: CW }); y += 12; }
      }

      // ── PAGE 3: Defects + Authentication ───────────────────────────────────
      doc.addPage(); drawBorder(doc);
      y = 40;

      y = sectionTitle(doc, y, "Condition Report");
      if (defects.length === 0) {
        doc.font("Helvetica").fontSize(8).fillColor(GRAY).text("No defects detected.", M, y);
        y += 16;
      } else {
        doc.font("Helvetica").fontSize(7).fillColor(GRAY)
          .text(`${defects.length} defect${defects.length !== 1 ? "s" : ""} detected:`, M, y);
        y += 14;
        for (const d of defects) {
          doc.font("Helvetica-Bold").fontSize(7).fillColor(TEXT).text(`${d.type}`, M + 10, y);
          doc.font("Helvetica").fontSize(7).fillColor(GRAY).text(`${d.location} — ${d.severity}`, M + 120, y);
          if (d.description) { y += 10; doc.font("Helvetica").fontSize(6.5).fillColor(MUTED).text(d.description, M + 20, y, { width: CW - 30 }); }
          y += 12;
          if (y > PAGE_H - 100) { doc.addPage(); drawBorder(doc); y = 40; }
        }
      }
      y += 10;

      y = sectionTitle(doc, y, "Authentication");
      y = fieldRow(doc, y, "Status", data.authentication.status === "genuine" ? "Genuine" : data.authentication.status === "authentic_altered" ? "Authentic Altered" : "Not Original");
      if (data.authentication.notes) {
        doc.font("Helvetica").fontSize(7).fillColor(TEXT).text(data.authentication.notes, M, y, { width: CW });
        y += 20;
      }

      // ── PAGE 4: Images ─────────────────────────────────────────────────────
      if (frontImgBuf || backImgBuf) {
        doc.addPage(); drawBorder(doc);
        y = 40;
        y = sectionTitle(doc, y, "Card Images");

        const imgMaxW = (CW - 20) / 2;
        const imgMaxH = PAGE_H - 140;

        if (frontImgBuf && backImgBuf) {
          try { doc.image(frontImgBuf, M, y, { width: imgMaxW, height: imgMaxH, fit: [imgMaxW, imgMaxH] }); } catch {}
          try { doc.image(backImgBuf, M + imgMaxW + 20, y, { width: imgMaxW, height: imgMaxH, fit: [imgMaxW, imgMaxH] }); } catch {}
        } else if (frontImgBuf) {
          const singleW = CW * 0.6;
          try { doc.image(frontImgBuf, (PAGE_W - singleW) / 2, y, { width: singleW, height: imgMaxH, fit: [singleW, imgMaxH] }); } catch {}
        } else if (backImgBuf) {
          const singleW = CW * 0.6;
          try { doc.image(backImgBuf, (PAGE_W - singleW) / 2, y, { width: singleW, height: imgMaxH, fit: [singleW, imgMaxH] }); } catch {}
        }
      }

      // ── FINAL PAGE: Verification ───────────────────────────────────────────
      doc.addPage(); drawBorder(doc);
      y = 40;

      y = sectionTitle(doc, y, "Verification & Integrity");

      doc.font("Helvetica").fontSize(7).fillColor(GRAY).text("This logbook is cryptographically signed. The hash below can be verified at the URL or by scanning the QR code.", M, y, { width: CW });
      y += 20;

      // QR code
      try { doc.image(qrBuf, (PAGE_W - 100) / 2, y, { width: 100 }); } catch {}
      y += 115;

      doc.font("Helvetica").fontSize(6).fillColor(MUTED).text("SIGNATURE HASH", M, y, { width: CW, align: "center" });
      y += 10;
      doc.font("Courier").fontSize(7).fillColor(TEXT).text(verification.signature || "—", M, y, { width: CW, align: "center" });
      y += 18;
      doc.font("Helvetica").fontSize(6).fillColor(MUTED).text("VERIFICATION URL", M, y, { width: CW, align: "center" });
      y += 10;
      doc.font("Courier").fontSize(6).fillColor(GOLD_DARK).text(verification.verifyUrl, M, y, { width: CW, align: "center" });
      y += 25;

      goldLine(doc, y); y += 15;

      doc.font("Helvetica").fontSize(6).fillColor(GRAY).text(
        "This Ownership Logbook is an official record issued by MintVault Ltd. The cryptographic signature covers the certificate ID, card identity, and all grade data at time of issuance. Any modification to the underlying data will invalidate the signature. This document does not constitute a guarantee of future value.",
        M, y, { width: CW, align: "center", lineGap: 2 }
      );

      // Add page footers to all pages
      const totalPages = doc.bufferedPageRange().count;
      for (let i = 0; i < totalPages; i++) {
        doc.switchToPage(i);
        pageFooter(doc, i + 1, totalPages, certId);
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
