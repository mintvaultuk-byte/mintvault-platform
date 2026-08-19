import type { Express } from "express";
import crypto from "crypto";
import { SUBMISSION_STATUS_TRANSITIONS, SUBMISSION_STATUS_LABELS } from "@shared/schema";
import { isServiceValidForCarrier } from "@shared/carriers";
import { storage } from "../storage";
import { requireAdmin } from "../auth";
import {
  sendCardsReceived,
  sendGradingComplete,
  sendGradingStarted,
  sendShipped,
  sendSubmissionDelivered,
} from "../email";
import { db } from "../db";
import { sql } from "drizzle-orm";
import { PartnerSubmissionCreditLifecycleError } from "../partner/partner-submission-credit-lifecycle";
import { cancelPendingReviewRequest, queueReviewRequest } from "../review-request-service";

function getSignedUrlSecret(): string {
  const s = process.env.SIGNED_URL_SECRET;
  if (!s) throw new Error("SIGNED_URL_SECRET environment secret is required");
  return s;
}

export function registerAdminSubmissionRoutes(app: Express): void {
  app.get("/api/admin/submissions", requireAdmin, async (req, res) => {
    try {
      const filters: Record<string, string> = {};
      if (req.query.status && req.query.status !== "all") filters.status = req.query.status as string;
      if (req.query.email) filters.email = req.query.email as string;
      if (req.query.submissionId) filters.submissionId = req.query.submissionId as string;
      if (req.query.dateFrom) filters.dateFrom = req.query.dateFrom as string;
      if (req.query.dateTo) filters.dateTo = req.query.dateTo as string;

      const subs = await storage.listSubmissions(Object.keys(filters).length > 0 ? filters : undefined);
      res.json(subs);
    } catch (error: any) {
      console.error("List submissions error:", error.message);
      res.status(500).json({ error: "Failed to list submissions" });
    }
  });

  app.get("/api/admin/submissions/export-csv", requireAdmin, async (_req, res) => {
    try {
      const subs = await storage.listSubmissions();
      const headers = [
        "Submission ID",
        "Status",
        "Service Type",
        "Tier",
        "Card Count",
        "Total Price",
        "Declared Value",
        "Payment Status",
        "Payment Intent",
        "Payment Amount",
        "Currency",
        "Shipping Cost",
        "Grading Cost",
        "Insurance Tier",
        "First Name",
        "Last Name",
        "Email",
        "Phone",
        "Address Line 1",
        "Address Line 2",
        "City",
        "County",
        "Postcode",
        "Return Carrier",
        "Return Tracking",
        "Return Postage Cost",
        "Notes",
        "Admin Notes",
        "Flagged",
        "Created At",
        "Received At",
        "Shipped At",
        "Completed At",
      ];
      const rows = subs.map((s: any) => [
        s.submissionId || s.submission_id || "",
        s.status || "",
        s.serviceType || s.service_type || s.type || "",
        s.serviceTier || s.service_tier || s.tier || "",
        s.cardCount ?? s.card_count ?? s.quantity ?? "",
        s.totalPrice ?? s.total_price ?? s.amount_total ?? "",
        s.totalDeclaredValue ?? s.total_declared_value ?? "",
        s.paymentStatus ?? s.payment_status ?? "",
        s.paymentIntentId ?? s.payment_intent_id ?? s.stripe_payment_id ?? "",
        s.paymentAmount ?? s.payment_amount ?? "",
        s.paymentCurrency ?? s.payment_currency ?? s.currency ?? "GBP",
        s.shippingCost ?? s.shipping_cost ?? "",
        s.gradingCost ?? s.grading_cost ?? "",
        s.shippingInsuranceTier ?? s.shipping_insurance_tier ?? "",
        s.customerFirstName ?? s.customer_first_name ?? s.first_name ?? "",
        s.customerLastName ?? s.customer_last_name ?? s.last_name ?? "",
        s.customerEmail ?? s.customer_email ?? s.email ?? "",
        s.phone ?? "",
        s.returnAddressLine1 ?? s.return_address_line1 ?? "",
        s.returnAddressLine2 ?? s.return_address_line2 ?? "",
        s.returnCity ?? s.return_city ?? "",
        s.returnCounty ?? s.return_county ?? "",
        s.returnPostcode ?? s.return_postcode ?? "",
        s.returnCarrier ?? s.return_carrier ?? "",
        s.returnTracking ?? s.return_tracking ?? "",
        s.returnPostageCost ?? s.return_postage_cost ?? "",
        s.notes ?? "",
        s.adminNotes ?? s.admin_notes ?? "",
        s.adminFlagged ?? s.admin_flagged ?? "",
        s.createdAt ?? s.created_at ?? "",
        s.receivedAt ?? s.received_at ?? "",
        s.shippedAt ?? s.shipped_at ?? "",
        s.completedAt ?? s.completed_at ?? "",
      ]);
      const csvContent = [
        headers.join(","),
        ...rows.map((r: any[]) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")),
      ].join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="mintvault-submissions-${new Date().toISOString().split("T")[0]}.csv"`
      );
      res.send(csvContent);
    } catch (error: any) {
      console.error("Export submissions CSV error:", error.message);
      res.status(500).json({ error: "Failed to export submissions CSV" });
    }
  });

  app.get("/api/admin/submissions/:id", requireAdmin, async (req, res) => {
    try {
      const submission = await storage.getSubmissionBySubmissionId(String(req.params.id));
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }
      const numId = typeof submission.id === "string" ? parseInt(submission.id, 10) : submission.id;
      const items = await storage.getSubmissionItems(numId);
      res.json({ ...submission, items });
    } catch (error: any) {
      console.error("Get submission error:", error.message);
      res.status(500).json({ error: "Failed to get submission" });
    }
  });

  app.post("/api/admin/submissions/:id/status", requireAdmin, async (req, res) => {
    try {
      const submission = await storage.getSubmissionBySubmissionId(String(req.params.id));
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      const { status, returnTracking, returnCarrier, returnService, returnPostageCost } = req.body;
      if (!status) {
        return res.status(400).json({ error: "Status is required" });
      }

      const currentStatus = submission.status?.toLowerCase();
      const expectedNext = SUBMISSION_STATUS_TRANSITIONS[currentStatus];
      if (expectedNext && expectedNext !== status.toLowerCase()) {
        return res.status(400).json({
          error: `Cannot transition from ${SUBMISSION_STATUS_LABELS[currentStatus] || currentStatus} to ${SUBMISSION_STATUS_LABELS[status] || status}`,
        });
      }

      // Validate the (carrier, service) pair against the shared catalogue
      // ONLY when both are supplied. A null/omitted service must NOT block
      // a shipped transition — legacy callers (pre-service rollout) and
      // the "other" carrier path both rely on this. Backwards compatible.
      if (status.toLowerCase() === "shipped" && returnCarrier && returnService) {
        if (!isServiceValidForCarrier(String(returnCarrier), String(returnService))) {
          return res.status(400).json({
            error: "Invalid carrier/service combination",
            carrier: returnCarrier,
            service: returnService,
          });
        }
      }

      const numId = typeof submission.id === "string" ? parseInt(submission.id, 10) : submission.id;
      const updated = await storage.updateSubmissionStatus(numId, status, {
        returnTracking,
        returnCarrier,
        returnService,
        returnPostageCost: returnPostageCost ? parseInt(returnPostageCost, 10) : undefined,
        creditActorEmail: req.session.adminEmail || "admin",
      });

      await storage.writeAuditLog(
        "submission",
        submission.submissionId,
        `status_${status}`,
        req.session.adminEmail || "admin",
        {
          fromStatus: currentStatus,
          toStatus: status,
          returnTracking,
          returnCarrier,
          returnService: returnService ?? null,
        }
      );

      if (status.toLowerCase() === "shipped") {
        // Diagnostic-safe log: submissionId + carrier + service only. No PII.
        console.log(
          `[dispatch] status_shipped submissionId=${submission.submissionId} carrier=${returnCarrier ?? "-"} service=${returnService ?? "-"}`
        );
      }

      const emailData = {
        email: submission.email || "",
        firstName: submission.firstName || "Customer",
        submissionId: submission.submissionId,
        cardCount: submission.cardCount || 0,
      };

      // Status already committed above — a failed transactional email must
      // never fail this request, but a bare catch left zero operator
      // visibility that the customer never got their update. Audit instead.
      const newStatus = status.toLowerCase();
      if (newStatus === "received" && emailData.email) {
        sendCardsReceived(emailData).catch((e: any) =>
          storage
            .writeAuditLog(
              "submission",
              String(submission.id ?? submission.submissionId),
              "email_cards_received_failed",
              null,
              { error: e?.message }
            )
            .catch(() => {})
        );
      } else if (newStatus === "in_grading" && emailData.email) {
        // FORWARD transition only — this endpoint only ever fires on the
        // standard ladder. Step-back into in_grading from ready_to_return
        // goes through POST /step-back, which never calls sendX. So the
        // gate is enforced by virtue of being on the forward endpoint at all.
        sendGradingStarted({
          ...emailData,
          turnaroundDays: submission.turnaroundDays ?? null,
        }).catch((e: any) =>
          storage
            .writeAuditLog(
              "submission",
              String(submission.id ?? submission.submissionId),
              "email_grading_started_failed",
              null,
              { error: e?.message }
            )
            .catch(() => {})
        );
      } else if ((newStatus === "completed" || newStatus === "ready_to_return") && emailData.email) {
        sendGradingComplete(emailData).catch((e: any) =>
          storage
            .writeAuditLog(
              "submission",
              String(submission.id ?? submission.submissionId),
              "email_grading_complete_failed",
              null,
              { error: e?.message }
            )
            .catch(() => {})
        );
      } else if (newStatus === "shipped" && emailData.email) {
        sendShipped({
          ...emailData,
          trackingNumber: returnTracking || submission.returnTracking || undefined,
          carrier: returnCarrier || submission.returnCarrier || undefined,
          service: returnService || (submission as any).returnService || undefined,
        }).catch((e: any) =>
          storage
            .writeAuditLog(
              "submission",
              String(submission.id ?? submission.submissionId),
              "email_shipped_failed",
              null,
              { error: e?.message }
            )
            .catch(() => {})
        );
      } else if (newStatus === "delivered" && emailData.email) {
        sendSubmissionDelivered({
          email: emailData.email,
          firstName: emailData.firstName,
          submissionId: emailData.submissionId,
        }).catch((e: any) =>
          storage
            .writeAuditLog(
              "submission",
              String(submission.id ?? submission.submissionId),
              "email_delivered_failed",
              null,
              { error: e?.message }
            )
            .catch(() => {})
        );
      }

      res.json({ success: true, submission: updated });
    } catch (error: any) {
      if (error instanceof PartnerSubmissionCreditLifecycleError) {
        return res.status(409).json({ error: error.message });
      }
      console.error("Update submission status error:", error.message);
      res.status(500).json({ error: "Failed to update submission status" });
    }
  });

  app.patch("/api/admin/submissions/:id/items/:itemId", requireAdmin, async (req, res) => {
    try {
      const submission = await storage.getSubmissionBySubmissionId(String(req.params.id));
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      const itemId = parseInt(String(req.params.itemId), 10);
      if (isNaN(itemId)) {
        return res.status(400).json({ error: "Invalid item ID" });
      }

      const numSubId = typeof submission.id === "string" ? parseInt(submission.id, 10) : submission.id;
      const items = await storage.getSubmissionItems(numSubId);
      const targetItem = items.find((i) => i.id === itemId);
      if (!targetItem) {
        return res.status(404).json({ error: "Submission item not found" });
      }

      const { game, cardName, cardSet, cardNumber, year, declaredValue, notes } = req.body;
      const updateData: any = {};
      if (game !== undefined) updateData.game = game || null;
      if (cardName !== undefined) updateData.cardName = cardName || null;
      if (cardSet !== undefined) updateData.cardSet = cardSet || null;
      if (cardNumber !== undefined) updateData.cardNumber = cardNumber || null;
      if (year !== undefined) updateData.year = year || null;
      if (declaredValue !== undefined) {
        const dv = parseInt(declaredValue, 10);
        if (isNaN(dv) || dv < 0) {
          return res.status(400).json({ error: "Declared value must be a non-negative number" });
        }
        updateData.declaredValue = dv;
      }
      if (notes !== undefined) updateData.notes = notes || null;

      const updated = await storage.updateSubmissionItem(itemId, updateData);

      await storage.writeAuditLog(
        "submission_item",
        String(itemId),
        "item_updated",
        req.session.adminEmail || "admin",
        {
          submissionId: submission.submissionId,
          changes: updateData,
        }
      );

      res.json({ success: true, item: updated });
    } catch (error: any) {
      console.error("Update submission item error:", error.message);
      res.status(500).json({ error: "Failed to update submission item" });
    }
  });

  app.patch("/api/admin/submissions/:id/notes", requireAdmin, async (req, res) => {
    try {
      const submission = await storage.getSubmissionBySubmissionId(String(req.params.id));
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }
      const { notes, flagged } = req.body;
      const numId = typeof submission.id === "string" ? parseInt(submission.id, 10) : submission.id;
      await storage.updateAdminNotes(numId, notes ?? null, !!flagged);
      await storage.writeAuditLog(
        "submission",
        String(numId),
        "admin_notes_updated",
        req.session.adminEmail || "admin",
        {
          submissionId: submission.submissionId,
          flagged,
        }
      );
      res.json({ success: true });
    } catch (error: any) {
      console.error("Update admin notes error:", error.message);
      res.status(500).json({ error: "Failed to update admin notes" });
    }
  });

  app.post("/api/admin/submissions/:id/return-label", requireAdmin, async (req, res) => {
    try {
      const submission = await storage.getSubmissionBySubmissionId(String(req.params.id));
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      const { carrier, service, trackingNumber, postageCost } = req.body;
      const numId = typeof submission.id === "string" ? parseInt(submission.id, 10) : submission.id;

      const safeCarrier = carrier ? String(carrier) : null;
      const safeService = service ? String(service) : null;

      // Tracking: distinguish "not provided" (preserve via COALESCE) from
      // "explicitly blanked" (sent as empty/whitespace string). Blanking
      // is rejected once the parcel is shipped — we should never lose the
      // tracking number on a parcel the customer has already been told
      // about. Empty-string on a not-yet-shipped row silently preserves
      // the existing value, matching prior behaviour.
      const trackingProvided = trackingNumber !== undefined && trackingNumber !== null;
      const trimmedTracking = trackingProvided ? String(trackingNumber).trim() : null;
      const submissionStatus = String(submission.status || "").toLowerCase();
      const isShipped = submissionStatus === "shipped" || submissionStatus === "completed";
      if (trackingProvided && trimmedTracking === "" && isShipped) {
        return res.status(400).json({
          error: "Tracking number cannot be blank once the submission has been shipped",
        });
      }
      const safeTracking = trimmedTracking ? trimmedTracking : null;

      const safeCost = postageCost ? parseInt(postageCost, 10) : null;

      // Validate the (carrier, service) pair against the shared catalogue
      // ONLY when BOTH are supplied. A null/omitted service must never
      // block a return-label write — legacy callers and the "other"
      // carrier flow both rely on this. Backwards compatible.
      if (safeCarrier && safeService && !isServiceValidForCarrier(safeCarrier, safeService)) {
        return res.status(400).json({
          error: "Invalid carrier/service combination",
          carrier: safeCarrier,
          service: safeService,
        });
      }

      const adminEmail = req.session.adminEmail || "admin";

      // Edit-vs-create detection: if any return-label field was already
      // set on the row before this write, treat as an edit. The first
      // save stays "return_label_created"; every subsequent change is
      // "return_label_edited" with a {field: {from, to}} delta in the
      // audit details so corrections are traceable.
      const prevCarrier = (submission as any).returnCarrier ?? null;
      const prevService = (submission as any).returnService ?? null;
      const prevTracking = (submission as any).returnTracking ?? null;
      const prevCost = (submission as any).returnPostageCost ?? null;
      const isEdit = !!(prevCarrier || prevTracking);

      // Build a deltas object — only fields the caller actually changed.
      // COALESCE means a null/omitted field preserves the prior value, so
      // we only treat it as a change when (a) the new value is non-null
      // and (b) it differs from the stored value.
      const changes: Record<string, { from: any; to: any }> = {};
      if (safeCarrier !== null && safeCarrier !== prevCarrier) {
        changes.carrier = { from: prevCarrier, to: safeCarrier };
      }
      if (safeService !== null && safeService !== prevService) {
        changes.service = { from: prevService, to: safeService };
      }
      if (safeTracking !== null && safeTracking !== prevTracking) {
        changes.tracking = { from: prevTracking, to: safeTracking };
      }
      if (safeCost !== null && safeCost !== prevCost) {
        changes.postageCost = { from: prevCost, to: safeCost };
      }

      const action = isEdit ? "return_label_edited" : "return_label_created";
      const details = isEdit
        ? { changes, admin_user: adminEmail, submissionId: submission.submissionId }
        : { carrier: safeCarrier, service: safeService, trackingNumber: safeTracking, postageCost: safeCost };

      await db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE submissions SET
            return_carrier = COALESCE(${safeCarrier}, return_carrier),
            return_service = COALESCE(${safeService}, return_service),
            return_tracking = COALESCE(${safeTracking}, return_tracking),
            return_postage_cost = COALESCE(${safeCost}, return_postage_cost),
            updated_at = NOW()
          WHERE id = ${numId}
        `);
        await tx.execute(sql`
          INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
          VALUES (
            'submission',
            ${submission.submissionId},
            ${action},
            ${adminEmail},
            ${JSON.stringify(details)}::jsonb
          )
        `);
      });

      // Diagnostic-safe log: submissionId + carrier + service only. No PII.
      console.log(
        `[dispatch] ${action} submissionId=${submission.submissionId} carrier=${safeCarrier ?? "-"} service=${safeService ?? "-"}`
      );

      res.json({ success: true, edited: isEdit });
    } catch (error: any) {
      console.error("Return label error:", error.message);
      res.status(500).json({ error: "Failed to save return label" });
    }
  });

  // Re-send the shipping notification email using the row's current
  // return_carrier / return_service / return_tracking. Never auto-fires
  // on edit — the admin clicks this explicitly when they've corrected
  // tracking after the customer was already notified.
  app.post("/api/admin/submissions/:id/resend-shipping", requireAdmin, async (req, res) => {
    try {
      const submission = await storage.getSubmissionBySubmissionId(String(req.params.id));
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }
      if (!submission.email) {
        return res.status(400).json({ error: "Submission has no customer email on file" });
      }
      if (!(submission as any).returnTracking) {
        return res.status(400).json({ error: "No tracking number to send" });
      }

      const carrier = (submission as any).returnCarrier ?? undefined;
      const service = (submission as any).returnService ?? undefined;
      const trackingNumber = (submission as any).returnTracking ?? undefined;
      const adminEmail = req.session.adminEmail || "admin";

      await sendShipped({
        email: submission.email,
        firstName: submission.firstName || "Customer",
        submissionId: submission.submissionId,
        cardCount: submission.cardCount || 0,
        carrier,
        service,
        trackingNumber,
      });

      await storage.writeAuditLog("submission", submission.submissionId, "shipping_email_resent", adminEmail, {
        carrier: carrier ?? null,
        service: service ?? null,
        trackingNumber: trackingNumber ?? null,
      });

      // Diagnostic-safe log: submissionId + carrier + service only. No PII.
      console.log(
        `[dispatch] shipping_email_resent submissionId=${submission.submissionId} carrier=${carrier ?? "-"} service=${service ?? "-"}`
      );

      res.json({ success: true });
    } catch (error: any) {
      console.error("Resend shipping email error:", error.message);
      res.status(500).json({ error: "Failed to resend shipping email" });
    }
  });

  // MANUAL BRIDGE — sets submissions.delivered_at to NOW() so the customer-
  // facing progress stepper can light up the "Delivered" node. This is a
  // stopgap until the Royal Mail Tracking API polling is wired up; once
  // that lands the same column will be written automatically with
  // details.source='royalmail_api' instead of 'manual_admin'.
  //
  // Idempotent: a row that already has delivered_at set returns ok=true,
  // unchanged=true, and writes no audit row (no double-confirmation).
  // Pair endpoint below clears delivered_at (mis-click recovery).
  app.post("/api/admin/submissions/:id/mark-delivered", requireAdmin, async (req, res) => {
    try {
      const submission = await storage.getSubmissionBySubmissionId(String(req.params.id));
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }
      const numId = typeof submission.id === "string" ? parseInt(submission.id, 10) : submission.id;
      const adminEmail = req.session.adminEmail || "admin";

      // Idempotent: don't overwrite an existing confirmation. Returning
      // unchanged=true lets the UI mutation onSuccess silently no-op.
      if ((submission as any).deliveredAt) {
        return res.json({ success: true, unchanged: true, deliveredAt: (submission as any).deliveredAt });
      }

      let deliveredAt: string | null = null;
      await db.transaction(async (tx) => {
        const r = await tx.execute(sql`
          UPDATE submissions
          SET delivered_at = NOW(), updated_at = NOW()
          WHERE id = ${numId}
            AND delivered_at IS NULL
            AND shipped_at IS NOT NULL
            AND LOWER(status) = 'completed'
            AND payment_status = 'paid'
            AND deleted_at IS NULL
            AND payment_intent_id IS NOT NULL
            AND payment_timestamp IS NOT NULL
            AND payment_currency = 'GBP'
          RETURNING delivered_at
        `);
        // Drizzle returns timestamps as strings on some pool paths and as
        // Date instances on others. Normalise both shapes to an ISO-8601
        // string so the response + audit detail are always populated.
        const raw = (r.rows[0] as any)?.delivered_at;
        deliveredAt =
          raw instanceof Date ? raw.toISOString() : raw != null ? new Date(String(raw)).toISOString() : null;
        if (!deliveredAt) throw new Error("DELIVERY_STATE_CONFLICT");
        await queueReviewRequest(numId, new Date(deliveredAt), tx);
        await tx.execute(sql`
          INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
          VALUES (
            'submission',
            ${submission.submissionId},
            'delivery_confirmed_manual',
            ${adminEmail},
            ${JSON.stringify({ delivered_at: deliveredAt, source: "manual_admin" })}::jsonb
          )
        `);
      });

      // Diagnostic-safe log: submissionId only. No PII.
      console.log(`[dispatch] delivery_confirmed_manual submissionId=${submission.submissionId}`);
      res.json({ success: true, unchanged: false, deliveredAt });
    } catch (error: any) {
      if (error?.message === "DELIVERY_STATE_CONFLICT") {
        return res.status(409).json({
          error: "Delivery can only be confirmed for a paid, completed submission that has been shipped",
        });
      }
      console.error("Mark delivered error:", error.message);
      return res.status(500).json({ error: "Failed to mark delivered" });
    }
  });

  // Clear delivered_at — mis-click recovery for the manual path. Audited
  // separately so a confirmation that gets walked back is traceable.
  app.post("/api/admin/submissions/:id/mark-delivered/clear", requireAdmin, async (req, res) => {
    try {
      const submission = await storage.getSubmissionBySubmissionId(String(req.params.id));
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }
      if (!(submission as any).deliveredAt) {
        return res.json({ success: true, unchanged: true });
      }
      const numId = typeof submission.id === "string" ? parseInt(submission.id, 10) : submission.id;
      const adminEmail = req.session.adminEmail || "admin";
      const previous = (submission as any).deliveredAt;

      await db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE submissions
          SET delivered_at = NULL, updated_at = NOW()
          WHERE id = ${numId}
        `);
        await cancelPendingReviewRequest(numId, tx);
        await tx.execute(sql`
          INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
          VALUES (
            'submission',
            ${submission.submissionId},
            'delivery_confirmation_cleared',
            ${adminEmail},
            ${JSON.stringify({ previous_delivered_at: previous, reason: "admin_cleared" })}::jsonb
          )
        `);
      });

      console.log(`[dispatch] delivery_confirmation_cleared submissionId=${submission.submissionId}`);
      res.json({ success: true, unchanged: false });
    } catch (error: any) {
      console.error("Clear delivered error:", error.message);
      res.status(500).json({ error: "Failed to clear delivered" });
    }
  });

  // One-step-back status correction. Mis-click recovery: an admin can
  // walk a submission BACK exactly one step along the ladder. No arbitrary
  // jumps; the trigger (status-transition-trigger.sql) gates the allowed
  // pairs. NEVER fires a customer email — that's why this endpoint
  // doesn't share the forward /status path. Going forward again later
  // re-fires the relevant sendX as a real notification.
  //
  // Step → previous map (received is the floor):
  //   completed       → shipped         (clears completed_at)
  //   shipped         → ready_to_return (clears shipped_at, and delivered_at if set)
  //   ready_to_return → in_grading      (status_history append, no column clear)
  //   in_grading      → received        (status_history append, no column clear)
  //
  // status_history is append-only — we add an entry for the NEW (earlier)
  // status with a {step_back:true} marker so the derived inGradingAt /
  // readyToReturnAt stay truthful AND a future reader can distinguish a
  // back-walk from a forward visit.
  app.post("/api/admin/submissions/:id/step-back", requireAdmin, async (req, res) => {
    try {
      const submission = await storage.getSubmissionBySubmissionId(String(req.params.id));
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }
      const current = String(submission.status || "").toLowerCase();

      // G6D consumes the Partner credit when grading completes. Rewinding one of those destination
      // submissions would make the physical lifecycle appear pre-settlement while the immutable
      // debit remains consumed. There is no compensating-credit workflow in this endpoint, so fail
      // explicitly rather than creating an irreversible overcharge. A pre-connector database has
      // no mapping table and retains its established step-back behaviour.
      const partnerMappingTable = await db.execute(sql`
        SELECT to_regclass('public.partner_connector_imports') AS relation
      `);
      if ((partnerMappingTable.rows[0] as { relation?: string | null } | undefined)?.relation) {
        const partnerLink = await db.execute(sql`
          SELECT 1
            FROM partner_connector_imports
           WHERE destination_submission_id = ${typeof submission.id === "string" ? parseInt(submission.id, 10) : submission.id}
           LIMIT 1
        `);
        if (partnerLink.rows.length > 0) {
          return res.status(409).json({
            error:
              "Partner-linked submissions cannot be stepped back because their grading credit is immutable. Use the approved credit-adjustment or reconciliation path.",
            code: "partner_credit_lifecycle_conflict",
            currentStatus: current,
          });
        }
      }

      // Single source of truth for backward pairs — must match the trigger.
      const PREV: Record<string, string> = {
        completed: "shipped",
        shipped: "ready_to_return",
        ready_to_return: "in_grading",
        in_grading: "received",
      };
      const prev = PREV[current];
      if (!prev) {
        return res.status(400).json({
          error:
            current === "received"
              ? "Already at the earliest step (Received). Nothing to step back to."
              : `Cannot step back from status "${current}".`,
          currentStatus: current,
        });
      }

      const numId = typeof submission.id === "string" ? parseInt(submission.id, 10) : submission.id;
      const adminEmail = req.session.adminEmail || "admin";
      const cleared: string[] = [];

      // Build the per-pair UPDATE clause. status always changes; specific
      // *_at columns get cleared based on the step we're LEAVING.
      const setParts: ReturnType<typeof sql>[] = [sql`status = ${prev}`, sql`updated_at = NOW()`];
      if (current === "shipped") {
        setParts.push(sql`shipped_at = NULL`);
        cleared.push("shipped_at");
        // Carrier-confirmed delivery can't survive going un-shipped.
        if ((submission as any).deliveredAt) {
          setParts.push(sql`delivered_at = NULL`);
          cleared.push("delivered_at");
        }
      } else if (current === "completed") {
        setParts.push(sql`completed_at = NULL`);
        cleared.push("completed_at");
      }
      // No column clear for in_grading or ready_to_return (no dedicated
      // *_at column) — status_history append below is the truthful record.

      // status_history append — preserves the chronological audit. The
      // {step_back:true} marker lets future readers distinguish backward
      // visits from forward ones; firstStatusHistoryTime in storage.ts
      // returns the FIRST occurrence regardless, so the derived inGradingAt
      // / readyToReturnAt continue to reflect the ORIGINAL forward time
      // even after a back-walk (which is the intent: the customer was
      // first told about that stage at the original time).
      const historyEntry = JSON.stringify({
        status: prev,
        timestamp: new Date().toISOString(),
        note: null,
        step_back: true,
      });
      setParts.push(sql`status_history = COALESCE(status_history, '[]'::jsonb) || ${historyEntry}::jsonb`);

      await db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE submissions SET ${sql.join(setParts, sql`, `)} WHERE id = ${numId}
        `);
        await tx.execute(sql`
          INSERT INTO audit_log (entity_type, entity_id, action, admin_user, details)
          VALUES (
            'submission',
            ${submission.submissionId},
            'status_stepped_back',
            ${adminEmail},
            ${JSON.stringify({ fromStatus: current, toStatus: prev, cleared })}::jsonb
          )
        `);
      });

      console.log(
        `[dispatch] status_stepped_back submissionId=${submission.submissionId} ${current}->${prev} cleared=${cleared.join(",") || "(none)"}`
      );
      res.json({ success: true, fromStatus: current, toStatus: prev, cleared });
    } catch (error: any) {
      console.error("Step-back error:", error.message);
      res.status(500).json({ error: "Failed to step back status" });
    }
  });

  app.get("/api/admin/submissions/:id/packing-slip", requireAdmin, async (req, res) => {
    try {
      const submission = await storage.getSubmissionBySubmissionId(String(req.params.id));
      if (!submission) {
        return res.status(404).json({ error: "Submission not found" });
      }

      const numId = typeof submission.id === "string" ? parseInt(submission.id, 10) : submission.id;
      const items = await storage.getSubmissionItems(numId);

      const { generatePackingSlipPDF } = await import("../packingSlip");
      const pdf = await generatePackingSlipPDF({
        submissionId: submission.submissionId,
        customerFirstName: submission.customerFirstName || submission.customer_first_name || "",
        customerLastName: submission.customerLastName || submission.customer_last_name || "",
        customerEmail: submission.customerEmail || submission.customer_email || "",
        phone: submission.phone,
        returnAddressLine1: submission.returnAddressLine1 || submission.return_address_line1 || "",
        returnAddressLine2: submission.returnAddressLine2 || submission.return_address_line2 || "",
        returnCity: submission.returnCity || submission.return_city || "",
        returnCounty: submission.returnCounty || submission.return_county || "",
        returnPostcode: submission.returnPostcode || submission.return_postcode || "",
        serviceType: submission.serviceType || submission.service_type || "",
        serviceTier: submission.serviceTier || submission.service_tier || "",
        turnaroundDays: submission.turnaroundDays || submission.turnaround_days,
        cardCount: submission.cardCount || submission.card_count || 0,
        totalDeclaredValue: parseInt(submission.totalDeclaredValue || submission.total_declared_value || "0", 10),
        totalPrice: submission.totalPrice || submission.total_price || "0",
        shippingCost: parseInt(submission.shippingCost || submission.shipping_cost || "0", 10),
        shippingInsuranceTier: submission.shippingInsuranceTier || submission.shipping_insurance_tier || "",
        gradingCost: parseInt(submission.gradingCost || submission.grading_cost || "0", 10),
        insuranceFee: parseInt(submission.insuranceFee || submission.insurance_fee || "0", 10),
        items: items.map((item: any) => ({
          cardIndex: item.cardIndex || item.card_index || 0,
          game: item.game,
          cardSet: item.cardSet || item.card_set,
          cardName: item.cardName || item.card_name,
          cardNumber: item.cardNumber || item.card_number,
          year: item.year,
          declaredValue: item.declaredValue || item.declared_value,
        })),
      });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${submission.submissionId}-packing-slip.pdf"`);
      res.send(pdf);
    } catch (error: any) {
      console.error("Packing slip error:", error.message);
      res.status(500).json({ error: "Failed to generate packing slip" });
    }
  });

  app.get("/api/admin/submission-items/unlinked", requireAdmin, async (_req, res) => {
    try {
      const rows = await db.execute(sql`
        SELECT si.id, si.submission_id, si.card_index, si.game, si.card_set, si.card_name, si.card_number, si.year, si.declared_value,
               s.tracking_number AS submission_tracking, s.service_tier, s.customer_email, s.customer_first_name, s.customer_last_name
        FROM submission_items si
        JOIN submissions s ON s.id = si.submission_id
        WHERE si.id NOT IN (SELECT submission_item_id FROM certificates WHERE submission_item_id IS NOT NULL)
          AND s.deleted_at IS NULL
          AND s.status != 'draft'
        ORDER BY si.submission_id DESC, si.card_index ASC
        LIMIT 200
      `);
      res.json(rows.rows);
    } catch (error: any) {
      console.error("List unlinked items error:", error.message);
      res.status(500).json({ error: "Failed to list unlinked items" });
    }
  });
}
