/**
 * Partner Management & Onboarding UX v1 — unit + source-assertion coverage.
 *
 * The repo has no DOM/RTL harness, so this follows the convention already established by
 * partner-management-admin-ui.test.ts: all page LOGIC lives in exported pure helpers and is unit
 * tested here, and the page COMPONENTS are verified by source assertion (required data-testids
 * present, submits gated, reasons required, accessible dialogs, no future-phase controls).
 *
 * The contract tests at the bottom are the load-bearing ones: they assert the client's field list
 * matches the server's allow-list and that no code path invents an audit action the database CHECK
 * constraint would reject. Those are the two ways this feature could silently half-work.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  canSuspendLocation,
  EMPTY_PARTNER_LOCATION_ADDRESS,
  PROFILE_FIELD_DEFS,
  PARTNER_LOCATION_CREATE_REASONS,
  PARTNER_USER_ROLES,
  isPartnerUserRole,
  profileFormFromRow,
  emailValid,
  websiteValid,
  telephoneValid,
  normalisePostcode,
  normaliseName,
  normalisePhone,
  normaliseUkPostcode,
  isValidUkPostcode,
  composePartnerLocationAddress,
  locationCreationAuditReason,
  validatePartnerLocationCreate,
  validateProfileForm,
  validateLegalName,
  validateInvitationForm,
  reasonError,
  canSubmit,
  diffProfile,
  isDirty,
  displayValue,
  EMPTY_VALUE_LABEL,
  isBlockingDuplicate,
  blockingDuplicates,
  overridableDuplicates,
  duplicateSummary,
  canCreateDespiteDuplicates,
  duplicateOverrideNote,
  computeChecklist,
  checklistProgress,
  googleMapsSearchUrl,
  profileHasDetail,
  invitationEditable,
  userInvitationReadOnly,
  invitationActions,
  submitAllowed,
  submitLabel,
  serverErrorMessage,
  type DuplicateMatch,
  type ProfileValues,
} from "../client/src/pages/admin/partner-management-helpers";

const ROOT = join(__dirname, "..");
const readSrc = (p: string) => readFileSync(join(ROOT, p), "utf8");

const DETAIL_PAGE = "client/src/pages/admin/partner-management-detail.tsx";
const LIST_PAGE = "client/src/pages/admin/partner-management.tsx";
const SERVER_ROUTES = "server/partner/partner-management-routes.ts";
const SERVER_SERVICE = "server/partner/partner-management-service.ts";

// ---------------------------------------------------------------------------------------------
// Field definitions
// ---------------------------------------------------------------------------------------------
describe("profile field definitions", () => {
  it("covers every operational field the pilot found missing", () => {
    const keys = PROFILE_FIELD_DEFS.map((f) => f.key);
    for (const required of [
      "trading_name",
      "primary_email",
      "primary_phone",
      "website",
      "address_line1",
      "address_city",
      "address_postcode",
      "address_country",
      "health_note",
    ]) {
      expect(keys).toContain(required);
    }
  });

  it("has no duplicate keys and every field carries a human label", () => {
    const keys = PROFILE_FIELD_DEFS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of PROFILE_FIELD_DEFS) {
      expect(f.label.trim().length).toBeGreaterThan(0);
      expect(f.max).toBeGreaterThan(0);
    }
  });

  it("profileFormFromRow yields every defined field, mapping null/missing to empty string", () => {
    const form = profileFormFromRow({ trading_name: "MV Test Cards", address_postcode: null });
    expect(Object.keys(form).sort()).toEqual(PROFILE_FIELD_DEFS.map((f) => f.key).sort());
    expect(form.trading_name).toBe("MV Test Cards");
    expect(form.address_postcode).toBe("");
    expect(form.website).toBe("");
  });

  it("profileFormFromRow tolerates a null/undefined row (partner with no profile yet)", () => {
    for (const row of [null, undefined]) {
      const form = profileFormFromRow(row);
      expect(Object.keys(form).length).toBe(PROFILE_FIELD_DEFS.length);
      expect(Object.values(form).every((v) => v === "")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------
describe("email validation", () => {
  it("accepts ordinary deliverable addresses", () => {
    for (const e of ["a@b.co", "oliver.test+pilot@gmail.com", "MintVaultUK@Gmail.com"]) {
      expect(emailValid(e)).toBe(true);
    }
  });

  it("rejects addresses that cannot be delivered", () => {
    for (const e of ["", "   ", "no-at-sign", "a@b", "a@@b.com", "a b@c.com", "@b.com", "a@", "a@.com", "a@b..com"]) {
      expect(emailValid(e)).toBe(false);
    }
  });

  it("rejects an over-length address", () => {
    expect(emailValid(`${"x".repeat(320)}@example.com`)).toBe(false);
  });
});

describe("website validation", () => {
  it("treats blank as valid (the field is optional)", () => {
    expect(websiteValid("")).toBe(true);
    expect(websiteValid("   ")).toBe(true);
  });

  it("accepts http and https URLs only", () => {
    expect(websiteValid("https://mintvaultuk.com")).toBe(true);
    expect(websiteValid("http://example.test/path")).toBe(true);
    expect(websiteValid("javascript:alert(1)")).toBe(false);
    expect(websiteValid("ftp://example.com")).toBe(false);
    expect(websiteValid("mintvaultuk.com")).toBe(false);
  });
});

describe("telephone validation", () => {
  it("treats blank as valid and accepts real-world formats", () => {
    expect(telephoneValid("")).toBe(true);
    expect(telephoneValid("01634 123456")).toBe(true);
    expect(telephoneValid("+44 (0)1634 123-456")).toBe(true);
  });

  it("rejects letters and numbers too short to be a phone number", () => {
    expect(telephoneValid("call me")).toBe(false);
    expect(telephoneValid("12345")).toBe(false);
    expect(telephoneValid("1".repeat(51))).toBe(false);
  });
});

describe("comparison normalisers (used for duplicate detection only)", () => {
  it("normalisePostcode ignores case and spacing", () => {
    expect(normalisePostcode("me2 2aa")).toBe("ME22AA");
    expect(normalisePostcode("ME2  2AA")).toBe(normalisePostcode("me22aa"));
  });

  it("normaliseName collapses case and internal whitespace", () => {
    expect(normaliseName("  MintVault   Pilot  Partner One Ltd ")).toBe("mintvault pilot partner one ltd");
  });

  it("normalisePhone keeps digits only", () => {
    expect(normalisePhone("+44 (0)1634 123-456")).toBe("4401634123456");
  });
});

describe("validateProfileForm", () => {
  const blank = (): ProfileValues => profileFormFromRow(null);

  it("accepts a fully blank profile — every profile field is optional", () => {
    expect(validateProfileForm(blank())).toEqual({});
  });

  it("accepts the pilot partner's real details", () => {
    const v = blank();
    v.trading_name = "MV Test Cards Strood";
    v.address_line1 = "Test Suite 1";
    v.address_line2 = "MintVault Pilot Centre";
    v.address_city = "Strood";
    v.address_postcode = "ME2 2AA";
    v.address_country = "United Kingdom";
    v.primary_email = "mintvaultuk@gmail.com";
    expect(validateProfileForm(v)).toEqual({});
  });

  it("reports a bad email, website and telephone against the right field keys", () => {
    const v = blank();
    v.primary_email = "not-an-email";
    v.website = "notaurl";
    v.primary_phone = "abc";
    const errors = validateProfileForm(v);
    expect(Object.keys(errors).sort()).toEqual(["primary_email", "primary_phone", "website"]);
    expect(errors.primary_email).toMatch(/valid email/i);
  });

  it("reports over-length values", () => {
    const v = blank();
    v.trading_name = "x".repeat(501);
    expect(validateProfileForm(v).trading_name).toMatch(/500 characters or fewer/);
  });
});

describe("validateLegalName", () => {
  it("requires a non-blank name", () => {
    expect(validateLegalName("")).toMatch(/required/i);
    expect(validateLegalName("   ")).toMatch(/required/i);
  });
  it("accepts a real name and rejects an over-length one", () => {
    expect(validateLegalName("MintVault Pilot Partner One Ltd")).toBeNull();
    expect(validateLegalName("x".repeat(501))).toMatch(/500/);
  });
});

describe("validateInvitationForm", () => {
  const ok = { firstName: "Oliver", lastName: "Test Partner", email: "mintvaultuk@gmail.com", role: "OWNER" };

  it("accepts a complete valid invitation", () => {
    expect(validateInvitationForm(ok)).toEqual({});
  });

  it("reports every missing required field at once, not one at a time", () => {
    const errors = validateInvitationForm({ firstName: "", lastName: "", email: "", role: "" });
    expect(Object.keys(errors).sort()).toEqual(["email", "firstName", "lastName", "role"]);
  });

  it("rejects an invalid role that did not come from the dropdown", () => {
    expect(validateInvitationForm({ ...ok, role: "SUPERUSER" }).role).toMatch(/role/i);
  });

  it("rejects a malformed email", () => {
    expect(validateInvitationForm({ ...ok, email: "oliver@" }).email).toMatch(/valid email/i);
  });

  it("only accepts roles from the declared list", () => {
    for (const r of PARTNER_USER_ROLES) expect(isPartnerUserRole(r)).toBe(true);
    expect(isPartnerUserRole("ROOT")).toBe(false);
  });
});

describe("reason validation and the submit gate", () => {
  it("requires a reason and explains why", () => {
    expect(reasonError("")).toMatch(/audit trail/i);
    expect(reasonError("   ")).toMatch(/audit trail/i);
    expect(reasonError("Correcting the postcode")).toBeNull();
  });

  it("rejects an over-length reason", () => {
    expect(reasonError("x".repeat(2001))).toMatch(/2000/);
  });

  it("canSubmit blocks on field errors, on a missing reason, and while pending", () => {
    expect(canSubmit({}, "a reason", false)).toBe(true);
    expect(canSubmit({ email: "bad" }, "a reason", false)).toBe(false);
    expect(canSubmit({}, "", false)).toBe(false);
    expect(canSubmit({}, "a reason", true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Dirty tracking / diff
// ---------------------------------------------------------------------------------------------
describe("diffProfile and dirty tracking", () => {
  it("reports nothing for an untouched form", () => {
    const before = profileFormFromRow({ trading_name: "MV Test Cards" });
    expect(diffProfile(before, { ...before })).toEqual([]);
    expect(isDirty(before, { ...before })).toBe(false);
  });

  it("treats a whitespace-only edit as no change (so it creates no audit row)", () => {
    const before = profileFormFromRow({ trading_name: "MV Test Cards" });
    const after = { ...before, trading_name: "  MV Test Cards  " };
    expect(diffProfile(before, after)).toEqual([]);
    expect(isDirty(before, after)).toBe(false);
  });

  it("reports each changed field with its label and both values", () => {
    const before = profileFormFromRow({ trading_name: "Old Name", address_postcode: "" });
    const after = { ...before, trading_name: "MV Test Cards Strood", address_postcode: "ME2 2AA" };
    const changes = diffProfile(before, after);
    expect(changes).toHaveLength(2);
    const trading = changes.find((c) => c.key === "trading_name")!;
    expect(trading.label).toBe("Trading name");
    expect(trading.before).toBe("Old Name");
    expect(trading.after).toBe("MV Test Cards Strood");
    expect(isDirty(before, after)).toBe(true);
  });

  it("detects clearing a field as a change", () => {
    const before = profileFormFromRow({ primary_phone: "01634 123456" });
    const after = { ...before, primary_phone: "" };
    expect(diffProfile(before, after)).toHaveLength(1);
  });

  it("renders an empty value as a readable placeholder, never as blank space", () => {
    expect(displayValue("")).toBe(EMPTY_VALUE_LABEL);
    expect(displayValue("   ")).toBe(EMPTY_VALUE_LABEL);
    expect(displayValue(" ME2 2AA ")).toBe("ME2 2AA");
  });
});

// ---------------------------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------------------------
describe("duplicate detection", () => {
  const match = (kind: DuplicateMatch["kind"], value = "v"): DuplicateMatch => ({
    kind,
    partnerId: "p1",
    partnerName: "Existing Partner Ltd",
    value,
  });

  it("treats an email collision as blocking and everything else as overridable", () => {
    expect(isBlockingDuplicate("email")).toBe(true);
    for (const k of ["legal_name", "trading_name", "postcode", "phone"] as const) {
      expect(isBlockingDuplicate(k)).toBe(false);
    }
  });

  it("splits matches into blocking and overridable sets", () => {
    const all = [match("email"), match("postcode"), match("phone")];
    expect(blockingDuplicates(all).map((m) => m.kind)).toEqual(["email"]);
    expect(overridableDuplicates(all).map((m) => m.kind)).toEqual(["postcode", "phone"]);
  });

  it("refuses creation on a blocking duplicate no matter what the admin acknowledges", () => {
    const r = canCreateDespiteDuplicates([match("email")], true);
    expect(r.allowed).toBe(false);
    expect(r.requiresAcknowledgement).toBe(false);
  });

  it("allows creation with no duplicates and asks for nothing", () => {
    expect(canCreateDespiteDuplicates([], false)).toEqual({ allowed: true, requiresAcknowledgement: false });
  });

  it("requires explicit acknowledgement for soft duplicates", () => {
    const soft = [match("postcode", "ME2 2AA")];
    expect(canCreateDespiteDuplicates(soft, false)).toEqual({ allowed: false, requiresAcknowledgement: true });
    expect(canCreateDespiteDuplicates(soft, true)).toEqual({ allowed: true, requiresAcknowledgement: true });
  });

  it("writes the override into the reason so it lands in the audit trail", () => {
    const note = duplicateOverrideNote([match("postcode"), match("phone"), match("postcode")]);
    expect(note).toMatch(/duplicate override acknowledged/);
    expect(note).toContain("phone");
    expect(note).toContain("postcode");
    expect(duplicateOverrideNote([])).toBe("");
    // A blocking-only set produces no override note — it is never overridable.
    expect(duplicateOverrideNote([match("email")])).toBe("");
  });

  it("summarises a duplicate in a sentence naming the existing partner and the value", () => {
    const s = duplicateSummary(match("postcode", "ME2 2AA"));
    expect(s).toContain("Existing Partner Ltd");
    expect(s).toContain("ME2 2AA");
    expect(s).toMatch(/postcode/);
  });
});

// ---------------------------------------------------------------------------------------------
// Setup checklist
// ---------------------------------------------------------------------------------------------
describe("administrative setup list", () => {
  const input = {
    companyCreated: true,
    hasOwner: false,
    hasInvitation: false,
    locationCount: 1,
    hasBranding: false,
    hasProfileDetail: false,
  };

  it("does not claim station or credits as administrative readiness", () => {
    const keys = computeChecklist(input).map((item) => item.key);
    expect(keys).not.toContain("device");
    expect(keys).not.toContain("credits");
  });

  it("reflects the real state of the achievable items", () => {
    const items = computeChecklist(input);
    expect(items.find((i) => i.key === "company")!.state).toBe("done");
    expect(items.find((i) => i.key === "location")!.state).toBe("done");
    expect(items.find((i) => i.key === "owner")!.state).toBe("todo");
  });

  it("reports an administrative count, never a readiness percentage", () => {
    const complete = computeChecklist({
      companyCreated: true,
      hasOwner: true,
      hasInvitation: true,
      locationCount: 1,
      hasBranding: true,
      hasProfileDetail: true,
    });
    expect(checklistProgress(complete)).toEqual({ done: 6, total: 6 });
  });

  it("reports the current administrative count", () => {
    expect(checklistProgress(computeChecklist(input))).toEqual({ done: 2, total: 6 });
  });

  it("reports no completed records for a bare company", () => {
    const items = computeChecklist({
      companyCreated: false,
      hasOwner: false,
      hasInvitation: false,
      locationCount: 0,
      hasBranding: false,
      hasProfileDetail: false,
    });
    expect(checklistProgress(items).done).toBe(0);
  });

  it("handles empty administrative lists", () => {
    expect(checklistProgress([{ key: "x", label: "x", state: "unavailable" }])).toEqual({ done: 0, total: 0 });
    expect(checklistProgress([])).toEqual({ done: 0, total: 0 });
  });

  it("profileHasDetail requires a trading name, a way to make contact, and a postcode", () => {
    expect(profileHasDetail(null)).toBe(false);
    expect(profileHasDetail({ trading_name: "MV Test Cards" })).toBe(false);
    expect(profileHasDetail({ trading_name: "MV", primary_email: "a@b.co" })).toBe(false);
    expect(profileHasDetail({ trading_name: "MV", primary_email: "a@b.co", address_postcode: "ME2 2AA" })).toBe(true);
    expect(profileHasDetail({ trading_name: "MV", primary_phone: "01634 123456", address_postcode: "ME2" })).toBe(true);
    // whitespace is not detail
    expect(profileHasDetail({ trading_name: "  ", primary_email: "a@b.co", address_postcode: "ME2" })).toBe(false);
  });
});

describe("location map navigation", () => {
  it("uses a URL-encoded external Google Maps search only when an address exists", () => {
    expect(googleMapsSearchUrl("12 High Street, London SW1A 1AA")).toBe(
      "https://www.google.com/maps/search/?api=1&query=12%20High%20Street%2C%20London%20SW1A%201AA"
    );
    expect(googleMapsSearchUrl(" ")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Invitation lifecycle
// ---------------------------------------------------------------------------------------------
describe("invitation lifecycle", () => {
  it("treats only open invitations as editable", () => {
    for (const s of ["PENDING", "SENT", "DELIVERY_FAILED"]) expect(invitationEditable(s)).toBe(true);
    for (const s of ["CONSUMED", "REVOKED", "EXPIRED"]) expect(invitationEditable(s)).toBe(false);
  });

  it("makes an accepted user's invitation read-only", () => {
    expect(userInvitationReadOnly("INVITED")).toBe(false);
    expect(userInvitationReadOnly("ACTIVE")).toBe(true);
    expect(userInvitationReadOnly("SUSPENDED")).toBe(true);
  });

  it("offers edit/resend/revoke only while the invitation is genuinely open", () => {
    expect(invitationActions("INVITED", "SENT")).toEqual({ canEdit: true, canResend: true, canRevoke: true });
    expect(invitationActions("INVITED", "CONSUMED")).toEqual({ canEdit: false, canResend: false, canRevoke: false });
    expect(invitationActions("ACTIVE", "SENT")).toEqual({ canEdit: false, canResend: false, canRevoke: false });
    expect(invitationActions("INVITED", null)).toEqual({ canEdit: false, canResend: false, canRevoke: false });
  });
});

// ---------------------------------------------------------------------------------------------
// Submit state / double-submit prevention
// ---------------------------------------------------------------------------------------------
describe("submit state machine", () => {
  it("blocks a second submit while one is in flight", () => {
    expect(submitAllowed("idle")).toBe(true);
    expect(submitAllowed("submitting")).toBe(false);
    expect(submitAllowed("success")).toBe(false);
    expect(submitAllowed("error")).toBe(true); // retry after a failure is allowed
  });

  it("swaps the button label while busy", () => {
    expect(submitLabel("idle", "Save changes", "Saving…")).toBe("Save changes");
    expect(submitLabel("submitting", "Save changes", "Saving…")).toBe("Saving…");
  });
});

// ---------------------------------------------------------------------------------------------
// Server error surfacing
// ---------------------------------------------------------------------------------------------
describe("serverErrorMessage", () => {
  it("rewrites a duplicate-user rejection into an actionable sentence", () => {
    const msg = serverErrorMessage({ error: { code: "DUPLICATE_PARTNER_USER", message: "A partner user…" } });
    expect(msg).toMatch(/already exists/i);
    expect(msg).toMatch(/different address/i);
  });

  it("explains a version conflict as a concurrent edit, not a validation failure", () => {
    const msg = serverErrorMessage({ error: { code: "VERSION_CONFLICT", message: "…" } });
    expect(msg).toMatch(/someone else changed/i);
    expect(msg).toMatch(/reload/i);
  });

  it("explains a capability failure as a deployment problem, not the admin's input", () => {
    const msg = serverErrorMessage({ error: "nope", code: "PARTNER_ADMIN_CAPABILITY_UNAVAILABLE" });
    expect(msg).toMatch(/deployment problem/i);
  });

  it("passes through a server validation message verbatim when there is no friendlier version", () => {
    const msg = serverErrorMessage({ error: { code: "VALIDATION_ERROR", message: "firstName is required." } });
    expect(msg).toBe("firstName is required.");
  });

  it("handles the older { error, code } envelope shape", () => {
    expect(serverErrorMessage({ error: "reason required", code: "BAD_REQUEST" })).toBe("reason required");
  });

  it("never renders [object Object] or an empty string for an unrecognised payload", () => {
    for (const p of [null, undefined, {}, { error: {} }, { error: 42 }, "boom"]) {
      const msg = serverErrorMessage(p);
      expect(msg).not.toContain("object Object");
      expect(msg.trim().length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// CONTRACT TESTS — the two ways this feature could silently half-work
// ---------------------------------------------------------------------------------------------
describe("client/server field contract", () => {
  it("every client profile field is in the server's allow-list (else the server drops it silently)", () => {
    const src = readSrc(SERVER_ROUTES);
    const block = src.slice(src.indexOf("function extractProfileFields"));
    // NOTE: the character class MUST include digits — address_line1 / address_line2 exist.
    const allowed =
      block
        .slice(0, block.indexOf("]"))
        .match(/"([a-z0-9_]+)"/g)
        ?.map((s) => s.replace(/"/g, "")) ?? [];
    expect(allowed.length).toBeGreaterThan(10);
    for (const f of PROFILE_FIELD_DEFS) {
      expect(allowed).toContain(f.key);
    }
  });

  it("the profile PATCH handler actually APPLIES the allow-list (mass-assignment guard)", () => {
    /*
     * Verifying the allow-list ARRAY is not enough: deleting the extractProfileFields CALL and
     * passing req.body straight through leaves the array untouched and every field assertion green,
     * while the request body flows unfiltered into the profile UPDATE. Pin the call site.
     */
    const src = readSrc(SERVER_ROUTES);
    const start = src.indexOf('r.patch("/partners/:partnerId/profile"');
    expect(start).toBeGreaterThan(-1);
    const handler = src.slice(start, src.indexOf("r.post(", start));
    expect(handler).toMatch(/const fields = extractProfileFields\(req\.body \?\? \{\}\)/);
    expect(handler).toMatch(/svc\.updateProfile\(actor, req\.params\.partnerId, fields,/);
  });

  it("the server service persists every field the client can edit", () => {
    const src = readSrc(SERVER_SERVICE);
    const start = src.indexOf("const PROFILE_FIELDS");
    expect(start).toBeGreaterThan(-1);
    // Anchor on the plain "]" — NOT "] as const". If the `as const` is ever dropped (a routine
    // refactor) indexOf returns -1, slice(0,-1) swallows the rest of the file, and the match set
    // silently becomes every quoted token in ~1200 lines — a vacuous pass.
    const block = src.slice(start);
    const end = block.indexOf("]");
    expect(end).toBeGreaterThan(0);
    const persisted =
      block
        .slice(0, end)
        .match(/"([a-z0-9_]+)"/g)
        ?.map((s) => s.replace(/"/g, "")) ?? [];
    // Non-vacuity guard: the real list has 15 entries. An empty/over-broad parse fails here.
    expect(persisted.length).toBeGreaterThan(10);
    expect(persisted.length).toBeLessThan(40);
    for (const f of PROFILE_FIELD_DEFS) {
      expect(persisted).toContain(f.key);
    }
  });
});

describe("canonical MFA-reset inventory (prevents a second divergent implementation)", () => {
  const ADMIN_ROUTES = "server/partner/admin-routes.ts";

  it("exactly ONE admin MFA-reset implementation exists — the legacy route delegates", () => {
    const legacy = readSrc(ADMIN_ROUTES);
    // The legacy URL is retained for compatibility but must own no implementation of its own.
    expect(legacy).toContain("resetPartnerUserMfa(actorOf(req)");
    expect(legacy).not.toContain("partner_mfa_methods");
    expect(legacy).not.toContain("partner_recovery_codes");
    // Must never re-introduce the defect that made it divergent. Match an SQL SET, not the word —
    // the file explains the old behaviour in prose and that explanation must stay readable.
    expect(legacy).not.toMatch(/SET[^;]*mfa_required\s*=\s*false/);
  });

  it("no server file outside the canonical service performs an ADMIN mfa teardown", () => {
    const dir = join(ROOT, "server", "partner");
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      // mfa-service.ts owns the USER's own self-service flows (enrol supersede, self-disable with
      // password) — different operations, deliberately excluded.
      if (f === "partner-management-service.ts" || f === "mfa-service.ts") continue;
      const src = readFileSync(join(dir, f), "utf8");
      if (/UPDATE partner_mfa_methods SET status='DISABLED'/.test(src)) offenders.push(f);
      if (/DELETE FROM partner_recovery_codes/.test(src)) offenders.push(f);
    }
    expect(offenders, "a second admin MFA-reset implementation has appeared").toEqual([]);
  });

  it("both MFA-reset routes are rate limited", () => {
    const legacy = readSrc(ADMIN_ROUTES);
    expect(legacy).toContain("legacyMutationRateLimit");
    expect(legacy).toMatch(/r\.post\("\/:partnerId\/users\/:userId\/mfa-reset", legacyMutationRateLimit/);
    // the new route sits after the router-level mutation limiter
    const routes = readSrc(SERVER_ROUTES);
    const limiterIdx = routes.indexOf("r.use(g5MutationRateLimit)");
    const resetIdx = routes.indexOf('r.post("/partners/:partnerId/users/:userId/reset-mfa"');
    expect(limiterIdx).toBeGreaterThan(-1);
    expect(resetIdx).toBeGreaterThan(limiterIdx);
  });

  it("the canonical service writes exactly ONE partner-visible security event", () => {
    const svc = readSrc(SERVER_SERVICE);
    const amend = svc.slice(svc.indexOf("export async function resetPartnerUserMfa"));
    const body = amend.slice(0, amend.indexOf("export async function", 10));
    const inserts = body.match(/INSERT INTO partner_security_events/g) ?? [];
    expect(inserts).toHaveLength(1);
    expect(body).toContain("'high','partner_mfa_admin_reset'");
  });
});

describe("route-ordering contract", () => {
  /**
   * Express matches routes in registration order. `/partners/duplicate-check` is a LITERAL path that
   * collides with the parameterised `/partners/:partnerId`. If the parameterised route is registered
   * first, "duplicate-check" is parsed as a partner id and the endpoint 404s — the duplicate warning
   * silently stops appearing, and creation continues with no warning at all. That is a fail-OPEN
   * regression a type-checker cannot catch, so it is pinned here.
   */
  it("registers /partners/duplicate-check BEFORE /partners/:partnerId", () => {
    const src = readSrc(SERVER_ROUTES);
    const literal = src.indexOf('r.get("/partners/duplicate-check"');
    const param = src.indexOf('r.get("/partners/:partnerId"');
    expect(literal).toBeGreaterThan(-1);
    expect(param).toBeGreaterThan(-1);
    expect(literal).toBeLessThan(param);
  });

  it("the duplicate-check route neither writes nor audits", () => {
    const src = readSrc(SERVER_ROUTES);
    const start = src.indexOf('r.get("/partners/duplicate-check"');
    const handler = src.slice(start, src.indexOf('r.get("/partners/:partnerId"', start));
    expect(handler).toContain("svc.findDuplicates");
    // A read-only probe must not reach any mutating helper or the audit ledger.
    expect(handler).not.toMatch(/mutationResponse|writeAuditLog|withAudit|INSERT|UPDATE|DELETE/);
  });
});

describe("audit-action contract (database CHECK constraint)", () => {
  /**
   * Reads the LATEST migration that (re)defines chk_partner_management_audit_action rather than a
   * hardcoded filename. The previous version pinned 0031; when 0033 legitimately extended the
   * constraint the test failed against a stale definition — a change-detector, not a contract test.
   * Discovering the newest definer keeps this a real contract check as the constraint evolves.
   */
  function latestPermittedActions(): string[] {
    const dir = join(ROOT, "migrations");
    const definers = readdirSync(dir)
      .filter((f) => /^\d{4}.*\.sql$/.test(f))
      .filter((f) => readFileSync(join(dir, f), "utf8").includes("ADD CONSTRAINT chk_partner_management_audit_action"))
      .sort();
    expect(definers.length, "some migration must define the audit-action constraint").toBeGreaterThan(0);
    const newest = definers[definers.length - 1];
    const sql = readFileSync(join(dir, newest), "utf8");
    const block = sql.slice(sql.lastIndexOf("ADD CONSTRAINT chk_partner_management_audit_action"));
    return (block.slice(0, block.indexOf("));")).match(/'([a-z_]+)'/g) ?? []).map((s) => s.replace(/'/g, ""));
  }

  function declaredActions(): string[] {
    const service = readSrc(SERVER_SERVICE);
    const block = service.slice(service.indexOf("type AuditAction ="));
    return (block.slice(0, block.indexOf(";")).match(/"([a-z_]+)"/g) ?? []).map((s) => s.replace(/"/g, ""));
  }

  it("every action type the service can write is permitted by the newest migration's constraint", () => {
    const permitted = latestPermittedActions();
    expect(permitted.length).toBeGreaterThan(5);
    const declared = declaredActions();
    expect(declared.length).toBeGreaterThan(5);
    expect(declared.filter((a) => !permitted.includes(a))).toEqual([]);
  });

  it("the Card Job void workflow emits exactly the canonical action admitted by the migration", () => {
    const service = readSrc(SERVER_SERVICE);
    const start = service.indexOf("export async function voidPartnerCardJob(");
    expect(start).toBeGreaterThan(-1);
    const body = service.slice(start, service.indexOf("async function lookupCardJobLocation", start));
    expect(body).toMatch(/withAudit\(actor, org\.id, "partner_card_job_voided", reason, \{ cardJobId \}/);
    expect(declaredActions()).toContain("partner_card_job_voided");
    expect(latestPermittedActions()).toContain("partner_card_job_voided");
  });
  it("the four owner-approved 0033 actions are BOTH declared in code and permitted by the migration", () => {
    const permitted = latestPermittedActions();
    const declared = declaredActions();
    for (const a of [
      "partner_user_mfa_reset",
      "partner_invitation_amended",
      "partner_legal_name_changed",
      "partner_duplicate_override",
    ]) {
      expect(permitted, `${a} must be permitted by the migration`).toContain(a);
      expect(declared, `${a} must be declared in the AuditAction union`).toContain(a);
    }
  });

  it("0033 is strictly additive — every pre-0033 action survives", () => {
    const permitted = latestPermittedActions();
    for (const a of [
      "partner_created",
      "profile_updated",
      "status_changed",
      "contact_added",
      "contact_updated",
      "contact_deactivated",
      "branding_updated",
      "note_added",
      "partner_user_invited",
      "partner_invitation_resent",
      "partner_invitation_revoked",
      "partner_invitation_accepted",
      "partner_user_role_changed",
      "partner_user_suspended",
      "partner_user_reactivated",
      "partner_user_password_reset_initiated",
      "partner_user_sessions_revoked",
      "partner_user_membership_removed",
    ]) {
      expect(permitted).toContain(a);
    }
  });

  it("a rename and an amendment now use their OWN precise actions, not borrowed neighbours", () => {
    const service = readSrc(SERVER_SERVICE);
    expect(service).toContain('withAudit(actor, org.id, "partner_legal_name_changed"');
    expect(service).toContain("'partner_invitation_amended'");
  });
});

// ---------------------------------------------------------------------------------------------
// Source assertions on the pages
// ---------------------------------------------------------------------------------------------
describe("detail page — edit partner", () => {
  const src = readSrc(DETAIL_PAGE);

  it("renders a real profile form, not a browser prompt", () => {
    expect(src).toContain('data-testid="pm-profile-form"');
    // window.prompt loses the value on cancel, cannot validate, and is not keyboard-accessible.
    // Match the CALL specifically — the file still mentions it in comments explaining the removal.
    expect(src).not.toMatch(/window\.prompt\(/);
  });

  it("exposes an input for every editable profile field", () => {
    expect(src).toContain("PROFILE_FIELD_DEFS");
    expect(src).toContain("data-testid={`pm-profile-field-${f.key}`}");
  });

  it("requires a reason and shows a before/after summary before saving", () => {
    expect(src).toContain('data-testid="pm-profile-reason"');
    expect(src).toContain('data-testid="pm-profile-diff"');
  });

  it("gates the save button through the shared submit rule", () => {
    expect(src).toContain("canSubmit(");
    expect(src).toContain('data-testid="pm-profile-save"');
  });

  it("warns about unsaved changes", () => {
    expect(src).toContain("isDirty(");
    expect(src).toContain('data-testid="pm-unsaved-warning"');
  });

  it("surfaces backend errors through the shared mapper rather than raw JSON", () => {
    expect(src).toContain("serverErrorMessage(");
  });
});

describe("detail page — invitation management", () => {
  const src = readSrc(DETAIL_PAGE);

  it("offers edit/resend/revoke driven by invitationActions, not by ad-hoc conditions", () => {
    expect(src).toContain("invitationActions(");
    expect(src).toContain('data-testid="pm-invitation-edit-form"');
  });

  it("shows inline field errors on the invitation form", () => {
    expect(src).toContain("validateInvitationForm(");
    // The per-field error id is BUILT AT RUNTIME inside UserInput (`${testId}-error`), so it never
    // appears literally in the source. Assert the observable wiring instead: UserInput takes an
    // `error` prop, renders it in an alert region with a derived testid, and the invitation form
    // feeds it from the validator (gated on `userTouched` so it only shows after a submit attempt).
    expect(src).toMatch(/const errId = `\$\{testId\}-error`/);
    expect(src).toMatch(/id=\{errId\}\s+role="alert"\s+data-testid=\{errId\}/);
    expect(src).toContain("error={userTouched ? userErrors.email : undefined}");
    // Both invitation forms gate error DISPLAY on a save attempt, so a freshly-opened dialog is
    // never pre-reddened (an invited user with no first name used to open straight into red).
    expect(src).toContain("error={inviteTouched ? inviteErrors.email : undefined}");
  });
});

describe("detail page — server readiness and administrative list", () => {
  const src = readSrc(DETAIL_PAGE);

  it("renders the computed administrative list without a readiness percentage", () => {
    expect(src).toContain("computeChecklist(");
    expect(src).toContain("checklistProgress(");
    expect(src).toContain('data-testid="pm-checklist-progress"');
    expect(src).toContain("ReadinessPanel");
  });

  it("does not render the administrative list as a progress bar", () => {
    expect(src).not.toContain('role="progressbar"');
  });
});

describe("list page — create with confirmation and duplicate detection", () => {
  const src = readSrc(LIST_PAGE);

  it("checks for duplicates before creating", () => {
    expect(src).toContain("duplicate-check");
    expect(src).toContain('data-testid="pm-create-duplicates"');
  });

  it("requires acknowledgement of soft duplicates and records the override in the reason", () => {
    expect(src).toContain("canCreateDespiteDuplicates(");
    expect(src).toContain("duplicateOverrideNote(");
    expect(src).toContain('data-testid="pm-create-dup-ack"');
  });

  it("shows a confirmation summary before the irreversible create", () => {
    expect(src).toContain('data-testid="pm-create-confirm-summary"');
  });

  it("prevents double-submit and shows a busy label", () => {
    expect(src).toContain("submitAllowed(");
    expect(src).toContain("submitLabel(");
  });
});

describe("hostile-review repairs (regression pins)", () => {
  const detail = readSrc(DETAIL_PAGE);
  const list = readSrc(LIST_PAGE);
  const helpers = readSrc("client/src/pages/admin/partner-management-helpers.ts");

  it("the checklist reads branding from the branding query, not the detail payload", () => {
    // getPartnerDetail returns {organisation, profile, primaryContact} — no `branding`. Reading
    // detail.data.branding pinned "Branding configured" to false forever, capping the bar at 83%.
    const service = readSrc(SERVER_SERVICE);
    const detailReturn = service.slice(service.indexOf("export async function getPartnerDetail"));
    expect(detailReturn.slice(0, detailReturn.indexOf("}\n"))).not.toContain("branding");
    expect(detail).toContain("hasBranding: !!branding.data?.branding");
    expect(detail).not.toContain("hasBranding: !!detail.data?.branding");
  });

  it("the branding query is loaded on the Overview tab so the checklist can see it", () => {
    expect(detail).toMatch(/enabled: on && \(tab === "branding" \|\| tab === "overview"\)/);
  });

  it("the checklist does not claim a login exists for a merely-invited owner", () => {
    expect(helpers).toContain('label: "Owner invited"');
    expect(helpers).not.toContain('label: "Owner login created"');
  });

  it("a DELIVERY_FAILED invitation does not tick 'Invitation sent'", () => {
    expect(detail).toContain('u.invitation_status !== "DELIVERY_FAILED"');
  });

  it("invitation success messages never claim delivery the server did not confirm", () => {
    expect(detail).toContain("deliveryBanner(");
    expect(detail).not.toContain('setBanner("Invitation updated and re-sent.');
  });

  it("a failed duplicate check is never rendered as 'No similar partner found'", () => {
    expect(list).toContain("dupCheckFailed");
    expect(list).toContain('data-testid="pm-create-dup-failed"');
    // the all-clear line must be conditional on the check having actually run
    expect(list).toContain("{!dupCheckFailed && duplicates.length === 0 && (");
  });

  it("the partners list cache is invalidated after a detail-page mutation", () => {
    // staleTime is Infinity, so without this the list shows the old name until a hard reload.
    expect(detail).toContain("queryKey: [`${BASE}/partners`]");
  });

  it("Escape closes the new dialogs, and routes the profile editor through the dirty check", () => {
    expect(detail).toMatch(/\[modal, noteOpen, userOpen, profileOpen, inviteEdit, profileDirty\]/);
    expect(detail).toMatch(/if \(profileOpen\) \{\s*\n\s*closeProfileEdit\(\);/);
  });

  it("saved address and internal notes are actually displayed on the profile tab", () => {
    for (const label of ["Address line 1", "Town / city", "Postcode", "Country", "Internal notes"]) {
      expect(detail).toContain(`<Field label="${label}"`);
    }
  });

  it("only CHANGED fields can block the save (legacy stored values must not lock the editor)", () => {
    expect(detail).toContain("changedKeys.has(k)");
    expect(detail).toContain("if (legalNameErr && legalNameChanged) blocking.legal_name = legalNameErr;");
  });

  it("the partial-save path adopts the saved name and refreshes the cached version", () => {
    expect(detail).toContain("setLegalNameBaseline(legalNameForm.trim())");
    expect(detail).not.toContain("PARTIAL SAVE —");
  });

  it("the mutation limiter keys on req.ip, not a hand-parsed X-Forwarded-For", () => {
    const routes = readSrc(SERVER_ROUTES);
    expect(routes).toContain("keyGenerator: adminClientIpRateLimitKey");
    expect(routes).not.toContain('req.headers["x-forwarded-for"]');
  });

  it("partner-management response bodies are suppressed from the request log", () => {
    const logger = readSrc("server/lib/request-logger.ts");
    expect(logger).toContain('"/api/super-admin/partner-management"');
  });

  it("the duplicate scan trims as well as collapsing whitespace, matching the client normaliser", () => {
    const service = readSrc(SERVER_SERVICE);
    expect(service).toContain("lower(btrim(regexp_replace(legal_name");
    expect(service).toContain("lower(btrim(regexp_replace(p.trading_name");
  });

  it("amend writes an audit row that survives a rollback and names both sides of the correction", () => {
    const service = readSrc(SERVER_SERVICE);
    const amend = service.slice(service.indexOf("export async function amendPendingInvitation"));
    const body = amend.slice(0, amend.indexOf("export async function listPartnerUsers"));
    expect(body).toContain("'attempted'");
    expect(body).toContain('intent: "amend_pending_invitation"');
    // written via the pooled helper (separate connection) so a rollback cannot erase it
    expect(body).toMatch(/await partnerAdminQuery\(\s*\n?\s*`INSERT INTO partner_management_audit/);
  });

  it("a post-commit delivery failure degrades instead of reporting the amend as failed", () => {
    const service = readSrc(SERVER_SERVICE);
    expect(service).toContain("DELIVERY_STATUS_UNKNOWN");
  });
});

describe("accessibility and safety invariants (unchanged from G5)", () => {
  const detail = readSrc(DETAIL_PAGE);
  const list = readSrc(LIST_PAGE);

  it("every dialog remains labelled and modal", () => {
    for (const src of [detail, list]) {
      const dialogs = src.match(/role="dialog"/g) ?? [];
      const modals = src.match(/aria-modal="true"/g) ?? [];
      expect(dialogs.length).toBeGreaterThan(0);
      expect(modals.length).toBe(dialogs.length);
    }
  });

  it("every inline error is announced to assistive technology", () => {
    expect(detail).toContain('role="alert"');
    expect(list).toContain('role="alert"');
  });

  it("introduces no future-phase controls (wallet, credits, billing, devices, pricing)", () => {
    for (const src of [detail, list]) {
      expect(src).not.toMatch(/topUpWallet|chargeCard|issueCredits|createInvoice|enrolDevice/);
    }
  });

  it("does not weaken the typed-confirmation on high-risk status changes", () => {
    expect(detail).toContain("isHighRiskStatus(");
    expect(detail).toContain('data-testid="pm-typed-confirm"');
  });
});

describe("AG-1 locations — the last-active-location rule, client side", () => {
  /*
   * The SERVER is the authority: setPartnerLocationStatus refuses this in SQL, inside the same
   * transaction that would perform it. These cases pin the client's advance warning, which exists
   * so an operator is not asked to type a reason into a dialog that cannot succeed.
   */
  it("refuses to suspend the only active location", () => {
    expect(canSuspendLocation("ACTIVE", 1)).toBe(false);
  });

  it("allows suspending one of several active locations", () => {
    expect(canSuspendLocation("ACTIVE", 2)).toBe(true);
    expect(canSuspendLocation("ACTIVE", 7)).toBe(true);
  });

  it("offers no suspend for a location that is not ACTIVE", () => {
    // SUSPENDED and PENDING are activated, not suspended again — the control is the other one.
    for (const status of ["SUSPENDED", "PENDING"]) {
      expect(canSuspendLocation(status, 5)).toBe(false);
    }
  });

  it("fails closed on a count that cannot be right", () => {
    // A zero/negative count means the list did not load. Offering the destructive action on a
    // number we do not believe is worse than withholding it.
    expect(canSuspendLocation("ACTIVE", 0)).toBe(false);
    expect(canSuspendLocation("ACTIVE", -1)).toBe(false);
  });
});

describe("location creation form contract", () => {
  const ukAddress = {
    ...EMPTY_PARTNER_LOCATION_ADDRESS,
    line1: " 2 Temple Gardens ",
    townCity: " Rochester ",
    postcode: " me2  2ng ",
  };

  it("composes a valid UK address into the existing one-string location authority", () => {
    expect(normaliseUkPostcode(ukAddress.postcode)).toBe("ME2 2NG");
    expect(isValidUkPostcode(ukAddress.postcode)).toBe(true);
    expect(composePartnerLocationAddress(ukAddress)).toBe("2 Temple Gardens, Rochester, ME2 2NG, United Kingdom");
  });

  it("uses only stable permitted audit reasons and requires an explanation for Other", () => {
    expect(PARTNER_LOCATION_CREATE_REASONS.map((option) => option.label)).toEqual([
      "New Partner location",
      "Additional shop/site",
      "Partner moved location",
      "Address correction",
      "Temporary location",
      "Administrative correction",
      "Other",
    ]);
    expect(locationCreationAuditReason("new_partner_location", "")).toBe("New Partner location");
    expect(locationCreationAuditReason("other", "  temporary pop-up  ")).toBe("Other: temporary pop-up");
    expect(
      validatePartnerLocationCreate({
        name: "Shop",
        address: EMPTY_PARTNER_LOCATION_ADDRESS,
        reason: "other",
        otherExplanation: "",
      })
    ).toMatchObject({ otherExplanation: "Please explain the reason." });
  });

  it("fails closed on invalid reasons and incomplete started addresses but keeps address optional", () => {
    expect(
      validatePartnerLocationCreate({
        name: "Shop",
        address: EMPTY_PARTNER_LOCATION_ADDRESS,
        reason: "forged",
        otherExplanation: "",
      })
    ).toMatchObject({ reason: "Select a valid reason." });
    expect(
      validatePartnerLocationCreate({
        name: "Shop",
        address: { ...EMPTY_PARTNER_LOCATION_ADDRESS, postcode: "ME2 2NG" },
        reason: "new_partner_location",
        otherExplanation: "",
      })
    ).toMatchObject({ line1: "Address line 1 is required.", townCity: "Town / City is required." });
    expect(
      validatePartnerLocationCreate({
        name: " Shop ",
        address: EMPTY_PARTNER_LOCATION_ADDRESS,
        reason: "new_partner_location",
        otherExplanation: "",
      })
    ).toEqual({});
    expect(
      validatePartnerLocationCreate({
        name: "S",
        address: EMPTY_PARTNER_LOCATION_ADDRESS,
        reason: "new_partner_location",
        otherExplanation: "",
      })
    ).toMatchObject({ name: "Location name must be 2–120 characters." });
    expect(
      validatePartnerLocationCreate({
        name: "S".repeat(121),
        address: EMPTY_PARTNER_LOCATION_ADDRESS,
        reason: "new_partner_location",
        otherExplanation: "",
      })
    ).toMatchObject({ name: "Location name must be 2–120 characters." });
    expect(composePartnerLocationAddress(EMPTY_PARTNER_LOCATION_ADDRESS)).toBeNull();
  });

  it("keeps the canonical route, audit action and encoded Maps link rather than introducing a new authority", () => {
    const detail = readSrc(DETAIL_PAGE);
    const routes = readSrc(SERVER_ROUTES);
    const service = readSrc(SERVER_SERVICE);
    expect(detail).toContain('data-testid="pm-location-reason"');
    expect(detail).toContain("data-testid={`pm-location-maps-${l.id}`}");
    expect(detail).toContain("aria-label={`Open ${l.name} address in Google Maps`}");
    expect(detail).toContain("googleMapsSearchUrl(l.address)");
    expect(routes).toContain('r.post("/partners/:partnerId/locations"');
    expect(service).toContain('withAudit(actor, org.id, "partner_location_created"');
    expect(service).toContain("WHERE tenant_id = $1");
  });
});
