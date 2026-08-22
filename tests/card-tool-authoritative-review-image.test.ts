/**
 * Super Admin Card Tool regression: the review-image fallback reached the DISPLAY path
 * (ImageViewer) but not the Card Tool enable gate or its launch payload, so an authorised
 * reviewer saw the card render while both Card Tool buttons stayed disabled.
 *
 * Both call sites now read `card-tool-image-source`, so the button and the tool cannot disagree.
 * Authorisation is NOT decided here — `reviewEvidence` is emitted only by
 * buildSuperAdminCertImagesPayload, so grader/Partner payloads simply never carry it.
 */
import { describe, expect, it } from "vitest";
import { cardToolEnabled, cardToolImageSource } from "../client/src/components/grading/card-tool-image-source";

const URLS = {
  front_working: "https://signed.test/front_working.jpg",
  back_working: "https://signed.test/back_working.jpg",
  front_review: "https://signed.test/front_review.jpg",
  back_review: "https://signed.test/back_review.jpg",
};
const OK = { front: { available: true }, back: { available: true } };
const NO = { front: { available: false }, back: { available: false } };

describe("CASE A — working evidence absent, authorised review evidence available", () => {
  const args = { urls: URLS, workingEvidence: NO, reviewEvidence: OK };

  it("enables the Card Tool for BOTH sides", () => {
    expect(cardToolEnabled({ ...args, side: "front" })).toBe(true);
    expect(cardToolEnabled({ ...args, side: "back" })).toBe(true);
  });

  it("opens FRONT from the authorised FRONT review image, never BACK", () => {
    expect(cardToolImageSource({ ...args, side: "front" })).toBe(URLS.front_review);
  });

  it("opens BACK from the authorised BACK review image, never FRONT", () => {
    expect(cardToolImageSource({ ...args, side: "back" })).toBe(URLS.back_review);
  });
});

describe("CASE B — both available: working evidence stays preferred", () => {
  const args = { urls: URLS, workingEvidence: OK, reviewEvidence: OK };

  it("prefers working evidence on both sides (no priority regression)", () => {
    expect(cardToolImageSource({ ...args, side: "front" })).toBe(URLS.front_working);
    expect(cardToolImageSource({ ...args, side: "back" })).toBe(URLS.back_working);
  });
});

describe("NEGATIVE proofs", () => {
  it("no admitted image on a side -> that side's tool is disabled", () => {
    const args = { urls: URLS, workingEvidence: NO, reviewEvidence: NO };
    expect(cardToolEnabled({ ...args, side: "front" })).toBe(false);
    expect(cardToolImageSource({ ...args, side: "front" })).toBeNull();
  });

  it("a URL without the companion server admission is NOT admissible", () => {
    // Stale query data / older endpoint: the URL exists, the server never admitted it.
    expect(cardToolImageSource({ side: "front", urls: URLS, workingEvidence: undefined, reviewEvidence: undefined })).toBeNull();
  });

  it("FRONT never borrows BACK when only BACK is admitted", () => {
    const args = { urls: URLS, workingEvidence: NO, reviewEvidence: { front: { available: false }, back: { available: true } } };
    expect(cardToolImageSource({ ...args, side: "front" })).toBeNull();
    expect(cardToolEnabled({ ...args, side: "front" })).toBe(false);
    expect(cardToolImageSource({ ...args, side: "back" })).toBe(URLS.back_review);
  });

  it("BACK never borrows FRONT when only FRONT is admitted", () => {
    const args = { urls: URLS, workingEvidence: NO, reviewEvidence: { front: { available: true }, back: { available: false } } };
    expect(cardToolImageSource({ ...args, side: "back" })).toBeNull();
    expect(cardToolImageSource({ ...args, side: "front" })).toBe(URLS.front_review);
  });

  it("admitted but URL missing -> unavailable, never a derivative", () => {
    const args = { urls: { front_working: null, front_review: null }, workingEvidence: OK, reviewEvidence: OK };
    expect(cardToolImageSource({ ...args, side: "front" })).toBeNull();
  });

  it("STRICT ROUTES: a payload with no reviewEvidence (grader/Partner) stays working-evidence-only", () => {
    // buildCertImagesPayload never emits reviewEvidence, so the review branch is unreachable there.
    const strict = { urls: URLS, workingEvidence: NO, reviewEvidence: undefined };
    expect(cardToolEnabled({ ...strict, side: "front" })).toBe(false);
    expect(cardToolEnabled({ ...strict, side: "back" })).toBe(false);
  });

  it("cert A's payload can only ever yield cert A's URLs", () => {
    const certA = { front_working: null, front_review: "https://signed.test/A_front_review.jpg" };
    expect(cardToolImageSource({ side: "front", urls: certA, workingEvidence: NO, reviewEvidence: OK })).toBe(certA.front_review);
  });
});

/**
 * SUPER ADMIN TOOLING RULE (owner-locked 2026-08-22): if Super Admin has a server-authorised
 * image for the selected side, that side's grading tools must be available BEFORE the card is
 * graded. They may depend on an authorised image existing, on server-side Super Admin
 * authorisation, and on side-safe admission — never on grade completion or identity confirmation.
 *
 * This is enforced structurally: the resolver takes ONLY side + urls + the two server admission
 * maps. There is no grade, status, or identity input it could depend on, so an ungraded card
 * behaves identically to a graded one by construction.
 */
describe("Super Admin tools on an UNGRADED card", () => {
  const REVIEW_FRONT_ONLY = { front: { available: true }, back: { available: false } };
  const REVIEW_BACK_ONLY = { front: { available: false }, back: { available: true } };
  const NONE = { front: { available: false }, back: { available: false } };

  it("ungraded + review FRONT only -> FRONT tools enabled, BACK disabled", () => {
    const a = { urls: URLS, workingEvidence: NONE, reviewEvidence: REVIEW_FRONT_ONLY };
    expect(cardToolEnabled({ ...a, side: "front" })).toBe(true);
    expect(cardToolImageSource({ ...a, side: "front" })).toBe(URLS.front_review);
    expect(cardToolEnabled({ ...a, side: "back" })).toBe(false);
  });

  it("ungraded + review BACK only -> BACK tools enabled, FRONT disabled", () => {
    const a = { urls: URLS, workingEvidence: NONE, reviewEvidence: REVIEW_BACK_ONLY };
    expect(cardToolEnabled({ ...a, side: "back" })).toBe(true);
    expect(cardToolImageSource({ ...a, side: "back" })).toBe(URLS.back_review);
    expect(cardToolEnabled({ ...a, side: "front" })).toBe(false);
  });

  it("ungraded + review FRONT and BACK -> BOTH tool sets enabled", () => {
    const a = { urls: URLS, workingEvidence: NONE, reviewEvidence: OK };
    expect(cardToolEnabled({ ...a, side: "front" })).toBe(true);
    expect(cardToolEnabled({ ...a, side: "back" })).toBe(true);
  });

  it("working evidence still wins on an ungraded card", () => {
    const a = { urls: URLS, workingEvidence: OK, reviewEvidence: OK };
    expect(cardToolImageSource({ ...a, side: "front" })).toBe(URLS.front_working);
  });

  it("no authorised image -> tools disabled even for Super Admin", () => {
    const a = { urls: URLS, workingEvidence: NONE, reviewEvidence: NONE };
    expect(cardToolEnabled({ ...a, side: "front" })).toBe(false);
    expect(cardToolEnabled({ ...a, side: "back" })).toBe(false);
  });

  it("cannot cross-fallback between sides on an ungraded card", () => {
    const front = { urls: URLS, workingEvidence: NONE, reviewEvidence: REVIEW_FRONT_ONLY };
    expect(cardToolImageSource({ ...front, side: "back" })).toBeNull();
    const back = { urls: URLS, workingEvidence: NONE, reviewEvidence: REVIEW_BACK_ONLY };
    expect(cardToolImageSource({ ...back, side: "front" })).toBeNull();
  });

  it("the decision cannot depend on grade state — no such input exists", () => {
    // Passing grade-ish extras must not change the outcome; they are not part of the contract.
    const base = { urls: URLS, workingEvidence: NONE, reviewEvidence: REVIEW_FRONT_ONLY, side: "front" as const };
    const withNoise = { ...base, ...({ gradingStatus: "submitted", identityConfirmed: false } as any) };
    expect(cardToolImageSource(withNoise)).toBe(cardToolImageSource(base));
  });
});
