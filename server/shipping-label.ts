import PDFDocument from "pdfkit";
import path from "path";

const GOLD     = "#D4AF37";
const BLACK    = "#111111";
const GREY     = "#555555";
const GREY_LT  = "#888888";

const LOGO_PATH = path.join(process.cwd(), "public", "brand", "logo.png");

// A4 in points (72 pts/inch): 595.28 × 841.89
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN  = 48;

export interface ShippingLabelData {
  submissionId: string;
  customerFirstName: string;
  customerLastName: string;
  returnAddressLine1: string;
  returnAddressLine2?: string;
  returnCity: string;
  returnCounty?: string;
  returnPostcode: string;
  cardCount: number;
}

const RECEIVING_ADDRESS = [
  "MintVault Grading",
  "2 Temple Gardens",
  "Strood",
  "Kent",
  "ME2 2NG",
  "United Kingdom",
];

export async function generateShippingLabelPDF(data: ShippingLabelData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 0, info: { Title: `Shipping Label — ${data.submissionId}` } });
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const midY = PAGE_H / 2;

      // ── GOLD BORDER — full page ──────────────────────────────────────
      doc.rect(MARGIN - 12, MARGIN - 12, PAGE_W - (MARGIN - 12) * 2, PAGE_H - (MARGIN - 12) * 2)
        .lineWidth(1.5).strokeColor(GOLD).stroke();

      // ── TOP HALF: TO address ─────────────────────────────────────────
      const topY = MARGIN + 8;

      // Logo
      try {
        doc.image(LOGO_PATH, MARGIN, topY, { height: 36 });
      } catch {
        doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(14)
          .text("MINTVAULT UK", MARGIN, topY + 8);
      }

      // "FRAGILE — TRADING CARDS" banner
      const bannerY = topY + 50;
      doc.rect(MARGIN, bannerY, PAGE_W - MARGIN * 2, 28)
        .fillColor(GOLD).fill();
      doc.fillColor(BLACK).font("Helvetica-Bold").fontSize(11)
        .text("⚠  FRAGILE — TRADING CARDS  ⚠", MARGIN, bannerY + 7, {
          width: PAGE_W - MARGIN * 2,
          align: "center",
        });

      // TO: label
      const toY = bannerY + 48;
      doc.fillColor(GREY_LT).font("Helvetica").fontSize(9)
        .text("SEND TO:", MARGIN, toY);

      doc.fillColor(BLACK).font("Helvetica-Bold").fontSize(22)
        .text(RECEIVING_ADDRESS[0], MARGIN, toY + 16);
      doc.fillColor(GREY).font("Helvetica").fontSize(14);
      RECEIVING_ADDRESS.slice(1).forEach((line, i) => {
        doc.text(line, MARGIN, toY + 42 + i * 20);
      });

      // Submission ID box
      const idBoxX = PAGE_W / 2 + 10;
      const idBoxY = toY + 10;
      const idBoxW = PAGE_W / 2 - MARGIN - 10;
      doc.rect(idBoxX, idBoxY, idBoxW, 100)
        .lineWidth(1).strokeColor(GOLD).stroke();
      doc.fillColor(GREY_LT).font("Helvetica").fontSize(8)
        .text("SUBMISSION ID", idBoxX + 10, idBoxY + 10);
      doc.fillColor(BLACK).font("Helvetica-Bold").fontSize(18)
        .text(data.submissionId, idBoxX + 10, idBoxY + 26, { width: idBoxW - 20, align: "center" });
      doc.fillColor(GREY_LT).font("Helvetica").fontSize(8)
        .text(`${data.cardCount} card${data.cardCount !== 1 ? "s" : ""}`, idBoxX + 10, idBoxY + 72, {
          width: idBoxW - 20, align: "center",
        });

      // ── DOTTED CUT LINE ──────────────────────────────────────────────
      doc.save();
      (doc as any).dash(4, { space: 5 });
      doc.lineWidth(0.8).strokeColor(GREY_LT);
      doc.moveTo(MARGIN, midY).lineTo(PAGE_W - MARGIN, midY).stroke();
      doc.restore();

      // Scissors icon text
      doc.fillColor(GREY_LT).font("Helvetica").fontSize(8)
        .text("✂  fold or cut here  ✂", 0, midY - 10, { width: PAGE_W, align: "center" });

      // ── BOTTOM HALF: Packing instructions + return address ───────────
      const botY = midY + 20;

      // Return address
      doc.fillColor(GREY_LT).font("Helvetica").fontSize(9)
        .text("RETURN ADDRESS:", MARGIN, botY + 4);

      const returnLines = [
        `${data.customerFirstName} ${data.customerLastName}`,
        data.returnAddressLine1,
        ...(data.returnAddressLine2 ? [data.returnAddressLine2] : []),
        data.returnCity,
        ...(data.returnCounty ? [data.returnCounty] : []),
        data.returnPostcode,
      ];
      doc.fillColor(GREY).font("Helvetica").fontSize(11);
      returnLines.forEach((line, i) => {
        doc.text(line, MARGIN, botY + 24 + i * 16);
      });

      // Packing instructions
      const instrX = PAGE_W / 2 + 10;
      const instrW = PAGE_W / 2 - MARGIN - 10;
      doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(9)
        .text("PACKING CHECKLIST", instrX, botY + 4);

      const steps = [
        "Place each card in a penny sleeve",
        "Slide into a rigid top loader",
        "Tape top of each top loader closed",
        "Wrap stack in bubble wrap",
        "Pack snugly — no movement inside box",
        "Include your Submission ID on the box",
      ];
      doc.fillColor(GREY).font("Helvetica").fontSize(9);
      steps.forEach((step, i) => {
        doc.text(`□  ${step}`, instrX, botY + 22 + i * 18, { width: instrW });
      });

      // Footer note
      const footerY = PAGE_H - MARGIN - 20;
      doc.fillColor(GREY_LT).font("Helvetica").fontSize(7)
        .text(
          "Top half: attach to the outside of your package  ·  Bottom half: place inside",
          MARGIN, footerY - 12,
          { width: PAGE_W - MARGIN * 2, align: "center" }
        )
        .text(
          `Generated by MintVault UK — mintvaultuk.com  ·  Submission: ${data.submissionId}`,
          MARGIN, footerY,
          { width: PAGE_W - MARGIN * 2, align: "center" }
        );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
