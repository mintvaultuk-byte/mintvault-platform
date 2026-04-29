import { users, submissions, submissionItems, certificates, certificateImages, cardSets, cardMaster, auditLog, serviceTiers, labelPrints, labelOverrides, reprintLog, ownershipHistory, claimVerifications, transferVerifications, type User, type Submission, type SubmissionItem, type CertificateRecord, type InsertCertificate, type CertificateImage, type InsertCertificateImage, type CardMaster, type CardSet, type AuditLog, type ServiceTierRecord, type LabelPrint, type LabelOverride, type OwnershipHistoryRecord, type ClaimVerification, type TransferVerification, isNonNumericGrade } from "@shared/schema";
import { eq, sql, desc, or, ilike, like, and, isNull, isNotNull, ne, inArray } from "drizzle-orm";
import { db } from "./db";
import crypto from "crypto";

export interface DashboardStats {
  totalCerts: number;
  thisWeek: number;
  thisMonth: number;
  authenticOnlyCount: number;
  authenticAlteredCount: number;
  gradeDistribution: { grade: number; count: number }[];
  recentCerts: CertificateRecord[];
}

export interface PopulationResult {
  lowerCount: number;
  sameCount: number;
  higherCount: number;
  totalCount: number;
  authenticOnlyCount: number;
  authenticAlteredCount: number;
  gradeDistribution: { grade: number; count: number }[];
}

export interface SubmissionFilters {
  status?: string;
  email?: string;
  submissionId?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface CertificateFilters {
  cardName?: string;
  setName?: string;
  grade?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: string;
  ownershipStatus?: string;
}

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(data: { email: string; firstName?: string; lastName?: string }): Promise<User>;
  createSubmission(data: any): Promise<any>;
  getSubmissionBySubmissionId(submissionId: string): Promise<any | undefined>;
  getSubmissionByPaymentIntentId(paymentIntentId: string): Promise<any | undefined>;
  markSubmissionAsPaid(id: number): Promise<boolean>;
  updateSubmission(id: any, data: any): Promise<any | undefined>;
  getNextSubmissionId(): Promise<string>;
  listSubmissions(filters?: SubmissionFilters): Promise<any[]>;
  getSubmissionItems(submissionId: number): Promise<SubmissionItem[]>;
  addSubmissionItems(submissionId: number, items: any[]): Promise<void>;
  updateSubmissionItem(itemId: number, data: Partial<{ game: string | null; cardName: string | null; cardSet: string | null; cardNumber: string | null; year: string | null; declaredValue: number; notes: string | null }>): Promise<SubmissionItem | undefined>;
  updateSubmissionStatus(id: number, status: string, extra?: Record<string, any>): Promise<any | undefined>;
  setEstimatedCompletionDate(id: number): Promise<void>;

  createCertificate(data: InsertCertificate, adminUser?: string): Promise<CertificateRecord>;
  getCertificate(id: number): Promise<CertificateRecord | undefined>;
  getCertificateByCertId(certId: string): Promise<CertificateRecord | undefined>;
  updateCertificate(id: number, data: Partial<CertificateRecord>): Promise<CertificateRecord | undefined>;
  listCertificates(filters?: CertificateFilters): Promise<CertificateRecord[]>;
  searchCertificates(query: string): Promise<CertificateRecord[]>;
  getNextCertId(): Promise<string>;

  saveNfcData(id: number, data: { uid: string; chipType?: string; url: string; writtenBy?: string }): Promise<CertificateRecord | undefined>;
  getCertificateByNfcUid(uid: string): Promise<CertificateRecord | undefined>;
  lockNfc(id: number): Promise<CertificateRecord | undefined>;
  clearNfc(id: number): Promise<CertificateRecord | undefined>;
  recordNfcVerified(id: number): Promise<void>;
  recordNfcScan(certId: string, ip?: string): Promise<void>;

  // ── Label printing ─────────────────────────────────────────────────────────
  getAllCertificatesForPrinting(limit?: number): Promise<(CertificateRecord & { lastPrintedAt: Date | null })[]>;
  getLabelPrintStatus(certIds: string[]): Promise<LabelPrint[]>;
  queueForPrinting(certIds: string[], sheetRef: string): Promise<void>;
  markSheetPrinted(sheetRef: string): Promise<void>;
  getLabelSheets(): Promise<{ sheetRef: string; total: number; printed: boolean; queuedAt: Date; printedAt: Date | null }[]>;
  getSheetDetail(sheetRef: string): Promise<{ certId: string; printedAt: Date | null; queuedAt: Date; cert: CertificateRecord | null }[]>;

  // ── Label overrides & reprint log ──────────────────────────────────────────
  getLabelOverride(certId: string): Promise<LabelOverride | null>;
  upsertLabelOverride(certId: string, data: { cardNameOverride?: string | null; setOverride?: string | null; variantOverride?: string | null; languageOverride?: string | null; yearOverride?: string | null }): Promise<LabelOverride>;
  clearLabelOverride(certId: string): Promise<void>;
  logReprint(certId: string): Promise<void>;
  listCertificatesBrowser(): Promise<Array<CertificateRecord & { isPrinted: boolean; reprintCount: number }>>;

  getDistinctRarityOthers(): Promise<string[]>;
  getDistinctVariants(): Promise<string[]>;
  getDashboardStats(): Promise<DashboardStats>;
  getPopulationData(cert: CertificateRecord): Promise<PopulationResult>;

  addCertificateImage(data: InsertCertificateImage): Promise<CertificateImage>;
  getCertificateImages(certificateId: number): Promise<CertificateImage[]>;

  autofillCard(setId: string, cardNumber: string, language: string, allowFallbackLanguage: boolean): Promise<{ match: CardMaster | null; matchType: "exact" | "fallback_language" | "none"; setName: string | null; suggestions?: CardMaster[] }>;
  getCardSets(game?: string): Promise<CardSet[]>;

  writeAuditLog(entityType: string, entityId: string, action: string, adminUser: string | null, details?: Record<string, unknown>): Promise<void>;
  softDeleteCardMaster(id: number, adminUser: string): Promise<boolean>;
  getLastIssuedMvNumber(): Promise<{ lastIssued: number; mvNumber: string }>;

  updateAdminNotes(submissionId: number, notes: string | null, flagged: boolean): Promise<void>;

  getServiceTiers(serviceType?: string): Promise<ServiceTierRecord[]>;
  getServiceTier(serviceType: string, tierId: string): Promise<ServiceTierRecord | undefined>;
  updateServiceTier(id: number, data: Partial<ServiceTierRecord>): Promise<ServiceTierRecord | undefined>;

  // ── Ownership system ────────────────────────────────────────────────────────
  generateClaimCode(certId: string): Promise<string>;
  getOrGenerateClaimCode(certId: string): Promise<string>;
  validateClaimCode(certId: string, claimCode: string): Promise<boolean>;
  createClaimVerification(certId: string, email: string, ownerName?: string, declaredNew?: boolean): Promise<string>;
  completeClaimByToken(token: string): Promise<{ success: boolean; certId?: string; email?: string; ownerName?: string | null; error?: string }>;
  getOwnershipHistory(certId: string): Promise<OwnershipHistoryRecord[]>;
  assignOwnerManual(certId: string, email: string, adminUser: string, notes?: string): Promise<void>;
  batchGenerateClaimCodes(): Promise<{ certId: string; claimCode: string }[]>;
  createTransferVerification(certId: string, fromEmail: string, toEmail: string, newOwnerName?: string): Promise<string>;
  confirmOwnerTransferStep(token: string): Promise<{ success: boolean; certId?: string; fromEmail?: string; toEmail?: string; newOwnerToken?: string; error?: string }>;
  completeTransferByNewOwnerToken(token: string): Promise<{ success: boolean; certId?: string; toEmail?: string; ownerName?: string | null; error?: string }>;

  // ── v2 transfer flow (DVLA-style with ref number + dispute window) ─────────
  createTransferV2(data: {
    certId: string; fromEmail: string; toEmail: string; newOwnerName?: string;
    outgoingKeeperUserId: string; referenceNumber: string;
  }): Promise<string>;
  confirmOutgoingKeeperV2(token: string): Promise<{ success: boolean; certId?: string; fromEmail?: string; toEmail?: string; newOwnerToken?: string; error?: string }>;
  confirmIncomingKeeperV2(token: string, referenceNumberProvided: string): Promise<{ success: boolean; certId?: string; toEmail?: string; ownerName?: string | null; error?: string }>;
  getTransferV2(id: number): Promise<TransferVerification | undefined>;
  getTransferV2ByCertId(certId: string): Promise<TransferVerification | undefined>;
  listTransfersV2(filters?: { status?: string; certId?: string }): Promise<TransferVerification[]>;
  disputeTransferV2(transferId: number, disputedBy: "outgoing" | "incoming", reason: string): Promise<{ success: boolean; error?: string }>;
  cancelTransferV2(transferId: number, reason: string): Promise<{ success: boolean; error?: string }>;
  finaliseTransferV2(transferId: number, opts?: { skipStatusCheck?: boolean }): Promise<{ success: boolean; certId?: string; toEmail?: string; ownerName?: string | null; error?: string }>;
  getTransfersReadyToFinalise(): Promise<TransferVerification[]>;
  expireStaleTransfersV2(): Promise<Array<{ transferId: number; certId: string; fromEmail: string; toEmail: string; reason: string }>>;

  // ── v435 buyer-initiated transfer entry point ─────────────────────────────
  validateClaimCodeForTransfer(certId: string, claimCode: string): Promise<{ valid: boolean; currentOwnerEmail?: string; currentOwnerUserId?: string }>;
  createTransferV2BuyerInit(data: {
    certId: string; claimantEmail: string; claimantName?: string; currentOwnerEmail: string; currentOwnerUserId: string;
  }): Promise<{ ownerToken: string; transferId: number }>;
  confirmBuyerInitTransfer(token: string): Promise<{ success: boolean; transferId?: number; certId?: string; claimantEmail?: string; ownerEmail?: string; disputeDeadline?: Date; error?: string }>;
  disputeBuyerInitTransfer(token: string, reason?: string): Promise<{ success: boolean; transferId?: number; certId?: string; claimantEmail?: string; ownerEmail?: string; error?: string }>;

  // ── Customer dashboard queries ──────────────────────────────────────────────
  getSubmissionsByEmail(email: string): Promise<any[]>;
  getCertificatesByEmail(email: string): Promise<CertificateRecord[]>;

  // ── Population report ───────────────────────────────────────────────────────
  getGlobalPopulation(filters: { game?: string; set?: string; card?: string }): Promise<{
    cardGame: string | null;
    setName: string | null;
    cardName: string | null;
    total: number;
    gBL: number; g10: number; g9: number;
    g8: number; g7: number; gLow: number;
  }[]>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
    return user;
  }

  async createUser(data: { email: string; firstName?: string; lastName?: string }): Promise<User> {
    const [user] = await db.insert(users).values({
      email: data.email.toLowerCase(),
      firstName: data.firstName || null,
      lastName: data.lastName || null,
    }).returning();
    return user;
  }

  async createSubmission(data: any): Promise<any> {
    if (!data.pricePerCardAtPurchase || data.pricePerCardAtPurchase <= 0) {
      throw new Error(`Cannot create submission: price_per_card_at_purchase is missing or zero (${data.pricePerCardAtPurchase}). Aborting.`);
    }
    const trackingNumber = data.submissionId || `MV-SUB-${Date.now()}`;
    const totalDeclaredValue = data.totalDeclaredValue || data.declaredValue || 0;
    const result = await db.execute(sql`
      INSERT INTO submissions (
        user_id, status, tracking_number, card_count, total_price, total_declared_value,
        payment_currency, customer_email, customer_first_name, customer_last_name,
        phone, return_address_line1, return_address_line2, return_city, return_county,
        return_postcode, service_type, service_tier, turnaround_days,
        shipping_cost, shipping_insurance_tier, grading_cost, notes, price_per_card_at_purchase,
        insurance_fee, insurance_surcharge_per_card,
        liability_accepted, liability_accepted_at, liability_accepted_ip,
        high_value_flag, requires_manual_approval,
        terms_accepted, terms_accepted_at, terms_version,
        crossover_company, crossover_original_grade, crossover_cert_number,
        reholder_company, reholder_reason, reholder_condition,
        auth_reason, auth_concerns, reveal_wrap
      )
      VALUES (
        COALESCE(${data.userId || null}, (SELECT id FROM users LIMIT 1), gen_random_uuid()::text),
        ${data.status || 'draft'},
        ${trackingNumber},
        ${data.quantity || 0},
        ${((data.amountTotal || 0) / 100).toFixed(2)},
        ${totalDeclaredValue},
        ${data.currency || 'GBP'},
        ${data.email || null},
        ${data.firstName || null},
        ${data.lastName || null},
        ${data.phone || null},
        ${data.shippingAddress?.line1 || data.addressLine1 || null},
        ${data.shippingAddress?.line2 || data.addressLine2 || null},
        ${data.shippingAddress?.city || data.city || null},
        ${data.shippingAddress?.county || data.county || null},
        ${data.shippingAddress?.postcode || data.postcode || null},
        ${data.type || null},
        ${data.tier || null},
        ${data.turnaroundDays || null},
        ${data.shippingCost || 0},
        ${data.shippingInsuranceTier || null},
        ${data.gradingCost || 0},
        ${data.notes || null},
        ${data.pricePerCardAtPurchase || 0},
        ${data.insuranceFee || 0},
        ${data.insuranceSurchargePerCard || 0},
        ${data.liabilityAccepted || false},
        ${data.liabilityAcceptedAt || null},
        ${data.liabilityAcceptedIp || null},
        ${data.highValueFlag || false},
        ${data.requiresManualApproval || false},
        ${data.termsAccepted || false},
        ${data.termsAcceptedAt || null},
        ${data.termsVersion || null},
        ${data.crossoverCompany || null},
        ${data.crossoverOriginalGrade || null},
        ${data.crossoverCertNumber || null},
        ${data.reholderCompany || null},
        ${data.reholderReason || null},
        ${data.reholderCondition || null},
        ${data.authReason || null},
        ${data.authConcerns || null},
        ${data.revealWrap || false}
      )
      RETURNING *
    `);
    const row = result.rows[0] as any;
    return {
      id: String(row.id),
      submissionId: row.tracking_number,
      email: row.customer_email || data.email,
      firstName: row.customer_first_name || data.firstName,
      lastName: row.customer_last_name || data.lastName,
      status: row.status,
      stripePaymentId: row.payment_intent_id,
      ...row,
    };
  }

  async getSubmissionBySubmissionId(submissionId: string): Promise<any | undefined> {
    const result = await db.execute(sql`
      SELECT * FROM submissions WHERE tracking_number = ${submissionId} LIMIT 1
    `);
    if (result.rows.length === 0) return undefined;
    const row = result.rows[0] as any;
    return {
      id: String(row.id),
      submissionId: row.tracking_number,
      status: row.status,
      stripePaymentId: row.payment_intent_id,
      email: row.customer_email,
      firstName: row.customer_first_name,
      lastName: row.customer_last_name,
      customerEmail: row.customer_email,
      customerFirstName: row.customer_first_name,
      customerLastName: row.customer_last_name,
      phone: row.phone,
      returnAddressLine1: row.return_address_line1,
      returnAddressLine2: row.return_address_line2,
      returnCity: row.return_city,
      returnCounty: row.return_county,
      returnPostcode: row.return_postcode,
      serviceType: row.service_type,
      serviceTier: row.service_tier,
      turnaroundDays: row.turnaround_days,
      cardCount: row.card_count,
      totalDeclaredValue: row.total_declared_value,
      totalPrice: row.total_price,
      shippingCost: row.shipping_cost,
      shippingInsuranceTier: row.shipping_insurance_tier,
      gradingCost: row.grading_cost,
      notes: row.notes,
      receivedAt: row.received_at,
      shippedAt: row.shipped_at,
      completedAt: row.completed_at,
      returnCarrier: row.return_carrier,
      returnTracking: row.return_tracking,
      crossoverCompany: row.crossover_company,
      crossoverOriginalGrade: row.crossover_original_grade,
      crossoverCertNumber: row.crossover_cert_number,
      reholderCompany: row.reholder_company,
      reholderReason: row.reholder_reason,
      reholderCondition: row.reholder_condition,
      authReason: row.auth_reason,
      authConcerns: row.auth_concerns,
      adminNotes: row.admin_notes,
      adminFlagged: row.admin_flagged,
      adminFlaggedAt: row.admin_flagged_at,
      ...row,
    };
  }

  async markSubmissionAsPaid(id: number): Promise<boolean> {
    // Uses the admin bypass to step around the status-transition trigger, which
    // rejects the uppercase "DRAFT" stored at submission creation.  Transitions
    // to "paid" — the correct next state per the trigger's own transition map.
    const numId = id;
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL mintvault.admin_bypass = 'true'`);
      await tx.execute(sql`
        UPDATE submissions
        SET status = 'paid',
            payment_status = 'paid',
            updated_at = NOW()
        WHERE id = ${numId}
          AND LOWER(status) = 'draft'
          AND payment_status != 'paid'
      `);
    });
    return true;
  }

  async getSubmissionByPaymentIntentId(paymentIntentId: string): Promise<any | undefined> {
    const result = await db.execute(sql`
      SELECT * FROM submissions WHERE payment_intent_id = ${paymentIntentId} LIMIT 1
    `);
    if (result.rows.length === 0) return undefined;
    const row = result.rows[0] as any;
    return {
      id: String(row.id),
      submissionId: row.tracking_number,
      status: row.status,
      paymentStatus: row.payment_status,
      stripePaymentId: row.payment_intent_id,
      email: row.customer_email,
      firstName: row.customer_first_name,
      lastName: row.customer_last_name,
      cardCount: row.card_count,
      serviceTier: row.service_tier,
      serviceType: row.service_type,
      crossoverCompany: row.crossover_company,
      crossoverOriginalGrade: row.crossover_original_grade,
      crossoverCertNumber: row.crossover_cert_number,
    };
  }

  async updateAdminNotes(submissionId: number, notes: string | null, flagged: boolean): Promise<void> {
    await db.execute(sql`
      UPDATE submissions
      SET admin_notes = ${notes},
          admin_flagged = ${flagged},
          admin_flagged_at = ${flagged ? sql`NOW()` : sql`NULL`}
      WHERE id = ${submissionId}
    `);
  }

  async updateSubmission(id: any, data: any): Promise<any | undefined> {
    const numId = typeof id === 'string' ? parseInt(id, 10) : id;
    const setParts: ReturnType<typeof sql>[] = [];

    if (data.stripePaymentId !== undefined) {
      setParts.push(sql`payment_intent_id = ${data.stripePaymentId}`);
    }
    if (data.status !== undefined) {
      setParts.push(sql`status = ${data.status.toLowerCase()}`);
    }
    if (data.paymentStatus !== undefined) {
      setParts.push(sql`payment_status = ${data.paymentStatus}`);
    }
    if (data.userId !== undefined) {
      setParts.push(sql`user_id = ${data.userId}`);
    }

    if (setParts.length === 0) return undefined;
    setParts.push(sql`updated_at = NOW()`);

    const result = await db.execute(
      sql`UPDATE submissions SET ${sql.join(setParts, sql`, `)} WHERE id = ${numId} RETURNING *`
    );
    if (result.rows.length === 0) return undefined;
    const row = result.rows[0] as any;
    return { id: String(row.id), submissionId: row.tracking_number, ...row };
  }

  async getNextSubmissionId(): Promise<string> {
    const result = await db.execute(sql`SELECT COUNT(*) as count FROM submissions`);
    const count = parseInt(result.rows[0]?.count as string || "0", 10) + 1;
    return `MV-SUB-${String(count).padStart(6, "0")}`;
  }

  async listSubmissions(filters?: SubmissionFilters): Promise<any[]> {
    const conditions: ReturnType<typeof sql>[] = [sql`deleted_at IS NULL`];

    if (filters?.status && filters.status !== "all") {
      conditions.push(sql`LOWER(status) = ${filters.status.toLowerCase()}`);
    }
    if (filters?.email) {
      conditions.push(sql`LOWER(customer_email) LIKE ${'%' + filters.email.toLowerCase() + '%'}`);
    }
    if (filters?.submissionId) {
      conditions.push(sql`LOWER(tracking_number) LIKE ${'%' + filters.submissionId.toLowerCase() + '%'}`);
    }
    if (filters?.dateFrom) {
      conditions.push(sql`created_at >= ${filters.dateFrom}::timestamp`);
    }
    if (filters?.dateTo) {
      conditions.push(sql`created_at <= (${filters.dateTo}::date + interval '1 day')`);
    }

    const whereClause = conditions.reduce((acc, cond, i) => i === 0 ? cond : sql`${acc} AND ${cond}`);
    const result = await db.execute(sql`SELECT * FROM submissions WHERE ${whereClause} ORDER BY created_at DESC`);
    return result.rows.map((row: any) => ({
      id: row.id,
      submissionId: row.tracking_number,
      status: row.status,
      customerEmail: row.customer_email,
      customerFirstName: row.customer_first_name,
      customerLastName: row.customer_last_name,
      phone: row.phone,
      returnAddressLine1: row.return_address_line1,
      returnAddressLine2: row.return_address_line2,
      returnCity: row.return_city,
      returnCounty: row.return_county,
      returnPostcode: row.return_postcode,
      serviceType: row.service_type,
      serviceTier: row.service_tier,
      turnaroundDays: row.turnaround_days,
      cardCount: row.card_count,
      totalDeclaredValue: row.total_declared_value,
      totalPrice: row.total_price,
      shippingCost: row.shipping_cost,
      shippingInsuranceTier: row.shipping_insurance_tier,
      gradingCost: row.grading_cost,
      paymentIntentId: row.payment_intent_id,
      notes: row.notes,
      receivedAt: row.received_at,
      shippedAt: row.shipped_at,
      completedAt: row.completed_at,
      returnCarrier: row.return_carrier,
      returnTracking: row.return_tracking,
      returnPostageCost: row.return_postage_cost,
      insuranceFee: row.insurance_fee,
      insuranceSurchargePerCard: row.insurance_surcharge_per_card,
      highValueFlag: row.high_value_flag,
      requiresManualApproval: row.requires_manual_approval,
      liabilityAccepted: row.liability_accepted,
      crossoverCompany: row.crossover_company,
      crossoverOriginalGrade: row.crossover_original_grade,
      crossoverCertNumber: row.crossover_cert_number,
      reholderCompany: row.reholder_company,
      reholderReason: row.reholder_reason,
      reholderCondition: row.reholder_condition,
      authReason: row.auth_reason,
      authConcerns: row.auth_concerns,
      adminNotes: row.admin_notes,
      adminFlagged: row.admin_flagged,
      adminFlaggedAt: row.admin_flagged_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async getSubmissionItems(submissionId: number): Promise<SubmissionItem[]> {
    return await db.select().from(submissionItems).where(eq(submissionItems.submissionId, submissionId));
  }

  async addSubmissionItems(submissionId: number, items: any[]): Promise<void> {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      await db.insert(submissionItems).values({
        submissionId,
        cardIndex: item.cardIndex ?? (i + 1),
        game: item.game || null,
        cardSet: item.cardSet || null,
        cardName: item.cardName || null,
        cardNumber: item.cardNumber || null,
        year: item.year || null,
        declaredValue: item.declaredValue || 0,
        notes: item.notes || null,
      });
    }
  }

  async updateSubmissionItem(itemId: number, data: Partial<{ game: string | null; cardName: string | null; cardSet: string | null; cardNumber: string | null; year: string | null; declaredValue: number; notes: string | null }>): Promise<SubmissionItem | undefined> {
    const setParts: ReturnType<typeof sql>[] = [];
    if (data.game !== undefined) setParts.push(sql`game = ${data.game}`);
    if (data.cardName !== undefined) setParts.push(sql`card_name = ${data.cardName}`);
    if (data.cardSet !== undefined) setParts.push(sql`card_set = ${data.cardSet}`);
    if (data.cardNumber !== undefined) setParts.push(sql`card_number = ${data.cardNumber}`);
    if (data.year !== undefined) setParts.push(sql`year = ${data.year}`);
    if (data.declaredValue !== undefined) setParts.push(sql`declared_value = ${data.declaredValue}`);
    if (data.notes !== undefined) setParts.push(sql`notes = ${data.notes}`);
    if (setParts.length === 0) return undefined;
    const result = await db.execute(
      sql`UPDATE submission_items SET ${sql.join(setParts, sql`, `)} WHERE id = ${itemId} RETURNING *`
    );
    if (result.rows.length === 0) return undefined;
    const row = result.rows[0] as any;
    return row as SubmissionItem;
  }

  async updateSubmissionStatus(id: number, status: string, extra: Record<string, any> = {}): Promise<any | undefined> {
    const setParts: ReturnType<typeof sql>[] = [
      sql`status = ${status.toLowerCase()}`,
      sql`updated_at = NOW()`,
    ];

    if (status.toLowerCase() === "received") {
      setParts.push(sql`received_at = NOW()`);
    }
    if (status.toLowerCase() === "queued") {
      setParts.push(sql`queued_at = NOW()`);
    }
    if (status.toLowerCase() === "grading_started" || status.toLowerCase() === "in_grading") {
      if (status.toLowerCase() === "grading_started") setParts.push(sql`grading_started_at = NOW()`);
    }
    if (status.toLowerCase() === "encapsulating") {
      setParts.push(sql`encapsulating_at = NOW()`);
    }
    if (status.toLowerCase() === "shipped") {
      setParts.push(sql`shipped_at = NOW()`);
      if (extra.returnTracking) setParts.push(sql`return_tracking = ${extra.returnTracking}`);
      if (extra.returnCarrier) setParts.push(sql`return_carrier = ${extra.returnCarrier}`);
    }
    if (status.toLowerCase() === "delivered") {
      setParts.push(sql`delivered_at = NOW()`);
    }
    if (status.toLowerCase() === "completed") {
      setParts.push(sql`completed_at = NOW()`);
    }
    if (extra.returnPostageCost !== undefined) {
      setParts.push(sql`return_postage_cost = ${extra.returnPostageCost}`);
    }
    if (extra.onReceiptPhotoUrls !== undefined) {
      setParts.push(sql`on_receipt_photo_urls = ${extra.onReceiptPhotoUrls}`);
    }
    // Append to status_history JSON array
    const historyEntry = JSON.stringify({ status: status.toLowerCase(), timestamp: new Date().toISOString(), note: extra.note || null });
    setParts.push(sql`status_history = COALESCE(status_history, '[]'::jsonb) || ${historyEntry}::jsonb`);

    const result = await db.execute(
      sql`UPDATE submissions SET ${sql.join(setParts, sql`, `)} WHERE id = ${id} RETURNING *`
    );
    if (result.rows.length === 0) return undefined;
    const row = result.rows[0] as any;
    return { id: row.id, submissionId: row.tracking_number, ...row };
  }

  async setEstimatedCompletionDate(id: number): Promise<void> {
    // Read the service_tier from the submission, then calculate working days
    const result = await db.execute(sql`SELECT service_tier FROM submissions WHERE id = ${id} LIMIT 1`);
    if (result.rows.length === 0) return;
    const tier = (result.rows[0] as any).service_tier as string | null;
    const workingDaysMap: Record<string, number> = { standard: 20, priority: 10, express: 5 };
    const days = workingDaysMap[tier?.toLowerCase() ?? ""] ?? 20;
    // Calculate working days from now (Mon–Fri only)
    const target = new Date();
    let added = 0;
    while (added < days) {
      target.setDate(target.getDate() + 1);
      const day = target.getDay();
      if (day !== 0 && day !== 6) added++;
    }
    await db.execute(sql`
      UPDATE submissions SET estimated_completion_date = ${target.toISOString()} WHERE id = ${id}
    `);
  }

  async createCertificate(data: InsertCertificate, adminUser?: string): Promise<CertificateRecord> {
    const certId = await this.getNextCertId();
    const hash = crypto.createHash("sha256").update(certId + Date.now()).digest("hex");

    const { getDatabaseUrl } = await import("./config");
    const dbUrl = getDatabaseUrl();
    let dbHost = "";
    try { dbHost = new URL(dbUrl).hostname.split(".")[0].slice(0, 12); } catch {}
    const env = process.env.NODE_ENV || "development";

    await this.writeAuditLog("certificate", certId, "CERT_ID_ALLOCATED", adminUser || null, {
      mvNumber: certId, env, dbHost, timestamp: new Date().toISOString(),
    });

    try {
      // Generate reference number for new certs
      let refNum: string | undefined;
      try {
        const { generateReferenceNumber } = await import("./reference-number");
        refNum = generateReferenceNumber();
      } catch {}

      const [cert] = await db.insert(certificates).values({
        ...data,
        certId,
        integrityHash: hash,
        ...(refNum ? { referenceNumber: refNum } : {}),
        logbookVersion: 1,
        logbookLastIssuedAt: new Date(),
      } as any).returning();
      return cert;
    } catch (error: any) {
      await this.writeAuditLog("certificate", certId, "CERT_CREATE_FAILED", adminUser || null, {
        mvNumber: certId, env, dbHost, reason: error.message, timestamp: new Date().toISOString(),
      });
      throw error;
    }
  }

  /** Live cert by numeric PK. Soft-deleted certs (deleted_at IS NOT NULL) are NOT returned.
   *  For admin/audit flows that need to see soft-deleted rows, add a dedicated
   *  getCertificateIncludingDeleted — do not widen this one. */
  async getCertificate(id: number): Promise<CertificateRecord | undefined> {
    const [cert] = await db.select().from(certificates)
      .where(sql`${certificates.id} = ${id} AND ${certificates.deletedAt} IS NULL`);
    return cert;
  }

  /** Live cert by public MV cert-id. Soft-deleted certs (deleted_at IS NOT NULL) are NOT returned.
   *  See getCertificate above for the rationale on scoping. */
  async getCertificateByCertId(certId: string): Promise<CertificateRecord | undefined> {
    const [cert] = await db.select().from(certificates)
      .where(sql`${certificates.certId} = ${certId} AND ${certificates.deletedAt} IS NULL`);
    return cert;
  }

  async updateCertificate(id: number, data: Partial<CertificateRecord>): Promise<CertificateRecord | undefined> {
    const updateData: any = { ...data };
    updateData.updatedAt = new Date();
    delete updateData.id;
    delete updateData.certId;
    const [cert] = await db.update(certificates).set(updateData).where(eq(certificates.id, id)).returning();
    return cert;
  }

  async getCertificateByNfcUid(uid: string): Promise<CertificateRecord | undefined> {
    const normalised = uid.toLowerCase();
    const [cert] = await db.select().from(certificates)
      .where(sql`LOWER(${certificates.nfcUid}) = ${normalised} AND ${certificates.deletedAt} IS NULL`);
    return cert;
  }

  async saveNfcData(id: number, data: { uid: string; chipType?: string; url: string; writtenBy?: string }): Promise<CertificateRecord | undefined> {
    const [cert] = await db.update(certificates).set({
      nfcUid: data.uid,
      nfcEnabled: true,
      nfcChipType: data.chipType || null,
      nfcUrl: data.url,
      nfcLocked: false,
      nfcWrittenAt: new Date(),
      nfcWrittenBy: data.writtenBy || null,
      nfcLastVerifiedAt: null,
      nfcLockedAt: null,
      updatedAt: new Date(),
    }).where(eq(certificates.id, id)).returning();
    return cert;
  }

  async lockNfc(id: number): Promise<CertificateRecord | undefined> {
    const [cert] = await db.update(certificates).set({
      nfcLocked: true,
      nfcLockedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(certificates.id, id)).returning();
    return cert;
  }

  async clearNfc(id: number): Promise<CertificateRecord | undefined> {
    const [cert] = await db.update(certificates).set({
      nfcUid: null,
      nfcEnabled: false,
      nfcChipType: null,
      nfcUrl: null,
      nfcLocked: false,
      nfcWrittenAt: null,
      nfcLockedAt: null,
      nfcLastVerifiedAt: null,
      nfcWrittenBy: null,
      nfcScanCount: 0,
      nfcLastScanAt: null,
      nfcLastScanIp: null,
      updatedAt: new Date(),
    }).where(eq(certificates.id, id)).returning();
    return cert;
  }

  async recordNfcVerified(id: number): Promise<void> {
    await db.update(certificates).set({
      nfcLastVerifiedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(certificates.id, id));
  }

  async recordNfcScan(certId: string, ip?: string): Promise<void> {
    await db.update(certificates).set({
      nfcScanCount: sql`COALESCE(${certificates.nfcScanCount}, 0) + 1`,
      nfcLastScanAt: new Date(),
      nfcLastScanIp: ip || null,
    }).where(eq(certificates.certId, certId));
  }

  // ── Label printing ──────────────────────────────────────────────────────────

  async getAllCertificatesForPrinting(limit = 200): Promise<(CertificateRecord & { lastPrintedAt: Date | null })[]> {
    // ALL active (non-deleted, non-voided) certificates.
    // Printed status is NEVER used to filter — it is informational only.
    const allActive = await db
      .select()
      .from(certificates)
      .where(and(isNull(certificates.deletedAt), ne(certificates.status, "voided")))
      .orderBy(desc(certificates.createdAt))
      .limit(limit);

    if (!allActive.length) return [];

    // Look up last printedAt for each cert — purely for badge display, never for filtering.
    const certIds = allActive.map((c) => c.certId);
    const prints = await db
      .select({ certId: labelPrints.certId, printedAt: labelPrints.printedAt })
      .from(labelPrints)
      .where(and(inArray(labelPrints.certId, certIds), isNotNull(labelPrints.printedAt)))
      .orderBy(desc(labelPrints.printedAt));

    const latestPrint = new Map<string, Date>();
    for (const p of prints) {
      if (!latestPrint.has(p.certId)) latestPrint.set(p.certId, p.printedAt!);
    }

    return allActive.map((c) => ({ ...c, lastPrintedAt: latestPrint.get(c.certId) ?? null }));
  }

  async getLabelPrintStatus(certIds: string[]): Promise<LabelPrint[]> {
    if (!certIds.length) return [];
    return db.select().from(labelPrints).where(
      sql`${labelPrints.certId} = ANY(${certIds}::text[])`
    );
  }

  async queueForPrinting(certIds: string[], sheetRef: string): Promise<void> {
    if (!certIds.length) return;
    for (const certId of certIds) {
      await db
        .insert(labelPrints)
        .values({ certId, sheetRef, printedAt: null })
        .onConflictDoUpdate({
          target: labelPrints.certId,
          set: { sheetRef, printedAt: null, queuedAt: new Date() },
        });
    }
  }

  async markSheetPrinted(sheetRef: string): Promise<void> {
    await db
      .update(labelPrints)
      .set({ printedAt: new Date() })
      .where(eq(labelPrints.sheetRef, sheetRef));
  }

  async getLabelSheets(): Promise<{ sheetRef: string; total: number; printed: boolean; queuedAt: Date; printedAt: Date | null }[]> {
    const rows = await db.select().from(labelPrints).orderBy(desc(labelPrints.queuedAt));
    const bySheet = new Map<string, typeof rows>();
    for (const row of rows) {
      const ref = row.sheetRef || "unassigned";
      if (!bySheet.has(ref)) bySheet.set(ref, []);
      bySheet.get(ref)!.push(row);
    }
    return Array.from(bySheet.entries()).map(([sheetRef, items]) => ({
      sheetRef,
      total:     items.length,
      printed:   items.every((i) => i.printedAt != null),
      queuedAt:  items[0].queuedAt,
      printedAt: items.find((i) => i.printedAt)?.printedAt ?? null,
    }));
  }

  async getSheetDetail(sheetRef: string): Promise<{ certId: string; printedAt: Date | null; queuedAt: Date; cert: CertificateRecord | null }[]> {
    const prints = await db
      .select()
      .from(labelPrints)
      .where(eq(labelPrints.sheetRef, sheetRef))
      .orderBy(labelPrints.queuedAt);

    if (!prints.length) return [];

    const certIds = prints.map((p) => p.certId);
    const certs = await db
      .select()
      .from(certificates)
      .where(inArray(certificates.certId, certIds));

    const certMap = new Map(certs.map((c) => [c.certId, c]));
    return prints.map((p) => ({
      certId:    p.certId,
      printedAt: p.printedAt,
      queuedAt:  p.queuedAt,
      cert:      certMap.get(p.certId) ?? null,
    }));
  }

  async listCertificates(filters?: CertificateFilters): Promise<CertificateRecord[]> {
    const conditions: ReturnType<typeof sql>[] = [sql`${certificates.deletedAt} IS NULL`];

    if (filters?.status && filters.status !== "all") {
      if (filters.status === "active") {
        conditions.push(sql`${certificates.status} != 'voided'`);
      } else {
        conditions.push(sql`${certificates.status} = ${filters.status}`);
      }
    }
    if (filters?.cardName) {
      conditions.push(sql`LOWER(${certificates.cardName}) LIKE ${'%' + filters.cardName.toLowerCase() + '%'}`);
    }
    if (filters?.setName) {
      conditions.push(sql`LOWER(${certificates.setName}) LIKE ${'%' + filters.setName.toLowerCase() + '%'}`);
    }
    if (filters?.grade) {
      const gradeNum = parseFloat(filters.grade);
      if (!isNaN(gradeNum)) {
        conditions.push(sql`CAST(${certificates.gradeOverall} AS numeric) = ${gradeNum}`);
      }
    }
    if (filters?.dateFrom) {
      conditions.push(sql`${certificates.createdAt} >= ${filters.dateFrom}::timestamp`);
    }
    if (filters?.dateTo) {
      conditions.push(sql`${certificates.createdAt} <= (${filters.dateTo}::date + interval '1 day')`);
    }
    if (filters?.ownershipStatus && filters.ownershipStatus !== "all") {
      conditions.push(sql`${certificates.ownershipStatus} = ${filters.ownershipStatus}`);
    }

    const whereClause = conditions.reduce((acc, cond, i) => i === 0 ? cond : sql`${acc} AND ${cond}`);
    // Sort by numeric portion of certId DESC so MV141 > MV140 > MV135 — admin
    // dashboard list, CSV export, ownership export, and printing sheet all
    // read via this method. createdAt order puts renumbered certs out of place.
    return await db.select().from(certificates).where(whereClause).orderBy(sql`CAST(REGEXP_REPLACE(${certificates.certId}, '[^0-9]', '', 'g') AS INTEGER) DESC NULLS LAST`);
  }

  async searchCertificates(query: string): Promise<CertificateRecord[]> {
    const q = `%${query}%`;
    return await db.select().from(certificates).where(
      and(
        sql`${certificates.deletedAt} IS NULL`,
        or(
          ilike(certificates.certId, q),
          ilike(certificates.cardName, q),
          ilike(certificates.setName, q),
          ilike(certificates.cardGame, q),
        )
      )
    ).orderBy(desc(certificates.createdAt));
  }

  async getNextCertId(): Promise<string> {
    await db.execute(
      sql`INSERT INTO cert_counter (id, last_issued) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`
    );
    const result = await db.execute(
      sql`UPDATE cert_counter SET last_issued = last_issued + 1, updated_at = NOW() WHERE id = 1 RETURNING last_issued`
    );
    if (!result.rows.length) {
      throw new Error("FATAL: cert_counter UPDATE returned no rows — cannot allocate certificate number");
    }
    const nextNum = parseInt(result.rows[0].last_issued as string, 10);
    if (isNaN(nextNum) || nextNum <= 0) {
      throw new Error(`FATAL: cert_counter returned invalid last_issued value: ${result.rows[0].last_issued}`);
    }
    return `MV${nextNum}`;
  }



  async getLastIssuedMvNumber(): Promise<{ lastIssued: number; mvNumber: string }> {
    const result = await db.execute(sql`SELECT last_issued FROM cert_counter WHERE id = 1`);
    const lastIssued = parseInt(result.rows[0]?.last_issued as string || "0", 10);
    return {
      lastIssued,
      mvNumber: lastIssued > 0 ? `MV${lastIssued}` : "None",
    };
  }

  async getDistinctRarityOthers(): Promise<string[]> {
    const rows = await db
      .selectDistinct({ rarityOther: certificates.rarityOther })
      .from(certificates)
      .where(
        and(
          isNotNull(certificates.rarityOther),
          ne(certificates.rarityOther, ""),
          isNull(certificates.deletedAt),
        )
      )
      .orderBy(certificates.rarityOther);
    return rows.map((r) => r.rarityOther!).filter(Boolean) as string[];
  }

  async getDistinctVariants(): Promise<string[]> {
    const rows = await db
      .selectDistinct({ variant: certificates.variant })
      .from(certificates)
      .where(
        and(
          isNotNull(certificates.variant),
          ne(certificates.variant, ""),
          ne(certificates.variant, "NONE"),
          isNull(certificates.deletedAt),
        )
      )
      .orderBy(certificates.variant);
    return rows.map((r) => r.variant!).filter(Boolean) as string[];
  }

  async getDashboardStats(): Promise<DashboardStats> {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const allCerts = await db.select().from(certificates).where(
      sql`${certificates.deletedAt} IS NULL`
    ).orderBy(desc(certificates.createdAt));
    const totalCerts = allCerts.length;
    const thisWeek = allCerts.filter(c => c.createdAt && new Date(c.createdAt) >= weekAgo).length;
    const thisMonth = allCerts.filter(c => c.createdAt && new Date(c.createdAt) >= monthAgo).length;

    const gradeMap = new Map<number, number>();
    let authenticOnlyCount = 0;
    let authenticAlteredCount = 0;

    for (const cert of allCerts) {
      const gradeType = cert.gradeType || "numeric";
      if (gradeType === "NO") {
        authenticOnlyCount++;
      } else if (gradeType === "AA") {
        authenticAlteredCount++;
      } else if (cert.gradeOverall) {
        const g = Math.floor(parseFloat(cert.gradeOverall));
        if (g >= 1 && g <= 10) {
          gradeMap.set(g, (gradeMap.get(g) || 0) + 1);
        }
      }
    }

    const gradeDistribution = [];
    for (let i = 1; i <= 10; i++) {
      gradeDistribution.push({ grade: i, count: gradeMap.get(i) || 0 });
    }

    const recentCerts = allCerts.slice(0, 20);

    return { totalCerts, thisWeek, thisMonth, authenticOnlyCount, authenticAlteredCount, gradeDistribution, recentCerts };
  }

  async getPopulationData(cert: CertificateRecord): Promise<PopulationResult> {
    const conditions: any[] = [
      sql`${certificates.deletedAt} IS NULL`,
    ];

    if (cert.cardName) conditions.push(eq(certificates.cardName, cert.cardName));
    if (cert.setName) conditions.push(eq(certificates.setName, cert.setName));
    if (cert.cardNumber) conditions.push(eq(certificates.cardNumber, cert.cardNumber));
    if (cert.year) conditions.push(eq(certificates.year, cert.year));
    if (cert.language) conditions.push(eq(certificates.language, cert.language));
    if (cert.variant) conditions.push(eq(certificates.variant, cert.variant));

    const matching = await db.select().from(certificates).where(and(...conditions));

    const certGradeType = cert.gradeType || "numeric";
    const certIsNonNumeric = isNonNumericGrade(certGradeType);
    const certGrade = certIsNonNumeric ? 0 : parseFloat(cert.gradeOverall || "0");
    let lowerCount = 0;
    let sameCount = 0;
    let higherCount = 0;
    let authenticOnlyCount = 0;
    let authenticAlteredCount = 0;

    const gradeMap = new Map<number, number>();

    for (const m of matching) {
      const mGradeType = m.gradeType || "numeric";
      if (mGradeType === "NO") {
        authenticOnlyCount++;
        continue;
      }
      if (mGradeType === "AA") {
        authenticAlteredCount++;
        continue;
      }

      const g = parseFloat(m.gradeOverall || "0");
      if (!certIsNonNumeric) {
        if (g < certGrade) lowerCount++;
        else if (g === certGrade) sameCount++;
        else higherCount++;
      }

      const rounded = Math.floor(g);
      if (rounded >= 1 && rounded <= 10) {
        gradeMap.set(rounded, (gradeMap.get(rounded) || 0) + 1);
      }
    }

    const gradeDistribution = [];
    for (let i = 1; i <= 10; i++) {
      gradeDistribution.push({ grade: i, count: gradeMap.get(i) || 0 });
    }

    return {
      lowerCount,
      sameCount,
      higherCount,
      totalCount: matching.length,
      authenticOnlyCount,
      authenticAlteredCount,
      gradeDistribution,
    };
  }

  async addCertificateImage(data: InsertCertificateImage): Promise<CertificateImage> {
    const [img] = await db.insert(certificateImages).values(data).returning();
    return img;
  }

  async getCertificateImages(certificateId: number): Promise<CertificateImage[]> {
    return await db.select().from(certificateImages)
      .where(eq(certificateImages.certificateId, certificateId))
      .orderBy(certificateImages.sortOrder);
  }

  async autofillCard(setId: string, cardNumber: string, language: string, allowFallbackLanguage: boolean): Promise<{ match: CardMaster | null; matchType: "exact" | "fallback_language" | "none"; setName: string | null; suggestions?: CardMaster[] }> {
    const num = cardNumber.trim();
    const lang = language.trim();

    const [setRow] = await db.select().from(cardSets).where(
      and(eq(cardSets.setId, setId), eq(cardSets.isDeleted, false))
    );
    const setName = setRow?.setName || null;

    const exact = await db.select().from(cardMaster).where(
      and(
        eq(cardMaster.setId, setId),
        eq(cardMaster.cardNumber, num),
        eq(cardMaster.language, lang),
        eq(cardMaster.isDeleted, false),
      )
    ).limit(1);

    if (exact.length > 0) {
      return { match: exact[0], matchType: "exact", setName };
    }

    if (allowFallbackLanguage) {
      const fallback = await db.select().from(cardMaster).where(
        and(
          eq(cardMaster.setId, setId),
          eq(cardMaster.cardNumber, num),
          eq(cardMaster.isDeleted, false),
        )
      ).limit(1);

      if (fallback.length > 0) {
        return { match: fallback[0], matchType: "fallback_language", setName };
      }
    }

    const suggestions = await db.select().from(cardMaster).where(
      and(
        eq(cardMaster.setId, setId),
        eq(cardMaster.language, lang),
        eq(cardMaster.isDeleted, false),
        or(
          like(cardMaster.cardNumber, `${num}%`),
          like(cardMaster.cardNumber, `%${num}%`),
        ),
      )
    ).limit(5);

    return { match: null, matchType: "none", setName, suggestions: suggestions.length > 0 ? suggestions : undefined };
  }

  async getCardSets(game?: string): Promise<CardSet[]> {
    if (game) {
      return await db.select().from(cardSets).where(
        and(eq(cardSets.game, game), eq(cardSets.isDeleted, false))
      );
    }
    return await db.select().from(cardSets).where(eq(cardSets.isDeleted, false));
  }

  async writeAuditLog(entityType: string, entityId: string, action: string, adminUser: string | null, details: Record<string, unknown> = {}): Promise<void> {
    await db.insert(auditLog).values({
      entityType,
      entityId,
      action,
      adminUser,
      details,
    });
  }

  async softDeleteCardMaster(id: number, adminUser: string): Promise<boolean> {
    const [card] = await db.select().from(cardMaster).where(eq(cardMaster.id, id));
    if (!card || card.isDeleted) return false;

    await db.update(cardMaster).set({
      isDeleted: true,
      deletedAt: new Date(),
      deletedBy: adminUser,
    }).where(eq(cardMaster.id, id));

    await this.writeAuditLog("card_master", String(id), "soft_delete", adminUser, {
      cardName: card.cardName,
      setId: card.setId,
      cardNumber: card.cardNumber,
      language: card.language,
    });

    return true;
  }

  async getServiceTiers(serviceType?: string): Promise<ServiceTierRecord[]> {
    if (serviceType) {
      return await db.select().from(serviceTiers)
        .where(and(eq(serviceTiers.serviceType, serviceType), eq(serviceTiers.isActive, true)))
        .orderBy(serviceTiers.sortOrder);
    }
    return await db.select().from(serviceTiers).orderBy(serviceTiers.serviceType, serviceTiers.sortOrder);
  }

  async getServiceTier(serviceType: string, tierId: string): Promise<ServiceTierRecord | undefined> {
    const [tier] = await db.select().from(serviceTiers)
      .where(and(eq(serviceTiers.serviceType, serviceType), eq(serviceTiers.tierId, tierId), eq(serviceTiers.isActive, true)));
    return tier;
  }

  async updateServiceTier(id: number, data: Partial<ServiceTierRecord>): Promise<ServiceTierRecord | undefined> {
    const setParts: ReturnType<typeof sql>[] = [sql`updated_at = NOW()`];
    if (data.pricePerCard !== undefined) setParts.push(sql`price_per_card = ${data.pricePerCard}`);
    if (data.turnaroundDays !== undefined) setParts.push(sql`turnaround_days = ${data.turnaroundDays}`);
    if (data.maxValueGbp !== undefined) setParts.push(sql`max_value_gbp = ${data.maxValueGbp}`);
    if (data.isActive !== undefined) setParts.push(sql`is_active = ${data.isActive}`);
    if (data.features !== undefined) setParts.push(sql`features = ${data.features}`);

    const result = await db.execute(
      sql`UPDATE service_tiers SET ${sql.join(setParts, sql`, `)} WHERE id = ${id} RETURNING *`
    );
    if (result.rows.length === 0) return undefined;
    return result.rows[0] as ServiceTierRecord;
  }

  // ── Label overrides ──────────────────────────────────────────────────────────

  async getLabelOverride(certId: string): Promise<LabelOverride | null> {
    const [row] = await db.select().from(labelOverrides).where(eq(labelOverrides.certId, certId));
    return row ?? null;
  }

  async upsertLabelOverride(
    certId: string,
    data: { cardNameOverride?: string | null; setOverride?: string | null; variantOverride?: string | null; languageOverride?: string | null; yearOverride?: string | null }
  ): Promise<LabelOverride> {
    const now = new Date();
    const [row] = await db.insert(labelOverrides)
      .values({ certId, ...data, editedAt: now })
      .onConflictDoUpdate({
        target: labelOverrides.certId,
        set: { ...data, editedAt: now },
      })
      .returning();
    return row;
  }

  async clearLabelOverride(certId: string): Promise<void> {
    await db.delete(labelOverrides).where(eq(labelOverrides.certId, certId));
  }

  // ── Reprint log ──────────────────────────────────────────────────────────────

  async logReprint(certId: string): Promise<void> {
    await db.insert(reprintLog).values({ certId, reprintTime: new Date() });
  }

  // ── Certificate browser ──────────────────────────────────────────────────────

  async listCertificatesBrowser(): Promise<Array<CertificateRecord & { isPrinted: boolean; reprintCount: number }>> {
    // Sort by numeric portion of certId DESC so MV141 > MV140 > MV135, not by
    // createdAt (which puts renumbered certs out of sequence). Text sort alone
    // would give MV9 > MV141 lexically — CAST avoids that.
    const certs = await db
      .select()
      .from(certificates)
      .where(isNull(certificates.deletedAt))
      .orderBy(sql`CAST(REGEXP_REPLACE(${certificates.certId}, '[^0-9]', '', 'g') AS INTEGER) DESC NULLS LAST`);

    const printedRows = await db
      .select({ certId: labelPrints.certId })
      .from(labelPrints)
      .where(isNotNull(labelPrints.printedAt));
    const printedSet = new Set(printedRows.map((r) => r.certId));

    const reprintCounts = await db
      .select({ certId: reprintLog.certId, count: sql<number>`cast(count(*) as int)` })
      .from(reprintLog)
      .groupBy(reprintLog.certId);
    const reprintMap = new Map(reprintCounts.map((r) => [r.certId, r.count]));

    return certs.map((cert) => ({
      ...cert,
      isPrinted: printedSet.has(cert.certId),
      reprintCount: reprintMap.get(cert.certId) ?? 0,
    }));
  }

  // ── Ownership system ──────────────────────────────────────────────────────

  private _hashClaimCode(code: string): string {
    return crypto.createHash("sha256").update(code.toUpperCase().trim()).digest("hex");
  }

  private _generateRandomCode(length = 12): string {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = crypto.randomBytes(length);
    return Array.from(bytes).map(b => chars[b % chars.length]).join("");
  }

  async generateClaimCode(certId: string): Promise<string> {
    const code = this._generateRandomCode(12);
    const hash = this._hashClaimCode(code);
    await db.execute(sql`
      UPDATE certificates
      SET claim_code_hash = ${hash},
          claim_code = ${code},
          claim_code_created_at = NOW(),
          claim_code_used_at = NULL,
          ownership_status = CASE WHEN ownership_status = 'claimed' THEN ownership_status ELSE 'unclaimed' END,
          updated_at = NOW()
      WHERE certificate_number = ${certId}
    `);
    return code;
  }

  // Returns the existing claim code if the cert is unclaimed, otherwise generates a new one.
  // Used by claim insert PDF downloads so repeated downloads don't invalidate the code.
  async getOrGenerateClaimCode(certId: string): Promise<string> {
    const result = await db.execute(sql`
      SELECT claim_code FROM certificates
      WHERE certificate_number = ${certId}
        AND ownership_status = 'unclaimed'
        AND claim_code IS NOT NULL
        AND claim_code_used_at IS NULL
        AND deleted_at IS NULL
        AND status = 'active'
      LIMIT 1
    `);
    if (result.rows.length > 0) {
      const row = result.rows[0] as any;
      if (row.claim_code) return row.claim_code as string;
    }
    return this.generateClaimCode(certId);
  }

  async validateClaimCode(certId: string, claimCode: string): Promise<boolean> {
    const hash = this._hashClaimCode(claimCode);
    const result = await db.execute(sql`
      SELECT 1 FROM certificates
      WHERE certificate_number = ${certId}
        AND claim_code_hash = ${hash}
        AND ownership_status = 'unclaimed'
        AND claim_code_used_at IS NULL
        AND deleted_at IS NULL
        AND status = 'active'
      LIMIT 1
    `);
    return result.rows.length > 0;
  }

  async createClaimVerification(certId: string, email: string, ownerName?: string, declaredNew?: boolean): Promise<string> {
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await db.insert(claimVerifications).values({
      certId,
      email: email.toLowerCase().trim(),
      ownerName: ownerName?.trim() || null,
      tokenHash,
      expiresAt,
      declaredNew: declaredNew === true,
    });

    return token;
  }

  async completeClaimByToken(token: string): Promise<{ success: boolean; certId?: string; email?: string; ownerName?: string | null; error?: string }> {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const [verification] = await db.select()
      .from(claimVerifications)
      .where(eq(claimVerifications.tokenHash, tokenHash));

    if (!verification) return { success: false, error: "Invalid verification link." };
    if (verification.usedAt) return { success: false, error: "This verification link has already been used." };
    if (new Date() > verification.expiresAt) return { success: false, error: "This verification link has expired. Please submit a new claim." };

    const cert = await this.getCertificateByCertId(verification.certId);
    if (!cert) return { success: false, error: "Certificate not found." };
    if (cert.ownershipStatus === "claimed") return { success: false, error: "This certificate has already been claimed." };
    if (cert.claimCodeUsedAt) return { success: false, error: "This claim code has already been used." };
    if (cert.claimCodeCreatedAt && verification.createdAt < cert.claimCodeCreatedAt) {
      return { success: false, error: "The claim code was regenerated after this verification was requested. Please submit a new claim." };
    }

    let user = await this.getUserByEmail(verification.email);
    if (!user) {
      user = await this.createUser({ email: verification.email });
    }

    const ownershipToken = await this._generateOwnershipToken();

    // Atomic claim — cert UPDATE, ownership_history INSERT, claim_verifications
    // UPDATE, and the new users.email_verified flip all succeed together or
    // none. Without the wrapping transaction a partial failure could leave
    // the user table un-flipped while the cert is already claimed (or vice
    // versa). The email_verified flip is conditional on email_verified=false
    // so repeated claims by the same user don't churn the timestamp.
    const userId = user.id;
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE certificates
        SET current_owner_user_id = ${userId},
            ownership_status = 'claimed',
            claim_code_used_at = NOW(),
            ownership_token = ${ownershipToken},
            ownership_token_generated_at = NOW(),
            owner_name = ${verification.ownerName ?? null},
            owner_email = ${verification.email},
            declared_new = ${verification.declaredNew === true},
            updated_at = NOW()
        WHERE certificate_number = ${verification.certId}
      `);

      await tx.insert(ownershipHistory).values({
        certId: verification.certId,
        fromUserId: null,
        toUserId: userId,
        toEmail: verification.email,
        eventType: "initial_claim",
        notes: "Claimed via email verification",
      });

      await tx.update(claimVerifications)
        .set({ usedAt: new Date() })
        .where(eq(claimVerifications.id, verification.id));

      // Clicking the unique-token verify link IS proof of email control;
      // flip the user's email_verified flag now if it isn't already.
      await tx.execute(sql`
        UPDATE users
        SET email_verified = true,
            email_verified_at = NOW()
        WHERE id = ${userId}
          AND email_verified = false
      `);
    });

    return { success: true, certId: verification.certId, email: verification.email, ownerName: verification.ownerName ?? undefined };
  }

  async getOwnershipHistory(certId: string): Promise<OwnershipHistoryRecord[]> {
    return await db.select()
      .from(ownershipHistory)
      .where(eq(ownershipHistory.certId, certId))
      .orderBy(desc(ownershipHistory.createdAt));
  }

  async assignOwnerManual(certId: string, email: string, adminUser: string, notes?: string): Promise<void> {
    const normalEmail = email.toLowerCase().trim();
    let user = await this.getUserByEmail(normalEmail);
    if (!user) {
      user = await this.createUser({ email: normalEmail });
    }

    const cert = await this.getCertificateByCertId(certId);
    const previousOwnerId = cert?.currentOwnerUserId || null;

    const ownershipToken = await this._generateOwnershipToken();

    await db.execute(sql`
      UPDATE certificates
      SET current_owner_user_id = ${user.id},
          ownership_status = 'claimed',
          claim_code_used_at = NOW(),
          ownership_token = ${ownershipToken},
          ownership_token_generated_at = NOW(),
          updated_at = NOW()
      WHERE certificate_number = ${certId}
    `);

    await db.insert(ownershipHistory).values({
      certId,
      fromUserId: previousOwnerId,
      toUserId: user.id,
      toEmail: normalEmail,
      eventType: previousOwnerId ? "transfer" : "initial_claim",
      notes: notes || `Manually assigned by admin (${adminUser})`,
    });

    await this.writeAuditLog("certificate", certId, "OWNER_ASSIGNED", adminUser, {
      email: normalEmail, userId: user.id,
    });
  }

  async batchGenerateClaimCodes(): Promise<{ certId: string; claimCode: string }[]> {
    const result = await db.execute(sql`
      SELECT certificate_number FROM certificates
      WHERE ownership_status = 'unclaimed'
        AND claim_code_hash IS NULL
        AND deleted_at IS NULL
        AND status = 'active'
      ORDER BY certificate_number
    `);

    const codes: { certId: string; claimCode: string }[] = [];
    for (const row of result.rows as any[]) {
      const certId = row.certificate_number;
      const code = await this.generateClaimCode(certId);
      codes.push({ certId, claimCode: code });
    }
    return codes;
  }

  async createTransferVerification(certId: string, fromEmail: string, toEmail: string, newOwnerName?: string): Promise<string> {
    const ownerToken = crypto.randomBytes(32).toString("hex");
    const ownerTokenHash = crypto.createHash("sha256").update(ownerToken).digest("hex");
    const ownerExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await db.insert(transferVerifications).values({
      certId,
      fromEmail: fromEmail.toLowerCase().trim(),
      toEmail: toEmail.toLowerCase().trim(),
      ownerTokenHash,
      ownerExpiresAt,
      newOwnerName: newOwnerName?.trim() || null,
    });

    // Mark cert as transfer_pending
    await db.execute(sql`
      UPDATE certificates
      SET ownership_status = 'transfer_pending', updated_at = NOW()
      WHERE certificate_number = ${certId}
    `);

    return ownerToken;
  }

  // Step 1: current owner clicks their confirmation link → generates new owner token
  async confirmOwnerTransferStep(token: string): Promise<{ success: boolean; certId?: string; fromEmail?: string; toEmail?: string; newOwnerToken?: string; error?: string }> {
    const ownerTokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const [verification] = await db.select()
      .from(transferVerifications)
      .where(eq(transferVerifications.ownerTokenHash, ownerTokenHash));

    if (!verification) return { success: false, error: "Invalid confirmation link." };
    if (verification.ownerConfirmedAt) return { success: false, error: "You have already confirmed this transfer. The new owner has been emailed." };
    if (new Date() > verification.ownerExpiresAt) return { success: false, error: "This confirmation link has expired. Please initiate a new transfer." };
    if (verification.usedAt) return { success: false, error: "This transfer has already been completed." };

    // Generate token for new owner
    const newOwnerToken = crypto.randomBytes(32).toString("hex");
    const newOwnerTokenHash = crypto.createHash("sha256").update(newOwnerToken).digest("hex");
    const newOwnerExpiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h for new owner

    await db.update(transferVerifications)
      .set({
        ownerConfirmedAt: new Date(),
        newOwnerTokenHash,
        newOwnerExpiresAt,
      })
      .where(eq(transferVerifications.id, verification.id));

    return { success: true, certId: verification.certId, fromEmail: verification.fromEmail, toEmail: verification.toEmail, newOwnerToken };
  }

  private async _generateOwnershipToken(): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const raw = crypto.randomBytes(16).toString("hex").toUpperCase();
      const token = `${raw.slice(0, 8)}-${raw.slice(8, 16)}-${raw.slice(16, 24)}-${raw.slice(24, 32)}`;
      const result = await db.execute(sql`SELECT 1 FROM certificates WHERE ownership_token = ${token} LIMIT 1`);
      if ((result.rows as unknown[]).length === 0) return token;
    }
    throw new Error("Could not generate unique ownership token after 10 attempts");
  }

  // Step 2: new owner clicks their confirmation link → transfer completes
  async completeTransferByNewOwnerToken(token: string): Promise<{ success: boolean; certId?: string; toEmail?: string; ownerName?: string | null; error?: string }> {
    const newOwnerTokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const [verification] = await db.select()
      .from(transferVerifications)
      .where(eq(transferVerifications.newOwnerTokenHash, newOwnerTokenHash));

    if (!verification) return { success: false, error: "Invalid confirmation link." };
    if (verification.usedAt) return { success: false, error: "This transfer has already been completed." };
    if (!verification.newOwnerExpiresAt || new Date() > verification.newOwnerExpiresAt) {
      return { success: false, error: "This confirmation link has expired. Please ask the original owner to initiate a new transfer." };
    }

    const cert = await this.getCertificateByCertId(verification.certId);
    if (!cert) return { success: false, error: "Certificate not found." };

    let newOwner = await this.getUserByEmail(verification.toEmail);
    if (!newOwner) {
      newOwner = await this.createUser({ email: verification.toEmail });
    }

    const ownershipToken = await this._generateOwnershipToken();

    await db.execute(sql`
      UPDATE certificates
      SET current_owner_user_id = ${newOwner.id},
          ownership_status = 'claimed',
          ownership_token = ${ownershipToken},
          ownership_token_generated_at = NOW(),
          owner_name = ${verification.newOwnerName ?? null},
          owner_email = ${verification.toEmail},
          updated_at = NOW()
      WHERE certificate_number = ${verification.certId}
    `);

    await db.insert(ownershipHistory).values({
      certId: verification.certId,
      fromUserId: cert.currentOwnerUserId || null,
      toUserId: newOwner.id,
      toEmail: verification.toEmail,
      eventType: "transfer",
      notes: `Transferred from ${verification.fromEmail} — both parties confirmed by email`,
    });

    await db.update(transferVerifications)
      .set({ usedAt: new Date() })
      .where(eq(transferVerifications.id, verification.id));

    return { success: true, certId: verification.certId, toEmail: verification.toEmail, ownerName: verification.newOwnerName ?? null };
  }

  // ── Customer dashboard queries ──────────────────────────────────────────────
  async getSubmissionsByEmail(email: string): Promise<any[]> {
    const normalEmail = email.toLowerCase().trim();
    const result = await db.execute(sql`
      SELECT * FROM submissions
      WHERE LOWER(customer_email) = ${normalEmail}
      ORDER BY created_at DESC
    `);
    return result.rows.map((row: any) => ({
      id: row.id,
      submissionId: row.tracking_number,
      status: row.status,
      cardCount: row.card_count,
      tier: row.tier,
      serviceType: row.service_type,
      totalAmount: row.total_amount,
      createdAt: row.created_at,
      receivedAt: row.received_at,
      shippedAt: row.shipped_at,
      completedAt: row.completed_at,
      returnCarrier: row.return_carrier,
      returnTrackingNumber: row.return_tracking_number,
      customerFirstName: row.customer_first_name,
      customerEmail: row.customer_email,
    }));
  }

  async getCertificatesByEmail(email: string): Promise<CertificateRecord[]> {
    const normalEmail = email.toLowerCase().trim();
    // Certs linked via submission items
    const linked = await db.execute(sql`
      SELECT DISTINCT c.*
      FROM certificates c
      JOIN submission_items si ON c.submission_item_id = si.id
      JOIN submissions s ON si.submission_id = s.id
      WHERE LOWER(s.customer_email) = ${normalEmail}
        AND c.status != 'voided'
      ORDER BY c.issued_at DESC
    `);
    // Certs owned by this email (claimed via registry)
    const owned = await db.execute(sql`
      SELECT c.*
      FROM certificates c
      WHERE LOWER(c.owner_email) = ${normalEmail}
        AND c.ownership_status = 'claimed'
        AND c.status != 'voided'
      ORDER BY c.issued_at DESC
    `);
    // Merge, dedup by id
    const seen = new Set<number>();
    const rows: CertificateRecord[] = [];
    for (const row of [...linked.rows, ...owned.rows] as any[]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push({
        id: row.id,
        cardId: row.card_id,
        submissionItemId: row.submission_item_id,
        nfcUid: row.nfc_uid,
        nfcEnabled: row.nfc_enabled,
        nfcChipType: row.nfc_chip_type,
        nfcWrittenAt: row.nfc_written_at,
        nfcWrittenBy: row.nfc_written_by,
        nfcLocked: row.nfc_locked,
        nfcScanCount: row.nfc_scan_count,
        nfcLastScanAt: row.nfc_last_scan_at,
        nfcLastScanIp: row.nfc_last_scan_ip,
        certId: row.certificate_number,
        gradeOverall: row.grade,
        gradeType: row.grade_type,
        gradeCentering: row.centering_score,
        gradeCorners: row.corners_score,
        gradeEdges: row.edges_score,
        gradeSurface: row.surface_score,
        status: row.status,
        voidReason: row.void_reason,
        replacedByCertId: row.replaced_by_cert_id,
        integrityHash: row.integrity_hash,
        cardName: row.card_name,
        setName: row.set_name,
        cardNumber: row.card_number_display,
        year: row.year_text,
        language: row.language,
        variant: row.variant,
        rarity: row.rarity,
        collection: row.collection,
        designations: row.designations,
        cardGame: row.card_game,
        notes: row.notes,
        createdBy: row.created_by,
        updatedAt: row.updated_at,
        currentOwnerUserId: row.current_owner_user_id,
        ownershipStatus: row.ownership_status,
        claimCodeHash: row.claim_code_hash,
        claimCodeCreatedAt: row.claim_code_created_at,
        claimCodeUsedAt: row.claim_code_used_at,
        ownershipToken: row.ownership_token,
        ownershipTokenGeneratedAt: row.ownership_token_generated_at,
        ownerName: row.owner_name,
        ownerEmail: row.owner_email,
        frontImagePath: row.front_image_path,
        createdAt: row.issued_at,
      } as unknown as CertificateRecord);
    }
    return rows;
  }

  async getGlobalPopulation(filters: { game?: string; set?: string; card?: string }): Promise<{
    cardGame: string | null; setName: string | null; cardName: string | null;
    total: number; gBL: number; g10: number; g9: number;
    g8: number; g7: number; gLow: number;
  }[]> {
    const conditions: string[] = [
      `status = 'active'`,
      `deleted_at IS NULL`,
      `grade_type = 'numeric'`,
    ];
    if (filters.game) conditions.push(`LOWER(card_game) = LOWER('${filters.game.replace(/'/g, "''")}')`);
    if (filters.set)  conditions.push(`LOWER(set_name)  LIKE LOWER('%${filters.set.replace(/'/g, "''").replace(/%/g, "\\%")}%')`);
    if (filters.card) conditions.push(`LOWER(card_name) LIKE LOWER('%${filters.card.replace(/'/g, "''").replace(/%/g, "\\%")}%')`);

    const where = conditions.join(" AND ");
    const result = await db.execute(sql.raw(`
      SELECT
        card_game,
        set_name,
        card_name,
        COUNT(*)::int AS total,
        COUNT(CASE WHEN grade::numeric = 10
          AND COALESCE(centering_score::numeric, 0) = 10
          AND COALESCE(corners_score::numeric, 0)   = 10
          AND COALESCE(edges_score::numeric, 0)     = 10
          AND COALESCE(surface_score::numeric, 0)   = 10
          THEN 1 END)::int AS gBL,
        COUNT(CASE WHEN grade::numeric = 10 AND NOT (
          COALESCE(centering_score::numeric, 0) = 10
          AND COALESCE(corners_score::numeric, 0)   = 10
          AND COALESCE(edges_score::numeric, 0)     = 10
          AND COALESCE(surface_score::numeric, 0)   = 10
        ) THEN 1 END)::int AS g10,
        COUNT(CASE WHEN grade::numeric >= 9 AND grade::numeric < 10 THEN 1 END)::int AS g9,
        COUNT(CASE WHEN grade::numeric >= 8 AND grade::numeric < 9  THEN 1 END)::int AS g8,
        COUNT(CASE WHEN grade::numeric = 7 THEN 1 END)::int AS g7,
        COUNT(CASE WHEN grade::numeric <= 6 THEN 1 END)::int AS gLow
      FROM certificates
      WHERE ${where}
      GROUP BY card_game, set_name, card_name
      ORDER BY total DESC
      LIMIT 200
    `));

    return (result.rows as any[]).map(r => ({
      cardGame: r.card_game ?? null,
      setName:  r.set_name  ?? null,
      cardName: r.card_name ?? null,
      total:    Number(r.total),
      gBL:      Number(r.gbl ?? r.gBL ?? 0),
      g10:      Number(r.g10),
      g9:       Number(r.g9),
      g8:       Number(r.g8),
      g7:       Number(r.g7),
      gLow:     Number(r.glow ?? r.gLow ?? 0),
    }));
  }

  // ── v2 Transfer Flow (DVLA-style) ─────────────────────────────────────────
  async createTransferV2(data: {
    certId: string; fromEmail: string; toEmail: string; newOwnerName?: string;
    outgoingKeeperUserId: string; referenceNumber: string;
  }): Promise<string> {
    const ownerToken = crypto.randomBytes(32).toString("hex");
    const ownerTokenHash = crypto.createHash("sha256").update(ownerToken).digest("hex");
    const ownerExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    await db.insert(transferVerifications).values({
      certId: data.certId,
      fromEmail: data.fromEmail.toLowerCase().trim(),
      toEmail: data.toEmail.toLowerCase().trim(),
      ownerTokenHash,
      ownerExpiresAt,
      newOwnerName: data.newOwnerName?.trim() || null,
      flowVersion: "v2",
      status: "pending_owner",
      outgoingKeeperUserId: data.outgoingKeeperUserId,
      referenceNumberProvided: null, // incoming keeper provides this at step 2
    });

    // Mark cert as transfer_pending
    await db.execute(sql`
      UPDATE certificates
      SET ownership_status = 'transfer_pending', updated_at = NOW()
      WHERE certificate_number = ${data.certId}
    `);

    return ownerToken;
  }

  async confirmOutgoingKeeperV2(token: string): Promise<{
    success: boolean; certId?: string; fromEmail?: string; toEmail?: string;
    newOwnerToken?: string; error?: string;
  }> {
    const ownerTokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const [verification] = await db.select()
      .from(transferVerifications)
      .where(and(
        eq(transferVerifications.ownerTokenHash, ownerTokenHash),
        eq(transferVerifications.flowVersion, "v2"),
      ));

    if (!verification) return { success: false, error: "Invalid confirmation link." };
    if (verification.ownerConfirmedAt) return { success: false, error: "You have already confirmed this transfer." };
    if (new Date() > verification.ownerExpiresAt) return { success: false, error: "This confirmation link has expired. Please initiate a new transfer." };
    if (verification.usedAt) return { success: false, error: "This transfer has already been completed." };
    if (verification.cancelledAt) return { success: false, error: "This transfer has been cancelled." };

    // Generate token for incoming keeper — 14-day deadline
    const newOwnerToken = crypto.randomBytes(32).toString("hex");
    const newOwnerTokenHash = crypto.createHash("sha256").update(newOwnerToken).digest("hex");
    const incomingConfirmDeadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days

    await db.update(transferVerifications)
      .set({
        ownerConfirmedAt: new Date(),
        newOwnerTokenHash,
        newOwnerExpiresAt: incomingConfirmDeadline,
        incomingConfirmDeadline,
        status: "pending_incoming",
      })
      .where(eq(transferVerifications.id, verification.id));

    return {
      success: true,
      certId: verification.certId,
      fromEmail: verification.fromEmail,
      toEmail: verification.toEmail,
      newOwnerToken,
    };
  }

  async confirmIncomingKeeperV2(token: string, referenceNumberProvided: string): Promise<{
    success: boolean; certId?: string; toEmail?: string; ownerName?: string | null; error?: string;
  }> {
    const newOwnerTokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const [verification] = await db.select()
      .from(transferVerifications)
      .where(and(
        eq(transferVerifications.newOwnerTokenHash, newOwnerTokenHash),
        eq(transferVerifications.flowVersion, "v2"),
      ));

    if (!verification) return { success: false, error: "Invalid confirmation link." };
    if (verification.usedAt) return { success: false, error: "This transfer has already been completed." };
    if (verification.cancelledAt) return { success: false, error: "This transfer has been cancelled." };
    if (!verification.incomingConfirmDeadline || new Date() > verification.incomingConfirmDeadline) {
      return { success: false, error: "This confirmation link has expired (14-day deadline passed)." };
    }

    // Verify reference number matches the certificate
    const cert = await this.getCertificateByCertId(verification.certId);
    if (!cert) return { success: false, error: "Certificate not found." };

    const certRefNumber = (cert as any).referenceNumber as string | null;
    if (!certRefNumber) {
      return { success: false, error: "This certificate does not have a Document Reference Number. Please contact support." };
    }

    // Normalise: strip dashes and compare uppercase
    const normalise = (s: string) => s.replace(/-/g, "").toUpperCase().trim();
    if (normalise(referenceNumberProvided) !== normalise(certRefNumber)) {
      // Record the failed attempt (store what they provided for admin review)
      await db.update(transferVerifications)
        .set({ referenceNumberProvided: referenceNumberProvided.trim() })
        .where(eq(transferVerifications.id, verification.id));

      // Audit the failed attempt (do not log the actual ref number)
      await db.insert(auditLog).values({
        entityType: "transfer",
        entityId: verification.certId,
        action: "transfer_v2.ref_number_mismatch",
        adminUser: null,
        details: { transferId: verification.id, toEmail: verification.toEmail },
      });

      return { success: false, error: "The Document Reference Number you entered does not match. Please check your Logbook and try again." };
    }

    // Reference number correct — start dispute window (14 days from now)
    const disputeDeadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    // Create/find incoming keeper user
    let incomingUser = await this.getUserByEmail(verification.toEmail);
    if (!incomingUser) {
      incomingUser = await this.createUser({ email: verification.toEmail });
    }

    await db.update(transferVerifications)
      .set({
        referenceNumberProvided: referenceNumberProvided.trim(),
        incomingKeeperUserId: incomingUser.id,
        disputeDeadline,
        status: "pending_dispute",
      })
      .where(eq(transferVerifications.id, verification.id));

    return {
      success: true,
      certId: verification.certId,
      toEmail: verification.toEmail,
      ownerName: verification.newOwnerName ?? null,
    };
  }

  async getTransferV2(id: number): Promise<TransferVerification | undefined> {
    const [row] = await db.select()
      .from(transferVerifications)
      .where(and(
        eq(transferVerifications.id, id),
        eq(transferVerifications.flowVersion, "v2"),
      ));
    return row;
  }

  async getTransferV2ByCertId(certId: string): Promise<TransferVerification | undefined> {
    const [row] = await db.select()
      .from(transferVerifications)
      .where(and(
        eq(transferVerifications.certId, certId),
        eq(transferVerifications.flowVersion, "v2"),
        isNull(transferVerifications.usedAt),
        isNull(transferVerifications.cancelledAt),
      ))
      .orderBy(desc(transferVerifications.createdAt))
      .limit(1);
    return row;
  }

  async listTransfersV2(filters?: { status?: string; certId?: string }): Promise<TransferVerification[]> {
    const conditions = [eq(transferVerifications.flowVersion, "v2")];
    if (filters?.status) conditions.push(eq(transferVerifications.status, filters.status));
    if (filters?.certId) conditions.push(eq(transferVerifications.certId, filters.certId));

    return db.select()
      .from(transferVerifications)
      .where(and(...conditions))
      .orderBy(desc(transferVerifications.createdAt));
  }

  async disputeTransferV2(transferId: number, disputedBy: "outgoing" | "incoming", reason: string): Promise<{ success: boolean; error?: string }> {
    const [transfer] = await db.select()
      .from(transferVerifications)
      .where(and(
        eq(transferVerifications.id, transferId),
        eq(transferVerifications.flowVersion, "v2"),
      ));

    if (!transfer) return { success: false, error: "Transfer not found." };
    if (transfer.status !== "pending_dispute") return { success: false, error: "This transfer is not in the dispute window." };
    if (transfer.disputeDeadline && new Date() > transfer.disputeDeadline) {
      return { success: false, error: "The dispute window has closed." };
    }

    await db.update(transferVerifications)
      .set({
        status: "disputed",
        disputedAt: new Date(),
        disputedBy,
        disputeReason: reason.trim().slice(0, 2000),
      })
      .where(eq(transferVerifications.id, transferId));

    // Reset cert to claimed (transfer no longer proceeding)
    await db.execute(sql`
      UPDATE certificates
      SET ownership_status = 'claimed', updated_at = NOW()
      WHERE certificate_number = ${transfer.certId}
    `);

    return { success: true };
  }

  async cancelTransferV2(transferId: number, reason: string): Promise<{ success: boolean; error?: string }> {
    const [transfer] = await db.select()
      .from(transferVerifications)
      .where(and(
        eq(transferVerifications.id, transferId),
        eq(transferVerifications.flowVersion, "v2"),
      ));

    if (!transfer) return { success: false, error: "Transfer not found." };
    // Can only cancel if not yet completed or already cancelled
    if (transfer.status === "completed" || transfer.status === "cancelled") {
      return { success: false, error: "This transfer cannot be cancelled." };
    }

    await db.update(transferVerifications)
      .set({
        status: "cancelled",
        cancelledAt: new Date(),
        cancellationReason: reason.trim().slice(0, 2000),
      })
      .where(eq(transferVerifications.id, transferId));

    // Reset cert to claimed
    await db.execute(sql`
      UPDATE certificates
      SET ownership_status = 'claimed', updated_at = NOW()
      WHERE certificate_number = ${transfer.certId}
    `);

    return { success: true };
  }

  async finaliseTransferV2(transferId: number, opts?: { skipStatusCheck?: boolean }): Promise<{
    success: boolean; certId?: string; toEmail?: string; ownerName?: string | null; error?: string;
  }> {
    const [transfer] = await db.select()
      .from(transferVerifications)
      .where(and(
        eq(transferVerifications.id, transferId),
        eq(transferVerifications.flowVersion, "v2"),
      ));

    if (!transfer) return { success: false, error: "Transfer not found." };
    if (["completed", "cancelled", "expired"].includes(transfer.status)) {
      return { success: false, error: `Transfer is already ${transfer.status}.` };
    }
    if (!opts?.skipStatusCheck && transfer.status !== "pending_dispute") {
      return { success: false, error: "Transfer is not in dispute window." };
    }
    if (transfer.finalisedAt) return { success: false, error: "Already finalised." };

    const cert = await this.getCertificateByCertId(transfer.certId);
    if (!cert) return { success: false, error: "Certificate not found." };

    // Create or find incoming keeper user
    let incomingUser = await this.getUserByEmail(transfer.toEmail);
    if (!incomingUser) {
      incomingUser = await this.createUser({ email: transfer.toEmail });
    }

    // Generate new ownership token
    const ownershipToken = await this._generateOwnershipToken();

    // ── DRN rotation on transfer completion ──────────────────────────────────
    // Ensures previous owner's Owner Copy PDF no longer displays a DRN that
    // matches the live cert record. Retry on 32^12 collision (essentially
    // never-fires but handled defensively — mirrors backfill retry pattern).
    const oldReferenceNumber = (cert as any).referenceNumber ?? null;
    const currentLogbookVersion = (cert as any).logbookVersion ?? 1;
    const { generateReferenceNumber } = await import("./reference-number");
    let newReferenceNumber: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = generateReferenceNumber();
      const existing = await db.select({ id: certificates.id })
        .from(certificates)
        .where(eq(certificates.referenceNumber, candidate))
        .limit(1);
      if (existing.length === 0) {
        newReferenceNumber = candidate;
        break;
      }
    }
    if (!newReferenceNumber) {
      return { success: false, error: "Failed to generate unique reference number after 3 attempts — please try again." };
    }

    // Transfer ownership on the certificate (rotate DRN + bump logbook version)
    await db.execute(sql`
      UPDATE certificates
      SET current_owner_user_id = ${incomingUser.id},
          ownership_status = 'claimed',
          ownership_token = ${ownershipToken},
          ownership_token_generated_at = NOW(),
          owner_name = ${transfer.newOwnerName ?? null},
          owner_email = ${transfer.toEmail},
          reference_number = ${newReferenceNumber},
          logbook_version = logbook_version + 1,
          logbook_last_issued_at = NOW(),
          updated_at = NOW()
      WHERE certificate_number = ${transfer.certId}
    `);

    // Audit log — DRN rotation event paired with transfer completion
    await db.insert(auditLog).values({
      entityType: "certificate",
      entityId: transfer.certId,
      action: "drn_rotated_on_transfer",
      adminUser: null,
      details: {
        transferId,
        previousDrn: oldReferenceNumber,
        newDrn: newReferenceNumber,
        logbookVersionBefore: currentLogbookVersion,
        logbookVersionAfter: currentLogbookVersion + 1,
      },
    });

    // Record in ownership history
    await db.insert(ownershipHistory).values({
      certId: transfer.certId,
      fromUserId: transfer.outgoingKeeperUserId || cert.currentOwnerUserId || null,
      toUserId: incomingUser.id,
      toEmail: transfer.toEmail,
      eventType: "transfer_completed",
      notes: `v2 transfer — ref number verified, dispute window passed. From ${transfer.fromEmail}`,
    });

    // Mark transfer as completed
    await db.update(transferVerifications)
      .set({
        status: "completed",
        finalisedAt: new Date(),
        usedAt: new Date(),
        incomingKeeperUserId: incomingUser.id,
      })
      .where(eq(transferVerifications.id, transferId));

    return {
      success: true,
      certId: transfer.certId,
      toEmail: transfer.toEmail,
      ownerName: transfer.newOwnerName ?? null,
    };
  }

  async getTransfersReadyToFinalise(): Promise<TransferVerification[]> {
    return db.select()
      .from(transferVerifications)
      .where(and(
        eq(transferVerifications.flowVersion, "v2"),
        eq(transferVerifications.status, "pending_dispute"),
        isNotNull(transferVerifications.disputeDeadline),
        sql`${transferVerifications.disputeDeadline} <= NOW()`,
      ));
  }

  async expireStaleTransfersV2(): Promise<Array<{
    transferId: number; certId: string; fromEmail: string; toEmail: string; reason: string;
  }>> {
    // Expire pending_owner transfers where ownerExpiresAt has passed (24h seller-init)
    const expiredOwner = await db.execute(sql`
      UPDATE transfer_verifications
      SET transfer_status = 'expired', cancelled_at = NOW(), cancellation_reason = 'Outgoing keeper did not confirm within 24 hours'
      WHERE flow_version = 'v2'
        AND transfer_status = 'pending_owner'
        AND owner_expires_at < NOW()
      RETURNING id, cert_id, from_email, to_email
    `);

    // Expire pending_incoming transfers where incoming_confirm_deadline has passed (14d seller-init)
    const expiredIncoming = await db.execute(sql`
      UPDATE transfer_verifications
      SET transfer_status = 'expired', cancelled_at = NOW(), cancellation_reason = 'Incoming keeper did not confirm within 14 days'
      WHERE flow_version = 'v2'
        AND transfer_status = 'pending_incoming'
        AND incoming_confirm_deadline < NOW()
      RETURNING id, cert_id, from_email, to_email
    `);

    // v435 — Expire pending_owner_invited_by_buyer (buyer-init) where the
    // owner's 14-day deadline has passed. SILENCE = REJECTION here. We do
    // NOT auto-complete buyer-init transfers when the owner ignores the
    // email — the owner must explicitly confirm to transfer.
    const expiredBuyerInit = await db.execute(sql`
      UPDATE transfer_verifications
      SET transfer_status = 'expired', cancelled_at = NOW(), cancellation_reason = 'Current keeper did not respond to buyer-initiated transfer within 14 days; original ownership preserved'
      WHERE flow_version = 'v2'
        AND transfer_status = 'pending_owner_invited_by_buyer'
        AND owner_expires_at < NOW()
      RETURNING id, cert_id, from_email, to_email
    `);

    const collected: Array<{
      transferId: number; certId: string; fromEmail: string; toEmail: string; reason: string;
    }> = [];
    const map = (rows: any[], reason: string) => {
      for (const r of rows) {
        collected.push({
          transferId: r.id,
          certId: r.cert_id,
          fromEmail: r.from_email,
          toEmail: r.to_email,
          reason,
        });
      }
    };
    map(expiredOwner.rows as any[], "Outgoing keeper did not confirm within 24 hours.");
    map(expiredIncoming.rows as any[], "Incoming keeper did not verify the Document Reference Number within 14 days.");
    map(expiredBuyerInit.rows as any[], "The current keeper did not respond to a buyer-initiated transfer within 14 days. Original ownership has been preserved.");

    // Reset cert ownership status for any expired transfers
    for (const row of collected) {
      await db.execute(sql`
        UPDATE certificates
        SET ownership_status = 'claimed', updated_at = NOW()
        WHERE certificate_number = ${row.certId}
          AND ownership_status = 'transfer_pending'
      `);
    }

    return collected;
  }

  // ── v435 buyer-initiated transfer entry point ─────────────────────────────
  // The new claimant has the printed claim insert and types cert ID + claim
  // code into /transfer/claim-by-code. This validates the code (constant-time
  // hash compare on claim_code_hash) and pivots into a new state machine
  // branch that requires the current owner's explicit confirmation.

  /**
   * Validates a claim code against `claim_code_hash` for a cert that is
   * already CLAIMED (i.e. transfer scenario). Returns the current owner's
   * email + user ID on success so the caller can route them into the
   * buyer-init flow. Differs from `validateClaimCode` (which only accepts
   * unclaimed certs) — this is for the transfer path only.
   *
   * Constant-time comparison via SHA-256 hash equality at the DB layer
   * (the hash comparison is internal to the Postgres engine, not the
   * Node process — same pattern as v420's `validateClaimCode`).
   */
  async validateClaimCodeForTransfer(
    certId: string,
    claimCode: string,
  ): Promise<{ valid: boolean; currentOwnerEmail?: string; currentOwnerUserId?: string }> {
    const hash = this._hashClaimCode(claimCode);
    const result = await db.execute(sql`
      SELECT c.current_owner_user_id, c.owner_email, u.email as user_email
      FROM certificates c
      LEFT JOIN users u ON u.id = c.current_owner_user_id
      WHERE c.certificate_number = ${certId}
        AND c.claim_code_hash = ${hash}
        AND c.ownership_status = 'claimed'
        AND c.deleted_at IS NULL
        AND c.status = 'active'
      LIMIT 1
    `);
    if (result.rows.length === 0) return { valid: false };
    const row = result.rows[0] as any;
    const ownerEmail = (row.user_email || row.owner_email || "").toLowerCase().trim();
    return {
      valid: true,
      currentOwnerEmail: ownerEmail,
      currentOwnerUserId: row.current_owner_user_id,
    };
  }

  async createTransferV2BuyerInit(data: {
    certId: string; claimantEmail: string; claimantName?: string;
    currentOwnerEmail: string; currentOwnerUserId: string;
  }): Promise<{ ownerToken: string; transferId: number }> {
    const ownerToken = crypto.randomBytes(32).toString("hex");
    const ownerTokenHash = crypto.createHash("sha256").update(ownerToken).digest("hex");
    // Owner has 14 days to confirm or dispute before the transfer expires.
    const ownerExpiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    const inserted = await db.insert(transferVerifications).values({
      certId: data.certId,
      // For buyer-init, fromEmail = current owner (the keeper losing the cert),
      // toEmail = new claimant (the buyer who used the claim code).
      fromEmail: data.currentOwnerEmail.toLowerCase().trim(),
      toEmail: data.claimantEmail.toLowerCase().trim(),
      ownerTokenHash,
      ownerExpiresAt,
      newOwnerName: data.claimantName?.trim() || null,
      flowVersion: "v2",
      status: "pending_owner_invited_by_buyer",
      outgoingKeeperUserId: data.currentOwnerUserId,
      // Mark that the buyer (incoming keeper) initiated this with the claim
      // code, so admin reviewers can see at a glance which path was used.
      referenceNumberProvided: "BUYER_INIT_VIA_CLAIM_CODE",
    }).returning({ id: transferVerifications.id });

    // Mark cert as transfer_pending — atomically guarded against any other
    // active transfer on the same cert. The select-then-insert sequence
    // upstream is wrapped by the caller, which checks `getTransferV2ByCertId`
    // before calling us.
    await db.execute(sql`
      UPDATE certificates
      SET ownership_status = 'transfer_pending', updated_at = NOW()
      WHERE certificate_number = ${data.certId}
    `);

    return { ownerToken, transferId: inserted[0].id };
  }

  /**
   * Owner clicks the CONFIRM link in the buyer-init notification. This
   * pivots the transfer into the standard `pending_dispute` state and
   * starts the 14-day dispute window — both parties can then dispute
   * before the existing sweep auto-finalises.
   */
  async confirmBuyerInitTransfer(token: string): Promise<{
    success: boolean; transferId?: number; certId?: string; claimantEmail?: string; ownerEmail?: string; disputeDeadline?: Date; error?: string;
  }> {
    const ownerTokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const [verification] = await db.select()
      .from(transferVerifications)
      .where(and(
        eq(transferVerifications.ownerTokenHash, ownerTokenHash),
        eq(transferVerifications.flowVersion, "v2"),
      ));

    if (!verification) return { success: false, error: "Invalid confirmation link." };
    if (verification.status !== "pending_owner_invited_by_buyer") {
      return { success: false, error: `This transfer is no longer in the owner-response stage (status: ${verification.status}).` };
    }
    if (new Date() > verification.ownerExpiresAt) {
      return { success: false, error: "This confirmation link has expired (14-day deadline passed)." };
    }
    if (verification.usedAt) return { success: false, error: "This transfer has already been completed." };
    if (verification.cancelledAt) return { success: false, error: "This transfer has been cancelled." };

    // Pre-create the incoming keeper user so finaliseTransferV2 can assign
    // ownership cleanly when the dispute window expires.
    let incomingUser = await this.getUserByEmail(verification.toEmail);
    if (!incomingUser) {
      incomingUser = await this.createUser({ email: verification.toEmail });
    }

    // 14-day dispute window starts now.
    const disputeDeadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    await db.update(transferVerifications)
      .set({
        status: "pending_dispute",
        ownerConfirmedAt: new Date(),
        disputeDeadline,
        incomingKeeperUserId: incomingUser.id,
      })
      .where(eq(transferVerifications.id, verification.id));

    return {
      success: true,
      transferId: verification.id,
      certId: verification.certId,
      claimantEmail: verification.toEmail,
      ownerEmail: verification.fromEmail,
      disputeDeadline,
    };
  }

  /**
   * Owner clicks the DISPUTE link in the buyer-init notification. The
   * transfer is rejected immediately and cert ownership returns to
   * 'claimed' (original keeper unchanged).
   */
  async disputeBuyerInitTransfer(token: string, reason?: string): Promise<{
    success: boolean; transferId?: number; certId?: string; claimantEmail?: string; ownerEmail?: string; error?: string;
  }> {
    const ownerTokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const [verification] = await db.select()
      .from(transferVerifications)
      .where(and(
        eq(transferVerifications.ownerTokenHash, ownerTokenHash),
        eq(transferVerifications.flowVersion, "v2"),
      ));

    if (!verification) return { success: false, error: "Invalid dispute link." };
    if (verification.status !== "pending_owner_invited_by_buyer") {
      return { success: false, error: `This transfer is no longer in the owner-response stage (status: ${verification.status}).` };
    }
    if (new Date() > verification.ownerExpiresAt) {
      return { success: false, error: "This dispute link has expired (14-day deadline passed)." };
    }
    if (verification.usedAt) return { success: false, error: "This transfer has already been completed." };
    if (verification.cancelledAt) return { success: false, error: "This transfer has been cancelled." };

    await db.update(transferVerifications)
      .set({
        status: "disputed",
        disputedAt: new Date(),
        disputedBy: "outgoing",
        disputeReason: (reason || "Disputed by current keeper via buyer-init notification email").trim().slice(0, 2000),
      })
      .where(eq(transferVerifications.id, verification.id));

    // Reset cert ownership status — original keeper retains the cert.
    await db.execute(sql`
      UPDATE certificates
      SET ownership_status = 'claimed', updated_at = NOW()
      WHERE certificate_number = ${verification.certId}
    `);

    return {
      success: true,
      transferId: verification.id,
      certId: verification.certId,
      claimantEmail: verification.toEmail,
      ownerEmail: verification.fromEmail,
    };
  }
}

export const storage = new DatabaseStorage();

/**
 * Deduct AI credits from a user's balance. Returns { ok: true, remaining } if successful,
 * or { ok: false, reason: 'insufficient' | 'no_user' } if the deduction failed.
 * Uses a conditional UPDATE so deductions are atomic and can't go negative.
 */
export async function deductAiCredits(
  userId: string,
  amount: number,
  reason: string
): Promise<{ ok: true; remaining: number } | { ok: false; reason: 'insufficient' | 'no_user' }> {
  if (amount <= 0) throw new Error('deductAiCredits: amount must be positive');

  const result = await db.execute(sql`
    UPDATE users
       SET ai_credits_user_balance = ai_credits_user_balance - ${amount},
           updated_at = NOW()
     WHERE id = ${userId}
       AND ai_credits_user_balance >= ${amount}
    RETURNING ai_credits_user_balance
  `);

  if (result.rows.length === 0) {
    // Either user doesn't exist OR they didn't have enough credits. Check which.
    const check = await db.execute(sql`
      SELECT ai_credits_user_balance FROM users WHERE id = ${userId} LIMIT 1
    `);
    if (check.rows.length === 0) return { ok: false, reason: 'no_user' };
    return { ok: false, reason: 'insufficient' };
  }

  // Audit trail
  await db.insert(auditLog).values({
    entityType: 'user',
    entityId: userId,
    action: 'ai_credits.deducted',
    adminUser: null,
    details: { amount, reason },
  });

  return { ok: true, remaining: Number((result.rows[0] as any).ai_credits_user_balance) };
}
