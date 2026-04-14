/**
 * MintVault Ownership Logbook — compact A4 PDF with DVLA-style sections.
 * Uses bufferPages for reliable page-1 border/footer rendering.
 * MAX_Y cutoff prevents overflow; sections skip gracefully if no space.
 * Owner variant includes Document Reference Number.
 */
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import path from "path";
import { buildLogbookData } from "./logbook-service";

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 40;
const CW = PAGE_W - M * 2;
const MAX_Y = PAGE_H - 70; // hard cutoff — below this, skip sections
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

export interface LogbookPdfOptions {
  includeReferenceNumber?: boolean;
}

export async function generateLogbookPdf(certIdInput: string, opts: LogbookPdfOptions = {}): Promise<Buffer | null> {
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
        bufferPages: true,
      });

      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      let y = 28;
      let skippedSections: string[] = [];

      function canFit(needed: number, sectionName: string): boolean {
        if (y + needed > MAX_Y) {
          skippedSections.push(sectionName);
          console.warn(`[logbook-pdf] ${certId}: skipped section "${sectionName}" \u2014 no space (y=${Math.round(y)}, MAX_Y=${MAX_Y})`);
          return false;
        }
        return true;
      }
      function hr() { y += 4; doc.save().rect(M, y, CW, 0.4).fill(GOLD).restore(); y += 6; }
      function heading(t: string) { doc.font("Helvetica-Bold").fontSize(6).fillColor(GOLD).text(t.toUpperCase(), M, y, { characterSpacing: 2 }); y += 9; }
      function row(label: string, value: string) { doc.font("Helvetica").fontSize(5.5).fillColor(GRAY).text(label, M, y); doc.font("Helvetica-Bold").fontSize(6.5).fillColor(TEXT).text(value, M + 90, y - 0.5); y += 10; }
      function bodyText(t: string, color = GRAY, size = 5) { doc.font("Helvetica").fontSize(size).fillColor(color).text(t, M, y, { width: CW, lineGap: 1 }); y += Math.ceil(t.length / 100) * 7 + 4; }

      // ── COVER ──────────────────────────────────────────────────────────────
      try { doc.image(LOGO_PATH, (PAGE_W - 36) / 2, y, { width: 36 }); y += 26; } catch { y += 6; }
      y += 4;
      doc.font("Helvetica").fontSize(5).fillColor(GOLD).text("OWNERSHIP LOGBOOK", M, y, { width: CW, align: "center", characterSpacing: 4 }); y += 9;
      doc.save().rect(M + CW * 0.35, y, CW * 0.3, 0.4).fill(GOLD).restore(); y += 7;
      doc.font("Helvetica-Bold").fontSize(13).fillColor(CHARCOAL).text(s(card.name, "Certificate"), M, y, { width: CW, align: "center" }); y += 16;
      doc.font("Helvetica").fontSize(7).fillColor(GRAY).text(`${s(card.set)} ${card.number ? `#${card.number}` : ""} ${card.year ? `(${card.year})` : ""}`.trim(), M, y, { width: CW, align: "center" }); y += 11;
      doc.font("Helvetica-Bold").fontSize(24).fillColor(GOLD).text(gradeStr, M, y, { width: CW, align: "center" }); y += 28;
      doc.font("Helvetica-Bold").fontSize(6.5).fillColor(GOLD_DARK).text(gradeLabel, M, y, { width: CW, align: "center", characterSpacing: 2 }); y += 9;
      if (grades.isBlackLabel) { doc.font("Helvetica-Bold").fontSize(5.5).fillColor(CHARCOAL).text("BLACK LABEL", M, y, { width: CW, align: "center", characterSpacing: 3 }); y += 8; }
      doc.font("Courier-Bold").fontSize(7.5).fillColor(TEXT).text(certId, M, y, { width: CW, align: "center" }); y += 9;
      if (provenance.issuedAt) { doc.font("Helvetica").fontSize(5).fillColor(GRAY).text(`Issued ${new Date(provenance.issuedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`, M, y, { width: CW, align: "center" }); y += 7; }

      // ── CARD IDENTITY ──────────────────────────────────────────────────────
      if (canFit(70, "Card Identity")) {
        hr(); heading("Card Identity");
        row("Card Name", s(card.name)); row("Game", s(card.game)); row("Set", s(card.set));
        row("Number", s(card.number)); row("Year", s(card.year));
        if (card.variant) row("Variant", card.variant);
        row("Rarity", s(card.rarity)); row("Language", s(card.language));
      }

      // ── GRADE ANALYSIS ─────────────────────────────────────────────────────
      if (canFit(55, "Grade Analysis")) {
        hr(); heading("Grade Analysis");
        doc.font("Helvetica-Bold").fontSize(16).fillColor(GOLD).text(gradeStr, M, y, { width: 45, align: "center" });
        doc.font("Helvetica").fontSize(4.5).fillColor(GOLD_DARK).text(gradeLabel, M, y + 18, { width: 45, align: "center" });
        const sx0 = M + 60; const sw = (CW - 60) / 4;
        ["Centering", "Corners", "Edges", "Surface"].forEach((lbl, i) => {
          const val = [grades.centering, grades.corners, grades.edges, grades.surface][i];
          doc.font("Helvetica").fontSize(4.5).fillColor(GRAY).text(lbl.toUpperCase(), sx0 + i * sw, y, { width: sw, align: "center" });
          doc.font("Helvetica-Bold").fontSize(11).fillColor(TEXT).text(s(val), sx0 + i * sw, y + 6, { width: sw, align: "center" });
        });
        y += 26;

        // Centering — compact single line
        const cParts = [centering.frontLR && `Front L/R: ${centering.frontLR}`, centering.frontTB && `T/B: ${centering.frontTB}`, centering.backLR && `Back L/R: ${centering.backLR}`, centering.backTB && `T/B: ${centering.backTB}`].filter(Boolean);
        if (cParts.length > 0) {
          doc.font("Helvetica").fontSize(5).fillColor(MUTED).text(cParts.join("  \u00B7  "), M, y, { width: CW }); y += 8;
        }

        // Grader notes — compact single paragraph
        const noteStr = [gradingReport.centering && `Centering: ${gradingReport.centering}`, gradingReport.corners && `Corners: ${gradingReport.corners}`, gradingReport.edges && `Edges: ${gradingReport.edges}`, gradingReport.surface && `Surface: ${gradingReport.surface}`, gradingReport.overall && `Overall: ${gradingReport.overall}`].filter(Boolean).join(". ");
        if (noteStr) {
          doc.font("Helvetica").fontSize(5).fillColor(TEXT).text(noteStr, M, y, { width: CW, lineGap: 0.5 });
          y += Math.min(30, Math.ceil(noteStr.length / 120) * 7 + 3);
        }
      }

      // ── AUTH + CONDITION ────────────────────────────────────────────────────
      if (canFit(25, "Authentication & Condition")) {
        hr(); heading("Authentication & Condition");
        const al = data.authentication.status === "genuine" ? "Genuine" : data.authentication.status === "authentic_altered" ? "Authentic Altered" : "Not Original";
        row("Auth Status", al);
        if (defects.length === 0) { row("Defects", "None recorded"); }
        else {
          row("Defects", `${defects.length} detected`);
          const shown = defects.slice(0, 4);
          for (const d of shown) { doc.font("Helvetica").fontSize(5).fillColor(TEXT).text(`\u2022 ${d.type} (${d.location}, ${d.severity})`, M + 8, y, { width: CW - 12 }); y += 8; }
          if (defects.length > 4) { doc.font("Helvetica").fontSize(4.5).fillColor(MUTED).text(`+ ${defects.length - 4} more`, M + 8, y); y += 7; }
        }
      }

      // ── CARD IMAGES ────────────────────────────────────────────────────────
      if ((frontBuf || backBuf) && canFit(140, "Card Images")) {
        hr(); heading("Card Images");
        const imgH = 130;
        const imgW = (CW - 10) / 2;
        if (frontBuf && backBuf) {
          try { doc.image(frontBuf, M, y, { fit: [imgW, imgH] }); } catch {}
          try { doc.image(backBuf, M + imgW + 10, y, { fit: [imgW, imgH] }); } catch {}
        } else {
          const buf = frontBuf || backBuf;
          if (buf) try { doc.image(buf, M + CW * 0.2, y, { fit: [CW * 0.6, imgH] }); } catch {}
        }
        y += imgH + 2;
      }

      // ── OWNERSHIP ──────────────────────────────────────────────────────────
      if (ownership?.chain?.length > 0 && canFit(20, "Ownership History")) {
        hr(); heading("Ownership History");
        for (const o of (ownership.chain as any[]).slice(0, 5)) {
          if (y > MAX_Y) break;
          const mk = o.isCurrent ? "\u25CF" : "\u25CB";
          const dt = new Date(o.claimedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
          const end = o.releasedAt ? ` to ${new Date(o.releasedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : " (Current)";
          doc.font("Helvetica").fontSize(5.5).fillColor(o.isCurrent ? GOLD : TEXT).text(`${mk} Owner ${o.ownerNumber} \u2014 ${dt}${end}`, M + 3, y, { width: CW - 6 }); y += 9;
        }
      }

      // ── REGISTRATION DETAILS (DVLA-style) ──────────────────────────────────
      if (canFit(30, "Registration Details")) {
        hr(); heading("Registration Details");
        const formerKeepers = Math.max(0, (ownership?.chain?.length || 1) - 1);
        row("Former Keepers", String(formerKeepers));
        row("Declared new at first registration", "Not declared");
        if (provenance.issuedAt) row("Date of first registration", new Date(provenance.issuedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }));
      }

      // ── TRANSFER PROCESS ───────────────────────────────────────────────────
      if (canFit(25, "Transfer Process")) {
        hr(); heading("Transfer Process");
        bodyText("To transfer ownership of this certificate, the current Registered Keeper must initiate a transfer at mintvaultuk.com/transfer using the Certificate ID and their Document Reference Number (found on the Owner Copy of this logbook). The new keeper confirms via email within 14 days. Transfers become final after a 14-day dispute window closes.");
      }

      // ── LOSS, THEFT OR DISPUTE ─────────────────────────────────────────────
      if (canFit(18, "Loss, Theft or Dispute")) {
        hr(); heading("Loss, Theft or Dispute");
        bodyText("Report loss, theft, or unauthorised transfer immediately to support@mintvaultuk.com. Disputes must be raised within 14 days of a transfer being initiated.");
      }

      // ── OWNER-ONLY: REFERENCE NUMBER ───────────────────────────────────────
      if (opts.includeReferenceNumber) {
        const refNum = (data as any).referenceNumber;
        if (refNum && canFit(45, "Document Reference Number")) {
          hr(); heading("Document Reference Number");
          doc.font("Courier-Bold").fontSize(14).fillColor(GOLD).text(refNum, M, y, { width: CW, align: "center" }); y += 20;
          bodyText("Keep this number secret. It is required to transfer ownership of this certificate. Treat it like a V5C document \u2014 anyone with this number and the Certificate ID can initiate a transfer. If you believe it has been compromised, report to support@mintvaultuk.com immediately.", MUTED, 4.5);
        }
      }

      // ── VERIFICATION ───────────────────────────────────────────────────────
      if (canFit(55, "Verification")) {
        hr(); heading("Verification");
        try { doc.image(qrBuf, M, y, { width: 45 }); } catch {}
        const vx = M + 55;
        doc.font("Helvetica").fontSize(4.5).fillColor(MUTED).text("SIGNATURE", vx, y);
        doc.font("Courier").fontSize(4).fillColor(TEXT).text(verification.signature || "\u2014", vx, y + 6, { width: CW - 60 });
        doc.font("Helvetica").fontSize(4.5).fillColor(MUTED).text("VERIFY", vx, y + 15);
        doc.font("Courier").fontSize(4).fillColor(GOLD_DARK).text(verification.verifyUrl, vx, y + 21, { width: CW - 60 });
        y += 48;
      }

      // ── DISCLAIMER ─────────────────────────────────────────────────────────
      if (canFit(20, "Disclaimer")) {
        doc.font("Helvetica-Oblique").fontSize(4).fillColor(GRAY).text(
          "This logbook is the official record of grading, authentication, and registered keeper history for this certificate. The Registered Keeper is the person recognised by MintVault as responsible for the card; this is distinct from legal ownership, which may depend on external factors such as purchase records, contracts, or court orders.",
          M, y, { width: CW, align: "center", lineGap: 0.5 }
        );
      }

      // ── PAGE 1 BORDER + FOOTER (drawn last via bufferPages) ────────────────
      doc.switchToPage(0);
      doc.rect(0, 0, PAGE_W, 2.5).fill(GOLD);
      doc.rect(0, PAGE_H - 2.5, PAGE_W, 2.5).fill(GOLD);
      doc.rect(0, 0, 2.5, PAGE_H).fill(GOLD);
      doc.rect(PAGE_W - 2.5, 0, 2.5, PAGE_H).fill(GOLD);
      doc.font("Helvetica").fontSize(4.5).fillColor(MUTED)
        .text(`MintVault Logbook \u2014 ${certId}`, M, PAGE_H - 18, { width: CW / 2, align: "left" })
        .text("mintvaultuk.com", M + CW / 2, PAGE_H - 18, { width: CW / 2, align: "right" });

      // Diagnostic log
      const range = doc.bufferedPageRange();
      console.log(`[logbook-pdf] ${certId}: final y=${Math.round(y)}, bufferedPages=${range.count}, includeRef=${!!opts.includeReferenceNumber}${skippedSections.length > 0 ? `, skipped=[${skippedSections.join(",")}]` : ""}`);

      doc.end();
    } catch (err) { reject(err); }
  });
}
