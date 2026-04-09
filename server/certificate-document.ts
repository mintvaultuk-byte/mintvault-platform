import QRCode from "qrcode";
import PDFDocument from "pdfkit";
import path from "path";
import type { CertificateRecord } from "@shared/schema";
import { isNonNumericGrade, gradeLabelFull } from "@shared/schema";

// ── Page geometry ────────────────────────────────────────────────────────────
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;

// ── Colour palette ────────────────────────────────────────────────────────────
const GOLD       = "#D4AF37";
const GOLD_DARK  = "#B8960C";
const BLACK      = "#000000";
const GRAY_DARK  = "#1a1a1a";
const GRAY_MID   = "#555555";
const GRAY_LIGHT = "#888888";
const GRAY_BG    = "#f5f0e8";

const LOGO_PATH = path.join(process.cwd(), "public", "brand", "logo.png");

function normalizeCertId(raw: string): string {
  const m = raw.match(/^MV-?0*(\d+)$/i);
  if (m) return `MV${m[1]}`;
  return raw;
}

async function generateQR(url: string, size: number): Promise<Buffer> {
  return QRCode.toBuffer(url, {
    width: size,
    margin: 1,
    color: { dark: "#000000", light: "#FFFFFF" },
    errorCorrectionLevel: "H",
  });
}

// Border frame: outer gold bars + corner ornaments + inner vertical lines only.
// No inner horizontal lines — they would read as a second divider in the document.
function drawBorderFrame(doc: PDFKit.PDFDocument) {
  const bw = 7;   // outer bar width (pt)
  const inner = 3; // inner line thickness (pt)
  const gap = 5;   // gap between outer bar and inner line

  // Outer gold bars (all four sides)
  doc.rect(0, 0, PAGE_W, bw).fill(GOLD);
  doc.rect(0, PAGE_H - bw, PAGE_W, bw).fill(GOLD);
  doc.rect(0, 0, bw, PAGE_H).fill(GOLD);
  doc.rect(PAGE_W - bw, 0, bw, PAGE_H).fill(GOLD);

  // Inner vertical lines only — horizontal would look like content dividers
  const offset = bw + gap;
  doc.rect(offset, offset, inner, PAGE_H - offset * 2).fill(GOLD_DARK);
  doc.rect(PAGE_W - offset - inner, offset, inner, PAGE_H - offset * 2).fill(GOLD_DARK);

  // Corner ornaments
  const cs = 16;
  const co = bw + 1;
  const corners: [number, number][] = [
    [co, co], [PAGE_W - co - cs, co],
    [co, PAGE_H - co - cs], [PAGE_W - co - cs, PAGE_H - co - cs],
  ];
  for (const [cx, cy] of corners) {
    doc.rect(cx, cy, cs, cs).fill(GOLD);
  }
}

function goldDivider(doc: PDFKit.PDFDocument, y: number, opacity = 1) {
  doc.save().opacity(opacity);
  doc.rect(MARGIN, y, CONTENT_W, 0.75).fill(GOLD);
  doc.restore();
}

export async function generateCertificateDocument(
  cert: CertificateRecord,
  ownerName?: string | null,
): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    try {
      const certId = normalizeCertId(cert.certId);
      const verifyUrl = `https://mintvaultuk.com/cert/${certId}`;
      const qrBuf = await generateQR(verifyUrl, 300);

      const doc = new PDFDocument({
        size: "A4",
        margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
        info: {
          Title: `MintVault Certificate of Authenticity — ${certId}`,
          Author: "MintVault UK",
        },
      });

      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      drawBorderFrame(doc);

      let y = 28;

      // ── Header: centered logo ─────────────────────────────────────────────────
      // Use doc.openImage() to get the true source pixel dimensions so we can
      // calculate the exact rendered height and advance y precisely.
      // logoX = (PAGE_W - logoW) / 2 — mathematically exact center.
      const logoW = 90;
      const logoX = (PAGE_W - logoW) / 2; // exact: (595.28 - 90) / 2 = 252.64

      let logoRenderedH = 36; // fallback estimate
      try {
        const imgObj = (doc as any).openImage(LOGO_PATH) as { width: number; height: number };
        logoRenderedH = Math.round(logoW * (imgObj.height / imgObj.width));
        doc.image(LOGO_PATH, logoX, y, { width: logoW });
      } catch {
        doc
          .font("Helvetica-Bold")
          .fontSize(20)
          .fillColor(GOLD)
          .text("MINTVAULT UK", MARGIN, y + 8, { width: CONTENT_W, align: "center" });
        logoRenderedH = 28;
      }
      y += logoRenderedH + 10; // exact gap below logo

      doc
        .font("Helvetica-Bold")
        .fontSize(8)
        .fillColor(GRAY_MID)
        .text("UK TRADING CARD AUTHENTICATION REGISTRY", MARGIN, y, {
          width: CONTENT_W,
          align: "center",
          characterSpacing: 1.5,
        });
      y += 14;
      doc
        .font("Helvetica")
        .fontSize(7)
        .fillColor(GRAY_LIGHT)
        .text("mintvaultuk.com", MARGIN, y, { width: CONTENT_W, align: "center" });
      y += 16;

      // ── Certificate of Authenticity title ─────────────────────────────────────
      doc
        .font("Helvetica-Bold")
        .fontSize(22)
        .fillColor(GOLD)
        .text("CERTIFICATE OF AUTHENTICITY", MARGIN, y, {
          width: CONTENT_W,
          align: "center",
          characterSpacing: 2,
        });
      y += 34;

      // ── Cert ID ───────────────────────────────────────────────────────────────
      doc
        .font("Courier-Bold")
        .fontSize(40)
        .fillColor(BLACK)
        .text(certId, MARGIN, y, { width: CONTENT_W, align: "center" });
      y += 54;

      // ── Verified badge ─────────────────────────────────────────────────────────
      // Plain ASCII text only — Helvetica does not include unicode symbols such as
      // U+2713 (checkmark), which renders as a garbage glyph in some PDF viewers.
      const badgeLabel = "VERIFIED & AUTHENTICATED";
      const badgeW = 210;
      const badgeX = (PAGE_W - badgeW) / 2; // exact center
      const badgeH = 24;
      doc.roundedRect(badgeX, y, badgeW, badgeH, 4).fill(GOLD);
      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .fillColor(BLACK)
        .text(badgeLabel, badgeX, y + 7, {
          width: badgeW,
          align: "center",
          characterSpacing: 0.8,
          lineBreak: false,
        });
      y += 38;

      // ── Owner name — shown when cert is claimed ────────────────────────────────
      const displayName = ownerName || cert.ownerName;
      const isClaimed = cert.ownershipStatus === "claimed";
      if (displayName) {
        doc
          .font("Helvetica")
          .fontSize(9)
          .fillColor(GRAY_MID)
          .text("REGISTERED OWNER", MARGIN, y, {
            width: CONTENT_W,
            align: "center",
            characterSpacing: 1,
          });
        y += 14;
        doc
          .font("Helvetica-Bold")
          .fontSize(14)
          .fillColor(BLACK)
          .text(displayName, MARGIN, y, { width: CONTENT_W, align: "center" });
        y += 28;
      }

      // ONE divider — below the entire header block, above card details.
      // This is the only decorative horizontal line below the header area.
      goldDivider(doc, y, 0.6);
      y += 16;

      // ── Card details table ────────────────────────────────────────────────────
      doc
        .font("Helvetica-Bold")
        .fontSize(9)
        .fillColor(GOLD_DARK)
        .text("CARD DETAILS", MARGIN, y, { characterSpacing: 1.5 });
      y += 16;

      const labelX = MARGIN;
      const valueX = MARGIN + 150;
      const rowH = 20;
      const tableW = CONTENT_W;

      type Row = [string, string | null | undefined];
      const rows: Row[] = [
        ["Card Name", cert.cardName],
        ["Game", cert.cardGame],
        ["Set", cert.setName ? `${cert.setName}${cert.year ? ` (${cert.year})` : ""}` : null],
        ["Card Number", cert.cardNumber],
        ["Rarity", cert.rarity],
        ["Variant", cert.variant || null],
        ["Collection", cert.collection || null],
        ["Language", cert.language || "English"],
        ["Designations", Array.isArray(cert.designations) && cert.designations.length > 0
          ? cert.designations.join(", ")
          : null],
      ].filter(([, v]) => v != null && String(v).trim() !== "") as Row[];

      rows.forEach(([label, value], i) => {
        const rowY = y + i * rowH;
        if (i % 2 === 0) {
          doc.rect(labelX, rowY - 3, tableW, rowH).fill(GRAY_BG);
        }
        doc
          .font("Helvetica-Bold")
          .fontSize(8.5)
          .fillColor(GRAY_MID)
          .text(label.toUpperCase(), labelX + 4, rowY + 2, { characterSpacing: 0.3 });
        doc
          .font("Helvetica")
          .fontSize(9.5)
          .fillColor(BLACK)
          .text(String(value), valueX, rowY + 2, { width: tableW - 150 - 4 });
      });

      y += rows.length * rowH + 14;
      goldDivider(doc, y, 0.4);
      y += 16;

      // ── Grade section ─────────────────────────────────────────────────────────
      doc
        .font("Helvetica-Bold")
        .fontSize(9)
        .fillColor(GOLD_DARK)
        .text("GRADE", MARGIN, y, { characterSpacing: 1.5 });
      y += 16;

      const isNonNumeric = isNonNumericGrade(cert.gradeType);
      const gradeText = isNonNumeric
        ? gradeLabelFull(cert.gradeType, String(cert.gradeOverall ?? ""))
        : cert.gradeOverall != null
          ? String(parseFloat(String(cert.gradeOverall)) % 1 === 0
              ? parseInt(String(cert.gradeOverall))
              : parseFloat(String(cert.gradeOverall)).toFixed(1))
          : "—";
      const gradeName = isNonNumeric
        ? gradeLabelFull(cert.gradeType, String(cert.gradeOverall ?? ""))
        : cert.gradeOverall != null
          ? gradeLabelFull(cert.gradeType, String(cert.gradeOverall))
          : "";

      if (isNonNumeric) {
        doc
          .font("Helvetica-Bold")
          .fontSize(34)
          .fillColor(GOLD)
          .text(gradeText, MARGIN, y, { width: CONTENT_W, align: "center" });
        y += 52;
      } else {
        const gradeBoxW = 100;
        const gradeBoxH = 72;
        doc.roundedRect(MARGIN, y - 4, gradeBoxW, gradeBoxH, 8).fill(GOLD);
        doc
          .font("Helvetica-Bold")
          .fontSize(52)
          .fillColor(BLACK)
          .text(gradeText, MARGIN, y + 6, { width: gradeBoxW, align: "center" });

        const nameX = MARGIN + gradeBoxW + 20;
        const nameW = CONTENT_W - gradeBoxW - 20;
        doc
          .font("Helvetica-Bold")
          .fontSize(26)
          .fillColor(GRAY_DARK)
          .text(gradeName, nameX, y + 8, { width: nameW });
        doc
          .font("Helvetica")
          .fontSize(9)
          .fillColor(GRAY_MID)
          .text("OVERALL GRADE", nameX, y + 40, { width: nameW, characterSpacing: 0.5 });

        y += gradeBoxH + 16;

        const subgrades: [string, string | null | undefined][] = [
          ["Centering", cert.gradeCentering != null ? String(parseFloat(String(cert.gradeCentering))) : null],
          ["Corners",   cert.gradeCorners   != null ? String(parseFloat(String(cert.gradeCorners)))   : null],
          ["Edges",     cert.gradeEdges     != null ? String(parseFloat(String(cert.gradeEdges)))     : null],
          ["Surface",   cert.gradeSurface   != null ? String(parseFloat(String(cert.gradeSurface)))   : null],
        ].filter(([, v]) => v != null) as [string, string][];

        if (subgrades.length > 0) {
          const sgW = CONTENT_W / subgrades.length;
          subgrades.forEach(([label, val], i) => {
            const sgX = MARGIN + i * sgW;
            doc.roundedRect(sgX + 2, y - 2, sgW - 4, 48, 6).fill(GRAY_BG);
            doc
              .font("Helvetica-Bold")
              .fontSize(22)
              .fillColor(GOLD_DARK)
              .text(String(val), sgX, y + 4, { width: sgW, align: "center" });
            doc
              .font("Helvetica")
              .fontSize(8)
              .fillColor(GRAY_MID)
              .text(label.toUpperCase(), sgX, y + 30, {
                width: sgW,
                align: "center",
                characterSpacing: 0.5,
              });
          });
          y += 62;
        }
      }

      goldDivider(doc, y, 0.4);
      y += 16;

      // ── QR + Ownership section ────────────────────────────────────────────────
      const qrSize = 140;
      doc.image(qrBuf, MARGIN, y, { width: qrSize, height: qrSize });
      doc
        .font("Helvetica")
        .fontSize(7.5)
        .fillColor(GRAY_LIGHT)
        .text("Scan to verify", MARGIN, y + qrSize + 4, { width: qrSize, align: "center" });

      const ownerX = MARGIN + qrSize + 24;
      const ownerW = CONTENT_W - qrSize - 24;

      doc
        .font("Helvetica-Bold")
        .fontSize(9)
        .fillColor(GOLD_DARK)
        .text("OWNERSHIP & REGISTRY", ownerX, y, { characterSpacing: 1 });

      const ownerRows: [string, string][] = [
        ["Owner", isClaimed ? (displayName || "Claimed (name not provided)") : "Unregistered"],
        ...(isClaimed && cert.ownerEmail ? [["Email", cert.ownerEmail] as [string, string]] : []),
        ["Registry Status", isClaimed ? "Registered" : cert.ownershipStatus === "transfer_pending" ? "Transfer Pending" : "Unregistered"],
        ["Certificate ID", certId],
        ["Date Issued", cert.createdAt ? new Date(cert.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" }) : "—"],
        ["Card Status", cert.status === "active" ? "Active" : cert.status],
      ];

      let ownerY = y + 20;
      for (const [lbl, val] of ownerRows) {
        doc
          .font("Helvetica-Bold")
          .fontSize(8)
          .fillColor(GRAY_MID)
          .text(lbl.toUpperCase() + ":", ownerX, ownerY, { characterSpacing: 0.3 });
        doc
          .font("Helvetica")
          .fontSize(9)
          .fillColor(BLACK)
          .text(val, ownerX + 110, ownerY, { width: ownerW - 110 });
        ownerY += 17;
      }

      y += Math.max(qrSize + 18, ownerY - y + 8);
      y += 10;

      goldDivider(doc, y, 0.3);
      y += 18;

      // ── Authenticity statement ────────────────────────────────────────────────
      doc
        .font("Helvetica")
        .fontSize(8.5)
        .fillColor(GRAY_MID)
        .text(
          "MintVault UK applies a rigorous multi-point grading process to every card we evaluate. Each graded card is " +
          "encapsulated in a tamper-evident slab fitted with an NFC chip and QR code for instant public verification. " +
          "This certificate confirms the authenticity of the card and grade recorded above at the time of grading.",
          MARGIN,
          y,
          { width: CONTENT_W, align: "justify", lineGap: 3 },
        );

      // ── Footer — anchored at bottom ───────────────────────────────────────────
      // footerTextY is the TOP of the footer text (PDFKit y = top of text box).
      // footerLineY is 30pt above footerTextY — guarantees ≥29pt visible gap
      // between the bottom of the 0.75pt line and the top of the text.
      const footerTextY = PAGE_H - MARGIN - 14;
      doc
        .font("Helvetica")
        .fontSize(7.5)
        .fillColor(GRAY_LIGHT)
        .text(
          "This certificate is valid only when verified at mintvaultuk.com  \u00b7  MintVault UK Ltd  \u00b7  Professional Trading Card Authentication",
          MARGIN,
          footerTextY,
          { width: CONTENT_W, align: "center" },
        );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
