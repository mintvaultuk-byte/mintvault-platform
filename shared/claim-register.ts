/**
 * Claim-credential reconciliation — the single definition of what state a
 * certificate's claim credential is in, and what (if anything) may be done to it.
 *
 * WHY THIS IS SHARED AND PURE. The same taxonomy drives the Super Admin register,
 * the production reconciliation counts, and any future repair job. If those three
 * disagreed about what "broken" means, a repair job could act on a card the
 * register calls healthy. Keeping it here — with no database, no I/O — means the
 * classification can be tested exhaustively against hand-built inputs.
 *
 * THE RULE THIS ENCODES. The code printed on a physical insert IS the customer's
 * credential, for the life of the card: `validateClaimCode` accepts it for the
 * first claim and `validateClaimCodeForTransfer` accepts the same code afterwards
 * to authorise a buyer-initiated transfer. We generally do not know who holds an
 * unclaimed card, so a credential that is replaced cannot be reissued to anyone.
 * Nothing here may ever recommend rotating a credential that has been printed.
 */

/** Everything the classifier needs about one certificate. No credential value — ever. */
export interface ClaimRegisterInput {
  certId: string;
  /** Certificate validity: "active", "voided", … */
  status: string;
  /** "unclaimed" | "claimed" | "transfer_pending" */
  ownershipStatus: string;
  /** "reported_stolen" when flagged, otherwise null. */
  stolenStatus: string | null;
  /** True when `claim_code_hash` is set — this is what validation compares against. */
  hasCredentialHash: boolean;
  /** True when the readable `claim_code` is set. A recovered credential may be hash-only. */
  hasReadableCode: boolean;
  /** When the current credential was issued. Null when there has never been one. */
  credentialIssuedAt: Date | null;
  /** Most recent moment a claim insert carrying this certificate's code was rendered. */
  lastPrintedAt: Date | null;
  /** Whether a print artefact for that run still exists and could yield the original code. */
  printArtefactSurvives: boolean;
  /** True when the stored plaintext does not hash to the stored hash — silent corruption. */
  credentialSelfConsistent: boolean | null;
  claimedAt: Date | null;
}

export type ClaimRegisterCategory =
  | "A_PRINTED_VALID"
  | "B_PRINTED_RECOVERABLE"
  | "C_PRINTED_BROKEN"
  | "D_NEVER_PRINTED_NO_CREDENTIAL"
  | "E_CLAIMED"
  | "F_TRANSFER_PENDING"
  | "G_VOID"
  | "H_STOLEN"
  | "I_CONFLICT"
  | "R_READY_NOT_PRINTED";

export type ClaimAction = "NONE" | "MANUAL_RECONCILIATION" | "RECOVER_FROM_ARTEFACT" | "MAY_GENERATE" | "REVIEW";

export interface ClaimRegisterVerdict {
  category: ClaimRegisterCategory;
  label: string;
  /** What may be done. Never "rotate" for anything that has been printed. */
  action: ClaimAction;
  /** Plain-English reason, safe to show an administrator. */
  reason: string;
  /** True when this row needs a human decision before anything else happens. */
  actionRequired: boolean;
}

/**
 * A credential issued AFTER the last print is a different code from the one on
 * paper. Clock skew between the mint and the audit row is milliseconds, so a
 * small tolerance keeps a same-operation pair from reading as a rotation.
 */
const ROTATION_TOLERANCE_MS = 5 * 60 * 1000;

export function classifyClaimRegister(input: ClaimRegisterInput): ClaimRegisterVerdict {
  const printed = input.lastPrintedAt !== null;

  // ── States that override credential accounting ────────────────────────────
  // A stolen or voided certificate must never be presented as claimable, whatever
  // its credential looks like.
  if (input.stolenStatus === "reported_stolen") {
    return {
      category: "H_STOLEN",
      label: "Stolen",
      action: "REVIEW",
      reason: "Reported stolen. Claiming and transfer are both refused by the server.",
      actionRequired: true,
    };
  }
  if (input.status !== "active") {
    return {
      category: "G_VOID",
      label: "Void",
      action: "NONE",
      reason: `Certificate status is "${input.status}". It cannot be claimed.`,
      actionRequired: false,
    };
  }
  if (input.ownershipStatus === "transfer_pending") {
    return {
      category: "F_TRANSFER_PENDING",
      label: "Transfer pending",
      action: "NONE",
      reason: "A transfer is in flight. Do not issue or rotate a credential.",
      actionRequired: false,
    };
  }

  // Silent corruption beats every other reading: if the stored code does not hash
  // to the stored hash, neither value can be trusted to describe the paper.
  if (input.credentialSelfConsistent === false) {
    return {
      category: "I_CONFLICT",
      label: "Conflict — stored code does not match its hash",
      action: "MANUAL_RECONCILIATION",
      reason: "The readable code and the stored hash disagree. Neither can be trusted.",
      actionRequired: true,
    };
  }

  if (input.ownershipStatus === "claimed") {
    return {
      category: "E_CLAIMED",
      label: "Claimed",
      action: "NONE",
      reason: "Owned. Its credential stays live so the owner can authorise a transfer.",
      actionRequired: false,
    };
  }

  // ── Unclaimed, active certificates — the credential accounting ────────────
  if (!input.hasCredentialHash) {
    if (printed) {
      return input.printArtefactSurvives
        ? {
            category: "B_PRINTED_RECOVERABLE",
            label: "Printed — credential missing, recoverable",
            action: "RECOVER_FROM_ARTEFACT",
            reason:
              "A credential was printed and is missing here, but the print artefact survives and can yield the exact original.",
            actionRequired: true,
          }
        : {
            category: "C_PRINTED_BROKEN",
            label: "Printed — credential lost",
            action: "MANUAL_RECONCILIATION",
            reason:
              "A credential was printed and no copy survives. Do not generate a replacement — the printed code is the customer's only credential.",
            actionRequired: true,
          };
    }
    return {
      category: "D_NEVER_PRINTED_NO_CREDENTIAL",
      label: "No credential, never printed",
      action: "MAY_GENERATE",
      reason: "Nothing was ever issued or printed, so generating a credential cannot invalidate anything.",
      actionRequired: false,
    };
  }

  // Has a credential. Was it issued after the last print?
  if (printed && input.credentialIssuedAt && input.lastPrintedAt) {
    const rotatedAfterPrint =
      input.credentialIssuedAt.getTime() > input.lastPrintedAt.getTime() + ROTATION_TOLERANCE_MS;
    if (rotatedAfterPrint) {
      return {
        category: "C_PRINTED_BROKEN",
        label: "Printed — credential rotated since",
        action: "MANUAL_RECONCILIATION",
        reason:
          "The stored credential was issued after the insert was printed, so the code on paper no longer validates.",
        actionRequired: true,
      };
    }
  }

  if (printed) {
    return {
      category: "A_PRINTED_VALID",
      label: "Printed — credential valid",
      action: "NONE",
      reason: "The credential on the physical insert is the one stored here. Do not touch it.",
      actionRequired: false,
    };
  }

  return {
    category: "R_READY_NOT_PRINTED",
    label: "Credential ready, not yet printed",
    action: "NONE",
    reason: "A credential exists and no insert has been rendered yet.",
    actionRequired: false,
  };
}

export interface ClaimRegisterMetrics {
  totalEligible: number;
  printed: number;
  validCredential: number;
  claimed: number;
  outstanding: number;
  noCredential: number;
  brokenPrintedCredential: number;
  transferPending: number;
  stolen: number;
  void: number;
  actionRequired: number;
}

/** Roll a classified population up into the register's headline counters. */
export function summariseClaimRegister(
  rows: Array<{ input: ClaimRegisterInput; verdict: ClaimRegisterVerdict }>
): ClaimRegisterMetrics {
  const m: ClaimRegisterMetrics = {
    totalEligible: rows.length,
    printed: 0,
    validCredential: 0,
    claimed: 0,
    outstanding: 0,
    noCredential: 0,
    brokenPrintedCredential: 0,
    transferPending: 0,
    stolen: 0,
    void: 0,
    actionRequired: 0,
  };
  for (const { input, verdict } of rows) {
    if (input.lastPrintedAt) m.printed += 1;
    if (input.hasCredentialHash) m.validCredential += 1;
    else m.noCredential += 1;
    if (verdict.category === "E_CLAIMED") m.claimed += 1;
    // "Outstanding" = issued into the world and still waiting to be claimed.
    if (verdict.category === "A_PRINTED_VALID") m.outstanding += 1;
    if (verdict.category === "C_PRINTED_BROKEN" || verdict.category === "B_PRINTED_RECOVERABLE")
      m.brokenPrintedCredential += 1;
    if (verdict.category === "F_TRANSFER_PENDING") m.transferPending += 1;
    if (verdict.category === "H_STOLEN") m.stolen += 1;
    if (verdict.category === "G_VOID") m.void += 1;
    if (verdict.actionRequired) m.actionRequired += 1;
  }
  return m;
}
