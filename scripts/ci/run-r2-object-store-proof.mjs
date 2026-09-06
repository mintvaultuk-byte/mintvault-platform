#!/usr/bin/env node
/** Direct child of the owned harness. No service creation or cleanup authority. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { MINIO_IMAGE, R2_PROOF_CHECKS } from "./run-disposable-integration.mjs";

export function objectProofEnvironment(env) {
  const runId = env.MINTVAULT_OBJECT_PROOF_RUN_ID;
  const endpoint = new URL(env.R2_ENDPOINT);
  if (
    env.NODE_ENV !== "test" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(runId || "") ||
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !endpoint.port ||
    Number(endpoint.port) < 1 ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash ||
    !/^mvtest-[a-f0-9]{20}$/.test(env.R2_ACCESS_KEY_ID || "") ||
    !/^[a-f0-9]{48}$/.test(env.R2_SECRET_ACCESS_KEY || "") ||
    env.R2_BUCKET_NAME !== `proof-${runId}` ||
    env.MINTVAULT_LOCAL_EVIDENCE_DIR
  )
    throw new Error("object proof requires the harness-owned synthetic test environment");
  return { runId, endpoint: endpoint.origin, bucket: env.R2_BUCKET_NAME };
}

export async function proveObjectStore(reportPath) {
  const identity = objectProofEnvironment(process.env);
  assert.ok(reportPath, "parent-owned report path is required");
  const report = {
    schemaVersion: 1,
    ...identity,
    image: MINIO_IMAGE,
    passed: 0,
    failed: 0,
    skipped: R2_PROOF_CHECKS.length,
    checks: R2_PROOF_CHECKS.map((name) => ({ name, status: "not_run" })),
  };
  // Import only after rejecting missing/remote/local-filesystem configuration.
  const r2 = await import("../../server/r2.ts");
  const hash = (body) => createHash("sha256").update(body).digest("hex");
  const body = Buffer.from("owned-local-object-proof");
  const key = "proof/roundtrip.bin";
  const immutableKey = "evidence/masters/test/master.tif";
  const metadata = { sha256: hash(body), evidenceclass: "NEW_IMMUTABLE_MASTER" };
  const readIntegrity = async (objectKey, expected) => {
    const actual = await r2.inspectR2ObjectIntegrity(objectKey);
    assert.deepEqual(
      { exists: actual.exists, byteLength: actual.byteLength, sha256: actual.sha256 },
      { exists: true, byteLength: expected.length, sha256: hash(expected) }
    );
  };
  const cases = [
    async () => {
      await r2.getR2Client().send(new CreateBucketCommand({ Bucket: identity.bucket }));
      assert.equal(await r2.uploadToR2(key, body, "application/octet-stream"), key);
      assert.deepEqual(await r2.getR2Buffer(key), body);
    },
    async () => readIntegrity(key, body),
    async () => {
      assert.equal((await r2.headR2(key))?.contentLength, body.length);
      assert.deepEqual(await r2.checkR2ObjectReadable(key), { ok: true });
    },
    async () => {
      assert.deepEqual(await r2.listR2Keys("proof/"), [key]);
      const objects = await r2.listR2Objects("proof/");
      assert.equal(objects.length, 1);
      assert.equal(objects[0].sizeBytes, body.length);
    },
    async () => {
      const stream = await r2.getR2ObjectStream(key),
        chunks = [];
      assert.ok(stream);
      for await (const chunk of stream.body) chunks.push(Buffer.from(chunk));
      assert.deepEqual(Buffer.concat(chunks), body);
    },
    async () => {
      const signed = await r2.getR2SignedUrl(key, 60);
      assert.equal(new URL(signed).origin, identity.endpoint);
      assert.ok(new URL(signed).searchParams.get("X-Amz-Signature"));
      const response = await fetch(signed, { signal: AbortSignal.timeout(5000), redirect: "error" });
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
    },
    async () => {
      const target = "proof/create-only.bin",
        changed = Buffer.from("replacement");
      await r2.uploadCreateOnlyToR2(target, body, "application/octet-stream", hash(body));
      await assert.rejects(
        () => r2.uploadCreateOnlyToR2(target, changed, "application/octet-stream", hash(changed)),
        (error) => error?.$metadata?.httpStatusCode === 412
      );
      await readIntegrity(target, body);
    },
    async () => {
      const target = "proof/race.bin",
        bodies = [Buffer.from("first"), Buffer.from("second")];
      const results = await Promise.allSettled(
        bodies.map((bytes) => r2.uploadCreateOnlyToR2(target, bytes, "application/octet-stream", hash(bytes)))
      );
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const winner = results.findIndex((result) => result.status === "fulfilled");
      const loser = results[1 - winner];
      assert.equal(loser.status, "rejected");
      assert.equal(loser.reason?.$metadata?.httpStatusCode, 412);
      await readIntegrity(target, bodies[winner]);
    },
    async () => {
      await r2.uploadImmutableEvidenceToR2(immutableKey, body, metadata);
      assert.equal(await r2.uploadImmutableEvidenceToR2(immutableKey, body, metadata), immutableKey);
      await readIntegrity(immutableKey, body);
    },
    async () => {
      const changed = Buffer.from("x".repeat(body.length));
      await assert.rejects(
        () => r2.uploadImmutableEvidenceToR2(immutableKey, changed, { ...metadata, sha256: hash(changed) }),
        /Refusing to overwrite/
      );
      await readIntegrity(immutableKey, body);
    },
    async () => {
      await r2.deleteFromR2(key);
      assert.equal(await r2.getR2Buffer(key), null);
      assert.deepEqual(await r2.inspectR2ObjectIntegrity(key), { exists: false });
      assert.equal(await r2.headR2(key), null);
    },
  ];
  assert.equal(cases.length, R2_PROOF_CHECKS.length);
  try {
    for (let index = 0; index < cases.length; index += 1) {
      report.skipped -= 1;
      try {
        await cases[index]();
        report.checks[index].status = "passed";
        report.passed += 1;
      } catch {
        // Never serialize SDK requests, credentials, presigned URLs or object bytes.
        report.checks[index].status = "failed";
        report.failed += 1;
        break;
      }
    }
  } finally {
    r2.getR2Client().destroy();
    writeFileSync(reportPath, `${JSON.stringify(report)}\n`, { flag: "wx", mode: 0o600 });
  }
  if (report.failed)
    console.error(`[object-proof] failed check: ${report.checks.find((check) => check.status === "failed").name}`);
  return report.failed || report.skipped ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  proveObjectStore(process.argv[2])
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error("object proof failed before a complete report; no success claimed");
      process.exitCode = 1;
    });
