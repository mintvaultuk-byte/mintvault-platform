import { describe, it, expect } from "vitest";
import { isSubmissionOwnedBySession, authorizeSubmissionDownload } from "../server/lib/customer-documents";

describe("isSubmissionOwnedBySession (BOLA core)", () => {
  it("matches on normalized customer email (case/space-insensitive)", () => {
    expect(
      isSubmissionOwnedBySession({ customer_email: "Ada@Example.com" }, { customerEmail: " ada@example.com " })
    ).toBe(true);
  });

  it("rejects a different customer's email", () => {
    expect(isSubmissionOwnedBySession({ customer_email: "ada@example.com" }, { customerEmail: "eve@evil.com" })).toBe(
      false
    );
  });

  it("matches on linked unified-user id even when emails differ/absent", () => {
    expect(isSubmissionOwnedBySession({ user_id: "u-1", customer_email: null }, { userId: "u-1" })).toBe(true);
  });

  it("does NOT match on user id when only one side has it", () => {
    expect(isSubmissionOwnedBySession({ user_id: "u-1" }, { userId: null, customerEmail: "x@y.com" })).toBe(false);
  });

  it("empty-vs-empty email never matches (no spurious ownership)", () => {
    expect(isSubmissionOwnedBySession({ customer_email: "" }, { customerEmail: "" })).toBe(false);
    expect(isSubmissionOwnedBySession({}, {})).toBe(false);
  });
});

describe("authorizeSubmissionDownload (owner / wrong-customer / anonymous-shape / draft)", () => {
  const owner = { customerEmail: "ada@example.com" };

  it("allows the owner of a non-draft submission", () => {
    expect(authorizeSubmissionDownload({ customer_email: "ada@example.com", status: "received" }, owner)).toEqual({
      ok: true,
    });
  });

  it("returns an indistinguishable 404 for a missing submission", () => {
    expect(authorizeSubmissionDownload(null, owner)).toEqual({ ok: false, status: 404 });
    expect(authorizeSubmissionDownload(undefined, owner)).toEqual({ ok: false, status: 404 });
  });

  it("returns 404 for a soft-deleted submission (even if owned)", () => {
    expect(
      authorizeSubmissionDownload(
        { customer_email: "ada@example.com", status: "received", deleted_at: new Date() },
        owner
      )
    ).toEqual({ ok: false, status: 404 });
  });

  it("returns 404 for another customer's submission (not 403, not 400 — indistinguishable)", () => {
    expect(authorizeSubmissionDownload({ customer_email: "eve@evil.com", status: "received" }, owner)).toEqual({
      ok: false,
      status: 404,
    });
  });

  it("hides a wrong-owner DRAFT as 404 too (ownership checked before state)", () => {
    expect(authorizeSubmissionDownload({ customer_email: "eve@evil.com", status: "draft" }, owner)).toEqual({
      ok: false,
      status: 404,
    });
  });

  it("returns 400 for the owner's own draft (owned but not ready)", () => {
    expect(authorizeSubmissionDownload({ customer_email: "ada@example.com", status: "draft" }, owner)).toEqual({
      ok: false,
      status: 400,
    });
  });
});
