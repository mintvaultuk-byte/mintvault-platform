import { describe, expect, it, vi } from "vitest";
import {
  createGoogleOAuthProof,
  decryptGoogleSecret,
  encryptGoogleSecret,
  googleBusinessConfigReadiness,
  googleOAuthAuthorizationUrl,
  type GoogleBusinessConfig,
} from "../server/partner/google-presence-crypto";
import {
  exchangeGoogleAuthorizationCode,
  GoogleBusinessProviderError,
  listGoogleBusinessCandidates,
} from "../server/partner/google-business-client";
import { redactDetails } from "../server/partner/audit";

const config: GoogleBusinessConfig = {
  clientId: "client-id.apps.googleusercontent.com",
  clientSecret: "synthetic-client-secret",
  redirectUri: "https://mintvaultuk.com/api/partner/google-business/callback",
  encryptionKey: Buffer.alloc(32, 7),
  keyVersion: 1,
};

describe("Google Partner presence cryptographic boundary", () => {
  it("requires a complete independent HTTPS configuration", () => {
    expect(googleBusinessConfigReadiness({})).toEqual({ ready: false, reason: "not_configured" });
    expect(googleBusinessConfigReadiness({
      GOOGLE_BUSINESS_CLIENT_ID: config.clientId,
      GOOGLE_BUSINESS_CLIENT_SECRET: config.clientSecret,
      GOOGLE_BUSINESS_OAUTH_REDIRECT_URI: "http://mintvaultuk.com/callback",
      GOOGLE_BUSINESS_OAUTH_ENC_KEY: config.encryptionKey.toString("base64"),
    })).toEqual({ ready: false, reason: "not_configured" });
    expect(googleBusinessConfigReadiness({
      GOOGLE_BUSINESS_CLIENT_ID: config.clientId,
      GOOGLE_BUSINESS_CLIENT_SECRET: config.clientSecret,
      GOOGLE_BUSINESS_OAUTH_REDIRECT_URI: config.redirectUri,
      GOOGLE_BUSINESS_OAUTH_ENC_KEY: config.encryptionKey.toString("base64"),
    }).ready).toBe(true);
  });

  it("uses authenticated encryption bound to the exact tenant/location record", () => {
    const cipher = encryptGoogleSecret("refresh-token", config, "google-refresh:tenant-a:location-a:connection-a");
    expect(cipher).not.toContain("refresh-token");
    expect(decryptGoogleSecret(cipher, config, "google-refresh:tenant-a:location-a:connection-a")).toBe("refresh-token");
    expect(() => decryptGoogleSecret(cipher, config, "google-refresh:tenant-b:location-a:connection-a")).toThrow();
    const tampered = cipher.split(".");
    tampered[3] = `${tampered[3].startsWith("A") ? "B" : "A"}${tampered[3].slice(1)}`;
    expect(() => decryptGoogleSecret(tampered.join("."), config, "google-refresh:tenant-a:location-a:connection-a")).toThrow();
  });

  it("generates high-entropy one-time state and S256 PKCE without placing a verifier in the URL", () => {
    const proof = createGoogleOAuthProof();
    const url = new URL(googleOAuthAuthorizationUrl(config, proof));
    expect(proof.state).not.toBe(createGoogleOAuthProof().state);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("state")).toBe(proof.state);
    expect(url.searchParams.get("code_challenge")).toBe(proof.challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_verifier")).toBeNull();
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });
});

describe("Google provider DTO and logging boundary", () => {
  it("exchanges only at fixed Google origins and projects an allowlisted listing candidate", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      if (value === "https://oauth2.googleapis.com/token") {
        const body = String(init?.body);
        expect(body).toContain("code=synthetic-code");
        expect(body).toContain("code_verifier=synthetic-verifier");
        return new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (value.startsWith("https://mybusinessaccountmanagement.googleapis.com/v1/accounts")) {
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer access");
        return new Response(JSON.stringify({ accounts: [{ name: "accounts/123", accountName: "Private field" }] }), { status: 200 });
      }
      if (value.startsWith("https://mybusinessbusinessinformation.googleapis.com/v1/accounts/123/locations")) {
        return new Response(JSON.stringify({ locations: [{
          name: "locations/456",
          title: "Canterbury Cards",
          storefrontAddress: { addressLines: ["1 High Street"], locality: "Canterbury", postalCode: "CT1 1AA", regionCode: "GB" },
          metadata: { placeId: "ChIJ_12345", mapsUri: "https://maps.google.com/?cid=123", duplicateLocation: { name: "private" } },
          profile: { description: "not requested" },
        }] }), { status: 200 });
      }
      throw new Error(`unexpected origin: ${value}`);
    }) as typeof fetch;

    const token = await exchangeGoogleAuthorizationCode({ config, code: "synthetic-code", verifier: "synthetic-verifier", fetchImpl });
    expect(token).toEqual({ accessToken: "access", refreshToken: "refresh", expiresIn: 3600 });
    const candidates = await listGoogleBusinessCandidates({ accessToken: token.accessToken, fetchImpl });
    expect(candidates).toEqual([{
      accountName: "accounts/123",
      locationName: "locations/456",
      placeId: "ChIJ_12345",
      mapsUri: "https://maps.google.com/?cid=123",
      businessName: "Canterbury Cards",
      businessAddress: "1 High Street, Canterbury, CT1 1AA, GB",
    }]);
  });

  it("converts provider bodies and outages to fixed codes, never raw payload text", async () => {
    const fetchImpl = vi.fn(async () => new Response("secret provider diagnostic", { status: 500 })) as typeof fetch;
    await expect(exchangeGoogleAuthorizationCode({ config, code: "x", verifier: "y", fetchImpl }))
      .rejects.toEqual(expect.objectContaining({ code: "provider_unavailable" }));
    await exchangeGoogleAuthorizationCode({ config, code: "x", verifier: "y", fetchImpl }).catch((err) => {
      expect(err).toBeInstanceOf(GoogleBusinessProviderError);
      expect(String(err)).not.toContain("secret provider diagnostic");
    });
  });

  it("redacts OAuth material recursively, including values nested in arrays", () => {
    expect(redactDetails({
      authorization: "Bearer x",
      nested: [{ codeVerifier: "verifier", clientAssertion: "assertion", safe: "visible" }],
      refresh_token: "refresh",
    })).toEqual({
      authorization: "[REDACTED]",
      nested: [{ codeVerifier: "[REDACTED]", clientAssertion: "[REDACTED]", safe: "visible" }],
      refresh_token: "[REDACTED]",
    });
  });
});
