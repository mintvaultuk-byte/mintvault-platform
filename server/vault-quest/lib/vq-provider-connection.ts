import { inArray } from "drizzle-orm";
import { vqConfig } from "@shared/vq-config-schema";
import { isUndefinedTableOrColumn } from "../production-storage";
import { higgsfieldConnection } from "../ai/higgsfield";

export type VqProviderConnectionStatus =
  | "connected"
  | "token_expiring"
  | "token_expired"
  | "not_configured"
  | "disconnected"
  | "unknown"
  | "checking";

export type VqProviderWarningLevel = "none" | "under_24h" | "under_1h" | "expired" | "unavailable";

export interface VqProviderConnectionSnapshot {
  id: "higgsfield";
  label: "Higgsfield Provider";
  status: VqProviderConnectionStatus;
  generationAllowed: boolean;
  connectionMode: "higgsfield_oauth_legacy";
  providerPath: "higgsfield_oauth_legacy";
  providerPathLabel: "Higgsfield OAuth / Legacy";
  remoteVerified: boolean;
  tokenExpiryAt: string | null;
  warningLevel: VqProviderWarningLevel;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastAuthFailureAt: string | null;
  message: string;
  reconnectRequired: boolean;
}

const KEY_LAST_CHECKED = "provider.higgsfield.last_checked_at";
const KEY_LAST_SUCCESS = "provider.higgsfield.last_success_at";
const KEY_LAST_AUTH_FAILURE = "provider.higgsfield.last_auth_failure_at";
const KEY_LAST_STATUS = "provider.higgsfield.last_status";
const KEY_LAST_MESSAGE = "provider.higgsfield.last_message";

const PROVIDER_KEYS = [KEY_LAST_CHECKED, KEY_LAST_SUCCESS, KEY_LAST_AUTH_FAILURE, KEY_LAST_STATUS, KEY_LAST_MESSAGE] as const;

type ProviderRows = Partial<Record<(typeof PROVIDER_KEYS)[number], string>>;

function safeIso(value: string | undefined | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function parseTokenExpiry(): { iso: string | null; malformed: boolean } {
  const raw = env("HIGGSFIELD_TOKEN_EXPIRES_AT") || env("HIGGSFIELD_API_KEY_EXPIRES_AT");
  if (!raw) return { iso: null, malformed: false };
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return { iso: null, malformed: true };
  return { iso: d.toISOString(), malformed: false };
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUndefinedTableOrColumn(err)) return fallback;
    throw err;
  }
}

async function readProviderRows(): Promise<ProviderRows> {
  return safe(async () => {
    const { db } = await import("../../db");
    const rows = await db
      .select({ key: vqConfig.key, value: vqConfig.value })
      .from(vqConfig)
      .where(inArray(vqConfig.key, [...PROVIDER_KEYS]));
    return Object.fromEntries(rows.map((r) => [r.key, r.value])) as ProviderRows;
  }, {});
}

async function writeProviderRows(values: Record<string, string>, updatedBy: string): Promise<void> {
  try {
    const { db } = await import("../../db");
    for (const [key, value] of Object.entries(values)) {
      await db
        .insert(vqConfig)
        .values({
          key,
          value,
          description: "Vault Quest Higgsfield provider connection state (no secrets)",
          updatedBy,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: vqConfig.key,
          set: {
            value,
            description: "Vault Quest Higgsfield provider connection state (no secrets)",
            updatedBy,
            updatedAt: new Date(),
          },
        });
    }
  } catch (err) {
    if (!isUndefinedTableOrColumn(err)) {
      console.warn("[vault-quest] provider status persistence failed; continuing fail-closed where applicable");
    }
  }
}

export async function markHiggsfieldProviderSuccess(nowMs = Date.now(), updatedBy = "provider-call"): Promise<void> {
  const now = new Date(nowMs).toISOString();
  await writeProviderRows({
    [KEY_LAST_SUCCESS]: now,
    [KEY_LAST_CHECKED]: now,
    [KEY_LAST_STATUS]: "connected",
    [KEY_LAST_MESSAGE]: "Provider connection is healthy.",
  }, updatedBy);
}

export async function markHiggsfieldProviderAuthFailure(nowMs = Date.now(), updatedBy = "provider-call"): Promise<void> {
  const now = new Date(nowMs).toISOString();
  await writeProviderRows({
    [KEY_LAST_AUTH_FAILURE]: now,
    [KEY_LAST_CHECKED]: now,
    [KEY_LAST_STATUS]: "token_expired",
    [KEY_LAST_MESSAGE]: "Token expired. Refresh the server-side provider token.",
  }, updatedBy);
}

export async function markHiggsfieldProviderDisconnected(message = "Provider status could not be confirmed.", nowMs = Date.now(), updatedBy = "provider-call"): Promise<void> {
  const now = new Date(nowMs).toISOString();
  await writeProviderRows({
    [KEY_LAST_CHECKED]: now,
    [KEY_LAST_STATUS]: "disconnected",
    [KEY_LAST_MESSAGE]: message,
  }, updatedBy);
}

export async function refreshHiggsfieldProviderConnectionLocal(updatedBy = "admin", nowMs = Date.now()): Promise<VqProviderConnectionSnapshot> {
  const conn = higgsfieldConnection();
  const expiry = parseTokenExpiry();
  const expiryMs = expiry.iso ? Date.parse(expiry.iso) : null;
  const canClearAuthLock = conn.connected && (expiryMs == null || expiryMs > nowMs);
  await writeProviderRows({
    [KEY_LAST_CHECKED]: new Date(nowMs).toISOString(),
    ...(canClearAuthLock ? { [KEY_LAST_STATUS]: "connected" } : {}),
    [KEY_LAST_MESSAGE]: "Credentials are configured, but a free remote connection test is not available.",
  }, updatedBy);
  return getHiggsfieldProviderConnection(nowMs);
}

export async function getHiggsfieldProviderConnection(nowMs = Date.now()): Promise<VqProviderConnectionSnapshot> {
  const conn = higgsfieldConnection();
  const rows = await readProviderRows();
  const expiry = parseTokenExpiry();
  const tokenExpiryAt = expiry.iso;
  const lastCheckedAt = safeIso(rows[KEY_LAST_CHECKED]);
  const lastSuccessAt = safeIso(rows[KEY_LAST_SUCCESS]);
  const lastAuthFailureAt = safeIso(rows[KEY_LAST_AUTH_FAILURE]);
  const lastStatus = rows[KEY_LAST_STATUS];
  const lastAuthMs = lastAuthFailureAt ? Date.parse(lastAuthFailureAt) : 0;
  const lastSuccessMs = lastSuccessAt ? Date.parse(lastSuccessAt) : 0;
  const authFailureIsCurrent = lastStatus === "token_expired" && lastAuthMs > 0 && lastAuthMs >= lastSuccessMs;
  const expiryMs = tokenExpiryAt ? Date.parse(tokenExpiryAt) : null;
  const msUntilExpiry = expiryMs == null ? null : expiryMs - nowMs;

  let status: VqProviderConnectionStatus;
  let warningLevel: VqProviderWarningLevel = "none";
  let message: string;

  if (authFailureIsCurrent || lastStatus === "token_expired") {
    status = "token_expired";
    warningLevel = "expired";
    message = "Token expired. Refresh the server-side provider token.";
  } else if (!conn.connected) {
    status = "not_configured";
    warningLevel = "unavailable";
    message = "Provider is not configured.";
  } else if (lastStatus === "disconnected") {
    status = "disconnected";
    warningLevel = "unavailable";
    message = "Provider status could not be confirmed.";
  } else if (expiryMs != null && msUntilExpiry != null && msUntilExpiry <= 0) {
    status = "token_expired";
    warningLevel = "expired";
    message = "Token expired. Refresh the server-side provider token.";
  } else if (expiryMs != null && msUntilExpiry != null && msUntilExpiry <= 60 * 60 * 1000) {
    status = "token_expiring";
    warningLevel = "under_1h";
    message = "Token expires soon. Refresh it before generation stops.";
  } else if (expiryMs != null && msUntilExpiry != null && msUntilExpiry <= 24 * 60 * 60 * 1000) {
    status = "token_expiring";
    warningLevel = "under_24h";
    message = "Token expires soon. Refresh it before generation stops.";
  } else {
    status = "connected";
    message = expiry.malformed || !tokenExpiryAt
      ? "Credentials are configured, but token expiry is not available."
      : "Provider connection is healthy.";
  }

  const remoteVerified = status !== "not_configured" && !!lastSuccessAt && !authFailureIsCurrent;
  const generationAllowed = status === "connected" || status === "token_expiring";
  if (generationAllowed && !remoteVerified && rows[KEY_LAST_MESSAGE]) {
    message = rows[KEY_LAST_MESSAGE] ?? message;
  }

  return {
    id: "higgsfield",
    label: "Higgsfield Provider",
    status,
    generationAllowed,
    connectionMode: "higgsfield_oauth_legacy",
    providerPath: "higgsfield_oauth_legacy",
    providerPathLabel: "Higgsfield OAuth / Legacy",
    remoteVerified,
    tokenExpiryAt,
    warningLevel,
    lastCheckedAt,
    lastSuccessAt,
    lastAuthFailureAt,
    message,
    reconnectRequired: !generationAllowed,
  };
}
