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
  /**
   * EARLIEST moment a claim insert was rendered for this certificate.
   *
   * Supersession must be judged against the FIRST print, never the last. A card
   * whose credential was silently re-minted mid-life is normally REPRINTED
   * afterwards, which pushes `lastPrintedAt` past the mint and makes the row look
   * healthy. Measured against production on 2026-08-23, the last-print rule missed
   * 12 of the 13 genuinely superseded certificates — including all ten customer
   * cards — reporting each of them as "printed, credential valid, do not touch".
   */
  firstPrintedAt: Date | null;
  /** Whether a print artefact for that run still exists and could yield the original code. */
  printArtefactSurvives: boolean;
  /** True when the stored plaintext does not hash to the stored hash — silent corruption. */
  credentialSelfConsistent: boolean | null;
  claimedAt: Date | null;
  /**
   * MV1–MV33: the controlled pre-launch population the founder physically retains.
   * Their ownership was assigned and deliberately reset during pre-launch testing on
   * a staff account, and their credentials were re-minted in the same period. They are
   * real rows with real defects, so they are classified exactly like any other card —
   * but they are NOT customer risk, and must never be counted as customer failures.
   */
  isControlledTestReset: boolean;
  /**
   * True when ownership_history holds a real ownership event (initial_claim /
   * transfer / transfer_completed) for this certificate. `auto_submission` rows do
   * NOT count — 602 of them exist, one per submitted card, and they record intake
   * linkage rather than a Vault Club claim.
   */
  hasPriorOwnershipEvent: boolean;
}

export type ClaimRegisterCategory =
  | "A_PRINTED_VALID"
  | "B_PRINTED_RECOVERABLE"
  | "C_PRINTED_BROKEN"
  | "S_PRINTED_SUPERSEDED"
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
  /**
   * A credential was printed and the stored credential is no longer that code, so a
   * physical insert in circulation cannot be honoured. Orthogonal to `category`,
   * because a CLAIMED card can also carry a dead earlier insert.
   */
  supersededPrintedCredential: boolean;
  /** Printed, but the server now holds no credential at all. */
  printedNoCredential: boolean;
  /** A real customer may hold paper we cannot honour. Excludes the controlled test set. */
  customerRisk: boolean;
  /** Mirrors the input flag so every consumer can exclude the test population. */
  controlledTestReset: boolean;
  /**
   * An ownership event happened, but the certificate no longer reflects it. On
   * production every instance of this is the controlled MV1–MV33 reset; a NEW one
   * appearing outside that set would mean ownership is being lost for real.
   */
  ownershipConflict: boolean;
}

/**
 * A credential issued AFTER a print is a different code from the one on that paper.
 * Clock skew between the mint and the audit row is milliseconds, so a small
 * tolerance keeps a same-operation pair from reading as a rotation.
 */
const ROTATION_TOLERANCE_MS = 5 * 60 * 1000;

/** Did the credential we hold today come into existence after `at`? */
function issuedAfter(input: ClaimRegisterInput, at: Date | null): boolean {
  if (!at || !input.credentialIssuedAt) return false;
  return input.credentialIssuedAt.getTime() > at.getTime() + ROTATION_TOLERANCE_MS;
}

export function classifyClaimRegister(input: ClaimRegisterInput): ClaimRegisterVerdict {
  const printed = input.firstPrintedAt !== null || input.lastPrintedAt !== null;

  /*
   * ── The two orthogonal credential facts ──────────────────────────────────
   * Computed BEFORE any early return, because a card can be claimed, stolen or
   * voided AND still have a dead insert in someone's hands. Folding these into
   * `category` would hide exactly the rows that matter most.
   */
  const supersededPrintedCredential =
    printed && input.hasCredentialHash && issuedAfter(input, input.firstPrintedAt);
  const printedNoCredential = printed && !input.hasCredentialHash;
  const customerRisk = (supersededPrintedCredential || printedNoCredential) && !input.isControlledTestReset;
  const ownershipConflict = input.hasPriorOwnershipEvent && input.ownershipStatus !== "claimed";

  /** Every return threads the orthogonal facts through unchanged. */
  const v = (
    category: ClaimRegisterCategory,
    label: string,
    action: ClaimAction,
    reason: string,
    actionRequired: boolean
  ): ClaimRegisterVerdict => ({
    category,
    label,
    action,
    reason,
    // A dead insert always demands a decision, whatever else the row is doing.
    actionRequired: actionRequired || supersededPrintedCredential || printedNoCredential,
    supersededPrintedCredential,
    printedNoCredential,
    customerRisk,
    controlledTestReset: input.isControlledTestReset,
    ownershipConflict,
  });

  const testNote = input.isControlledTestReset
    ? " Controlled pre-launch test card (MV1–MV33) — not a customer failure."
    : "";

  // ── States that override credential accounting ────────────────────────────
  // A stolen or voided certificate must never be presented as claimable, whatever
  // its credential looks like.
  if (input.stolenStatus === "reported_stolen") {
    return v(
      "H_STOLEN",
      "Stolen",
      "REVIEW",
      "Reported stolen. Claiming and transfer are both refused by the server." + testNote,
      true
    );
  }
  if (input.status !== "active") {
    return v("G_VOID", "Void", "NONE", `Certificate status is "${input.status}". It cannot be claimed.` + testNote, false);
  }
  if (input.ownershipStatus === "transfer_pending") {
    return v(
      "F_TRANSFER_PENDING",
      "Transfer pending",
      "NONE",
      "A transfer is in flight. Do not issue or rotate a credential." + testNote,
      false
    );
  }

  // Silent corruption beats every other reading: if the stored code does not hash
  // to the stored hash, neither value can be trusted to describe the paper.
  if (input.credentialSelfConsistent === false) {
    return v(
      "I_CONFLICT",
      "Conflict — stored code does not match its hash",
      "MANUAL_RECONCILIATION",
      "The readable code and the stored hash disagree. Neither can be trusted." + testNote,
      true
    );
  }

  if (input.ownershipStatus === "claimed") {
    /*
     * An owned card is never re-credentialed — the owner needs the live code to
     * authorise a transfer. But if an EARLIER insert was superseded, that paper is
     * still out there, so the row is surfaced for review with ownership untouched.
     */
    return supersededPrintedCredential
      ? v(
          "E_CLAIMED",
          "Claimed — earlier printed credential superseded",
          "REVIEW",
          "Owned, and the live credential works. An earlier insert carries a code that no longer " +
            "validates and may still exist. Do not alter ownership, and do not rotate the credential." +
            testNote,
          true
        )
      : v(
          "E_CLAIMED",
          "Claimed",
          "NONE",
          "Owned. Its credential stays live so the owner can authorise a transfer." + testNote,
          false
        );
  }

  // ── Unclaimed, active certificates — the credential accounting ────────────
  if (!input.hasCredentialHash) {
    if (printed) {
      return input.printArtefactSurvives
        ? v(
            "B_PRINTED_RECOVERABLE",
            "Printed — credential missing, recoverable",
            "RECOVER_FROM_ARTEFACT",
            "A credential was printed and is missing here, but the print artefact survives and can yield the exact original." +
              testNote,
            true
          )
        : v(
            "C_PRINTED_BROKEN",
            "Printed — credential lost",
            "MANUAL_RECONCILIATION",
            "A credential was printed and no copy survives. Do not generate a replacement — the printed code is the customer's only credential." +
              testNote,
            true
          );
    }
    return v(
      "D_NEVER_PRINTED_NO_CREDENTIAL",
      "No credential, never printed",
      "MAY_GENERATE",
      "Nothing was ever issued or printed, so generating a credential cannot invalidate anything." + testNote,
      false
    );
  }

  /*
   * Has a credential, and an insert was printed BEFORE that credential existed.
   * The paper in circulation is dead. Never rotate again — a second rotation
   * would only add another dead code without helping whoever holds the first.
   */
  if (supersededPrintedCredential) {
    return v(
      "S_PRINTED_SUPERSEDED",
      "Printed credential superseded",
      "MANUAL_RECONCILIATION",
      "An insert was printed before the credential now stored was issued, so the code on that paper no longer " +
        "validates. Do NOT rotate or regenerate. Recover the original from the print artefact, or reissue only " +
        "with the physical insert accounted for." + testNote,
      true
    );
  }

  if (printed) {
    return v(
      "A_PRINTED_VALID",
      "Printed — credential valid",
      "NONE",
      "The credential on the physical insert is the one stored here. Do not touch it." + testNote,
      false
    );
  }

  return v(
    "R_READY_NOT_PRINTED",
    "Credential ready, not yet printed",
    "NONE",
    "A credential exists and no insert has been rendered yet." + testNote,
    false
  );
}

export interface ClaimRegisterMetrics {
  totalEligible: number;
  printed: number;
  neverPrinted: number;
  validCredential: number;
  claimed: number;
  outstanding: number;
  noCredential: number;
  printedCredentialSuperseded: number;
  printedNoCredential: number;
  customerRisk: number;
  testReset: number;
  ownershipConflict: number;
  brokenPrintedCredential: number;
  transferPending: number;
  stolen: number;
  void: number;
  actionRequired: number;
  /**
   * Claimed ÷ (everything that has actually been issued into the world). Null —
   * rendered as "—" — when nothing has been issued, because 0/0 is not 0%.
   */
  claimVerificationRate: number | null;
}

/** Roll a classified population up into the register's headline counters. */
export function summariseClaimRegister(
  rows: Array<{ input: ClaimRegisterInput; verdict: ClaimRegisterVerdict }>
): ClaimRegisterMetrics {
  const m: ClaimRegisterMetrics = {
    totalEligible: rows.length,
    printed: 0,
    neverPrinted: 0,
    validCredential: 0,
    claimed: 0,
    outstanding: 0,
    noCredential: 0,
    printedCredentialSuperseded: 0,
    printedNoCredential: 0,
    customerRisk: 0,
    testReset: 0,
    ownershipConflict: 0,
    brokenPrintedCredential: 0,
    transferPending: 0,
    stolen: 0,
    void: 0,
    actionRequired: 0,
    claimVerificationRate: null,
  };
  for (const { input, verdict } of rows) {
    const printed = input.firstPrintedAt !== null || input.lastPrintedAt !== null;
    if (printed) m.printed += 1;
    else m.neverPrinted += 1;
    if (input.hasCredentialHash) m.validCredential += 1;
    else m.noCredential += 1;
    if (verdict.category === "E_CLAIMED") m.claimed += 1;
    // "Outstanding" = issued into the world and still waiting to be claimed.
    if (verdict.category === "A_PRINTED_VALID") m.outstanding += 1;
    if (verdict.supersededPrintedCredential) m.printedCredentialSuperseded += 1;
    if (verdict.printedNoCredential) m.printedNoCredential += 1;
    if (verdict.customerRisk) m.customerRisk += 1;
    if (verdict.controlledTestReset) m.testReset += 1;
    if (verdict.ownershipConflict) m.ownershipConflict += 1;
    if (verdict.category === "C_PRINTED_BROKEN" || verdict.category === "B_PRINTED_RECOVERABLE")
      m.brokenPrintedCredential += 1;
    if (verdict.category === "F_TRANSFER_PENDING") m.transferPending += 1;
    if (verdict.category === "H_STOLEN") m.stolen += 1;
    if (verdict.category === "G_VOID") m.void += 1;
    if (verdict.actionRequired) m.actionRequired += 1;
  }
  const issued = m.printed;
  m.claimVerificationRate = issued > 0 ? m.claimed / issued : null;
  return m;
}

/**
 * The ONLY population a bulk issuance may touch.
 *
 * Deliberately expressed as an allow-list of one category rather than a list of
 * exclusions: `D_NEVER_PRINTED_NO_CREDENTIAL` is reachable only when the card is
 * active, unclaimed, not stolen, not mid-transfer, has never held a credential and
 * has never been printed. Anything a future category adds is excluded by default,
 * which is the safe direction to fail.
 */
export function isSafeToIssue(
  input: ClaimRegisterInput,
  verdict: ClaimRegisterVerdict,
  opts: { includeControlledTestReset?: boolean } = {}
): boolean {
  if (verdict.category !== "D_NEVER_PRINTED_NO_CREDENTIAL") return false;
  if (verdict.customerRisk || verdict.supersededPrintedCredential || verdict.printedNoCredential) return false;
  if (verdict.ownershipConflict) return false;
  if (input.isControlledTestReset && !opts.includeControlledTestReset) return false;
  return true;
}
