/**
 * Claim-credential classification — the taxonomy the Super Admin register and any
 * future repair job both read from.
 *
 * THE INVARIANT THAT MATTERS MOST: nothing that has ever been printed may be
 * classified as safe to generate a credential for. The code on a physical insert
 * is the customer's only credential, and because we generally do not know who
 * holds an unclaimed card, a replaced credential cannot be reissued to anyone. A
 * classifier bug here would be acted on in bulk, so the safety property is
 * asserted across the whole input space rather than on a few examples.
 */
import { describe, expect, it } from "vitest";
import {
  classifyClaimRegister,
  isSafeToIssue,
  summariseClaimRegister,
  type ClaimRegisterInput,
} from "../shared/claim-register";

const PRINTED = new Date("2026-04-26T10:00:00Z");
const LATER = new Date("2026-05-25T10:00:00Z");
const EARLIER = new Date("2026-03-30T10:00:00Z");

function input(over: Partial<ClaimRegisterInput> = {}): ClaimRegisterInput {
  const built: ClaimRegisterInput = {
    certId: "MV1",
    status: "active",
    ownershipStatus: "unclaimed",
    stolenStatus: null,
    hasCredentialHash: true,
    hasReadableCode: true,
    credentialIssuedAt: EARLIER,
    lastPrintedAt: null,
    firstPrintedAt: null,
    printArtefactSurvives: false,
    credentialSelfConsistent: true,
    claimedAt: null,
    isControlledTestReset: false,
    hasPriorOwnershipEvent: false,
    ...over,
  };
  // A card printed once has the same first and last print. Only a test that is
  // explicitly modelling a REPRINT sets the two ends apart.
  if (over.firstPrintedAt === undefined) built.firstPrintedAt = built.lastPrintedAt;
  return built;
}

describe("claim credential classification", () => {
  it("a printed card whose stored credential predates the print is valid and untouchable", () => {
    const v = classifyClaimRegister(input({ lastPrintedAt: PRINTED, credentialIssuedAt: EARLIER }));
    expect(v.category).toBe("A_PRINTED_VALID");
    expect(v.action).toBe("NONE");
    expect(v.actionRequired).toBe(false);
  });

  it("a credential issued AFTER the print means the paper code is dead", () => {
    const v = classifyClaimRegister(input({ lastPrintedAt: PRINTED, credentialIssuedAt: LATER }));
    expect(v.category).toBe("S_PRINTED_SUPERSEDED");
    expect(v.action).toBe("MANUAL_RECONCILIATION");
    expect(v.actionRequired).toBe(true);
    expect(v.supersededPrintedCredential).toBe(true);
    expect(v.customerRisk).toBe(true);
  });

  /*
   * THE PRODUCTION DEFECT, PINNED.
   *
   * MV51: insert printed 2026-05-10; a REPRINT on 2026-06-04 silently minted a new
   * credential; further reprints followed on 06-07, 07-02 and 07-16. Judged against
   * the LAST print the row looks healthy — the credential predates 07-16 — and the
   * first shipped rule therefore reported it as "printed, credential valid, do not
   * touch it". Measured against production, that rule missed 12 of the 13 genuinely
   * superseded certificates, including all ten customer cards.
   *
   * Supersession is a fact about the EARLIEST print: paper from 05-10 is dead no
   * matter how many times the card was printed afterwards.
   */
  it("REGRESSION: a reprint after the mint must not hide a superseded credential", () => {
    const firstPrint = new Date("2026-05-10T18:40:53Z");
    const minted = new Date("2026-06-04T18:15:46Z");
    const reprint = new Date("2026-07-16T12:03:04Z");

    const v = classifyClaimRegister(
      input({ certId: "MV51", firstPrintedAt: firstPrint, lastPrintedAt: reprint, credentialIssuedAt: minted })
    );
    expect(v.category).toBe("S_PRINTED_SUPERSEDED");
    expect(v.supersededPrintedCredential).toBe(true);
    expect(v.customerRisk).toBe(true);
    expect(v.actionRequired).toBe(true);
    // And it must never be offered for issuance.
    expect(v.action).not.toBe("MAY_GENERATE");
    expect(isSafeToIssue(input({ firstPrintedAt: firstPrint, lastPrintedAt: reprint, credentialIssuedAt: minted }), v)).toBe(
      false
    );
  });

  it("MV98: a CLAIMED card with a superseded earlier insert keeps its ownership but is surfaced", () => {
    const firstPrint = new Date("2026-05-09T06:29:17Z");
    const minted = new Date("2026-06-09T10:32:04Z");
    const reprint = new Date("2026-06-09T10:32:14Z");
    const v = classifyClaimRegister(
      input({
        certId: "MV98",
        ownershipStatus: "claimed",
        claimedAt: LATER,
        firstPrintedAt: firstPrint,
        lastPrintedAt: reprint,
        credentialIssuedAt: minted,
        hasPriorOwnershipEvent: true,
      })
    );
    // Ownership is never disturbed …
    expect(v.category).toBe("E_CLAIMED");
    expect(v.action).not.toBe("MAY_GENERATE");
    expect(v.ownershipConflict).toBe(false);
    // … but the dead paper is not swept under the carpet.
    expect(v.supersededPrintedCredential).toBe(true);
    expect(v.customerRisk).toBe(true);
    expect(v.actionRequired).toBe(true);
  });

  it("the controlled MV1–MV33 population is classified normally but is never customer risk", () => {
    const over = { lastPrintedAt: PRINTED, credentialIssuedAt: LATER };
    const customer = classifyClaimRegister(input({ certId: "MV51", ...over }));
    const test = classifyClaimRegister(input({ certId: "MV3", ...over, isControlledTestReset: true }));

    // Same defect, same category — the distinction is who is exposed to it.
    expect(test.category).toBe(customer.category);
    expect(test.supersededPrintedCredential).toBe(true);
    expect(test.actionRequired).toBe(true);
    expect(customer.customerRisk).toBe(true);
    expect(test.customerRisk).toBe(false);
    expect(test.controlledTestReset).toBe(true);
  });

  it("an ownership event with no surviving ownership is a conflict, and is never issued for", () => {
    const lost = input({ certId: "MV12", hasPriorOwnershipEvent: true, ownershipStatus: "unclaimed",
      hasCredentialHash: false, hasReadableCode: false, lastPrintedAt: null });
    const v = classifyClaimRegister(lost);
    expect(v.ownershipConflict).toBe(true);
    // It still reads as "never printed, no credential" …
    expect(v.category).toBe("D_NEVER_PRINTED_NO_CREDENTIAL");
    // … but the lost ownership event disqualifies it from bulk issuance.
    expect(isSafeToIssue(lost, v)).toBe(false);

    const owned = classifyClaimRegister(input({ hasPriorOwnershipEvent: true, ownershipStatus: "claimed" }));
    expect(owned.ownershipConflict).toBe(false);
  });

  it("mint-then-print within one operation is not a rotation", () => {
    // The audit row and the credential write are milliseconds apart, in either order.
    const at = new Date(PRINTED.getTime() + 1200);
    const v = classifyClaimRegister(input({ lastPrintedAt: PRINTED, credentialIssuedAt: at }));
    expect(v.category).toBe("A_PRINTED_VALID");
  });

  it("printed with no stored credential is recoverable only while the artefact survives", () => {
    const gone = classifyClaimRegister(
      input({ lastPrintedAt: PRINTED, hasCredentialHash: false, hasReadableCode: false, printArtefactSurvives: false })
    );
    expect(gone.category).toBe("C_PRINTED_BROKEN");
    expect(gone.action).toBe("MANUAL_RECONCILIATION");

    const kept = classifyClaimRegister(
      input({ lastPrintedAt: PRINTED, hasCredentialHash: false, hasReadableCode: false, printArtefactSurvives: true })
    );
    expect(kept.category).toBe("B_PRINTED_RECOVERABLE");
    expect(kept.action).toBe("RECOVER_FROM_ARTEFACT");
  });

  it("never printed and no credential is the only state that may be generated for", () => {
    const v = classifyClaimRegister(input({ hasCredentialHash: false, hasReadableCode: false, lastPrintedAt: null }));
    expect(v.category).toBe("D_NEVER_PRINTED_NO_CREDENTIAL");
    expect(v.action).toBe("MAY_GENERATE");
  });

  it("a credential that exists but has not been printed is simply ready", () => {
    expect(classifyClaimRegister(input({ lastPrintedAt: null })).category).toBe("R_READY_NOT_PRINTED");
  });

  it("a hash-only recovered credential still counts as a valid printed credential", () => {
    const v = classifyClaimRegister(
      input({ lastPrintedAt: PRINTED, hasReadableCode: false, credentialSelfConsistent: null })
    );
    expect(v.category).toBe("A_PRINTED_VALID");
  });

  it("stolen, void and transfer-pending override credential accounting", () => {
    expect(classifyClaimRegister(input({ stolenStatus: "reported_stolen" })).category).toBe("H_STOLEN");
    expect(classifyClaimRegister(input({ status: "voided" })).category).toBe("G_VOID");
    expect(classifyClaimRegister(input({ ownershipStatus: "transfer_pending" })).category).toBe("F_TRANSFER_PENDING");
  });

  it("a stolen certificate stays stolen even with a perfectly healthy credential", () => {
    const v = classifyClaimRegister(
      input({ stolenStatus: "reported_stolen", lastPrintedAt: PRINTED, hasCredentialHash: true })
    );
    expect(v.category).toBe("H_STOLEN");
    expect(v.action).not.toBe("MAY_GENERATE");
  });

  it("a claimed certificate is left alone — its code still authorises a transfer", () => {
    const v = classifyClaimRegister(input({ ownershipStatus: "claimed", claimedAt: LATER }));
    expect(v.category).toBe("E_CLAIMED");
    expect(v.action).toBe("NONE");
  });

  it("a stored code that does not hash to its stored hash is a conflict, not a valid credential", () => {
    const v = classifyClaimRegister(input({ credentialSelfConsistent: false, lastPrintedAt: PRINTED }));
    expect(v.category).toBe("I_CONFLICT");
    expect(v.action).toBe("MANUAL_RECONCILIATION");
  });

  it("SAFETY: nothing that has ever been printed is classified as safe to generate for", () => {
    const bools = [true, false];
    let printedCases = 0;
    for (const status of ["active", "voided"])
      for (const own of ["unclaimed", "claimed", "transfer_pending"])
        for (const stolen of [null, "reported_stolen"])
          for (const hasHash of bools)
            for (const hasPlain of bools)
              for (const artefact of bools)
                for (const issued of [EARLIER, LATER])
                  for (const consistent of [true, false, null]) {
                    const v = classifyClaimRegister(
                      input({
                        status,
                        ownershipStatus: own,
                        stolenStatus: stolen,
                        hasCredentialHash: hasHash,
                        hasReadableCode: hasPlain,
                        printArtefactSurvives: artefact,
                        credentialIssuedAt: issued,
                        credentialSelfConsistent: consistent,
                        lastPrintedAt: PRINTED,
                      })
                    );
                    printedCases += 1;
                    expect(v.action, `printed card classified ${v.category}`).not.toBe("MAY_GENERATE");
                  }
    expect(printedCases).toBeGreaterThan(500); // non-vacuous
  });

  it("SAFETY: MAY_GENERATE requires never printed AND no credential", () => {
    for (const hasHash of [true, false])
      for (const printed of [null, PRINTED]) {
        const v = classifyClaimRegister(
          input({ hasCredentialHash: hasHash, hasReadableCode: hasHash, lastPrintedAt: printed })
        );
        if (v.action === "MAY_GENERATE") {
          expect(hasHash).toBe(false);
          expect(printed).toBeNull();
        }
      }
  });

  it("counters agree with the rows behind them", () => {
    const population: ClaimRegisterInput[] = [
      input({ certId: "MV1", lastPrintedAt: PRINTED }), // A
      input({ certId: "MV3", lastPrintedAt: PRINTED, credentialIssuedAt: LATER }), // S — superseded
      input({ certId: "MV4", lastPrintedAt: PRINTED, hasCredentialHash: false, hasReadableCode: false }), // C
      input({ certId: "MV6", hasCredentialHash: false, hasReadableCode: false }), // D
      input({ certId: "MV55", ownershipStatus: "claimed" }), // E
      input({ certId: "MV70", ownershipStatus: "transfer_pending" }), // F
      input({ certId: "MV80", status: "voided" }), // G
      input({ certId: "MV90", stolenStatus: "reported_stolen" }), // H
    ];
    const m = summariseClaimRegister(population.map((i) => ({ input: i, verdict: classifyClaimRegister(i) })));
    expect(m.totalEligible).toBe(8);
    expect(m.printed).toBe(3);
    expect(m.noCredential).toBe(2);
    expect(m.validCredential).toBe(6);
    expect(m.claimed).toBe(1);
    expect(m.outstanding).toBe(1);
    expect(m.brokenPrintedCredential).toBe(1); // MV4 only — MV3 is now its own superseded category
    expect(m.printedCredentialSuperseded).toBe(1); // MV3
    expect(m.printedNoCredential).toBe(1); // MV4
    expect(m.customerRisk).toBe(2); // MV3 + MV4, neither marked as controlled test
    expect(m.neverPrinted).toBe(5);
    expect(m.printed + m.neverPrinted).toBe(m.totalEligible);
    expect(m.claimVerificationRate).toBeCloseTo(1 / 3);
    expect(m.transferPending).toBe(1);
    expect(m.void).toBe(1);
    expect(m.stolen).toBe(1);
    expect(m.actionRequired).toBe(3); // MV3, MV4, MV90
  });
  it("claimVerificationRate is null — not zero — when nothing has been issued", () => {
    const m = summariseClaimRegister(
      [input({ hasCredentialHash: false, hasReadableCode: false })].map((i) => ({
        input: i,
        verdict: classifyClaimRegister(i),
      }))
    );
    expect(m.printed).toBe(0);
    // 0/0 is unknown. A dashboard that renders this as "0%" is lying.
    expect(m.claimVerificationRate).toBeNull();
  });

  it("SAFETY: isSafeToIssue accepts ONLY never-printed, never-credentialed, unowned cards", () => {
    let accepted = 0;
    let considered = 0;
    for (const status of ["active", "voided"])
      for (const own of ["unclaimed", "claimed", "transfer_pending"])
        for (const stolen of [null, "reported_stolen"])
          for (const hasHash of [true, false])
            for (const printed of [null, PRINTED])
              for (const issued of [EARLIER, LATER])
                for (const priorOwner of [true, false])
                  for (const testReset of [true, false]) {
                    const i = input({
                      status,
                      ownershipStatus: own,
                      stolenStatus: stolen,
                      hasCredentialHash: hasHash,
                      hasReadableCode: hasHash,
                      lastPrintedAt: printed,
                      credentialIssuedAt: issued,
                      hasPriorOwnershipEvent: priorOwner,
                      isControlledTestReset: testReset,
                    });
                    considered += 1;
                    if (isSafeToIssue(i, classifyClaimRegister(i))) {
                      accepted += 1;
                      // Every property that makes issuance dangerous must be absent.
                      expect(i.lastPrintedAt).toBeNull();
                      expect(i.firstPrintedAt).toBeNull();
                      expect(i.hasCredentialHash).toBe(false);
                      expect(i.status).toBe("active");
                      expect(i.ownershipStatus).toBe("unclaimed");
                      expect(i.stolenStatus).toBeNull();
                      expect(i.hasPriorOwnershipEvent).toBe(false);
                      expect(i.isControlledTestReset).toBe(false);
                    }
                  }
    expect(considered).toBeGreaterThan(300); // non-vacuous
    expect(accepted).toBeGreaterThan(0); // and it does accept something
  });

  it("the controlled test population is issued for ONLY when explicitly selected", () => {
    const i = input({ certId: "MV20", hasCredentialHash: false, hasReadableCode: false,
      lastPrintedAt: null, isControlledTestReset: true });
    const v = classifyClaimRegister(i);
    expect(isSafeToIssue(i, v)).toBe(false);
    expect(isSafeToIssue(i, v, { includeControlledTestReset: true })).toBe(true);
  });
});
