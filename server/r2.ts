import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let s3Client: S3Client | null = null;

function getClient(): S3Client {
  if (s3Client) return s3Client;
  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("R2 credentials not configured (R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)");
  }
  s3Client = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });
  return s3Client;
}

function getBucket(): string {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) throw new Error("R2_BUCKET_NAME not set");
  return bucket;
}

export async function uploadToR2(key: string, body: Buffer, contentType: string): Promise<string> {
  const client = getClient();
  await client.send(new PutObjectCommand({
    Bucket: getBucket(),
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
  return key;
}

export async function getR2SignedUrl(key: string, expiresInSeconds: number = 600): Promise<string> {
  const client = getClient();
  return getSignedUrl(client, new GetObjectCommand({
    Bucket: getBucket(),
    Key: key,
  }), { expiresIn: expiresInSeconds });
}

export async function deleteFromR2(key: string): Promise<void> {
  const client = getClient();
  await client.send(new DeleteObjectCommand({
    Bucket: getBucket(),
    Key: key,
  }));
}

export function r2KeyForImage(certId: string, side: "front" | "back", ext: string): string {
  return `images/${certId}/${side}.${ext}`;
}

export function r2KeyForLabel(certId: string, side: "front" | "back" | "both", format: "png" | "pdf"): string {
  return `labels/${certId}/${side}.${format}`;
}
