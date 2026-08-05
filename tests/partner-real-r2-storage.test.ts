/**
 * Real S3-compatible storage proof for the Partner pilot.
 *
 * This suite is intentionally opt-in because it performs real network I/O against a local
 * S3-compatible service such as MinIO. When PARTNER_REAL_R2_PROOF=1 is set, missing storage is a
 * hard failure, not a skip.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

const enabled = process.env.PARTNER_REAL_R2_PROOF === "1";
const endpoint = process.env.R2_ENDPOINT ?? "http://127.0.0.1:9010";
const bucket = process.env.R2_BUCKET_NAME ?? "partner-real-r2-proof";
const accessKeyId = process.env.R2_ACCESS_KEY_ID ?? "minioadmin";
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? "minioadmin";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);
const tinyJpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Amf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EFBABAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
  "base64"
);

function proofClient() {
  return new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

async function resetBucket(client: S3Client) {
  const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket })).catch(() => null);
  const objects = (listed?.Contents ?? []).map((object) => ({ Key: object.Key })).filter((object) => object.Key);
  if (objects.length) {
    await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
  }
  await client.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => {});
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
}

(enabled ? describe : describe.skip)("Partner real R2/S3-compatible storage proof", () => {
  beforeAll(async () => {
    process.env.R2_ENDPOINT = endpoint;
    process.env.R2_BUCKET_NAME = bucket;
    process.env.R2_ACCESS_KEY_ID = accessKeyId;
    process.env.R2_SECRET_ACCESS_KEY = secretAccessKey;
    process.env.R2_FORCE_PATH_STYLE = "1";
    await resetBucket(proofClient());
  }, 30_000);

  it("uploads, HEADs, signs, reads and deletes exact partner image bytes", async () => {
    const r2 = await import("../server/r2");
    const tenantId = "aaaaaaaa-r200-0000-0000-000000000001";
    const submissionId = "30000000-r200-0000-0000-000000000001";
    const cardId = "50000000-r200-0000-0000-000000000001";
    const frontKey = `partner-submissions/${tenantId}/${submissionId}/${cardId}/front-proof.png`;
    const backKey = `partner-submissions/${tenantId}/${submissionId}/${cardId}/back-proof.jpg`;

    await expect(r2.uploadToR2(frontKey, tinyPng, "image/png")).resolves.toBe(frontKey);
    await expect(r2.uploadToR2(backKey, tinyJpeg, "image/jpeg")).resolves.toBe(backKey);

    await expect(r2.headR2(frontKey)).resolves.toEqual(
      expect.objectContaining({
        lastModified: expect.any(Date),
        contentLength: tinyPng.length,
        contentType: "image/png",
        eTag: expect.any(String),
      })
    );
    await expect(r2.headR2(backKey)).resolves.toEqual(
      expect.objectContaining({
        lastModified: expect.any(Date),
        contentLength: tinyJpeg.length,
        contentType: "image/jpeg",
        eTag: expect.any(String),
      })
    );

    await expect(r2.getR2Buffer(frontKey)).resolves.toEqual(tinyPng);
    await expect(r2.getR2Buffer(backKey)).resolves.toEqual(tinyJpeg);

    const frontSigned = await r2.getR2SignedUrl(frontKey, 60);
    const backSigned = await r2.getR2SignedUrl(backKey, 60);
    const [frontFetched, backFetched] = await Promise.all([
      fetch(frontSigned).then((res) => res.arrayBuffer()),
      fetch(backSigned).then((res) => res.arrayBuffer()),
    ]);
    expect(Buffer.from(frontFetched)).toEqual(tinyPng);
    expect(Buffer.from(backFetched)).toEqual(tinyJpeg);

    await expect(r2.headR2(`${frontKey}.missing`)).resolves.toBeNull();
    await expect(r2.getR2Buffer(`${frontKey}.missing`)).resolves.toBeNull();

    await r2.deleteFromR2(frontKey);
    await expect(r2.headR2(frontKey)).resolves.toBeNull();
    await expect(r2.getR2Buffer(frontKey)).resolves.toBeNull();
    await expect(r2.headR2(backKey)).resolves.toEqual(
      expect.objectContaining({
        lastModified: expect.any(Date),
        contentLength: tinyJpeg.length,
        contentType: "image/jpeg",
      })
    );
  }, 30_000);
});
