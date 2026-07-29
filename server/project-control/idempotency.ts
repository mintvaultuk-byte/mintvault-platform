/**
 * Project Control — event identity and request idempotency.
 *
 * Two DIFFERENT things are deliberately kept apart here, because conflating them is what the
 * third hostile review found (H3-2):
 *
 *   A. REQUEST IDEMPOTENCY — the same submission retried must create exactly one event.
 *   B. EVENT IDENTITY      — a genuinely new deployment attempt or test run must create a NEW
 *                            event, even when every other fact is identical.
 *
 * The previous implementation derived identity from (environment, commit, releaseVersion,
 * packageKey) alone. Those facts legitimately repeat: redeploying the same commit, rolling back
 * and redeploying it, or re-running the same suite on the same commit are all genuinely separate
 * events. Deriving identity from them silently swallowed real history as "duplicates".
 *
 * So identity now REQUIRES a caller-supplied attempt identity — an external deployment/run id, or
 * an explicit idempotency key. If neither is present the event is REJECTED with a clear
 * validation error rather than being merged into a previous one. Timestamps are never part of
 * identity (that was the second review's finding, and it stays fixed).
 *
 * REMEDIATION of H3-3: fields are no longer concatenated with a `|~|` separator. A field
 * containing the separator could make two different tuples hash identically —
 * `["deployment|~|production", "abc"]` collided with `["deployment", "production", "abc"]`.
 * Encoding is now length-prefixed and domain-separated, so no field content can be mistaken for
 * structure.
 *
 * SERVER-ONLY by design: it uses `node:crypto`, which cannot be bundled for the browser. It has
 * no database import, so it is directly unit-testable without a connection, and it deliberately
 * does NOT live in the shared barrel, because everything there is imported by the client.
 */
import { createHash } from "node:crypto";

/** Shape a caller-supplied key must take. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;

/** Shape an external deployment/run identifier must take. Looser than a key, still bounded. */
export const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,200}$/;

/**
 * Domain separation. A deployment identity and a test-run identity can never collide even if
 * every field happens to match, and the `/v1` suffix lets the encoding change later without
 * silently re-identifying historical rows.
 */
export const IDEMPOTENCY_DOMAINS = {
  deployment: "project-control/deployment-idempotency/v1",
  testRun: "project-control/test-run-idempotency/v1",
} as const;

export type IdempotencyDomain = (typeof IDEMPOTENCY_DOMAINS)[keyof typeof IDEMPOTENCY_DOMAINS];

/** Thrown when a caller supplies no usable attempt identity. Mapped to HTTP 400 by the route. */
export class AttemptIdentityError extends Error {
  readonly code = "attempt_identity_required";
  constructor(message: string) {
    super(message);
    this.name = "AttemptIdentityError";
  }
}

/**
 * Encode one field unambiguously.
 *
 * `null`/`undefined` gets its own tag, so a missing field stays distinguishable from an empty
 * string. A present value is written as `s:<utf8ByteLength>:<value>`, so a reader can always tell
 * where the value ends without relying on any character being absent from the value.
 *
 * NO normalisation happens here — no trimming, no case folding, no separator stripping. Two
 * values that differ by a space are genuinely different values, and collapsing them would
 * reintroduce exactly the class of collision this function exists to prevent. Normalisation, if
 * any, is the caller's explicit and documented decision (see `validatedKey`, which trims a
 * caller-supplied key once, before it is ever used as identity).
 */
function encodeField(name: string, value: string | null | undefined): string {
  const n = `${Buffer.byteLength(name, "utf8")}:${name}`;
  if (value === null || value === undefined) return `${n}=n:`;
  const v = String(value);
  return `${n}=s:${Buffer.byteLength(v, "utf8")}:${v}`;
}

/**
 * Deterministic identity from a domain and a set of named fields.
 *
 * Fields are sorted by name before encoding, so the literal property order of the object the
 * caller happens to build can never change the resulting identity. Identical canonical inputs
 * always produce identical keys; any difference in any field produces a different key.
 */
export function canonicalIdempotencyKey(
  domain: IdempotencyDomain,
  fields: Record<string, string | null | undefined>
): string {
  const encoded = Object.keys(fields)
    .sort()
    .map((name) => encodeField(name, fields[name]))
    .join("");
  const material = `${encodeField("__domain", domain)}${encoded}`;
  return createHash("sha256").update(material, "utf8").digest("hex").slice(0, 48);
}

/** Validate a caller-supplied idempotency key, or return null when none was supplied. */
function validatedKey(supplied: string | null | undefined): string | null {
  if (typeof supplied !== "string" || supplied.trim().length === 0) return null;
  const trimmed = supplied.trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(trimmed)) {
    throw new AttemptIdentityError(
      "idempotencyKey must be 8-200 characters of letters, numbers, dot, colon, dash or underscore."
    );
  }
  return trimmed;
}

/** Validate an external attempt identifier, or return null when none was supplied. */
function validatedExternalId(supplied: string | null | undefined, field: string): string | null {
  if (typeof supplied !== "string" || supplied.trim().length === 0) return null;
  const trimmed = supplied.trim();
  if (!EXTERNAL_ID_PATTERN.test(trimmed)) {
    throw new AttemptIdentityError(
      `${field} must be 1-200 characters of letters, numbers, dot, colon, slash, dash or underscore.`
    );
  }
  return trimmed;
}

/**
 * Resolve the identity of ONE deployment attempt.
 *
 * An explicit `idempotencyKey` always wins — that is request idempotency, and the caller is
 * asserting "this is the same submission". Otherwise the identity is derived from the external
 * deployment id together with the facts of the release, so the same CI deployment retried
 * collapses to one row while a genuinely new deployment of the same commit does not.
 *
 * With neither, the attempt is rejected: there is no safe way to tell a retry from a redeploy.
 */
export function deploymentAttemptKey(input: {
  idempotencyKey?: string | null;
  externalId?: string | null;
  environment: string;
  commitSha: string;
  releaseVersion?: string | null;
  packageKey?: string | null;
}): { idempotencyKey: string; externalId: string | null } {
  const explicit = validatedKey(input.idempotencyKey);
  const externalId = validatedExternalId(input.externalId, "externalId");

  if (explicit) return { idempotencyKey: explicit, externalId };

  if (!externalId) {
    throw new AttemptIdentityError(
      "A deployment needs an attempt identity so a retry can be told apart from a genuine redeploy. " +
        "Supply externalId (the deployment id from Fly/CI) or an explicit idempotencyKey. " +
        "Environment and commit alone are not an identity — the same commit is legitimately deployed more than once."
    );
  }

  return {
    idempotencyKey: canonicalIdempotencyKey(IDEMPOTENCY_DOMAINS.deployment, {
      externalId,
      environment: input.environment,
      commitSha: input.commitSha,
      releaseVersion: input.releaseVersion ?? null,
      packageKey: input.packageKey ?? null,
    }),
    externalId,
  };
}

/**
 * Resolve the identity of ONE test run. Same rule as deployments: a CI run id or an explicit
 * key, never the suite and commit alone — re-running the same suite on the same commit is a
 * legitimately separate run.
 */
export function testRunAttemptKey(input: {
  idempotencyKey?: string | null;
  externalRunId?: string | null;
  packageKey?: string | null;
  kind: string;
  commitSha?: string | null;
}): { idempotencyKey: string; externalRunId: string | null } {
  const explicit = validatedKey(input.idempotencyKey);
  const externalRunId = validatedExternalId(input.externalRunId, "externalRunId");

  if (explicit) return { idempotencyKey: explicit, externalRunId };

  if (!externalRunId) {
    throw new AttemptIdentityError(
      "A test run needs an attempt identity so a retry can be told apart from a genuine re-run. " +
        "Supply externalRunId (the CI run id) or an explicit idempotencyKey. " +
        "Suite and commit alone are not an identity — the same suite is legitimately re-run on the same commit."
    );
  }

  return {
    idempotencyKey: canonicalIdempotencyKey(IDEMPOTENCY_DOMAINS.testRun, {
      externalRunId,
      packageKey: input.packageKey ?? null,
      kind: input.kind,
      commitSha: input.commitSha ?? null,
    }),
    externalRunId,
  };
}
