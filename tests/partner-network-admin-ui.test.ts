/**
 * G4 Partner-network operations UI — unit + source-assertion coverage.
 *
 * The repo has no DOM/RTL harness (vitest .ts only), so page logic lives in exported pure helpers
 * (unit-tested here) and the page component is verified by source assertion: required data-testids are
 * present, mutations are reason-gated, and the deferred controls (pause/disable/global emergency-stop
 * write) are NOT present.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  stateBadgeVariant,
  canRetry,
  canResolveManualReview,
  canAckFailure,
  canReconcile,
  canReleaseClaim,
  reasonValid,
  requiresTypedConfirm,
  recordsQueryString,
  opsKeys,
} from "../client/src/pages/admin/partner-network-helpers";

describe("G4 UI pure helpers", () => {
  it("stateBadgeVariant maps every connector state to a valid admin badge variant", () => {
    expect(stateBadgeVariant("imported")).toBe("act");
    expect(stateBadgeVariant("manual_review")).toBe("wait");
    expect(stateBadgeVariant("reconciliation_required")).toBe("wait");
    expect(stateBadgeVariant("failed")).toBe("red");
    expect(stateBadgeVariant("ready_for_import")).toBe("prog");
    expect(stateBadgeVariant("queued")).toBe("neu");
    expect(stateBadgeVariant("totally_unknown")).toBe("neu");
  });

  it("canRetry: reserved mapping OR ready/importing states only", () => {
    expect(canRetry("failed", "reserved")).toBe(true);
    expect(canRetry("ready_for_import")).toBe(true);
    expect(canRetry("importing")).toBe(true);
    expect(canRetry("failed")).toBe(false);
    expect(canRetry("cancelled")).toBe(false);
    expect(canRetry("imported")).toBe(false);
  });

  it("canResolveManualReview / canAckFailure gate strictly by state", () => {
    expect(canResolveManualReview("manual_review")).toBe(true);
    expect(canResolveManualReview("failed")).toBe(false);
    expect(canAckFailure("failed")).toBe(true);
    expect(canAckFailure("manual_review")).toBe(false);
  });

  it("canReconcile excludes clean terminal states", () => {
    expect(canReconcile("reconciliation_required")).toBe(true);
    expect(canReconcile("cancelled")).toBe(false);
    expect(canReconcile("rejected")).toBe(false);
  });

  it("canReleaseClaim only when the lease is expired", () => {
    expect(canReleaseClaim({ claimExpiresAt: null })).toBe(false);
    expect(canReleaseClaim({ claimExpiresAt: new Date(Date.now() - 60_000).toISOString() })).toBe(true);
    expect(canReleaseClaim({ claimExpiresAt: new Date(Date.now() + 60_000).toISOString() })).toBe(false);
  });

  it("reasonValid rejects blank and over-long reasons", () => {
    expect(reasonValid("")).toBe(false);
    expect(reasonValid("   ")).toBe(false);
    expect(reasonValid("ok")).toBe(true);
    expect(reasonValid("x".repeat(2001))).toBe(false);
  });

  it("requiresTypedConfirm flags high-risk actions only", () => {
    expect(requiresTypedConfirm("ack")).toBe(true);
    expect(requiresTypedConfirm("resolve-cancel")).toBe(true);
    expect(requiresTypedConfirm("retry")).toBe(false);
  });

  it("recordsQueryString is deterministic and only emits set filters", () => {
    expect(recordsQueryString({})).toBe("");
    expect(recordsQueryString({ manualReview: true })).toBe("?manualReview=true");
    expect(recordsQueryString({ state: "failed", page: 2 })).toBe("?state=failed&page=2");
  });

  it("opsKeys build literal API paths for prefix-invalidation", () => {
    expect(opsKeys.workerStatus()[0]).toBe("/api/super-admin/connector-ops/worker/status");
    expect(opsKeys.record("abc")[0]).toBe("/api/super-admin/connector-ops/records/abc");
  });
});

describe("G4 ops page source assertions", () => {
  const src = readFileSync(join(process.cwd(), "client/src/pages/admin/partner-network.tsx"), "utf8");

  it("uses the existing admin shell + admin session gate (no new app)", () => {
    expect(src).toContain("AdminShell");
    expect(src).toContain("/api/admin/session");
    expect(src).toContain("encodeURIComponent(`${pathname}${window.location.search}${window.location.hash}`)");
  });

  it("carries the required data-testids for overview, records, detail, and reason modal", () => {
    for (const id of [
      "pn-ops-root",
      "pn-stat-enabled",
      "pn-records-table",
      "pn-detail",
      "pn-credit-detail",
      "pn-reason-modal",
      "pn-reason-input",
      "pn-typed-confirm",
      "pn-modal-confirm",
    ]) {
      expect(src).toContain(id);
    }
  });

  it("gates the mutation confirm on a valid reason (no optimistic completion)", () => {
    expect(src).toContain("reasonValid(reason)");
    expect(src).toContain("disabled={!confirmOk}");
    // confirmOk requires a valid reason and, for high-risk actions, the typed phrase
    expect(src).toContain("requiresTypedConfirm(modal.action.key)");
    expect(src).toContain("typedConfirm.trim() === TYPED_CONFIRM_PHRASE");
  });

  it("modal is accessible: labelled dialog, associated reason label, and Escape-to-close", () => {
    expect(src).toContain('aria-labelledby="pn-modal-title"');
    expect(src).toContain('id="pn-modal-title"');
    expect(src).toContain('htmlFor="pn-reason-input"');
    expect(src).toContain('e.key === "Escape"');
  });

  it("wires unavailableReason into disabled action buttons", () => {
    expect(src).toContain("unavailableReason(a.key, selectedRec.state)");
  });

  it("does NOT expose the deferred controls (pause/disable/global emergency-stop write)", () => {
    expect(src).not.toMatch(/\/pause\b/);
    expect(src).not.toMatch(/\/disable\b/);
    expect(src).not.toMatch(/global-stop/);
    expect(src).not.toMatch(/emergency-stop['"`]\s*\)/); // no POST to an emergency-stop write endpoint
  });

  it("renders the read-only global-disabled banner", () => {
    expect(src).toContain("pn-disabled-banner");
    expect(src).toContain("globally DISABLED");
  });

  it("renders automatic Partner credit details without adding manual accounting controls", () => {
    expect(src).toContain("detail.data?.partnerCredit");
    expect(src).toContain("partnerCredit.error");
    expect(src).toContain("Credit reservation:");
    expect(src).toContain("Wallet:");
    expect(src).not.toMatch(/manual credit|adjust credits|credit adjustment/i);
  });
});
