import type {
  ObjectWriteAbandoner,
  ObjectWriteFinalizeContext,
  ObjectWriteFinalizer,
  ObjectWriteTransactionRunner,
} from "./object-write-coordinator";

export const REQUIRED_OBJECT_WRITE_KINDS = [
  "CERTIFICATE_IMAGE_REVISION",
  "CERTIFICATE_DERIVATIVE_SET",
  "CERTIFICATE_CREATE_IMAGES",
  "SCANNER_EVIDENCE_CAPTURE",
  "SUBMISSION_RECEIPT_PHOTOS",
  "PARTNER_CARD_IMAGE",
  "PRINT_ARTIFACT",
] as const;

export type RequiredObjectWriteKind = (typeof REQUIRED_OBJECT_WRITE_KINDS)[number];

export interface RegisteredObjectWriteFinalizer {
  transactionRunner(context: ObjectWriteFinalizeContext): ObjectWriteTransactionRunner;
  finalize: ObjectWriteFinalizer;
  abandon?: ObjectWriteAbandoner;
}

const registry = new Map<string, RegisteredObjectWriteFinalizer>();

export function registerObjectWriteFinalizer(
  operationKind: RequiredObjectWriteKind,
  handler: RegisteredObjectWriteFinalizer
): void {
  if (registry.has(operationKind)) throw new Error(`Object-write finalizer ${operationKind} is already registered`);
  registry.set(operationKind, handler);
}

export function resolveObjectWriteFinalizer(operationKind: string): RegisteredObjectWriteFinalizer | null {
  return registry.get(operationKind) ?? null;
}

export function objectWriteFinalizerRegistryComplete(): boolean {
  return REQUIRED_OBJECT_WRITE_KINDS.every((kind) => registry.has(kind));
}

/** Test-only: production registration is process-lifetime immutable. */
export function __resetObjectWriteFinalizersForTests(): void {
  registry.clear();
}
