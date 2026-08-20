import type { GoogleBusinessConfig } from "./google-presence-crypto";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ACCOUNTS_ENDPOINT = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts";
const LOCATIONS_ORIGIN = "https://mybusinessbusinessinformation.googleapis.com/v1/";
const REQUEST_TIMEOUT_MS = 12_000;

export class GoogleBusinessProviderError extends Error {
  constructor(public readonly code: "oauth_rejected" | "provider_unavailable" | "provider_response_invalid") {
    super(code);
  }
}

export interface GoogleTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
}

export interface GoogleBusinessCandidate {
  accountName: string;
  locationName: string;
  placeId: string | null;
  mapsUri: string | null;
  businessName: string;
  businessAddress: string | null;
}

type FetchLike = typeof fetch;

async function providerJson(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<Record<string, any>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new GoogleBusinessProviderError(response.status === 400 || response.status === 401
        ? "oauth_rejected"
        : "provider_unavailable");
    }
    const data = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new GoogleBusinessProviderError("provider_response_invalid");
    }
    return data as Record<string, any>;
  } catch (err) {
    if (err instanceof GoogleBusinessProviderError) throw err;
    throw new GoogleBusinessProviderError("provider_unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

function tokenSet(data: Record<string, any>, requireRefresh: boolean): GoogleTokenSet {
  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : null;
  if (!accessToken || (requireRefresh && !refreshToken)) {
    throw new GoogleBusinessProviderError("provider_response_invalid");
  }
  return {
    accessToken,
    refreshToken,
    expiresIn: Number.isFinite(Number(data.expires_in)) ? Number(data.expires_in) : null,
  };
}

export async function exchangeGoogleAuthorizationCode(input: {
  config: GoogleBusinessConfig;
  code: string;
  verifier: string;
  fetchImpl?: FetchLike;
}): Promise<GoogleTokenSet> {
  const data = await providerJson(input.fetchImpl ?? fetch, TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      redirect_uri: input.config.redirectUri,
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.verifier,
    }),
  });
  return tokenSet(data, true);
}

export async function refreshGoogleAccessToken(input: {
  config: GoogleBusinessConfig;
  refreshToken: string;
  fetchImpl?: FetchLike;
}): Promise<GoogleTokenSet> {
  const data = await providerJson(input.fetchImpl ?? fetch, TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    }),
  });
  return tokenSet(data, false);
}

function formattedAddress(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const address = value as Record<string, unknown>;
  const lines = Array.isArray(address.addressLines) ? address.addressLines.filter((v): v is string => typeof v === "string") : [];
  const parts = [...lines, address.locality, address.administrativeArea, address.postalCode, address.regionCode]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
  return parts.length ? parts.join(", ").slice(0, 500) : null;
}

function candidateOf(accountName: string, value: unknown): GoogleBusinessCandidate | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, any>;
  if (typeof row.name !== "string" || typeof row.title !== "string" || !row.name || !row.title) return null;
  return {
    accountName,
    locationName: row.name.slice(0, 500),
    placeId: typeof row.metadata?.placeId === "string" ? row.metadata.placeId.slice(0, 255) : null,
    mapsUri: typeof row.metadata?.mapsUri === "string" ? row.metadata.mapsUri.slice(0, 2048) : null,
    businessName: row.title.trim().slice(0, 160),
    businessAddress: formattedAddress(row.storefrontAddress),
  };
}

export async function listGoogleBusinessCandidates(input: {
  accessToken: string;
  fetchImpl?: FetchLike;
}): Promise<GoogleBusinessCandidate[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = { authorization: `Bearer ${input.accessToken}` };
  const accounts = await providerJson(fetchImpl, `${ACCOUNTS_ENDPOINT}?pageSize=20`, { headers });
  const accountRows = Array.isArray(accounts.accounts) ? accounts.accounts.slice(0, 20) : [];
  const candidates: GoogleBusinessCandidate[] = [];
  for (const account of accountRows) {
    const accountName = typeof account?.name === "string" ? account.name : "";
    if (!/^accounts\/[^/]+$/.test(accountName)) continue;
    const query = new URLSearchParams({
      readMask: "name,title,storefrontAddress,metadata",
      pageSize: "100",
    });
    const locations = await providerJson(fetchImpl, `${LOCATIONS_ORIGIN}${accountName}/locations?${query}`, { headers });
    for (const row of Array.isArray(locations.locations) ? locations.locations.slice(0, 100) : []) {
      const candidate = candidateOf(accountName, row);
      if (candidate) candidates.push(candidate);
      if (candidates.length >= 100) return candidates;
    }
  }
  return candidates;
}

export async function getGoogleBusinessLocation(input: {
  accessToken: string;
  locationName: string;
  fetchImpl?: FetchLike;
}): Promise<GoogleBusinessCandidate> {
  if (!/^locations\/[^/]+$/.test(input.locationName)) throw new GoogleBusinessProviderError("provider_response_invalid");
  const query = new URLSearchParams({ readMask: "name,title,storefrontAddress,metadata" });
  const row = await providerJson(input.fetchImpl ?? fetch, `${LOCATIONS_ORIGIN}${input.locationName}?${query}`, {
    headers: { authorization: `Bearer ${input.accessToken}` },
  });
  const candidate = candidateOf("", row);
  if (!candidate) throw new GoogleBusinessProviderError("provider_response_invalid");
  return candidate;
}

export async function revokeGoogleRefreshToken(refreshToken: string, fetchImpl: FetchLike = fetch): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    await fetchImpl(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      signal: controller.signal,
    });
  } catch {
    // Disconnection is local authority. Provider revocation is best effort and must
    // never leave a credential usable in MintVault if Google is unavailable.
  } finally {
    clearTimeout(timeout);
  }
}
