/**
 * server/routes/transfers.ts
 *
 * Ownership claim, transfer (v1 + v2), buyer-initiated transfer,
 * admin transfer management, ownership export, portfolio, and
 * public collection routes.
 * Extracted from server/routes.ts for maintainability.
 */

import type {
  Express,
  Request as ExpressRequest,
  Response as ExpressResponse,
  NextFunction as ExpressNextFunction,
} from "express";
import rateLimit from "express-rate-limit";
import { db } from "../db";
import { sql } from "drizzle-orm";
import { storage } from "../storage";
import { requireAdmin, ADMIN_EMAIL } from "../auth";
import { requireCustomer } from "../customer-auth";
import { APP_BASE_URL } from "../app-url";
import { generateCertificateDocument } from "../certificate-document";
import { generateClaimInsertPNG, generateClaimInsertPDF, generateClaimInsertSheet } from "../claim-insert";
import { FEATURE_FLAGS } from "../config/feature-flags";
import { getOwnerChain } from "../ownership-service";
import { normalizeCertId } from "../routes";
import {
  sendClaimVerification,
  sendTransferOwnerConfirmation,
  sendTransferNewOwnerConfirmation,
  sendTransferV2OutgoingConfirmation,
  sendTransferV2IncomingConfirmation,
  sendTransferV2DisputeWindowStarted,
  sendTransferV2Completed,
  sendTransferV2Cancelled,
  sendTransferV2Disputed,
  sendTransferV2OwnerInvitedByBuyer,
  sendTransferV2BuyerInitOwnerConfirmed,
  sendTransferV2BuyerInitOwnerRejected,
  sendCertificatePdf,
} from "../email";

export function registerTransferRoutes(app: Express): void {
  // ── PUBLIC CLAIM FLOW ──────────────────────────────────────────────────────
  // Rate limiter: max 5 attempts per IP per 15 minutes to prevent brute-forcing claim codes
  const claimRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many claim attempts from this device. Please wait 15 minutes before trying again." },
  });

  app.post("/api/claim/request", claimRateLimit, async (req, res) => {
    try {
      const { certId, claimCode, email, name, declaredNew } = req.body;
      if (!certId || !claimCode || !email) {
        return res.status(400).json({ error: "Certificate number, claim code, and email are all required." });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({ error: "Please provide a valid email address." });
      }

      const normalizedId = normalizeCertId(certId.trim());
      const cert = await storage.getCertificateByCertId(normalizedId);
      if (!cert) {
        // Generic error — do not confirm or deny whether the cert exists to avoid enumeration
        console.warn(`[claim] Failed attempt — cert not found: ${normalizedId} from IP ${req.ip}`);
        return res
          .status(400)
          .json({ error: "Invalid certificate number or claim code. Please check your details and try again." });
      }
      if ((cert as any).stolenStatus === "reported_stolen") {
        return res.status(403).json({
          error:
            "This certificate has been reported stolen and cannot be transferred. Contact support@mintvaultuk.com to verify.",
        });
      }
      if (cert.ownershipStatus === "claimed") {
        // v435 — surface a machine-readable code so the client can offer
        // the buyer-init transfer path when TRANSFER_FLOW_LIVE is true.
        return res.status(400).json({
          error:
            "This certificate has already been registered to an owner. If you are the new owner with the printed claim insert, you can request a transfer.",
          code: "ALREADY_CLAIMED",
          buyerInitPath: "/transfer/claim-by-code",
        });
      }
      if (cert.ownershipStatus === "transfer_pending") {
        return res.status(400).json({
          error:
            "A transfer is already in progress for this certificate. Please wait for it to complete or be resolved.",
          code: "TRANSFER_IN_PROGRESS",
        });
      }

      // ── SECOND FACTOR: validate claim code ──────────────────────────────────
      const codeValid = await storage.validateClaimCode(normalizedId, claimCode.trim());
      if (!codeValid) {
        console.warn(`[claim] Failed claim code attempt for cert ${normalizedId} from IP ${req.ip}`);
        return res
          .status(400)
          .json({ error: "Invalid certificate number or claim code. Please check your details and try again." });
      }

      const token = await storage.createClaimVerification(
        normalizedId,
        email.trim(),
        name?.trim() || undefined,
        declaredNew === true
      );

      const baseUrl = APP_BASE_URL;
      const verifyUrl = `${baseUrl}/api/claim/verify?token=${token}`;

      // Surface email-send failures explicitly.
      try {
        await sendClaimVerification({ email: email.trim(), certId: normalizedId, verifyUrl });
      } catch (sendErr: any) {
        console.error("[claim] sendClaimVerification failed:", sendErr.message);
        return res.status(500).json({
          success: false,
          error: "Could not send verification email. Please try again or contact support@mintvaultuk.com.",
        });
      }

      return res.json({
        success: true,
        message:
          "Verification email sent! Please check your inbox and click the link to complete your ownership registration.",
      });
    } catch (err: any) {
      console.error("[claim] Error processing claim request:", err);
      return res.status(500).json({ error: "An error occurred processing your request. Please try again." });
    }
  });

  app.get("/api/claim/verify", async (req, res) => {
    try {
      const token = req.query.token as string;
      if (!token) return res.redirect("/claim?error=missing_token");

      const result = await storage.completeClaimByToken(token);
      if (result.success) {
        // Auto-generate and email the certificate PDF
        try {
          const cert = await storage.getCertificateByCertId(result.certId!);
          if (cert && cert.status !== "voided") {
            const pdfBuffer = await generateCertificateDocument(cert, result.ownerName);
            await sendCertificatePdf({
              email: result.email!,
              ownerName: result.ownerName,
              certId: normalizeCertId(cert.certId),
              cardName: cert.cardName,
              pdfBuffer,
            });
          }
        } catch (pdfErr: any) {
          console.error("[claim] PDF generation/email failed (non-fatal):", pdfErr.message);
        }
        return res.redirect(`/claim?success=true&certId=${encodeURIComponent(result.certId || "")}`);
      } else {
        return res.redirect(`/claim?error=${encodeURIComponent(result.error || "unknown")}`);
      }
    } catch (err: any) {
      console.error("[claim] Error verifying claim:", err);
      return res.redirect("/claim?error=server_error");
    }
  });

  // ── PUBLIC TRANSFER FLOW ───────────────────────────────────────────────────
  // Rate limiter: max 5 attempts per IP per 15 minutes
  const transferRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many transfer attempts from this device. Please wait 15 minutes before trying again." },
  });

  // Step 1: initiate — current owner enters cert ID + their email + new owner email
  app.post("/api/transfer/request", transferRateLimit, async (req, res) => {
    try {
      const { certId, fromEmail, toEmail, newOwnerName } = req.body;
      if (!certId || !fromEmail || !toEmail) {
        return res.status(400).json({ error: "Certificate number, your email, and new owner email are all required." });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(fromEmail) || !emailRegex.test(toEmail)) {
        return res.status(400).json({ error: "Please provide valid email addresses for both fields." });
      }

      if (fromEmail.toLowerCase().trim() === toEmail.toLowerCase().trim()) {
        return res.status(400).json({ error: "The current owner and new owner email addresses must be different." });
      }

      const normalizedId = normalizeCertId(certId.trim());
      const cert = await storage.getCertificateByCertId(normalizedId);
      if (!cert) {
        return res.status(404).json({ error: "Certificate not found. Please check your certificate number." });
      }
      if (cert.ownershipStatus !== "claimed") {
        return res
          .status(400)
          .json({ error: "This certificate does not have a registered owner. Please use Register Ownership first." });
      }

      // Verify the fromEmail matches the current owner
      if (cert.currentOwnerUserId) {
        const owner = await storage.getUser(cert.currentOwnerUserId);
        if (!owner || (owner.email ?? "").toLowerCase() !== fromEmail.toLowerCase().trim()) {
          return res
            .status(400)
            .json({ error: "The email address you entered does not match the registered owner of this certificate." });
        }
      } else {
        return res.status(400).json({ error: "This certificate does not have a verified owner on record." });
      }

      const ownerToken = await storage.createTransferVerification(
        normalizedId,
        fromEmail.trim(),
        toEmail.trim(),
        newOwnerName?.trim() || undefined
      );
      const baseUrl = APP_BASE_URL;
      const confirmUrl = `${baseUrl}/api/transfer/owner-confirm?token=${ownerToken}`;

      await sendTransferOwnerConfirmation({
        fromEmail: fromEmail.trim(),
        toEmail: toEmail.trim(),
        certId: normalizedId,
        confirmUrl,
      });

      return res.json({
        success: true,
        message: "Transfer initiated. Please check your inbox and click the confirmation link to proceed.",
      });
    } catch (err: any) {
      console.error("[transfer] Error initiating transfer:", err);
      return res.status(500).json({ error: "An error occurred. Please try again." });
    }
  });

  // Step 2: current owner clicks their confirmation link → generates new owner token, sends to new owner
  app.get("/api/transfer/owner-confirm", async (req, res) => {
    try {
      const token = req.query.token as string;
      if (!token) return res.redirect("/transfer?error=missing_token");

      const result = await storage.confirmOwnerTransferStep(token);
      if (!result.success || !result.newOwnerToken) {
        return res.redirect(`/transfer?error=${encodeURIComponent(result.error || "unknown")}`);
      }

      const baseUrl = APP_BASE_URL;
      const newOwnerConfirmUrl = `${baseUrl}/api/transfer/new-owner-confirm?token=${result.newOwnerToken}`;

      await sendTransferNewOwnerConfirmation({
        toEmail: result.toEmail || "",
        fromEmail: result.fromEmail || "",
        certId: result.certId || "",
        confirmUrl: newOwnerConfirmUrl,
      });

      return res.redirect(`/transfer?step=owner_confirmed&certId=${encodeURIComponent(result.certId || "")}`);
    } catch (err: any) {
      console.error("[transfer] Error confirming owner step:", err);
      return res.redirect("/transfer?error=server_error");
    }
  });

  // Step 3: new owner clicks their confirmation link → transfer completes
  app.get("/api/transfer/new-owner-confirm", async (req, res) => {
    try {
      const token = req.query.token as string;
      if (!token) return res.redirect("/transfer?error=missing_token");

      const result = await storage.completeTransferByNewOwnerToken(token);
      if (result.success) {
        // Auto-generate and email the certificate PDF to the new owner
        try {
          const cert = await storage.getCertificateByCertId(result.certId!);
          if (cert && cert.status !== "voided") {
            const pdfBuffer = await generateCertificateDocument(cert, result.ownerName);
            await sendCertificatePdf({
              email: result.toEmail!,
              ownerName: result.ownerName,
              certId: normalizeCertId(cert.certId),
              cardName: cert.cardName,
              pdfBuffer,
            });
          }
        } catch (pdfErr: any) {
          console.error("[transfer] PDF generation/email failed (non-fatal):", pdfErr.message);
        }
        return res.redirect(`/transfer?success=true&certId=${encodeURIComponent(result.certId || "")}`);
      } else {
        return res.redirect(`/transfer?error=${encodeURIComponent(result.error || "unknown")}`);
      }
    } catch (err: any) {
      console.error("[transfer] Error completing transfer:", err);
      return res.redirect("/transfer?error=server_error");
    }
  });

  // ── V2 TRANSFER FLOW (DVLA-style: ref number + 14-day dispute window) ────
  // v435 — public transfer endpoints are gated by TRANSFER_FLOW_LIVE. When
  // false (default), they return 503. Admin endpoints are NOT gated so we
  // can inspect/resolve regardless of the public switch.
  const requireTransferFlowLive = (_req: ExpressRequest, res: ExpressResponse, next: ExpressNextFunction) => {
    if (!FEATURE_FLAGS.TRANSFER_FLOW_LIVE) {
      return res.status(503).json({ error: "Transfer flow not yet available — coming soon." });
    }
    next();
  };

  // Rate limiter: max 5 attempts per IP per 15 minutes (shared concept, separate instance)
  const transferV2RateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many transfer attempts. Please wait 15 minutes before trying again." },
  });

  // Stricter rate limit for ref number verification — 3 attempts per hour per IP
  const refNumberRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many verification attempts. Please wait before trying again." },
  });

  // Transfer dispute/cancel — same pattern as existing transferV2RateLimit
  const transferActionRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many transfer actions — please try again later." },
  });

  // Step 1: outgoing keeper initiates transfer
  app.post("/api/v2/transfers/initiate", requireTransferFlowLive, transferV2RateLimit, async (req, res) => {
    try {
      const { certId, fromEmail, toEmail, newOwnerName } = req.body;
      if (!certId || !fromEmail || !toEmail) {
        return res
          .status(400)
          .json({ error: "Certificate number, your email, and new keeper email are all required." });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(fromEmail) || !emailRegex.test(toEmail)) {
        return res.status(400).json({ error: "Please provide valid email addresses." });
      }

      if (fromEmail.toLowerCase().trim() === toEmail.toLowerCase().trim()) {
        return res.status(400).json({ error: "The current and new keeper email addresses must be different." });
      }

      const normalizedId = normalizeCertId(certId.trim());
      const cert = await storage.getCertificateByCertId(normalizedId);
      if (!cert) {
        return res.status(404).json({ error: "Certificate not found." });
      }
      if ((cert as any).stolenStatus === "reported_stolen") {
        return res.status(403).json({
          error:
            "This certificate has been reported stolen and cannot be transferred. Contact support@mintvaultuk.com to verify.",
        });
      }
      if (cert.ownershipStatus === "transfer_pending") {
        return res.status(400).json({ error: "A transfer is already in progress for this certificate." });
      }
      if (cert.ownershipStatus !== "claimed") {
        return res
          .status(400)
          .json({ error: "This certificate does not have a registered keeper. Please use Register Ownership first." });
      }

      // Verify fromEmail matches the current owner
      if (!cert.currentOwnerUserId) {
        return res.status(400).json({ error: "This certificate does not have a verified keeper on record." });
      }
      const owner = await storage.getUser(cert.currentOwnerUserId);
      if (!owner || (owner.email ?? "").toLowerCase() !== fromEmail.toLowerCase().trim()) {
        return res.status(400).json({ error: "The email address does not match the registered keeper." });
      }

      // Check reference number exists (required for v2)
      const certRefNumber = (cert as any).referenceNumber as string | null;
      if (!certRefNumber) {
        return res
          .status(400)
          .json({ error: "This certificate does not have a Document Reference Number yet. Please contact support." });
      }

      // Check for existing active v2 transfer
      const existing = await storage.getTransferV2ByCertId(normalizedId);
      if (existing) {
        return res.status(400).json({ error: "A transfer is already in progress for this certificate." });
      }

      const ownerToken = await storage.createTransferV2({
        certId: normalizedId,
        fromEmail: fromEmail.trim(),
        toEmail: toEmail.trim(),
        newOwnerName: newOwnerName?.trim() || undefined,
        outgoingKeeperUserId: cert.currentOwnerUserId,
        referenceNumber: certRefNumber,
      });

      const baseUrl = APP_BASE_URL;
      const confirmUrl = `${baseUrl}/api/v2/transfers/outgoing-confirm?token=${ownerToken}`;

      await sendTransferV2OutgoingConfirmation({
        fromEmail: fromEmail.trim(),
        toEmail: toEmail.trim(),
        certId: normalizedId,
        confirmUrl,
      });

      await storage.writeAuditLog("transfer", normalizedId, "transfer_v2.initiated", null, {
        fromEmail: fromEmail.trim().toLowerCase(),
        toEmail: toEmail.trim().toLowerCase(),
      });

      return res.json({ success: true, message: "Transfer initiated. Check your inbox for the confirmation link." });
    } catch (err: any) {
      console.error("[transfer-v2] Error initiating:", err);
      return res.status(500).json({ error: "An error occurred. Please try again." });
    }
  });

  // Step 2: outgoing keeper clicks email link → generates incoming keeper token
  app.get("/api/v2/transfers/outgoing-confirm", requireTransferFlowLive, async (req, res) => {
    try {
      const token = req.query.token as string;
      if (!token) return res.redirect("/transfer?error=missing_token&v=2");

      const result = await storage.confirmOutgoingKeeperV2(token);
      if (!result.success || !result.newOwnerToken) {
        return res.redirect(`/transfer?error=${encodeURIComponent(result.error || "unknown")}&v=2`);
      }

      const baseUrl = APP_BASE_URL;
      const incomingConfirmUrl = `${baseUrl}/transfer/accept?token=${result.newOwnerToken}&v=2`;

      // Compute former-keeper count for DVLA-parity on the incoming-transfer email.
      const ownerChain = result.certId ? await getOwnerChain(result.certId) : [];
      const previousOwnersCount = Math.max(0, ownerChain.length - 1);

      await sendTransferV2IncomingConfirmation({
        toEmail: result.toEmail || "",
        fromEmail: result.fromEmail || "",
        certId: result.certId || "",
        confirmUrl: incomingConfirmUrl,
        previousOwnersCount,
      });

      // v435 — audit log the outgoing-keeper confirmation step transition.
      await storage.writeAuditLog("transfer", result.certId || "", "transfer_v2.outgoing_confirmed", null, {
        fromEmail: result.fromEmail,
        toEmail: result.toEmail,
      });

      return res.redirect(`/transfer?step=outgoing_confirmed&certId=${encodeURIComponent(result.certId || "")}&v=2`);
    } catch (err: any) {
      console.error("[transfer-v2] Error outgoing confirm:", err);
      return res.redirect("/transfer?error=server_error&v=2");
    }
  });

  // Step 3: incoming keeper submits ref number + token → enters dispute window
  app.post(
    "/api/v2/transfers/incoming-confirm",
    requireTransferFlowLive,
    transferV2RateLimit,
    refNumberRateLimit,
    async (req, res) => {
      try {
        const { token, referenceNumber } = req.body;
        if (!token || !referenceNumber) {
          return res.status(400).json({ error: "Token and Document Reference Number are required." });
        }

        if (typeof referenceNumber !== "string" || referenceNumber.replace(/-/g, "").length < 8) {
          return res
            .status(400)
            .json({ error: "Please enter a valid Document Reference Number (format: XXXX-XXXX-XXXX)." });
        }

        const result = await storage.confirmIncomingKeeperV2(token, referenceNumber);
        if (!result.success) {
          if (result.stolen) {
            return res.status(403).json({ error: result.error });
          }
          return res.status(400).json({ error: result.error });
        }

        // Send dispute-window emails to both parties
        try {
          const cert = await storage.getCertificateByCertId(result.certId!);
          if (cert) {
            const ownerUser = cert.currentOwnerUserId ? await storage.getUser(cert.currentOwnerUserId) : null;
            const transfer = await storage.getTransferV2ByCertId(result.certId!);
            const disputeDeadline = transfer?.disputeDeadline || new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

            if (ownerUser?.email) {
              await sendTransferV2DisputeWindowStarted({
                email: ownerUser.email,
                certId: result.certId!,
                role: "outgoing",
                disputeDeadline,
              });
            }
            await sendTransferV2DisputeWindowStarted({
              email: result.toEmail!,
              certId: result.certId!,
              role: "incoming",
              disputeDeadline,
            });
          }
        } catch (emailErr: any) {
          console.error("[transfer-v2] Dispute window emails failed (non-fatal):", emailErr.message);
        }

        await storage.writeAuditLog("transfer", result.certId!, "transfer_v2.incoming_confirmed", null, {
          toEmail: result.toEmail,
          referenceNumberPresent: true,
        });

        return res.json({ success: true, message: "Transfer verified. A 14-day dispute window is now active." });
      } catch (err: any) {
        console.error("[transfer-v2] Error incoming confirm:", err);
        return res.status(500).json({ error: "An error occurred. Please try again." });
      }
    }
  );

  // Status check for a v2 transfer
  app.get("/api/v2/transfers/status/:certId", requireTransferFlowLive, async (req, res) => {
    try {
      const normalizedId = normalizeCertId(String(req.params.certId));
      const transfer = await storage.getTransferV2ByCertId(normalizedId);
      if (!transfer) {
        return res.status(404).json({ error: "No active transfer found for this certificate." });
      }

      return res.json({
        certId: transfer.certId,
        status: transfer.status,
        flowVersion: transfer.flowVersion,
        fromEmail: transfer.fromEmail.replace(/(.{2}).*(@.*)/, "$1***$2"), // mask email
        toEmail: transfer.toEmail.replace(/(.{2}).*(@.*)/, "$1***$2"),
        ownerConfirmed: !!transfer.ownerConfirmedAt,
        incomingConfirmed: transfer.status === "pending_dispute" || transfer.status === "completed",
        disputeDeadline: transfer.disputeDeadline,
        finalisedAt: transfer.finalisedAt,
        createdAt: transfer.createdAt,
      });
    } catch (err: any) {
      console.error("[transfer-v2] Error fetching status:", err);
      return res.status(500).json({ error: "An error occurred." });
    }
  });

  // Dispute a v2 transfer during the 14-day window
  app.post("/api/v2/transfers/dispute", requireTransferFlowLive, transferActionRateLimit, async (req, res) => {
    try {
      const { certId, email, reason } = req.body;
      if (!certId || !email || !reason) {
        return res.status(400).json({ error: "Certificate ID, your email, and a reason are required." });
      }

      const normalizedId = normalizeCertId(certId.trim());
      const transfer = await storage.getTransferV2ByCertId(normalizedId);
      if (!transfer) {
        return res.status(404).json({ error: "No active transfer found." });
      }

      // Determine role
      const normEmail = email.toLowerCase().trim();
      let role: "outgoing" | "incoming";
      if (normEmail === transfer.fromEmail.toLowerCase()) {
        role = "outgoing";
      } else if (normEmail === transfer.toEmail.toLowerCase()) {
        role = "incoming";
      } else {
        return res.status(403).json({ error: "You are not a party to this transfer." });
      }

      const result = await storage.disputeTransferV2(transfer.id, role, reason);
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      // Audit
      await storage.writeAuditLog("transfer", String(transfer.id), "transfer_v2.disputed", null, {
        certId: normalizedId,
        disputedBy: role,
        reason: reason.trim().slice(0, 200),
      });

      // Notify the other party
      try {
        const otherEmail = role === "outgoing" ? transfer.toEmail : transfer.fromEmail;
        await sendTransferV2Disputed({ email: otherEmail, certId: normalizedId, disputedBy: role });
      } catch {}

      return res.json({
        success: true,
        message: "Dispute raised. The transfer has been paused and MintVault will review.",
      });
    } catch (err: any) {
      console.error("[transfer-v2] Error disputing:", err);
      return res.status(500).json({ error: "An error occurred." });
    }
  });

  // Cancel a v2 transfer (outgoing keeper only, before completion)
  app.post("/api/v2/transfers/cancel", requireTransferFlowLive, transferActionRateLimit, async (req, res) => {
    try {
      const { certId, email } = req.body;
      if (!certId || !email) {
        return res.status(400).json({ error: "Certificate ID and your email are required." });
      }

      const normalizedId = normalizeCertId(certId.trim());
      const transfer = await storage.getTransferV2ByCertId(normalizedId);
      if (!transfer) {
        return res.status(404).json({ error: "No active transfer found." });
      }

      // Only the outgoing keeper can cancel
      if (email.toLowerCase().trim() !== transfer.fromEmail.toLowerCase()) {
        return res.status(403).json({ error: "Only the current registered keeper can cancel a transfer." });
      }

      const result = await storage.cancelTransferV2(transfer.id, "Cancelled by outgoing keeper");
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      await storage.writeAuditLog("transfer", String(transfer.id), "transfer_v2.cancelled", null, {
        certId: normalizedId,
        cancelledBy: "outgoing",
      });

      // Notify both parties
      try {
        await sendTransferV2Cancelled({
          email: transfer.fromEmail,
          certId: normalizedId,
          reason: "Cancelled by current keeper",
        });
        await sendTransferV2Cancelled({
          email: transfer.toEmail,
          certId: normalizedId,
          reason: "Cancelled by current keeper",
        });
      } catch {}

      return res.json({ success: true, message: "Transfer cancelled. Your keepership record is unchanged." });
    } catch (err: any) {
      console.error("[transfer-v2] Error cancelling:", err);
      return res.status(500).json({ error: "An error occurred." });
    }
  });

  // v435 — masks an email for audit log use: alice@example.com → a***@example.com
  const maskEmailForAudit = (email: string): string => {
    const trimmed = email.trim().toLowerCase();
    const at = trimmed.indexOf("@");
    if (at <= 0) return "***";
    const head = trimmed.slice(0, at);
    const domain = trimmed.slice(at);
    if (head.length <= 1) return `${head}***${domain}`;
    return `${head.charAt(0)}***${domain}`;
  };

  // ── V435 BUYER-INITIATED TRANSFER (eBay buyer with claim insert) ────────
  app.post(
    "/api/v2/transfers/claim-by-code",
    requireTransferFlowLive,
    transferV2RateLimit,
    claimRateLimit,
    async (req, res) => {
      try {
        const { certId, claimCode, claimantEmail, claimantName } = req.body as {
          certId?: unknown;
          claimCode?: unknown;
          claimantEmail?: unknown;
          claimantName?: unknown;
        };
        if (typeof certId !== "string" || typeof claimCode !== "string" || typeof claimantEmail !== "string") {
          return res.status(400).json({ error: "Certificate number, claim code, and your email are all required." });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(claimantEmail.trim())) {
          return res.status(400).json({ error: "Please provide a valid email address." });
        }

        const normalizedCertId = normalizeCertId(certId.trim());
        const cert = await storage.getCertificateByCertId(normalizedCertId);
        if (!cert) {
          return res.status(404).json({ error: "Certificate not found." });
        }

        if ((cert as any).stolenStatus === "reported_stolen") {
          return res.status(403).json({
            error:
              "This certificate has been reported stolen and cannot be transferred. Contact support@mintvaultuk.com to verify.",
          });
        }

        // Path discrimination — buyer-init only handles already-claimed certs.
        if (cert.ownershipStatus === "unclaimed") {
          return res.status(409).json({
            error: "This certificate has not yet been claimed. Use the first-time claim flow.",
            redirect: "/api/claim/request",
          });
        }
        if (cert.ownershipStatus === "transfer_pending") {
          await storage.writeAuditLog("transfer", normalizedCertId, "transfer_v2.buyer_init_rejected_race", null, {
            reason: "Another transfer in progress",
            claimantEmailMasked: maskEmailForAudit(claimantEmail.trim()),
          });
          return res.status(409).json({
            error:
              "A transfer is already in progress for this certificate. Please wait for it to complete or be resolved.",
          });
        }
        if (cert.ownershipStatus !== "claimed") {
          return res.status(400).json({ error: "This certificate is not in a state that supports transfer." });
        }

        // Validate the claim code (constant-time hash compare at DB layer)
        const validation = await storage.validateClaimCodeForTransfer(normalizedCertId, claimCode.trim());
        if (!validation.valid || !validation.currentOwnerEmail || !validation.currentOwnerUserId) {
          await storage.writeAuditLog("transfer", normalizedCertId, "transfer_v2.buyer_init_rejected_bad_code", null, {
            claimantEmailMasked: maskEmailForAudit(claimantEmail.trim()),
          });
          return res.status(401).json({ error: "Invalid certificate number or claim code." });
        }

        // Self-transfer guard
        if (claimantEmail.toLowerCase().trim() === validation.currentOwnerEmail) {
          return res.status(400).json({ error: "You're already the registered keeper of this certificate." });
        }

        // Final race check
        const existing = await storage.getTransferV2ByCertId(normalizedCertId);
        if (existing) {
          await storage.writeAuditLog("transfer", normalizedCertId, "transfer_v2.buyer_init_rejected_race", null, {
            reason: "Active transfer detected on second check",
            claimantEmailMasked: maskEmailForAudit(claimantEmail.trim()),
            existingTransferId: existing.id,
          });
          return res.status(409).json({ error: "A transfer is already in progress for this certificate." });
        }

        const { ownerToken, transferId } = await storage.createTransferV2BuyerInit({
          certId: normalizedCertId,
          claimantEmail: claimantEmail.trim(),
          claimantName: typeof claimantName === "string" ? claimantName.trim() : undefined,
          currentOwnerEmail: validation.currentOwnerEmail,
          currentOwnerUserId: validation.currentOwnerUserId,
        });

        const baseUrl = APP_BASE_URL;
        const disputeUrl = `${baseUrl}/api/v2/transfers/buyer-init/owner-dispute?token=${ownerToken}`;
        const confirmUrl = `${baseUrl}/api/v2/transfers/buyer-init/owner-confirm?token=${ownerToken}`;
        const ownerExpiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

        await sendTransferV2OwnerInvitedByBuyer({
          ownerEmail: validation.currentOwnerEmail,
          certId: normalizedCertId,
          maskedClaimantEmail: maskEmailForAudit(claimantEmail.trim()),
          ownerExpiresAt,
          disputeUrl,
          confirmUrl,
        });

        await storage.writeAuditLog("transfer", String(transferId), "transfer_v2.buyer_init_initiated", null, {
          certId: normalizedCertId,
          claimantEmailMasked: maskEmailForAudit(claimantEmail.trim()),
          currentOwnerEmailMasked: maskEmailForAudit(validation.currentOwnerEmail),
          ownerExpiresAt: ownerExpiresAt.toISOString(),
        });

        return res.json({
          success: true,
          message: "Transfer requested. The current keeper has been notified and has 14 days to confirm or dispute.",
          transferId,
        });
      } catch (err: any) {
        console.error("[transfer-v2-buyer-init] Error:", err);
        return res.status(500).json({ error: "An error occurred. Please try again." });
      }
    }
  );

  // Owner clicks CONFIRM link in buyer-init notification email
  app.get("/api/v2/transfers/buyer-init/owner-confirm", requireTransferFlowLive, async (req, res) => {
    try {
      const token = req.query.token as string;
      if (!token) return res.redirect("/transfer?error=missing_token&v=2&path=buyer-init");

      const result = await storage.confirmBuyerInitTransfer(token);
      if (!result.success) {
        return res.redirect(`/transfer?error=${encodeURIComponent(result.error || "unknown")}&v=2&path=buyer-init`);
      }

      // Notify the buyer that the owner confirmed and the dispute window has started.
      try {
        await sendTransferV2BuyerInitOwnerConfirmed({
          claimantEmail: result.claimantEmail!,
          certId: result.certId!,
          disputeDeadline: result.disputeDeadline!,
        });
        await sendTransferV2DisputeWindowStarted({
          email: result.ownerEmail!,
          certId: result.certId!,
          role: "outgoing",
          disputeDeadline: result.disputeDeadline!,
        });
        await sendTransferV2DisputeWindowStarted({
          email: result.claimantEmail!,
          certId: result.certId!,
          role: "incoming",
          disputeDeadline: result.disputeDeadline!,
        });
      } catch (emailErr: any) {
        console.error("[transfer-v2-buyer-init] confirm emails failed (non-fatal):", emailErr.message);
      }

      await storage.writeAuditLog(
        "transfer",
        String(result.transferId),
        "transfer_v2.buyer_init_owner_confirmed",
        null,
        {
          certId: result.certId,
          disputeDeadline: result.disputeDeadline?.toISOString(),
        }
      );

      return res.redirect(
        `/transfer?step=buyer_init_owner_confirmed&certId=${encodeURIComponent(result.certId || "")}&v=2`
      );
    } catch (err: any) {
      console.error("[transfer-v2-buyer-init] owner-confirm error:", err);
      return res.redirect("/transfer?error=server_error&v=2&path=buyer-init");
    }
  });

  // Owner clicks DISPUTE link in buyer-init notification email — rejects immediately
  app.get("/api/v2/transfers/buyer-init/owner-dispute", requireTransferFlowLive, async (req, res) => {
    try {
      const token = req.query.token as string;
      if (!token) return res.redirect("/transfer?error=missing_token&v=2&path=buyer-init");

      const result = await storage.disputeBuyerInitTransfer(token);
      if (!result.success) {
        return res.redirect(`/transfer?error=${encodeURIComponent(result.error || "unknown")}&v=2&path=buyer-init`);
      }

      // Notify the buyer that the owner rejected.
      try {
        await sendTransferV2BuyerInitOwnerRejected({
          claimantEmail: result.claimantEmail!,
          certId: result.certId!,
        });
      } catch (emailErr: any) {
        console.error("[transfer-v2-buyer-init] reject email failed (non-fatal):", emailErr.message);
      }

      await storage.writeAuditLog(
        "transfer",
        String(result.transferId),
        "transfer_v2.buyer_init_owner_disputed",
        null,
        {
          certId: result.certId,
        }
      );

      return res.redirect(
        `/transfer?step=buyer_init_owner_disputed&certId=${encodeURIComponent(result.certId || "")}&v=2`
      );
    } catch (err: any) {
      console.error("[transfer-v2-buyer-init] owner-dispute error:", err);
      return res.redirect("/transfer?error=server_error&v=2&path=buyer-init");
    }
  });

  // ── ADMIN TRANSFERS LIST ───────────────────────────────────────────────
  app.get("/api/admin/transfers", requireAdmin, async (_req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT id, cert_id, from_email, to_email, flow_version,
               transfer_status, owner_confirmed_at, dispute_deadline,
               disputed_at, dispute_reason, disputed_by,
               finalised_at, cancelled_at, cancellation_reason,
               used_at, created_at
        FROM transfer_verifications
        ORDER BY created_at DESC
        LIMIT 200
      `);

      const rows = (result.rows as any[]).map((r) => ({
        id: r.id,
        certId: r.cert_id,
        fromEmail: r.from_email,
        toEmail: r.to_email,
        flowVersion: r.flow_version || "v1",
        status: r.transfer_status || (r.used_at ? "completed" : "pending_owner"),
        ownerConfirmedAt: r.owner_confirmed_at,
        disputeDeadline: r.dispute_deadline,
        disputedAt: r.disputed_at,
        disputeReason: r.dispute_reason,
        disputedBy: r.disputed_by,
        finalisedAt: r.finalised_at,
        cancelledAt: r.cancelled_at,
        cancellationReason: r.cancellation_reason,
        createdAt: r.created_at,
      }));

      return res.json(rows);
    } catch (err: any) {
      console.error("[admin] Error listing transfers:", err);
      return res.status(500).json({ error: "Failed to load transfers" });
    }
  });

  // ── ADMIN TRANSFER RESOLVE (force-finalise + force-cancel) ──────────────
  app.post("/api/admin/transfers/:id/force-finalise", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid transfer id." });

      const { reason } = req.body || {};
      if (typeof reason !== "string" || reason.trim().length < 10) {
        return res.status(400).json({ error: "Reason is required (minimum 10 characters)." });
      }
      const trimmedReason = reason.trim().slice(0, 2000);

      const transfer = await storage.getTransferV2(id);
      if (!transfer) return res.status(404).json({ error: "Transfer not found." });

      if (["completed", "cancelled", "expired"].includes(transfer.status)) {
        return res.status(400).json({ error: `Transfer is already ${transfer.status}.` });
      }
      if (!["pending_dispute", "disputed"].includes(transfer.status)) {
        return res
          .status(400)
          .json({ error: "Force-finalise is only allowed on pending_dispute or disputed transfers." });
      }

      const priorStatus = transfer.status;
      const result = await storage.finaliseTransferV2(id, { skipStatusCheck: true });
      if (!result.success) return res.status(400).json({ error: result.error || "Finalise failed." });

      const adminUser = req.session.adminEmail || ADMIN_EMAIL;
      await storage.writeAuditLog("transfer", transfer.certId, "admin_force_finalise", adminUser, {
        transferId: id,
        priorStatus,
        reason: trimmedReason,
        fromEmail: transfer.fromEmail,
        toEmail: transfer.toEmail,
        disputeReason: transfer.disputeReason ?? null,
        disputedBy: transfer.disputedBy ?? null,
      });

      // Notify both parties
      try {
        await sendTransferV2Completed({ email: transfer.fromEmail, certId: result.certId!, role: "outgoing" });
        await sendTransferV2Completed({
          email: result.toEmail!,
          certId: result.certId!,
          role: "incoming",
          newKeeperName: result.ownerName,
        });
      } catch (emailErr: any) {
        console.error("[admin] force-finalise emails failed (non-fatal):", emailErr.message);
      }

      return res.json({ ok: true, certId: result.certId, toEmail: result.toEmail });
    } catch (err: any) {
      console.error("[admin] force-finalise error:", err);
      return res.status(500).json({ error: "Failed to force-finalise transfer." });
    }
  });

  app.post("/api/admin/transfers/:id/force-cancel", requireAdmin, async (req, res) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid transfer id." });

      const { reason } = req.body || {};
      if (typeof reason !== "string" || reason.trim().length < 10) {
        return res.status(400).json({ error: "Reason is required (minimum 10 characters)." });
      }
      const trimmedReason = reason.trim().slice(0, 1900);

      const transfer = await storage.getTransferV2(id);
      if (!transfer) return res.status(404).json({ error: "Transfer not found." });

      if (["completed", "cancelled", "expired"].includes(transfer.status)) {
        return res.status(400).json({ error: `Transfer is already ${transfer.status}.` });
      }

      const priorStatus = transfer.status;
      const adminPrefixed = `[ADMIN] ${trimmedReason}`;
      const result = await storage.cancelTransferV2(id, adminPrefixed);
      if (!result.success) return res.status(400).json({ error: result.error || "Cancel failed." });

      const adminUser = req.session.adminEmail || ADMIN_EMAIL;
      await storage.writeAuditLog("transfer", transfer.certId, "admin_force_cancel", adminUser, {
        transferId: id,
        priorStatus,
        reason: trimmedReason,
        fromEmail: transfer.fromEmail,
        toEmail: transfer.toEmail,
      });

      // Notify both parties
      try {
        await sendTransferV2Cancelled({ email: transfer.fromEmail, certId: transfer.certId, reason: adminPrefixed });
        await sendTransferV2Cancelled({ email: transfer.toEmail, certId: transfer.certId, reason: adminPrefixed });
      } catch (emailErr: any) {
        console.error("[admin] force-cancel emails failed (non-fatal):", emailErr.message);
      }

      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[admin] force-cancel error:", err);
      return res.status(500).json({ error: "Failed to cancel transfer." });
    }
  });

  // ── ADMIN OWNERSHIP ROUTES ────────────────────────────────────────────────
  app.get("/api/admin/certificates/:certId/ownership", requireAdmin, async (req, res) => {
    try {
      const cert = await storage.getCertificateByCertId(String(req.params.certId));
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const history = await storage.getOwnershipHistory(String(req.params.certId));

      let ownerEmail: string | null = null;
      if (cert.currentOwnerUserId) {
        const owner = await storage.getUser(cert.currentOwnerUserId);
        ownerEmail = owner?.email || null;
      }

      return res.json({
        certId: cert.certId,
        ownershipStatus: cert.ownershipStatus,
        ownerEmail,
        ownerUserId: cert.currentOwnerUserId,
        hasClaimCode: !!cert.claimCodeHash,
        claimCodeCreatedAt: cert.claimCodeCreatedAt,
        claimCodeUsedAt: cert.claimCodeUsedAt,
        ownershipToken: (cert as any).ownershipToken ?? null,
        ownershipTokenGeneratedAt: (cert as any).ownershipTokenGeneratedAt ?? null,
        history,
      });
    } catch (err: any) {
      console.error("[admin] Error fetching ownership:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/admin/certificates/:certId/regenerate-claim-code", requireAdmin, async (req, res) => {
    try {
      const certId = String(req.params.certId);
      const cert = await storage.getCertificateByCertId(certId);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const claimCode = await storage.generateClaimCode(certId);
      await storage.writeAuditLog("certificate", certId, "CLAIM_CODE_REGENERATED", "admin", {});

      return res.json({ certId, claimCode });
    } catch (err: any) {
      console.error("[admin] Error regenerating claim code:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/admin/certificates/:certId/assign-owner", requireAdmin, async (req, res) => {
    try {
      const { email, notes, overrideStolen, overrideReason } = req.body;
      if (!email) return res.status(400).json({ error: "Email is required" });

      const certId = String(req.params.certId);
      const cert = await storage.getCertificateByCertId(certId);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const adminUser = (req.session as any)?.adminEmail || "admin";

      // Admin-override audit.
      if (overrideStolen === true && (cert as any).stolenStatus === "reported_stolen") {
        await storage.writeAuditLog("certificate", certId, "admin_override_stolen_assign", adminUser, {
          email,
          reason: typeof overrideReason === "string" ? overrideReason.trim().slice(0, 2000) : null,
        });
      }

      await storage.assignOwnerManual(certId, email, adminUser, notes, { overrideStolen: overrideStolen === true });
      return res.json({ success: true });
    } catch (err: any) {
      const { StolenCertError } = await import("../storage");
      if (err instanceof StolenCertError) {
        return res.status(403).json({ error: err.message });
      }
      console.error("[admin] Error assigning owner:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  app.post("/api/admin/backfill-claim-codes", requireAdmin, async (req, res) => {
    try {
      const codes = await storage.batchGenerateClaimCodes();
      await storage.writeAuditLog("system", "backfill", "BATCH_CLAIM_CODES_GENERATED", "admin", {
        count: codes.length,
      });

      const csvLines = ["Certificate Number,Claim Code"];
      for (const { certId, claimCode } of codes) {
        csvLines.push(`${certId},${claimCode}`);
      }
      const csv = csvLines.join("\n");

      return res.json({ count: codes.length, codes, csv });
    } catch (err: any) {
      console.error("[admin] Error backfilling claim codes:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  // ── CLAIM INSERT GENERATION ──────────────────────────────────────────────────
  app.get("/api/admin/certificates/:certId/claim-insert", requireAdmin, async (req, res) => {
    try {
      const certId = String(req.params.certId);
      const cert = await storage.getCertificateByCertId(certId);
      if (!cert) return res.status(404).json({ error: "Certificate not found" });

      const claimCode = await storage.getOrGenerateClaimCode(certId);
      await storage.writeAuditLog("certificate", certId, "CLAIM_INSERT_GENERATED", "admin", {});

      const format = (req.query.format as string) || "pdf";
      const nCertId = normalizeCertId(cert.certId);

      if (format === "png") {
        const png = await generateClaimInsertPNG(nCertId, claimCode);
        res.setHeader("Content-Type", "image/png");
        res.setHeader("Content-Disposition", `inline; filename="${nCertId}-claim-insert.png"`);
        return res.send(png);
      }

      const pdf = await generateClaimInsertPDF(nCertId, claimCode);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${nCertId}-claim-insert.pdf"`);
      return res.send(pdf);
    } catch (err: any) {
      console.error("[admin] Error generating claim insert:", err);
      return res.status(500).json({ error: "Failed to generate claim insert" });
    }
  });

  app.post("/api/admin/claim-insert-sheet", requireAdmin, async (req, res) => {
    try {
      const { certIds } = req.body;
      if (!certIds || !Array.isArray(certIds) || certIds.length === 0) {
        return res.status(400).json({ error: "Provide an array of certIds" });
      }
      if (certIds.length > 50) {
        return res.status(400).json({ error: "Maximum 50 inserts per sheet" });
      }

      const inserts: Array<{ certId: string; claimCode: string }> = [];

      for (const cid of certIds) {
        const cert = await storage.getCertificateByCertId(cid);
        if (!cert) continue;

        const claimCode = await storage.getOrGenerateClaimCode(cid);
        inserts.push({ certId: normalizeCertId(cert.certId), claimCode });
      }

      if (inserts.length === 0) {
        return res.status(400).json({ error: "No valid certificates found" });
      }

      await storage.writeAuditLog("system", "batch", "CLAIM_INSERT_SHEET_GENERATED", "admin", {
        count: inserts.length,
        certIds: inserts.map((i) => i.certId),
      });

      const pdf = await generateClaimInsertSheet(inserts);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="claim-inserts-${new Date().toISOString().split("T")[0]}.pdf"`
      );
      return res.send(pdf);
    } catch (err: any) {
      console.error("[admin] Error generating claim insert sheet:", err);
      return res.status(500).json({ error: "Failed to generate claim insert sheet" });
    }
  });

  // ── OWNERSHIP EXPORT ──────────────────────────────────────────────────────
  app.get("/api/admin/ownership-export", requireAdmin, async (_req, res) => {
    try {
      const certs = await storage.listCertificates();
      const headers = [
        "Cert ID",
        "Card Name",
        "Card Game",
        "Set",
        "Grade",
        "Status",
        "Ownership Status",
        "Owner Email",
        "Owner User ID",
        "Claim Code Created At",
        "Claim Code Used At",
      ];
      const rows = certs.map((c) => {
        const ca = c as any;
        return [
          normalizeCertId(c.certId),
          c.cardName,
          c.cardGame,
          c.setName,
          c.gradeOverall || "",
          c.status,
          ca.ownershipStatus || "unclaimed",
          ca.ownerEmail || "",
          ca.ownerUserId || "",
          ca.claimCodeCreatedAt ? new Date(ca.claimCodeCreatedAt).toISOString() : "",
          ca.claimCodeUsedAt ? new Date(ca.claimCodeUsedAt).toISOString() : "",
        ];
      });
      const csvContent = [
        headers.join(","),
        ...rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")),
      ].join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="mintvault-ownership-${new Date().toISOString().split("T")[0]}.csv"`
      );
      res.send(csvContent);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to export ownership CSV" });
    }
  });

  // ── CUSTOMER PORTFOLIO ─────────────────────────────────────────────────────
  app.get("/api/customer/portfolio", requireCustomer, async (req, res) => {
    try {
      const email = (req.session as any).customerEmail;
      if (!email) return res.status(401).json({ error: "Not authenticated" });
      const rows = await db.execute(sql`
        SELECT
          c.id, c.cert_id, c.card_name, c.set_name, c.year, c.card_game, c.language,
          c.grade_overall, c.grade_type, c.created_at, c.grading_status,
          c.estimated_value_low, c.estimated_value_high,
          o.label_type
        FROM certificates c
        LEFT JOIN ownership_records o ON o.certificate_id = c.id AND o.owner_email = ${email} AND o.is_current = true
        WHERE c.grade_approved_by IS NOT NULL
          AND (o.owner_email = ${email} OR c.owner_email = ${email})
        ORDER BY c.created_at DESC
      `);
      res.json(rows.rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── PUBLIC COLLECTION ──────────────────────────────────────────────────────
  app.get("/api/public/collection/:userId", async (req, res) => {
    try {
      const userId = String(req.params.userId);
      const rows = await db.execute(sql`
        SELECT c.cert_id, c.card_name, c.set_name, c.year, c.card_game,
               c.grade_overall, c.grade_type, c.created_at
        FROM certificates c
        JOIN ownership_records o ON o.certificate_id = c.id
          AND o.owner_id = ${userId} AND o.is_current = true
          AND o.collection_public = true
        WHERE c.grade_approved_by IS NOT NULL
        ORDER BY c.created_at DESC
      `);
      res.json({ cards: rows.rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
