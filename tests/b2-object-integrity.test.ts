import { beforeEach, describe, expect, it, vi } from "vitest";

const s3Send = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...actual,
    S3Client: class {
      send = s3Send;
    },
  };
});

import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, PutObjectRetentionCommand } from "@aws-sdk/client-s3";
import { extendB2ComplianceRetention, inspectB2ObjectIntegrity, uploadToB2 } from "../server/b2";

describe("B2 stored-object integrity", () => {
  beforeEach(() => {
    s3Send.mockReset();
    process.env.B2_ENDPOINT = "https://b2.invalid.test";
    process.env.B2_KEY_ID = "test-key-id";
    process.env.B2_APPLICATION_KEY = "test-application-key";
    process.env.B2_BUCKET = "test-archive";
  });

  it("hashes the bytes returned by B2 rather than trusting object existence or metadata", async () => {
    const body = Buffer.from("historical-object-without-sha-metadata");
    s3Send.mockImplementation(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        return {
          ContentLength: body.length,
          ContentType: "image/tiff",
          Metadata: { sha256: "not-trusted" },
          VersionId: "version-a",
          ObjectLockMode: "COMPLIANCE",
          ObjectLockRetainUntilDate: new Date("2099-01-01"),
        };
      }
      if (command instanceof GetObjectCommand) {
        return {
          Body: (async function* () {
            yield body.subarray(0, 7);
            yield body.subarray(7);
          })(),
          ContentType: "image/tiff",
        };
      }
      throw new Error("unexpected command");
    });

    await expect(inspectB2ObjectIntegrity("evidence/masters/7/front/hash.tif")).resolves.toMatchObject({
      exists: true,
      byteLength: body.length,
      sha256: "0d82a88a036a09f43160e58a840fd2c46d6636432af93ec1fda25e89108401cd",
      objectLockMode: "COMPLIANCE",
      versionId: "version-a",
    });
    const get = s3Send.mock.calls.find(([command]) => command instanceof GetObjectCommand)?.[0];
    expect((get as GetObjectCommand).input.VersionId).toBe("version-a");
  });

  it("returns missing only for a genuine not-found response", async () => {
    s3Send.mockRejectedValueOnce(Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } }));

    await expect(inspectB2ObjectIntegrity("missing.tif")).resolves.toEqual({ exists: false });
    expect(s3Send).toHaveBeenCalledTimes(1);
  });

  it("fails closed when HEAD size and streamed GET bytes disagree", async () => {
    s3Send.mockResolvedValueOnce({ ContentLength: 100, VersionId: "version-truncated" }).mockResolvedValueOnce({
      Body: (async function* () {
        yield Buffer.from("short");
      })(),
    });

    await expect(inspectB2ObjectIntegrity("truncated.tif")).rejects.toThrow("changed or was truncated while reading");
  });

  it("pins GET to the exact immutable version selected by HEAD during a current-version race", async () => {
    const verified = Buffer.from("version-a-bytes");
    s3Send.mockImplementation(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        return { ContentLength: verified.length, VersionId: "version-a" };
      }
      if (command instanceof GetObjectCommand) {
        expect(command.input.VersionId).toBe("version-a");
        return {
          Body: (async function* () {
            yield verified;
          })(),
        };
      }
      throw new Error("unexpected command");
    });

    await expect(inspectB2ObjectIntegrity("archive/revisioned-object.tif")).resolves.toMatchObject({
      exists: true,
      versionId: "version-a",
    });
  });

  it("uploads with Compliance retention and source integrity metadata", async () => {
    const body = Buffer.from("new-archive-body");
    s3Send.mockResolvedValueOnce({});

    await uploadToB2("evidence/masters/7/front/hash.tif", body, "image/tiff", 90);

    const command = s3Send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect((command as PutObjectCommand).input).toMatchObject({
      Bucket: "test-archive",
      Key: "evidence/masters/7/front/hash.tif",
      Body: body,
      ContentType: "image/tiff",
      ObjectLockMode: "COMPLIANCE",
      Metadata: {
        sha256: "eb3ea66d99fba63568213b56f213714e0d04b91c16acdd3f64fc0acaca2b8b07",
        byte_length: String(body.length),
      },
    });
    expect((command as PutObjectCommand).input.ObjectLockRetainUntilDate?.getTime()).toBeGreaterThan(Date.now());
  });

  it("extends an existing object's Compliance retention with the S3 retention authority", async () => {
    const retainUntil = new Date(Date.now() + 90 * 86_400_000);
    s3Send.mockResolvedValueOnce({});

    await extendB2ComplianceRetention("evidence/masters/7/front/hash.tif", retainUntil);

    const command = s3Send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutObjectRetentionCommand);
    expect((command as PutObjectRetentionCommand).input).toEqual({
      Bucket: "test-archive",
      Key: "evidence/masters/7/front/hash.tif",
      Retention: {
        Mode: "COMPLIANCE",
        RetainUntilDate: retainUntil,
      },
    });
  });
});
