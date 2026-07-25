/**
 * Behavioural proof of the locked NO / authentication-only rule (owner-approved 2026-07-25).
 *
 * These test the DECISION FUNCTION the handlers actually call, not a hand-retyped copy —
 * so unlike source-string assertions, they fail if the rule's logic regresses, and they
 * cannot be satisfied by an implementation that merely contains the right words.
 *
 * THE RULE
 *   • Normal approval may NEVER change the kind, in either direction.
 *   • A published certificate's kind may not be changed by ordinary grading/editing
 *     routes; that needs Super Admin Correction Mode.
 *   • Setting the kind on a never-approved certificate is ordinary grading work.
 */
import { describe, expect, it } from "vitest";
import {
  CANONICAL_GRADE_TYPES,
  gradeTypeToPersist,
  kindOfGradeType,
  kindOfOverallGrade,
  normaliseGradeType,
  rejectKindChange,
} from "../server/lib/grade-kind";

const APPROVAL = { allowChangeWhenUnapproved: false } as const;
const DRAFT = { allowChangeWhenUnapproved: true } as const;

describe("normaliseGradeType", () => {
  it("passes through every legal value", () => {
    for (const t of CANONICAL_GRADE_TYPES) expect(normaliseGradeType(t)).toBe(t);
  });

  it("coerces junk, null, empty and non-strings to 'numeric' rather than persisting them", () => {
    // grade_type is plain text with no CHECK constraint, and one write path historically
    // persisted an unvalidated body value — which would then leak into the public
    // population labels, which emit the raw column.
    for (const junk of ["banana", "", "  ", null, undefined, 7, {}, [], true, "NUMERIC", "no", "aa"]) {
      expect(normaliseGradeType(junk)).toBe("numeric");
    }
  });

  it("trims surrounding whitespace on an otherwise legal value", () => {
    expect(normaliseGradeType(" NO ")).toBe("NO");
  });
});

describe("kindOfGradeType", () => {
  it("collapses legacy long forms onto their short form", () => {
    expect(kindOfGradeType("not_original")).toBe("NO");
    expect(kindOfGradeType("authentic_altered")).toBe("AA");
    expect(kindOfGradeType("NO")).toBe("NO");
    expect(kindOfGradeType("AA")).toBe("AA");
  });

  it("treats numeric, junk and empty as numeric", () => {
    for (const v of ["numeric", "banana", "", null, undefined]) expect(kindOfGradeType(v)).toBe("numeric");
  });
});

describe("kindOfOverallGrade is exact — no sloppy or hostile token is accepted", () => {
  it("accepts only the exact NO/AA tokens", () => {
    expect(kindOfOverallGrade("NO")).toBe("NO");
    expect(kindOfOverallGrade("AA")).toBe("AA");
  });

  it("treats lowercase, padded and legacy long forms as numeric, so they cannot smuggle a kind change", () => {
    for (const v of ["no", "aa", " NO ", "NO ", "not_original", "authentic_altered", "N0"]) {
      expect(kindOfOverallGrade(v)).toBe("numeric");
    }
  });

  it("treats a numeric grade, junk and absence as numeric", () => {
    for (const v of ["8.5", 8.5, "", null, undefined, [], {}]) expect(kindOfOverallGrade(v)).toBe("numeric");
  });
});

describe("APPROVAL routes: the kind can never change", () => {
  it("refuses numeric -> authentication-only (the MV205 conversion hole)", () => {
    for (const requested of ["NO", "AA"] as const) {
      const msg = rejectKindChange({
        storedGradeType: "numeric",
        requestedKind: requested,
        isApproved: false,
        ...APPROVAL,
      });
      expect(msg).toBeTruthy();
      expect(msg).toMatch(/numeric certificate/i);
    }
  });

  it("refuses authentication-only -> numeric", () => {
    const msg = rejectKindChange({ storedGradeType: "NO", requestedKind: "numeric", isApproved: true, ...APPROVAL });
    expect(msg).toBeTruthy();
    expect(msg).toMatch(/authentication-only/i);
  });

  it("refuses a NO <-> AA switch, because they print differently", () => {
    expect(
      rejectKindChange({ storedGradeType: "NO", requestedKind: "AA", isApproved: false, ...APPROVAL })
    ).toBeTruthy();
    expect(
      rejectKindChange({ storedGradeType: "AA", requestedKind: "NO", isApproved: false, ...APPROVAL })
    ).toBeTruthy();
  });

  it("refuses regardless of approval state — approval is never the place to convert", () => {
    for (const isApproved of [true, false]) {
      expect(
        rejectKindChange({ storedGradeType: "numeric", requestedKind: "NO", isApproved, ...APPROVAL })
      ).toBeTruthy();
    }
  });

  it("ALLOWS a matching kind", () => {
    expect(
      rejectKindChange({ storedGradeType: "numeric", requestedKind: "numeric", isApproved: false, ...APPROVAL })
    ).toBeNull();
    expect(rejectKindChange({ storedGradeType: "NO", requestedKind: "NO", isApproved: true, ...APPROVAL })).toBeNull();
    expect(rejectKindChange({ storedGradeType: "AA", requestedKind: "AA", isApproved: true, ...APPROVAL })).toBeNull();
  });

  it("ALLOWS a legacy long form matched by its short form (same outcome, two spellings)", () => {
    expect(
      rejectKindChange({ storedGradeType: "not_original", requestedKind: "NO", isApproved: true, ...APPROVAL })
    ).toBeNull();
    expect(
      rejectKindChange({ storedGradeType: "authentic_altered", requestedKind: "AA", isApproved: true, ...APPROVAL })
    ).toBeNull();
  });

  it("treats a junk stored value as numeric and refuses converting it", () => {
    expect(
      rejectKindChange({ storedGradeType: "banana", requestedKind: "NO", isApproved: false, ...APPROVAL })
    ).toBeTruthy();
    expect(
      rejectKindChange({ storedGradeType: "banana", requestedKind: "numeric", isApproved: false, ...APPROVAL })
    ).toBeNull();
  });
});

describe("DRAFT/EDIT routes: published records are protected, unapproved grading is not blocked", () => {
  it("REFUSES a kind change on a PUBLISHED certificate and names Correction Mode", () => {
    const msg = rejectKindChange({ storedGradeType: "numeric", requestedKind: "NO", isApproved: true, ...DRAFT });
    expect(msg).toBeTruthy();
    expect(msg).toMatch(/Super Admin Correction Mode/);
  });

  it("REFUSES the reverse direction on a published certificate too", () => {
    const msg = rejectKindChange({ storedGradeType: "AA", requestedKind: "numeric", isApproved: true, ...DRAFT });
    expect(msg).toBeTruthy();
    expect(msg).toMatch(/Super Admin Correction Mode/);
  });

  it("ALLOWS setting the kind on a never-approved certificate — that is ordinary grading", () => {
    // Without this a card could never be graded authentication-only in the first place.
    expect(
      rejectKindChange({ storedGradeType: "numeric", requestedKind: "NO", isApproved: false, ...DRAFT })
    ).toBeNull();
    expect(
      rejectKindChange({ storedGradeType: "numeric", requestedKind: "AA", isApproved: false, ...DRAFT })
    ).toBeNull();
    expect(
      rejectKindChange({ storedGradeType: "NO", requestedKind: "numeric", isApproved: false, ...DRAFT })
    ).toBeNull();
    expect(rejectKindChange({ storedGradeType: "NO", requestedKind: "AA", isApproved: false, ...DRAFT })).toBeNull();
  });

  it("ALLOWS a matching kind on a published certificate (an ordinary metadata save)", () => {
    expect(rejectKindChange({ storedGradeType: "NO", requestedKind: "NO", isApproved: true, ...DRAFT })).toBeNull();
    expect(
      rejectKindChange({ storedGradeType: "numeric", requestedKind: "numeric", isApproved: true, ...DRAFT })
    ).toBeNull();
  });
});

describe("gradeTypeToPersist", () => {
  it("keeps a legacy long form when the kind matches, so an unrelated save never normalises it", () => {
    expect(gradeTypeToPersist("not_original", "NO")).toBe("not_original");
    expect(gradeTypeToPersist("authentic_altered", "AA")).toBe("authentic_altered");
  });

  it("writes the canonical short form when the kind legitimately changes", () => {
    expect(gradeTypeToPersist("numeric", "NO")).toBe("NO");
    expect(gradeTypeToPersist("NO", "numeric")).toBe("numeric");
    expect(gradeTypeToPersist("not_original", "AA")).toBe("AA");
  });

  it("never writes junk back — it normalises to numeric", () => {
    expect(gradeTypeToPersist("banana", "numeric")).toBe("numeric");
    expect(gradeTypeToPersist(null, "numeric")).toBe("numeric");
    expect(gradeTypeToPersist("", "numeric")).toBe("numeric");
  });

  it("only ever returns a legal value, for every combination", () => {
    for (const stored of [...CANONICAL_GRADE_TYPES, "banana", "", null, undefined, 7]) {
      for (const kind of ["numeric", "NO", "AA"] as const) {
        expect(CANONICAL_GRADE_TYPES).toContain(gradeTypeToPersist(stored, kind));
      }
    }
  });
});

describe("exhaustive matrix — no combination silently converts a published certificate", () => {
  it("every stored/requested pair on an APPROVED record either matches or is refused", () => {
    const stored = [...CANONICAL_GRADE_TYPES, "banana", "", null];
    for (const s of stored) {
      for (const kind of ["numeric", "NO", "AA"] as const) {
        const matches = kindOfGradeType(s) === kind;
        // Approval route
        expect(
          rejectKindChange({ storedGradeType: s, requestedKind: kind, isApproved: true, ...APPROVAL }) === null
        ).toBe(matches);
        // Draft/edit route on a published record — identical protection
        expect(rejectKindChange({ storedGradeType: s, requestedKind: kind, isApproved: true, ...DRAFT }) === null).toBe(
          matches
        );
        // And when it IS allowed, the persisted value never changes the kind
        if (matches) expect(kindOfGradeType(gradeTypeToPersist(s, kind))).toBe(kind);
      }
    }
  });
});
