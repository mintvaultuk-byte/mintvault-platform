import crypto, { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./db";

export const CUSTOMER_NOTIFICATION_KINDS = [
  "ACCOUNT_VERIFY",
  "ACCOUNT_MAGIC_LINK",
  "PASSWORD_RESET",
  "PASSWORD_CHANGED",
  "EMAIL_CHANGED",
  "ACCOUNT_DELETED",
  "CUSTOMER_MAGIC_LINK",
  "PIN_RESET",
  "STOLEN_VERIFY",
  "CLAIM_VERIFY",
  "CERTIFICATE_PDF",
  "TRANSFER_OWNER_CONFIRM",
  "TRANSFER_INCOMING_CONFIRM",
  "TRANSFER_DISPUTE_WINDOW",
  "TRANSFER_BUYER_INVITE",
  "TRANSFER_BUYER_CONFIRMED",
  "TRANSFER_BUYER_REJECTED",
  "TRANSFER_COMPLETED",
  "TRANSFER_CANCELLED",
  "TRANSFER_DISPUTED",
  "TRANSFER_EXPIRED",
] as const;

export type CustomerNotificationKind = (typeof CUSTOMER_NOTIFICATION_KINDS)[number];

export interface CustomerNotificationSpec {
  eventKey: string;
  kind: CustomerNotificationKind;
  aggregateType: string;
  aggregateId: string;
  recipient: string;
  payload: Record<string, unknown>;
  expiresAt?: Date | null;
  templateVersion?: number;
}

export type CustomerNotificationExecutor = Pick<typeof db, "execute" | "transaction">;
type CustomerNotificationTx = Pick<typeof db, "execute">;
type CustomerNotificationSender = (
  kind: CustomerNotificationKind,
  envelope: { recipient: string; payload: Record<string, unknown> },
  options: { idempotencyKey: string; templateVersion: number }
) => Promise<{ id: string }>;

const CLAIM_LEASE_SECONDS = 5 * 60;
const MAX_ATTEMPTS = 12;
const PROVIDER_SAFE_RETRY_SECONDS = 23 * 60 * 60;
const DEFAULT_KEY_VERSION = 1;

function currentEncryptionKeyVersion(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CUSTOMER_NOTIFICATION_ENC_KEY_VERSION?.trim();
  if (!raw) return DEFAULT_KEY_VERSION;
  const version = Number(raw);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("CUSTOMER_NOTIFICATION_ENC_KEY_VERSION must be a positive integer");
  }
  return version;
}

function encryptionKey(version: number, env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = (
    env[`CUSTOMER_NOTIFICATION_ENC_KEY_V${version}`] ??
    (version === DEFAULT_KEY_VERSION ? env.CUSTOMER_NOTIFICATION_ENC_KEY : undefined)
  )?.trim();
  if (!raw) throw new Error(`customer notification encryption key version ${version} is not configured`);
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32)
    throw new Error(`customer notification encryption key version ${version} must decode to exactly 32 bytes`);
  return key;
}

function aad(eventKey: string, kind: CustomerNotificationKind, templateVersion: number): Buffer {
  return Buffer.from(`customer-notification|${eventKey}|${kind}|${templateVersion}`, "utf8");
}

export function encryptCustomerNotificationEnvelope(
  eventKey: string,
  kind: CustomerNotificationKind,
  templateVersion: number,
  envelope: { recipient: string; payload: Record<string, unknown> },
  env: NodeJS.ProcessEnv = process.env,
  keyVersion: number = currentEncryptionKeyVersion(env)
): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(keyVersion, env), iv);
  cipher.setAAD(aad(eventKey, kind, templateVersion));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(envelope), "utf8"), cipher.final()]);
  return `v${keyVersion}.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptCustomerNotificationEnvelope(
  eventKey: string,
  kind: CustomerNotificationKind,
  templateVersion: number,
  encrypted: string,
  env: NodeJS.ProcessEnv = process.env,
  keyVersion: number = currentEncryptionKeyVersion(env)
): { recipient: string; payload: Record<string, unknown> } {
  const [version, ivRaw, tagRaw, ciphertextRaw, extra] = encrypted.split(".");
  if (version !== `v${keyVersion}` || !ivRaw || !tagRaw || !ciphertextRaw || extra) {
    throw new Error("customer notification ciphertext format is invalid");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(keyVersion, env),
    Buffer.from(ivRaw, "base64url")
  );
  decipher.setAAD(aad(eventKey, kind, templateVersion));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  const decoded = Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, "base64url")), decipher.final()]).toString(
    "utf8"
  );
  const parsed = JSON.parse(decoded) as { recipient?: unknown; payload?: unknown };
  if (
    typeof parsed.recipient !== "string" ||
    !parsed.recipient.trim() ||
    !parsed.payload ||
    typeof parsed.payload !== "object" ||
    Array.isArray(parsed.payload)
  ) {
    throw new Error("customer notification encrypted envelope is invalid");
  }
  return { recipient: parsed.recipient, payload: parsed.payload as Record<string, unknown> };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function payloadFingerprint(
  spec: CustomerNotificationSpec,
  templateVersion: number,
  keyVersion: number,
  env: NodeJS.ProcessEnv = process.env
): string {
  const identity = stableJson({
    recipient: spec.recipient.trim().toLowerCase(),
    payload: spec.payload,
    kind: spec.kind,
    aggregateType: spec.aggregateType,
    aggregateId: spec.aggregateId,
    templateVersion,
  });
  return `v${keyVersion}:${crypto.createHmac("sha256", encryptionKey(keyVersion, env)).update(identity).digest("hex")}`;
}

function validateSpec(spec: CustomerNotificationSpec): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9:._/-]{2,199}$/.test(spec.eventKey) || spec.eventKey.includes("@")) {
    throw new Error("customer notification event key is invalid or contains recipient data");
  }
  if (!CUSTOMER_NOTIFICATION_KINDS.includes(spec.kind)) throw new Error("unsupported customer notification kind");
  if (!spec.aggregateType.trim() || !spec.aggregateId.trim() || !spec.recipient.trim()) {
    throw new Error("customer notification aggregate and recipient are required");
  }
}

/** Insert with the caller's transaction so a state/token mutation can never commit without its delivery authority. */
export async function enqueueCustomerNotification(
  tx: CustomerNotificationTx,
  spec: CustomerNotificationSpec
): Promise<number> {
  validateSpec(spec);
  const templateVersion = spec.templateVersion ?? 1;
  const keyVersion = currentEncryptionKeyVersion();
  const encrypted = encryptCustomerNotificationEnvelope(
    spec.eventKey,
    spec.kind,
    templateVersion,
    {
      recipient: spec.recipient.trim().toLowerCase(),
      payload: spec.payload,
    },
    process.env,
    keyVersion
  );
  const fingerprint = payloadFingerprint(spec, templateVersion, keyVersion);
  const providerKey = `customer-notification:${spec.eventKey}:v${templateVersion}`;
  const result = await tx.execute(sql`
    INSERT INTO public.customer_notification_outbox (
      event_key, kind, aggregate_type, aggregate_id, template_version,
      encrypted_payload, encryption_key_version, payload_fingerprint, provider_idempotency_key, expires_at
    ) VALUES (
      ${spec.eventKey}, ${spec.kind}, ${spec.aggregateType}, ${spec.aggregateId}, ${templateVersion},
      ${encrypted}, ${keyVersion}, ${fingerprint}, ${providerKey}, ${spec.expiresAt ?? null}
    )
    ON CONFLICT (event_key) DO NOTHING
    RETURNING id
  `);
  if (result.rows.length === 1) return Number((result.rows[0] as { id: number }).id);
  const existing = await tx.execute(sql`
    SELECT id FROM public.customer_notification_outbox
     WHERE event_key=${spec.eventKey} AND kind=${spec.kind}
       AND aggregate_type=${spec.aggregateType} AND aggregate_id=${spec.aggregateId}
       AND template_version=${templateVersion} AND encryption_key_version=${keyVersion}
       AND payload_fingerprint=${fingerprint} AND provider_idempotency_key=${providerKey}
  `);
  if (existing.rows.length !== 1) throw new Error("customer notification event key conflicts with another event");
  return Number((existing.rows[0] as { id: number }).id);
}

interface ClaimedNotification {
  id: number;
  event_key: string;
  kind: CustomerNotificationKind;
  template_version: number;
  encrypted_payload: string;
  encryption_key_version: number;
  provider_idempotency_key: string;
  claim_token: string;
  attempt_count: number;
  expires_at: Date | string | null;
}

async function defaultSender(
  kind: CustomerNotificationKind,
  envelope: { recipient: string; payload: Record<string, unknown> },
  options: { idempotencyKey: string; templateVersion: number }
): Promise<{ id: string }> {
  const { sendCustomerNotificationEmail } = await import("./email");
  return sendCustomerNotificationEmail(kind, envelope, options);
}

async function normalizeTerminalRows(runner: CustomerNotificationExecutor): Promise<void> {
  await runner.execute(sql`
    UPDATE public.customer_notification_outbox
       SET status='EXPIRED', claim_token=NULL, claim_expires_at=NULL, next_attempt_at=NULL,
           last_error='notification capability expired before confirmed delivery', updated_at=NOW()
     WHERE status IN ('PENDING','FAILED') AND expires_at IS NOT NULL AND expires_at <= NOW()
  `);
  await runner.execute(sql`
    UPDATE public.customer_notification_outbox
       SET status='RECONCILIATION_REQUIRED', claim_token=NULL, claim_expires_at=NULL, next_attempt_at=NULL,
           last_error='provider delivery remained uncertain beyond idempotent retry window', updated_at=NOW()
     WHERE status IN ('PROCESSING','FAILED')
       AND uncertain_delivery_at <= NOW() - (${PROVIDER_SAFE_RETRY_SECONDS} * INTERVAL '1 second')
  `);
  await runner.execute(sql`
    UPDATE public.customer_notification_outbox
       SET status='RECONCILIATION_REQUIRED', claim_token=NULL, claim_expires_at=NULL, next_attempt_at=NULL,
           last_error=COALESCE(last_error,'notification retry limit exhausted'), updated_at=NOW()
     WHERE status IN ('PENDING','FAILED','PROCESSING') AND attempt_count >= ${MAX_ATTEMPTS}
       AND (status <> 'PROCESSING' OR claim_expires_at <= NOW())
  `);
}

async function claimOne(
  runner: CustomerNotificationExecutor,
  onlyEventKey?: string
): Promise<ClaimedNotification | null> {
  const claimToken = randomUUID();
  const claimed = await runner.execute(sql`
    WITH due AS (
      SELECT id FROM public.customer_notification_outbox
       WHERE attempt_count < ${MAX_ATTEMPTS}
         AND (expires_at IS NULL OR expires_at > NOW())
         ${onlyEventKey ? sql`AND event_key=${onlyEventKey}` : sql``}
         AND (
           (status IN ('PENDING','FAILED') AND next_attempt_at <= NOW())
           OR (status='PROCESSING' AND claim_expires_at <= NOW())
         )
       ORDER BY next_attempt_at, id
       LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    UPDATE public.customer_notification_outbox n
       SET status='PROCESSING', attempt_count=attempt_count+1,
           claim_token=${claimToken}, claim_expires_at=NOW() + (${CLAIM_LEASE_SECONDS} * INTERVAL '1 second'),
           next_attempt_at=NOW() + (${CLAIM_LEASE_SECONDS} * INTERVAL '1 second'),
           uncertain_delivery_at=COALESCE(uncertain_delivery_at,NOW()), last_error=NULL, updated_at=NOW()
      FROM due WHERE n.id=due.id
    RETURNING n.id,n.event_key,n.kind,n.template_version,n.encrypted_payload,n.encryption_key_version,
              n.provider_idempotency_key,n.claim_token,n.attempt_count,n.expires_at
  `);
  return (claimed.rows[0] as unknown as ClaimedNotification | undefined) ?? null;
}

const RETRY_DELAYS_SECONDS = [60, 120, 300, 900, 2 * 60 * 60] as const;

function retryAtBeforeExpiry(claim: ClaimedNotification, nowMs = Date.now()): Date {
  const backoffSeconds = RETRY_DELAYS_SECONDS[Math.min(claim.attempt_count - 1, RETRY_DELAYS_SECONDS.length - 1)];
  let retryMs = nowMs + backoffSeconds * 1000;
  if (claim.expires_at) {
    const expiresMs = new Date(claim.expires_at).getTime();
    if (Number.isFinite(expiresMs)) {
      const remainingMs = Math.max(0, expiresMs - nowMs);
      // A capability notification must receive another attempt while the
      // capability is still useful. Half of the remaining lifetime preserves
      // a real delivery window even for short-lived links and clock skew.
      retryMs = Math.min(retryMs, nowMs + Math.max(1_000, Math.floor(remainingMs / 2)));
    }
  }
  return new Date(retryMs);
}

async function processClaim(
  claim: ClaimedNotification,
  runner: CustomerNotificationExecutor,
  sender: CustomerNotificationSender
): Promise<"SENT" | "FAILED" | "RECONCILIATION_REQUIRED"> {
  let envelope: { recipient: string; payload: Record<string, unknown> };
  try {
    envelope = decryptCustomerNotificationEnvelope(
      claim.event_key,
      claim.kind,
      claim.template_version,
      claim.encrypted_payload,
      process.env,
      claim.encryption_key_version
    );
  } catch {
    await runner.execute(sql`
      UPDATE public.customer_notification_outbox
         SET status='RECONCILIATION_REQUIRED', claim_token=NULL, claim_expires_at=NULL,
             next_attempt_at=NULL, last_error='encrypted notification payload cannot be decrypted', updated_at=NOW()
       WHERE id=${claim.id} AND claim_token=${claim.claim_token} AND status='PROCESSING'
    `);
    return "RECONCILIATION_REQUIRED";
  }

  try {
    const receipt = await sender(claim.kind, envelope, {
      idempotencyKey: claim.provider_idempotency_key,
      templateVersion: claim.template_version,
    });
    if (!receipt?.id) throw new Error("notification provider returned no receipt");
    await runner.execute(sql`
      UPDATE public.customer_notification_outbox
         SET status='SENT', delivered_at=NOW(), provider_message_id=${receipt.id},
             claim_token=NULL, claim_expires_at=NULL, next_attempt_at=NULL,
             uncertain_delivery_at=NULL, last_error=NULL, updated_at=NOW()
       WHERE id=${claim.id} AND claim_token=${claim.claim_token} AND status='PROCESSING'
    `);
    return "SENT";
  } catch {
    const terminal = claim.attempt_count >= MAX_ATTEMPTS;
    const nextAttemptAt = terminal ? null : retryAtBeforeExpiry(claim);
    await runner.execute(sql`
      UPDATE public.customer_notification_outbox
         SET status=${terminal ? "RECONCILIATION_REQUIRED" : "FAILED"},
             claim_token=NULL, claim_expires_at=NULL,
             next_attempt_at=${nextAttemptAt},
             last_error='notification provider delivery failed or is uncertain', updated_at=NOW()
       WHERE id=${claim.id} AND claim_token=${claim.claim_token} AND status='PROCESSING'
    `);
    return terminal ? "RECONCILIATION_REQUIRED" : "FAILED";
  }
}

export async function dispatchCustomerNotificationByEventKey(
  eventKey: string,
  options: { exec?: CustomerNotificationExecutor; send?: CustomerNotificationSender } = {}
): Promise<"NOT_DUE" | "SENT" | "FAILED" | "RECONCILIATION_REQUIRED"> {
  const runner = options.exec ?? db;
  await normalizeTerminalRows(runner);
  const claim = await claimOne(runner, eventKey);
  if (!claim) return "NOT_DUE";
  return processClaim(claim, runner, options.send ?? defaultSender);
}

export async function processCustomerNotificationBatch(
  options: { limit?: number; exec?: CustomerNotificationExecutor; send?: CustomerNotificationSender } = {}
): Promise<{ examined: number; sent: number; failed: number; reconciliationRequired: number }> {
  const runner = options.exec ?? db;
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
  await normalizeTerminalRows(runner);
  let examined = 0;
  let sent = 0;
  let failed = 0;
  for (; examined < limit; examined += 1) {
    const claim = await claimOne(runner);
    if (!claim) break;
    const result = await processClaim(claim, runner, options.send ?? defaultSender);
    if (result === "SENT") sent += 1;
    else if (result === "FAILED") failed += 1;
  }
  const backlog = await runner.execute(sql`
    SELECT COUNT(*)::int AS count FROM public.customer_notification_outbox
     WHERE status='RECONCILIATION_REQUIRED'
  `);
  return {
    examined,
    sent,
    failed,
    reconciliationRequired: Number((backlog.rows[0] as { count?: number } | undefined)?.count ?? 0),
  };
}
