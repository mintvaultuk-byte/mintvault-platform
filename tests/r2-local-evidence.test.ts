import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deleteFromR2, getR2Buffer, listR2Keys, uploadImmutableEvidenceToR2, uploadToR2 } from "../server/r2";

const previousLocalEvidenceDir = process.env.MINTVAULT_LOCAL_EVIDENCE_DIR;
const previousNodeEnv = process.env.NODE_ENV;
let localEvidenceDir = "";

beforeEach(async () => {
  localEvidenceDir = await mkdtemp(path.join(os.tmpdir(), "mintvault-local-evidence-"));
  process.env.NODE_ENV = "development";
  process.env.MINTVAULT_LOCAL_EVIDENCE_DIR = localEvidenceDir;
});

afterEach(async () => {
  if (previousLocalEvidenceDir === undefined) delete process.env.MINTVAULT_LOCAL_EVIDENCE_DIR;
  else process.env.MINTVAULT_LOCAL_EVIDENCE_DIR = previousLocalEvidenceDir;
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  await rm(localEvidenceDir, { recursive: true, force: true });
});

describe("development-local evidence adapter", () => {
  it("keeps a TIFF master immutable while supporting derivative reads without R2", async () => {
    const masterKey = "evidence/masters/99/front/abc.tif";
    const master = Buffer.from("canonical-tiff-master");
    const metadata = { sha256: "abc", evidenceclass: "NEW_IMMUTABLE_MASTER" };

    await expect(uploadImmutableEvidenceToR2(masterKey, master, metadata)).resolves.toBe(masterKey);
    await expect(uploadImmutableEvidenceToR2(masterKey, master, metadata)).resolves.toBe(masterKey);
    await expect(uploadImmutableEvidenceToR2(masterKey, Buffer.from("different"), metadata)).rejects.toThrow(
      "Refusing to overwrite immutable local evidence"
    );
    await expect(getR2Buffer(masterKey)).resolves.toEqual(master);

    const derivativeKey = "images/grading/99/front_display.jpg";
    await uploadToR2(derivativeKey, Buffer.from("preview-derivative"), "image/jpeg");
    await expect(getR2Buffer(derivativeKey)).resolves.toEqual(Buffer.from("preview-derivative"));
    await expect(listR2Keys("evidence/masters/99/")).resolves.toEqual([masterKey]);

    await deleteFromR2(masterKey);
    await expect(getR2Buffer(masterKey)).resolves.toBeNull();
  });
});
