import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import {
  StationIdentityError,
  assertStationRequestBodyDigest,
  canonicalStationRequest,
  canonicalStationRequestV2,
  createStationCode,
  parseStationRequestHeaders,
  parseStationRequestHeadersV2,
  stationPublicKeyFingerprint,
  verifyStationSignature,
  verifyStationSignatureV2,
} from "../server/partner/station-identity";
import { appVersionSatisfies, signedHeartbeatAppVersion } from "../server/partner/station-service";

describe("partner station cryptographic identity", () => {
  const keyPair = crypto.generateKeyPairSync("ed25519");
  const publicKey = keyPair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const stationCode = "MV-STN-ABCDEFGHIJKLMNOP";

  function signedHeaders(overrides: Record<string, string> = {}) {
    const envelope = {
      stationCode,
      method: "POST",
      path: "/api/partner/stations/heartbeat",
      timestamp: 1_700_000_000_000,
      nonce: 42n,
      contentSha256: "a".repeat(64),
    };
    const signature = crypto
      .sign(null, Buffer.from(canonicalStationRequest(envelope)), keyPair.privateKey)
      .toString("base64url");
    return {
      "x-mintvault-station-id": stationCode,
      "x-mintvault-station-timestamp": String(envelope.timestamp),
      "x-mintvault-station-nonce": String(envelope.nonce),
      "x-mintvault-content-sha256": envelope.contentSha256,
      "x-mintvault-station-signature": signature,
      ...overrides,
    };
  }

  it("uses a canonical signed request that rejects path/body/nonce tampering", () => {
    const headers = signedHeaders();
    const parsed = parseStationRequestHeaders(headers, "POST", "/api/partner/stations/heartbeat", 1_700_000_000_000);
    expect(verifyStationSignature(publicKey, parsed.envelope, parsed.signature)).toBe(true);
    expect(
      verifyStationSignature(
        publicKey,
        { ...parsed.envelope, path: "/api/partner/stations/calibrations" },
        parsed.signature
      )
    ).toBe(false);
    expect(
      verifyStationSignature(publicKey, { ...parsed.envelope, contentSha256: "b".repeat(64) }, parsed.signature)
    ).toBe(false);
    expect(verifyStationSignature(publicKey, { ...parsed.envelope, nonce: 43n }, parsed.signature)).toBe(false);
  });

  it("rejects JSON bytes that differ from the station-signed body digest", () => {
    const expected = Buffer.from('{"scannerConnected":true}');
    const digest = crypto.createHash("sha256").update(expected).digest("hex");
    const parsed = parseStationRequestHeaders(
      signedHeaders({ "x-mintvault-content-sha256": digest }),
      "POST",
      "/api/partner/stations/heartbeat",
      1_700_000_000_000
    );
    expect(() => assertStationRequestBodyDigest(parsed.envelope, expected)).not.toThrow();
    expect(() => assertStationRequestBodyDigest(parsed.envelope, Buffer.from('{"scannerConnected":false}'))).toThrow(
      StationIdentityError
    );
  });

  it("binds protocol v2 credential/request epochs, sequence and semantic operation", () => {
    const semanticOperationId = "2d5a018e-137f-4d6a-92be-ff09a0b02462";
    const envelope = {
      stationCode,
      credentialEpoch: 1n,
      requestEpoch: 3n,
      sequence: 91n,
      method: "POST",
      path: "/api/partner/stations/calibrations",
      timestamp: 1_700_000_000_000,
      contentSha256: "b".repeat(64),
      semanticOperationId,
    };
    const signature = crypto.sign(null, Buffer.from(canonicalStationRequestV2(envelope)), keyPair.privateKey)
      .toString("base64url");
    const parsed = parseStationRequestHeadersV2({
      "x-mintvault-station-protocol": "2",
      "x-mintvault-station-id": stationCode,
      "x-mintvault-station-credential-epoch": "1",
      "x-mintvault-station-request-epoch": "3",
      "x-mintvault-station-sequence": "91",
      "x-mintvault-station-timestamp": String(envelope.timestamp),
      "x-mintvault-content-sha256": envelope.contentSha256,
      "x-mintvault-semantic-operation-id": semanticOperationId,
      "x-mintvault-station-signature": signature,
    }, envelope.method, envelope.path, envelope.timestamp);
    expect(verifyStationSignatureV2(publicKey, parsed.envelope, parsed.signature)).toBe(true);
    expect(verifyStationSignatureV2(publicKey, { ...parsed.envelope, sequence: 92n }, parsed.signature)).toBe(false);
    expect(verifyStationSignatureV2(publicKey, {
      ...parsed.envelope,
      semanticOperationId: "77d411c6-f4dc-4aa6-b057-4628a5d0bf46",
    }, parsed.signature)).toBe(false);
  });

  it("rejects stale timestamps and malformed station headers before DB access", () => {
    expect(() =>
      parseStationRequestHeaders(signedHeaders(), "POST", "/api/partner/stations/heartbeat", 1_700_000_200_001)
    ).toThrow(StationIdentityError);
    expect(() =>
      parseStationRequestHeaders(
        signedHeaders({ "x-mintvault-station-nonce": "0" }),
        "POST",
        "/api/partner/stations/heartbeat",
        1_700_000_000_000
      )
    ).toThrow(/nonce/i);
    expect(() =>
      parseStationRequestHeaders(
        signedHeaders({ "x-mintvault-station-id": "macbook" }),
        "POST",
        "/api/partner/stations/heartbeat",
        1_700_000_000_000
      )
    ).toThrow(/identity/i);
  });

  it("normalises the public key fingerprint and allocates non-client station codes", () => {
    expect(stationPublicKeyFingerprint(publicKey)).toMatch(/^[a-f0-9]{64}$/);
    expect(createStationCode(() => Buffer.alloc(10, 0))).toBe("MV-STN-AAAAAAAAAAAAAAAA");
  });

  it("fails closed when app-version enforcement cannot parse a version", () => {
    expect(appVersionSatisfies("1.2.1", "1.2.0")).toBe(true);
    expect(appVersionSatisfies("1.2.1", "1.2.2")).toBe(false);
    expect(appVersionSatisfies("scanner-vNext", "1.2.1")).toBe(false);
    expect(appVersionSatisfies(null, "1.2.1")).toBe(false);
  });

  it("accepts an upgrade attestation only from the exact signed heartbeat body", () => {
    const body = Buffer.from(JSON.stringify({ appVersion: "1.2.1", scannerConnected: true }));
    expect(signedHeartbeatAppVersion("POST", "/api/partner/stations/heartbeat", body)).toBe("1.2.1");
    expect(signedHeartbeatAppVersion("POST", "/api/partner/stations/calibrations", body)).toBeNull();
    expect(signedHeartbeatAppVersion("GET", "/api/partner/stations/heartbeat", body)).toBeNull();
    expect(
      signedHeartbeatAppVersion("POST", "/api/partner/stations/heartbeat", Buffer.from('{"appVersion":"next"}'))
    ).toBeNull();
  });
});
