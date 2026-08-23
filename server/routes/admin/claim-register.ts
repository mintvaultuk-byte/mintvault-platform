/**
 * Super Admin Claim Code / Ownership Register (read-only).
 *
 *   GET /api/admin/claim-register   → every certificate's credential + ownership state
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It never returns a claim code, in any form,
 * to any caller. The register exists so an administrator can see WHICH cards need
 * attention — not to hand out credentials. It performs no writes of any kind.
 *
 * "Printed" is established from the audit log rather than from a print flag on the
 * certificate. Two reasons: the slab label carries no claim code (only the claim
 * insert does), so `print_state` is not evidence a credential was issued; and
 * several historical routes have put a code on paper, each with its own audit
 * action. Inferring it from one route would silently under-report.
 */
import crypto from "crypto";
import type { Express, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { requireAdmin } from "../../auth";
import { listR2Keys } from "../../r2";
import {
  classifyClaimRegister,
  summariseClaimRegister,
  type ClaimRegisterInput,
  type ClaimRegisterVerdict,
} from "@shared/claim-register";

/** Audit actions that have historically put a claim credential onto paper. */
const PRINT_ACTIONS = ["print_batch_generated", "CLAIM_INSERT_SHEET_GENERATED", "CLAIM_INSERT_GENERATED"];

interface PrintFact {
  lastPrintedAt: Date;
  batchIds: string[];
}

/** Most recent print of a claim credential per certificate, across every historical route. */
async function loadPrintHistory(): Promise<Map<string, PrintFact>> {
  const rows = await db.execute(sql`
    SELECT action, entity_id, created_at, details
    FROM audit_log
    WHERE action = ANY(${PRINT_ACTIONS})
    ORDER BY created_at
  `);
  const out = new Map<string, PrintFact>();
  const note = (certId: string, at: Date, batchId?: string | null) => {
    if (!certId) return;
    const prev = out.get(certId);
    if (!prev) out.set(certId, { lastPrintedAt: at, batchIds: batchId ? [batchId] : [] });
    else {
      if (at.getTime() > prev.lastPrintedAt.getTime()) prev.lastPrintedAt = at;
      if (batchId && !prev.batchIds.includes(batchId)) prev.batchIds.push(batchId);
    }
  };
  for (const raw of rows.rows as Array<Record<string, unknown>>) {
    const at = new Date(raw.created_at as string);
    const details = (raw.details || {}) as Record<string, unknown>;
    const action = raw.action as string;
    if (action === "CLAIM_INSERT_GENERATED") {
      note(String(raw.entity_id), at);
      continue;
    }
    // Batch and sheet actions carry the cert list in details, under two spellings.
    const ids = (details.cert_ids || details.certIds) as unknown;
    if (Array.isArray(ids)) {
      const batchId = typeof details.batch_id === "string" ? details.batch_id : null;
      for (const id of ids) note(String(id), at, batchId);
    }
  }
  return out;
}

/**
 * Which broken certificates still have a surviving print artefact.
 *
 * Only consulted for the handful of rows that are actually broken — listing R2 is
 * far too expensive to do for a healthy population, and a healthy row's
 * recoverability is irrelevant because nothing needs recovering.
 */
async function artefactsSurviving(batchIds: string[]): Promise<Set<string>> {
  if (batchIds.length === 0) return new Set();
  const keys = await listR2Keys("print-batches/").catch(() => [] as string[]);
  const surviving = new Set<string>();
  for (const id of batchIds) if (keys.some((k) => k.includes(id))) surviving.add(id);
  return surviving;
}

export interface ClaimRegisterRow {
  certId: string;
  cardName: string | null;
  setName: string | null;
  grade: string | null;
  gradeType: string | null;
  credentialStatus: "present" | "hash_only" | "absent";
  printedAt: string | null;
  claimStatus: string;
  ownerEmailMasked: string | null;
  ownerUserId: string | null;
  claimedAt: string | null;
  transferPending: boolean;
  stolen: boolean;
  voided: boolean;
  category: ClaimRegisterVerdict["category"];
  categoryLabel: string;
  action: ClaimRegisterVerdict["action"];
  reason: string;
  actionRequired: boolean;
  lastClaimEvent: string | null;
}

export function registerClaimRegisterRoutes(app: Express): void {
  app.get("/api/admin/claim-register", requireAdmin, async (_req: Request, res: Response) => {
    try {
      const [printHistory, certResult, eventResult] = await Promise.all([
        loadPrintHistory(),
        db.execute(sql`
          SELECT certificate_number, card_name, set_name, grade, grade_type, status,
                 ownership_status, stolen_status, current_owner_user_id, owner_email,
                 claim_code, claim_code_hash,
                 claim_code_created_at, claim_code_used_at
          FROM certificates
          WHERE deleted_at IS NULL
          ORDER BY NULLIF(regexp_replace(certificate_number, '\\D', '', 'g'), '')::bigint
        `),
        db.execute(sql`
          SELECT DISTINCT ON (cert_id) cert_id, event_type, created_at
          FROM ownership_history ORDER BY cert_id, created_at DESC
        `),
      ]);

      const lastEvent = new Map<string, { event_type: string; created_at: string }>();
      for (const r of eventResult.rows as Array<Record<string, string>>) {
        lastEvent.set(r.cert_id, { event_type: r.event_type, created_at: r.created_at });
      }

      // Pass 1 — classify with recoverability unknown, so we learn which rows are broken.
      const staged = (certResult.rows as Array<Record<string, unknown>>).map((r) => {
        const certId = String(r.certificate_number);
        const print = printHistory.get(certId);
        /*
         * The plaintext/hash agreement check is done HERE rather than in SQL because
         * pgcrypto is not installed on this database — `digest()` does not exist, so a
         * SQL-side comparison type-checks perfectly and then 500s at runtime. The code
         * is read into this process, compared, and discarded; it never enters a
         * response, a log line or the register.
         */
        const plain = (r.claim_code as string | null) ?? null;
        const storedHash = (r.claim_code_hash as string | null) ?? null;
        const selfConsistent =
          plain !== null && storedHash !== null
            ? crypto.createHash("sha256").update(plain.toUpperCase().trim()).digest("hex") === storedHash
            : null;

        const input: ClaimRegisterInput = {
          certId,
          status: String(r.status),
          ownershipStatus: String(r.ownership_status),
          stolenStatus: (r.stolen_status as string | null) ?? null,
          hasCredentialHash: storedHash !== null,
          hasReadableCode: plain !== null,
          credentialIssuedAt: r.claim_code_created_at ? new Date(r.claim_code_created_at as string) : null,
          lastPrintedAt: print?.lastPrintedAt ?? null,
          printArtefactSurvives: false,
          credentialSelfConsistent: selfConsistent,
          claimedAt: r.claim_code_used_at ? new Date(r.claim_code_used_at as string) : null,
        };
        return { raw: r, input, batchIds: print?.batchIds ?? [] };
      });

      // Pass 2 — only the rows that need recovering get an R2 lookup.
      const needsArtefact = staged.filter(
        (s) => classifyClaimRegister(s.input).category === "C_PRINTED_BROKEN" && !s.input.hasCredentialHash
      );
      const surviving = await artefactsSurviving(needsArtefact.flatMap((s) => s.batchIds));
      for (const s of needsArtefact) {
        if (s.batchIds.some((b) => surviving.has(b))) s.input.printArtefactSurvives = true;
      }

      const classified = staged.map((s) => ({ ...s, verdict: classifyClaimRegister(s.input) }));

      const rows: ClaimRegisterRow[] = classified.map(({ raw, input, verdict }) => {
        const ev = lastEvent.get(input.certId);
        const email = (raw.owner_email as string | null) ?? null;
        return {
          certId: input.certId,
          cardName: (raw.card_name as string | null) ?? null,
          setName: (raw.set_name as string | null) ?? null,
          grade: (raw.grade as string | null) ?? null,
          gradeType: (raw.grade_type as string | null) ?? null,
          credentialStatus: !input.hasCredentialHash ? "absent" : input.hasReadableCode ? "present" : "hash_only",
          printedAt: input.lastPrintedAt ? input.lastPrintedAt.toISOString() : null,
          claimStatus: input.ownershipStatus,
          ownerEmailMasked: email ? email.replace(/^(.).*(@.*)$/, "$1***$2") : null,
          ownerUserId: (raw.current_owner_user_id as string | null) ?? null,
          claimedAt: input.claimedAt ? input.claimedAt.toISOString() : null,
          transferPending: input.ownershipStatus === "transfer_pending",
          stolen: input.stolenStatus === "reported_stolen",
          voided: input.status !== "active",
          category: verdict.category,
          categoryLabel: verdict.label,
          action: verdict.action,
          reason: verdict.reason,
          actionRequired: verdict.actionRequired,
          lastClaimEvent: ev ? `${ev.event_type} · ${new Date(ev.created_at).toISOString()}` : null,
        };
      });

      return res.json({
        generatedAt: new Date().toISOString(),
        metrics: summariseClaimRegister(classified.map(({ input, verdict }) => ({ input, verdict }))),
        rows,
      });
    } catch (err) {
      console.error("[claim-register] failed:", (err as Error).message);
      return res.status(500).json({ error: "Failed to build the claim register." });
    }
  });
}
