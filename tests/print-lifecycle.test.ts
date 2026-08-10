/**
 * print-lifecycle.test.ts — regression coverage for the print-workflow state
 * machine (shared/print-lifecycle.ts). Pure logic, no DB. Covers every scenario
 * the feature brief requires: Approval → Needs Printing, batch creation, Print
 * Selected / Print All Ready, Printed status, Reprint, duplicate prevention,
 * audit-transition shape, permissions, and lifecycle regression guards.
 */
import { describe, it, expect } from "vitest";
import {
  PRINT_STATES,
  DEFAULT_PRINT_STATE,
  PRINT_STATE_LABEL,
  PRINT_STATE_BADGE,
  effectivePrintState,
  nextState,
  canPerform,
  canReadQueue,
  findDuplicatePrints,
  matchesFilter,
  isValidReprintReason,
  isReprintReasonCategory,
  REPRINT_REASON_CATEGORIES,
  PRINT_QUEUE_FILTERS,
  type PrintState,
  type PrintRole,
} from "../shared/print-lifecycle";

describe("state table integrity", () => {
  it("has exactly the seven brief-specified states", () => {
    expect([...PRINT_STATES]).toEqual([
      "awaiting_approval",
      "needs_printing",
      "printing",
      "printed",
      "reprint_required",
      "reprinted",
      "completed",
    ]);
  });
  it("labels and badges cover every state", () => {
    for (const s of PRINT_STATES) {
      expect(PRINT_STATE_LABEL[s]).toBeTruthy();
      expect(PRINT_STATE_BADGE[s]).toBeTruthy();
    }
  });
  it("defaults to awaiting_approval", () => {
    expect(DEFAULT_PRINT_STATE).toBe("awaiting_approval");
  });
});

describe("Approval → Needs Printing (effective state derivation, grader untouched)", () => {
  it("unapproved cert with default state is Awaiting Approval", () => {
    expect(effectivePrintState({ storedState: "awaiting_approval", approved: false })).toBe("awaiting_approval");
    expect(effectivePrintState({ storedState: null, approved: false })).toBe("awaiting_approval");
  });
  it("approving a cert promotes it to Needs Printing with NO stored write", () => {
    // storedState is still the default; approval alone flips the effective state.
    expect(effectivePrintState({ storedState: "awaiting_approval", approved: true })).toBe("needs_printing");
    expect(effectivePrintState({ storedState: null, approved: true })).toBe("needs_printing");
  });
  it("an advanced state always wins over approval (no backwards slide)", () => {
    for (const advanced of ["printing", "printed", "reprint_required", "reprinted", "completed"] as PrintState[]) {
      expect(effectivePrintState({ storedState: advanced, approved: true })).toBe(advanced);
      expect(effectivePrintState({ storedState: advanced, approved: false })).toBe(advanced);
    }
  });
});

describe("Batch creation / Print Selected / Print All Ready", () => {
  it("moves a needs_printing cert into printing", () => {
    const r = nextState("needs_printing", "create_batch");
    expect(r).toMatchObject({ ok: true, to: "printing" });
    expect(nextState("needs_printing", "print_all_ready")).toMatchObject({ ok: true, to: "printing" });
  });
  it("moves a reprint_required cert into printing (reprint batch)", () => {
    expect(nextState("reprint_required", "create_batch")).toMatchObject({ ok: true, to: "printing" });
  });
  it("refuses to batch an unapproved cert", () => {
    expect(nextState("awaiting_approval", "create_batch")).toMatchObject({ ok: false, code: "not_approved" });
  });
  it("refuses to batch an already-printed cert (forces the reprint path)", () => {
    for (const s of ["printed", "reprinted", "completed"] as PrintState[]) {
      expect(nextState(s, "create_batch")).toMatchObject({ ok: false, code: "already_printed" });
    }
  });
});

describe("Printed status", () => {
  it("mark_printed on a first-run batch → printed", () => {
    expect(nextState("printing", "mark_printed", { batchKind: "batch" })).toMatchObject({ ok: true, to: "printed" });
  });
  it("mark_printed on a reprint batch → reprinted", () => {
    expect(nextState("printing", "mark_printed", { batchKind: "reprint" })).toMatchObject({
      ok: true,
      to: "reprinted",
    });
  });
  it("cannot mark printed unless currently printing", () => {
    for (const s of ["needs_printing", "printed", "completed", "awaiting_approval"] as PrintState[]) {
      expect(nextState(s, "mark_printed")).toMatchObject({ ok: false, code: "not_printed_yet" });
    }
  });
});

describe("Reprint workflow", () => {
  it("requires a valid reason string", () => {
    expect(isValidReprintReason("too short")).toBe(false); // < 10 chars
    expect(isValidReprintReason("   " + "x".repeat(9))).toBe(false);
    expect(isValidReprintReason("Damaged during slabbing, corner scuffed.")).toBe(true);
    expect(isValidReprintReason("x".repeat(501))).toBe(false);
    expect(isValidReprintReason(123 as unknown)).toBe(false);
  });
  it("accepts only the five brief reason categories", () => {
    expect([...REPRINT_REASON_CATEGORIES]).toEqual([
      "lost_label",
      "damaged_print",
      "printer_error",
      "customer_replacement",
      "correction",
    ]);
    expect(isReprintReasonCategory("lost_label")).toBe(true);
    expect(isReprintReasonCategory("nope")).toBe(false);
  });
  it("reprint from a printed cert requires reason and yields reprint_required", () => {
    expect(nextState("printed", "reprint", { hasReason: false })).toMatchObject({ ok: false, code: "reason_required" });
    expect(nextState("printed", "reprint", { hasReason: true })).toMatchObject({ ok: true, to: "reprint_required" });
  });
  it("reprint is allowed from printed/reprinted/completed but not from unprinted states", () => {
    for (const s of ["printed", "reprinted", "completed"] as PrintState[]) {
      expect(nextState(s, "reprint", { hasReason: true })).toMatchObject({ ok: true, to: "reprint_required" });
    }
    for (const s of ["awaiting_approval", "needs_printing", "printing"] as PrintState[]) {
      expect(nextState(s, "reprint", { hasReason: true })).toMatchObject({ ok: false, code: "invalid_from" });
    }
  });
  it("full reprint loop: printed → reprint_required → printing → reprinted", () => {
    expect(nextState("printed", "reprint", { hasReason: true }).to).toBe("reprint_required");
    expect(nextState("reprint_required", "create_batch").to).toBe("printing");
    expect(nextState("printing", "mark_printed", { batchKind: "reprint" }).to).toBe("reprinted");
  });
});

describe("Completion (terminal)", () => {
  it("completes from printed or reprinted", () => {
    expect(nextState("printed", "complete")).toMatchObject({ ok: true, to: "completed" });
    expect(nextState("reprinted", "complete")).toMatchObject({ ok: true, to: "completed" });
  });
  it("cannot complete something never printed", () => {
    for (const s of ["awaiting_approval", "needs_printing", "printing", "reprint_required"] as PrintState[]) {
      expect(nextState(s, "complete")).toMatchObject({ ok: false, code: "not_printed_yet" });
    }
  });
  it("is idempotent-safe (already completed is rejected, not doubled)", () => {
    expect(nextState("completed", "complete")).toMatchObject({ ok: false, code: "already_completed" });
  });
});

describe("Duplicate prevention", () => {
  it("flags already-printed certs in a first-run batch selection", () => {
    const sel = [
      { certId: "MV1", state: "needs_printing" as PrintState },
      { certId: "MV2", state: "printed" as PrintState },
      { certId: "MV3", state: "completed" as PrintState },
      { certId: "MV4", state: "reprinted" as PrintState },
      { certId: "MV5", state: "reprint_required" as PrintState },
    ];
    const dupes = findDuplicatePrints(sel).map((c) => c.certId);
    expect(dupes).toEqual(["MV2", "MV3", "MV4"]);
  });
  it("returns nothing when selection is all fresh", () => {
    expect(findDuplicatePrints([{ certId: "MV1", state: "needs_printing" }])).toEqual([]);
  });
});

describe("Permissions", () => {
  const roles: PrintRole[] = ["admin", "staff_print", "staff_readonly"];
  it("admin can do everything including terminal complete", () => {
    for (const a of ["create_batch", "print_all_ready", "mark_printed", "reprint", "complete"] as const) {
      expect(canPerform(a, "admin")).toBe(true);
    }
  });
  it("staff_print can do all non-terminal actions but NOT complete", () => {
    for (const a of ["create_batch", "print_all_ready", "mark_printed", "reprint"] as const) {
      expect(canPerform(a, "staff_print")).toBe(true);
    }
    expect(canPerform("complete", "staff_print")).toBe(false);
  });
  it("partner_print can complete only through its separately constrained Partner adapter", () => {
    expect(canPerform("create_batch", "partner_print")).toBe(true);
    expect(canPerform("mark_printed", "partner_print")).toBe(true);
    expect(canPerform("complete", "partner_print")).toBe(true);
    expect(canPerform("reprint", "partner_print")).toBe(false);
  });
  it("staff_readonly can do no mutating action", () => {
    for (const a of ["create_batch", "print_all_ready", "mark_printed", "reprint", "complete"] as const) {
      expect(canPerform(a, "staff_readonly")).toBe(false);
    }
  });
  it("every role may read the queue", () => {
    for (const r of roles) expect(canReadQueue(r)).toBe(true);
  });
});

describe("Queue filters", () => {
  const DAY_START = Date.UTC(2026, 6, 24); // fixed, no clock read
  const AFTER = DAY_START + 3600_000;
  const BEFORE = DAY_START - 3600_000;

  it("exposes exactly the brief filters incl. Printing/In Progress", () => {
    expect([...PRINT_QUEUE_FILTERS]).toEqual([
      "needs_printing",
      "printing",
      "printed_today",
      "printed",
      "reprints",
      "completed",
      "all",
    ]);
  });
  it("Needs Printing shows only needs_printing", () => {
    expect(matchesFilter({ state: "needs_printing", printedAtMs: null }, "needs_printing", DAY_START)).toBe(true);
    expect(matchesFilter({ state: "printed", printedAtMs: AFTER }, "needs_printing", DAY_START)).toBe(false);
  });
  it("Printing/In Progress shows only printing", () => {
    expect(matchesFilter({ state: "printing", printedAtMs: null }, "printing", DAY_START)).toBe(true);
    expect(matchesFilter({ state: "needs_printing", printedAtMs: null }, "printing", DAY_START)).toBe(false);
    expect(matchesFilter({ state: "printed", printedAtMs: AFTER }, "printing", DAY_START)).toBe(false);
  });
  it("Printed shows printed and reprinted", () => {
    expect(matchesFilter({ state: "printed", printedAtMs: BEFORE }, "printed", DAY_START)).toBe(true);
    expect(matchesFilter({ state: "reprinted", printedAtMs: BEFORE }, "printed", DAY_START)).toBe(true);
    expect(matchesFilter({ state: "needs_printing", printedAtMs: null }, "printed", DAY_START)).toBe(false);
  });
  it("Printed Today respects the day boundary", () => {
    expect(matchesFilter({ state: "printed", printedAtMs: AFTER }, "printed_today", DAY_START)).toBe(true);
    expect(matchesFilter({ state: "printed", printedAtMs: BEFORE }, "printed_today", DAY_START)).toBe(false);
    expect(matchesFilter({ state: "printed", printedAtMs: null }, "printed_today", DAY_START)).toBe(false);
  });
  it("Reprints shows reprint_required and reprinted", () => {
    expect(matchesFilter({ state: "reprint_required", printedAtMs: null }, "reprints", DAY_START)).toBe(true);
    expect(matchesFilter({ state: "reprinted", printedAtMs: BEFORE }, "reprints", DAY_START)).toBe(true);
    expect(matchesFilter({ state: "printed", printedAtMs: BEFORE }, "reprints", DAY_START)).toBe(false);
  });
  it("Completed shows only completed; All shows everything", () => {
    expect(matchesFilter({ state: "completed", printedAtMs: BEFORE }, "completed", DAY_START)).toBe(true);
    for (const s of PRINT_STATES) {
      expect(matchesFilter({ state: s, printedAtMs: null }, "all", DAY_START)).toBe(true);
    }
  });
});

describe("Lifecycle regression — no illegal shortcut transitions", () => {
  it("cannot jump awaiting_approval straight to printed/completed", () => {
    expect(nextState("awaiting_approval", "mark_printed").ok).toBe(false);
    expect(nextState("awaiting_approval", "complete").ok).toBe(false);
  });
  it("printing cannot be re-batched (must be marked printed first)", () => {
    expect(nextState("printing", "create_batch").ok).toBe(false);
  });
});
