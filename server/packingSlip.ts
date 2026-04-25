import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import path from "path";
import fs from "fs";
import { APP_BASE_URL } from "./app-url";

const GOLD = "#D4AF37";
const DARK = "#111111";
const GREY_DARK = "#333333";
const GREY_MID = "#666666";
const GREY_LIGHT = "#999999";
const GOLD_FADED = "#B89A2A";

interface PackingSlipData {
  submissionId: string;
  customerFirstName: string;
  customerLastName: string;
  customerEmail: string;
  phone?: string;
  returnAddressLine1: string;
  returnAddressLine2?: string;
  returnCity: string;
  returnCounty?: string;
  returnPostcode: string;
  serviceType: string;
  serviceTier: string;
  turnaroundDays?: number;
  cardCount: number;
  totalDeclaredValue: number;
  totalPrice: string;
  shippingCost: number;
  shippingInsuranceTier?: string;
  gradingCost: number;
  insuranceFee?: number;
  items?: Array<{
    cardIndex: number;
    game?: string;
    cardSet?: string;
    cardName?: string;
    cardNumber?: string;
    year?: string;
    declaredValue?: number;
  }>;
}

export async function generatePackingSlipPDF(data: PackingSlipData): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    try {
      const qrDataUrl = await QRCode.toDataURL(
        `${APP_BASE_URL}/submit/track/${data.submissionId}`,
        { width: 140, margin: 1, color: { dark: "#000000", light: "#ffffff" } }
      );
      const qrBuffer = Buffer.from(qrDataUrl.split(",")[1], "base64");

      const logoPath = path.join(process.cwd(), "server", "brand-logo.png");
      const hasLogo = fs.existsSync(logoPath);

      const doc = new PDFDocument({ size: "A4", margin: 40 });
      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const pageW = doc.page.width;
      const marginL = 50;
      const marginR = pageW - 50;
      const contentW = marginR - marginL;

      doc.rect(0, 0, pageW, 100).fill(DARK);

      if (hasLogo) {
        doc.image(logoPath, marginL, 15, { height: 50 });
      } else {
        doc.font("Helvetica-Bold").fontSize(24).fillColor(GOLD)
          .text("MINTVAULT", marginL, 25);
      }

      doc.font("Helvetica").fontSize(7).fillColor(GREY_LIGHT)
        .text("TRADING CARD GRADING", marginL, 70, { characterSpacing: 2 });
      doc.font("Helvetica-Bold").fontSize(8).fillColor(GOLD_FADED)
        .text("PACKING SLIP / INVOICE", marginL, 82, { characterSpacing: 1.5 });

      doc.font("Helvetica-Bold").fontSize(14).fillColor(GOLD)
        .text(data.submissionId, 300, 22, { align: "right", width: marginR - 300 });

      doc.image(qrBuffer, marginR - 75, 42, { width: 55, height: 55 });

      doc.moveTo(marginL, 106).lineTo(marginR, 106).lineWidth(0.5).strokeColor(GOLD).stroke();

      let y = 116;

      const tierNames: Record<string, string> = {
        basic: "Basic", standard: "Standard", premier: "Premier",
        ultra: "Ultra", elite: "Elite",
      };
      const typeNames: Record<string, string> = {
        grading: "Grading", reholder: "Reholder",
        crossover: "Crossover", authentication: "Authentication",
      };

      const colLeft = marginL;
      const colRight = 310;

      doc.font("Helvetica-Bold").fontSize(9).fillColor(GOLD)
        .text("CUSTOMER", colLeft, y, { characterSpacing: 1.5 });
      doc.font("Helvetica-Bold").fontSize(9).fillColor(GOLD)
        .text("RETURN ADDRESS", colRight, y, { characterSpacing: 1.5 });
      y += 16;

      doc.font("Helvetica-Bold").fontSize(10).fillColor(GREY_DARK)
        .text(`${data.customerFirstName} ${data.customerLastName}`, colLeft, y);
      doc.font("Helvetica").fontSize(9).fillColor(GREY_MID);
      let yCust = y + 15;
      doc.text(data.customerEmail, colLeft, yCust); yCust += 13;
      if (data.phone) { doc.text(data.phone, colLeft, yCust); yCust += 13; }

      doc.font("Helvetica").fontSize(9).fillColor(GREY_DARK);
      let yAddr = y;
      doc.text(data.returnAddressLine1, colRight, yAddr); yAddr += 13;
      if (data.returnAddressLine2) { doc.text(data.returnAddressLine2, colRight, yAddr); yAddr += 13; }
      doc.text(data.returnCity, colRight, yAddr); yAddr += 13;
      if (data.returnCounty) { doc.text(data.returnCounty, colRight, yAddr); yAddr += 13; }
      doc.text(data.returnPostcode, colRight, yAddr);

      y = Math.max(yCust, yAddr) + 16;

      doc.moveTo(marginL, y).lineTo(marginR, y).lineWidth(0.3).strokeColor("#dddddd").stroke();
      y += 14;

      doc.font("Helvetica-Bold").fontSize(9).fillColor(GOLD)
        .text("ORDER DETAILS", colLeft, y, { characterSpacing: 1.5 });
      y += 18;

      const serviceName = typeNames[data.serviceType] || data.serviceType;
      const tierName = tierNames[data.serviceTier] || data.serviceTier;

      const drawDetailRow = (label: string, value: string, bold?: boolean, highlight?: boolean) => {
        doc.font("Helvetica").fontSize(9).fillColor(GREY_MID)
          .text(label, colLeft, y, { width: 180 });
        doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9)
          .fillColor(highlight ? GOLD : GREY_DARK)
          .text(value, 240, y, { width: marginR - 240 });
        y += 15;
      };

      drawDetailRow("Service", `${serviceName} — ${tierName}`);
      drawDetailRow("Quantity", `${data.cardCount} card${data.cardCount > 1 ? "s" : ""}`);
      if (data.turnaroundDays) {
        drawDetailRow("Turnaround", `${data.turnaroundDays} working days`);
      }
      drawDetailRow("Declared Value", `£${data.totalDeclaredValue.toLocaleString()}`);

      doc.moveTo(colLeft, y + 2).lineTo(marginR, y + 2).lineWidth(0.2).strokeColor("#eeeeee").stroke();
      y += 10;

      if (data.gradingCost > 0) {
        drawDetailRow("Service Cost", `£${(data.gradingCost / 100).toFixed(2)}`);
      }
      if (data.shippingCost > 0) {
        const shippingLabel = data.shippingInsuranceTier
          ? `Shipping (${data.shippingInsuranceTier})`
          : "Shipping (Insured)";
        drawDetailRow(shippingLabel, `£${(data.shippingCost / 100).toFixed(2)}`);
      }
      if (data.insuranceFee && data.insuranceFee > 0) {
        drawDetailRow("Insurance Surcharge", `£${(data.insuranceFee / 100).toFixed(2)}`);
      }

      doc.moveTo(colLeft, y + 2).lineTo(marginR, y + 2).lineWidth(0.3).strokeColor(GOLD).stroke();
      y += 10;
      drawDetailRow("TOTAL PAID", `£${parseFloat(data.totalPrice).toFixed(2)}`, true, true);
      y += 6;

      if (data.items && data.items.length > 0) {
        doc.moveTo(marginL, y).lineTo(marginR, y).lineWidth(0.3).strokeColor("#dddddd").stroke();
        y += 14;

        doc.font("Helvetica-Bold").fontSize(9).fillColor(GOLD)
          .text("CARD LIST", colLeft, y, { characterSpacing: 1.5 });
        y += 18;

        doc.font("Helvetica-Bold").fontSize(7).fillColor(GREY_MID);
        doc.text("#", colLeft, y, { width: 20 });
        doc.text("GAME", colLeft + 22, y, { width: 55 });
        doc.text("SET", colLeft + 80, y, { width: 120 });
        doc.text("CARD NAME", colLeft + 205, y, { width: 140 });
        doc.text("NO.", colLeft + 350, y, { width: 40 });
        doc.text("VALUE", colLeft + 395, y, { width: 60, align: "right" });
        y += 12;

        doc.moveTo(colLeft, y).lineTo(marginR, y).lineWidth(0.3).strokeColor("#dddddd").stroke();
        y += 5;

        doc.font("Helvetica").fontSize(8).fillColor(GREY_DARK);
        for (const item of data.items) {
          if (y > 720) {
            doc.addPage();
            y = 50;
          }
          doc.text(String(item.cardIndex + 1), colLeft, y, { width: 20 });
          doc.text(item.game || "—", colLeft + 22, y, { width: 55 });
          doc.text(item.cardSet || "—", colLeft + 80, y, { width: 120 });
          doc.text(item.cardName || "—", colLeft + 205, y, { width: 140 });
          doc.text(item.cardNumber || "—", colLeft + 350, y, { width: 40 });
          doc.text(item.declaredValue ? `£${item.declaredValue}` : "—", colLeft + 395, y, { width: 60, align: "right" });
          y += 13;
        }
        y += 8;
      }

      if (y > 580) { doc.addPage(); y = 50; }

      const boxX = marginL - 5;
      const boxW = contentW + 10;
      const boxH = 185;
      doc.roundedRect(boxX, y, boxW, boxH, 3).lineWidth(1).strokeColor(GOLD).stroke();

      const bx = marginL + 5;
      let by = y + 12;

      doc.font("Helvetica-Bold").fontSize(10).fillColor(GOLD)
        .text("SHIPPING INSTRUCTIONS", bx, by, { characterSpacing: 1 });
      by += 20;

      doc.font("Helvetica").fontSize(8.5).fillColor(GREY_DARK);
      const instructions = [
        "1. Print this packing slip and include it inside your package.",
        `2. Write your Submission ID (${data.submissionId}) on the OUTSIDE of the box.`,
        "3. Pack cards securely — use top loaders, bubble wrap, and rigid protection.",
        "4. Send using tracked, insured delivery appropriate to your declared value.",
      ];
      for (const line of instructions) {
        doc.text(line, bx, by, { width: boxW - 30 });
        by += 14;
      }

      by += 8;
      doc.moveTo(bx, by).lineTo(bx + boxW - 30, by).lineWidth(0.3).strokeColor(GOLD).stroke();
      by += 10;

      doc.font("Helvetica-Bold").fontSize(9).fillColor(GOLD)
        .text("SEND TO:", bx, by);
      by += 16;

      doc.font("Helvetica-Bold").fontSize(10).fillColor(GREY_DARK)
        .text("MintVault Grading", bx, by);
      by += 14;
      doc.font("Helvetica").fontSize(9).fillColor(GREY_DARK);
      doc.text("2 Temple Gardens", bx, by); by += 12;
      doc.text("Strood", bx, by); by += 12;
      doc.text("Kent", bx, by); by += 12;
      doc.text("ME2 2NG", bx, by); by += 12;
      doc.text("United Kingdom", bx, by);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
