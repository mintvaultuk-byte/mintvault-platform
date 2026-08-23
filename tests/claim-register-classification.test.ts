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
  summariseClaimRegister,
  type ClaimRegisterInput,
} from "../shared/claim-register";

const PRINTED = new Date("2026-04-26T10:00:00Z");
const LATER = new Date("2026-05-25T10:00:00Z");
const EARLIER = new Date("2026-03-30T10:00:00Z");

function input(over: Partial<ClaimRegisterInput> = {}): ClaimRegisterInput {
  return {
    certId: "MV1",
    status: "active",
    ownershipStatus: "unclaimed",
    stolenStatus: null,
    hasCredentialHash: true,
    hasReadableCode: true,
    credentialIssuedAt: EARLIER,
    lastPrintedAt: null,
    printArtefactSurvives: false,
    credentialSelfConsistent: true,
    claimedAt: null,
    ...over,
  };
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
    expect(v.category).toBe("C_PRINTED_BROKEN");
    expect(v.action).toBe("MANUAL_RECONCILIATION");
    expect(v.actionRequired).toBe(true);
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
      input({ certId: "MV3", lastPrintedAt: PRINTED, credentialIssuedAt: LATER }), // C
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
    expect(m.brokenPrintedCredential).toBe(2);
    expect(m.transferPending).toBe(1);
    expect(m.void).toBe(1);
    expect(m.stolen).toBe(1);
    expect(m.actionRequired).toBe(3); // MV3, MV4, MV90
  });
});
