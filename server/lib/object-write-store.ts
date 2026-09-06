import { inspectB2ObjectIntegrity, uploadCreateOnlyToB2 } from "../b2";
import { deleteFromR2, inspectR2ObjectIntegrity, uploadCreateOnlyToR2 } from "../r2";
import type { ObjectInspection, ObjectStorePort } from "./object-write-coordinator";

const OBJECT_STORE_OPERATION_TIMEOUT_MS = 30_000;

function providerSignal(): AbortSignal {
  return AbortSignal.timeout(OBJECT_STORE_OPERATION_TIMEOUT_MS);
}

export const objectWriteStore: ObjectStorePort = {
  async inspect(store, objectKey): Promise<ObjectInspection> {
    return store === "R2"
      ? inspectR2ObjectIntegrity(objectKey, providerSignal())
      : inspectB2ObjectIntegrity(objectKey, providerSignal());
  },

  async putCreateOnly(input): Promise<void> {
    if (input.store === "R2") {
      await uploadCreateOnlyToR2(input.objectKey, input.body, input.contentType, input.sha256, providerSignal());
      return;
    }
    if (!input.minimumRetainUntil || input.minimumRetainUntil.getTime() <= Date.now()) {
      throw new Error("B2 create-only writes require a future absolute Compliance retention deadline");
    }
    await uploadCreateOnlyToB2(
      input.objectKey,
      input.body,
      input.contentType,
      input.minimumRetainUntil,
      providerSignal()
    );
  },

  deleteR2(objectKey): Promise<void> {
    return deleteFromR2(objectKey);
  },
};
