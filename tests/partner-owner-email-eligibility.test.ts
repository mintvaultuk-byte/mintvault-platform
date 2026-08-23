/**
 * The CREATE SHOP form's eligibility decision, pinned exhaustively.
 *
 * The reported bug was that pressing Create with a duplicate Owner email "felt like a dead button":
 * a request fired, the server refused correctly, and the refusal appeared in a banner above the
 * fold. Two of those three are decisions — whether to fire at all, and what the button says — and
 * these tests are what make "no request is fired when blocked" a proven property rather than a
 * hopeful one.
 */
import { describe, expect, it } from "vitest";
import {
  createBlockedBy,
  createButtonLabel,
  ownerEmailState,
  type OwnerEmailLookup,
} from "../client/src/pages/admin/owner-email-eligibility";

const lookup = (over: Partial<OwnerEmailLookup> = {}): OwnerEmailLookup => ({
  query: "someone@example.test",
  isFetching: false,
  isError: false,
  available: undefined,
  ...over,
});

describe("owner email lookup state", () => {
  it("is idle before a plausible address has been entered", () => {
    expect(ownerEmailState(lookup({ query: "" }))).toBe("idle");
    // Even mid-flight: with nothing being asked about there is nothing to report.
    expect(ownerEmailState(lookup({ query: "", isFetching: true }))).toBe("idle");
  });

  it("is checking while a lookup is in flight", () => {
    expect(ownerEmailState(lookup({ isFetching: true }))).toBe("checking");
  });

  it("reports checking even when a PREVIOUS answer is still cached", () => {
    // A stale yes must never green-light a newly typed address.
    expect(ownerEmailState(lookup({ isFetching: true, available: true }))).toBe("checking");
    expect(ownerEmailState(lookup({ isFetching: true, available: false }))).toBe("checking");
  });

  it("is available / unavailable exactly as the server said", () => {
    expect(ownerEmailState(lookup({ available: true }))).toBe("available");
    expect(ownerEmailState(lookup({ available: false }))).toBe("unavailable");
  });

  it("is error when the lookup failed, and never silently available", () => {
    const state = ownerEmailState(lookup({ isError: true }));
    expect(state).toBe("error");
    expect(state).not.toBe("available");
  });
});

describe("whether Create may fire", () => {
  it("REFUSES on unavailable — this is what makes zero requests true, not merely likely", () => {
    expect(createBlockedBy("unavailable")).toBe(true);
  });

  it("REFUSES while checking, so a fast paste-then-click cannot beat the lookup", () => {
    expect(createBlockedBy("checking")).toBe(true);
  });

  it("allows idle and available", () => {
    expect(createBlockedBy("idle")).toBe(false);
    expect(createBlockedBy("available")).toBe(false);
  });

  it("allows error, because the transaction is the final authority", () => {
    // Not evidence of availability — the operator is told the check failed — but the create path
    // must stay reachable, or one flaky lookup makes the form unusable.
    expect(createBlockedBy("error")).toBe(false);
  });
});

describe("the button always explains itself", () => {
  it("names the reason it is disabled", () => {
    expect(createButtonLabel("unavailable", { pending: false, failed: false })).toBe("Owner email already in use");
    expect(createButtonLabel("checking", { pending: false, failed: false })).toBe("Checking Owner email…");
  });

  it("offers retry after a failed create", () => {
    expect(createButtonLabel("available", { pending: false, failed: true })).toContain("Retry");
  });

  it("shows progress while creating, whatever the eligibility state was", () => {
    for (const state of ["idle", "checking", "available", "unavailable", "error"] as const) {
      expect(createButtonLabel(state, { pending: true, failed: false })).toBe("Creating…");
    }
  });

  it("is never blank, in any combination", () => {
    for (const state of ["idle", "checking", "available", "unavailable", "error"] as const) {
      for (const pending of [true, false]) {
        for (const failed of [true, false]) {
          expect(createButtonLabel(state, { pending, failed }).trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("a disabled state ALWAYS carries a label explaining it", () => {
    for (const state of ["idle", "checking", "available", "unavailable", "error"] as const) {
      if (!createBlockedBy(state)) continue;
      const label = createButtonLabel(state, { pending: false, failed: false });
      // Never the neutral call to action while the control cannot be used — that is the dead button.
      expect(label).not.toBe("Create shop & send invitation");
    }
  });
});
