import { createSign } from "node:crypto";
import type { GrowthPeriod } from "./commercial-growth-service";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_ROOT = "https://www.googleapis.com/webmasters/v3/sites";
const READ_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const ALLOWED_PROPERTIES = new Set(["sc-domain:mintvaultuk.com", "https://mintvaultuk.com/"]);
const CACHE_MS = 15 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;

type FetchLike = typeof fetch;
type SearchRow = { keys?: unknown[]; clicks?: unknown; impressions?: unknown; ctr?: unknown; position?: unknown };
type SearchResponse = { rows?: SearchRow[] };
type ServiceAccount = { client_email: string; private_key: string };

export type SearchConsoleSnapshot = {
  state: "REAL" | "NOT_CONNECTED" | "ERROR" | "STALE" | "INSUFFICIENT_DATA";
  property: "MINTVAULT_CANONICAL" | null;
  clicks?: number;
  impressions?: number;
  ctrPercent?: number;
  averagePosition?: number;
  clickTrendPercent?: number;
  topQueries?: string[];
  topPages?: string[];
  reason?: string;
  lastUpdated: string | null;
  sourceWindow?: { startDate: string; endDate: string };
};

const snapshots = new Map<
  GrowthPeriod,
  { value: SearchConsoleSnapshot; expiresAt: number; staleUntil: number; authority: string }
>();

function disconnected(reason: string): SearchConsoleSnapshot {
  return { state: "NOT_CONNECTED", property: null, reason, lastUpdated: null };
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function configuration():
  | { state: "READY"; property: string; serviceAccount: ServiceAccount; authority: string }
  | { state: "NOT_CONNECTED" | "ERROR"; reason: string } {
  const property = process.env.SEARCH_CONSOLE_PROPERTY?.trim() ?? "";
  const raw = process.env.SEARCH_CONSOLE_SERVICE_ACCOUNT_JSON?.trim() ?? "";
  if (!property || !raw) {
    return {
      state: "NOT_CONNECTED",
      reason:
        "A verified MintVault Search Console property and dedicated server-side read identity are not configured.",
    };
  }
  if (!ALLOWED_PROPERTIES.has(property)) {
    return { state: "ERROR", reason: "The configured Search Console property is outside the MintVault allowlist." };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceAccount>;
    if (
      typeof parsed.client_email !== "string" ||
      !parsed.client_email.endsWith(".iam.gserviceaccount.com") ||
      typeof parsed.private_key !== "string" ||
      !parsed.private_key.includes("BEGIN PRIVATE KEY")
    ) {
      throw new Error("invalid service identity");
    }
    return {
      state: "READY",
      property,
      serviceAccount: { client_email: parsed.client_email, private_key: parsed.private_key },
      authority: `${property}:${parsed.client_email}`,
    };
  } catch {
    return { state: "ERROR", reason: "The configured Search Console service identity is invalid." };
  }
}

function londonDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function searchConsoleDateWindows(
  period: GrowthPeriod,
  now = new Date()
): { current: { startDate: string; endDate: string }; previous: { startDate: string; endDate: string } | null } {
  const endDate = londonDate(now);
  if (period === "all") {
    return { current: { startDate: shiftDate(endDate, -89), endDate }, previous: null };
  }
  const days = period === "today" ? 1 : period === "7d" ? 7 : period === "30d" ? 30 : 90;
  const startDate = shiftDate(endDate, -(days - 1));
  return {
    current: { startDate, endDate },
    previous: { startDate: shiftDate(startDate, -days), endDate: shiftDate(startDate, -1) },
  };
}

async function accessToken(serviceAccount: ServiceAccount, fetcher: FetchLike, now: number): Promise<string> {
  const issuedAt = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: READ_SCOPE,
      aud: TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3600,
    })
  );
  const unsigned = `${header}.${claim}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(serviceAccount.private_key, "base64url");
  const response = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
    signal: AbortSignal.timeout(7_000),
  });
  if (!response.ok) throw new Error(`token authority returned ${response.status}`);
  const body = (await response.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string" || body.access_token.length < 20) {
    throw new Error("token authority returned an invalid response");
  }
  return body.access_token;
}

async function searchQuery(
  property: string,
  token: string,
  window: { startDate: string; endDate: string },
  fetcher: FetchLike,
  dimensions: Array<"query" | "page"> = []
): Promise<SearchResponse> {
  const response = await fetcher(`${API_ROOT}/${encodeURIComponent(property)}/searchAnalytics/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      ...window,
      dimensions,
      rowLimit: dimensions.length ? 5 : 1,
      dataState: "final",
    }),
    signal: AbortSignal.timeout(7_000),
  });
  if (!response.ok) throw new Error(`Search Console returned ${response.status}`);
  return (await response.json()) as SearchResponse;
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function keys(response: SearchResponse): string[] {
  return (response.rows ?? [])
    .map((row) => row.keys?.[0])
    .filter((value): value is string => typeof value === "string")
    .slice(0, 5);
}

export async function getSearchConsoleSnapshot(
  period: GrowthPeriod,
  options: { fetcher?: FetchLike; now?: Date; force?: boolean } = {}
): Promise<SearchConsoleSnapshot> {
  const config = configuration();
  if (config.state !== "READY") {
    if (config.state === "NOT_CONNECTED") return disconnected(config.reason);
    return { state: "ERROR", property: null, reason: config.reason, lastUpdated: new Date().toISOString() };
  }

  const now = options.now?.getTime() ?? Date.now();
  const cached = snapshots.get(period);
  if (!options.force && cached && cached.authority === config.authority && cached.expiresAt > now) return cached.value;

  const fetcher = options.fetcher ?? fetch;
  const windows = searchConsoleDateWindows(period, new Date(now));
  try {
    const token = await accessToken(config.serviceAccount, fetcher, now);
    const [totals, queries, pages, previous] = await Promise.all([
      searchQuery(config.property, token, windows.current, fetcher),
      searchQuery(config.property, token, windows.current, fetcher, ["query"]),
      searchQuery(config.property, token, windows.current, fetcher, ["page"]),
      windows.previous ? searchQuery(config.property, token, windows.previous, fetcher) : Promise.resolve(null),
    ]);
    const row = totals.rows?.[0];
    const previousClicks = previous?.rows?.[0] ? number(previous.rows[0].clicks) : null;
    const clicks = number(row?.clicks);
    const value: SearchConsoleSnapshot = {
      state: row ? "REAL" : "INSUFFICIENT_DATA",
      property: "MINTVAULT_CANONICAL",
      clicks,
      impressions: number(row?.impressions),
      ctrPercent: Number((number(row?.ctr) * 100).toFixed(2)),
      averagePosition: Number(number(row?.position).toFixed(2)),
      clickTrendPercent:
        previousClicks && previousClicks > 0
          ? Number((((clicks - previousClicks) / previousClicks) * 100).toFixed(1))
          : undefined,
      topQueries: keys(queries),
      topPages: keys(pages),
      reason: row ? undefined : "Search Console returned no final rows for the selected period.",
      lastUpdated: new Date(now).toISOString(),
      sourceWindow: windows.current,
    };
    snapshots.set(period, {
      value,
      expiresAt: now + CACHE_MS,
      staleUntil: now + STALE_MS,
      authority: config.authority,
    });
    return value;
  } catch {
    if (cached && cached.authority === config.authority && cached.staleUntil > now) {
      return {
        ...cached.value,
        state: "STALE",
        reason: "Search Console refresh failed; showing the last valid bounded snapshot.",
      };
    }
    return {
      state: "ERROR",
      property: "MINTVAULT_CANONICAL",
      reason: "Search Console could not be refreshed from the configured read authority.",
      lastUpdated: new Date(now).toISOString(),
    };
  }
}

/** Test-only cache reset; production has no Search Console mutation route. */
export function clearSearchConsoleCache(): void {
  snapshots.clear();
}
