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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROFILE_FIELD_DEFS,
  PARTNER_USER_ROLES,
  isPartnerUserRole,
  profileFormFromRow,
  emailValid,
  websiteValid,
  telephoneValid,
  normalisePostcode,
  normaliseName,
  normalisePhone,
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
  checklistPercent,
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
describe("setup checklist", () => {
  const input = {
    companyCreated: true,
    hasOwner: false,
    hasInvitation: false,
    locationCount: 1,
    hasBranding: false,
    hasProfileDetail: false,
  };

  it("marks device and credits unavailable rather than permanently unticked", () => {
    const items = computeChecklist(input);
    expect(items.find((i) => i.key === "device")!.state).toBe("unavailable");
    expect(items.find((i) => i.key === "credits")!.state).toBe("unavailable");
    // and each explains why, so the admin does not go looking for a button that does not exist
    expect(items.find((i) => i.key === "device")!.hint).toBeTruthy();
    expect(items.find((i) => i.key === "credits")!.hint).toBeTruthy();
  });

  it("reflects the real state of the achievable items", () => {
    const items = computeChecklist(input);
    expect(items.find((i) => i.key === "company")!.state).toBe("done");
    expect(items.find((i) => i.key === "location")!.state).toBe("done");
    expect(items.find((i) => i.key === "owner")!.state).toBe("todo");
  });

  it("excludes unavailable items from the percentage so the bar can reach 100", () => {
    const complete = computeChecklist({
      companyCreated: true,
      hasOwner: true,
      hasInvitation: true,
      locationCount: 1,
      hasBranding: true,
      hasProfileDetail: true,
    });
    expect(checklistPercent(complete)).toBe(100);
  });

  it("computes an honest intermediate percentage", () => {
    // 6 achievable items; company + location done = 2/6 = 33%
    expect(checklistPercent(computeChecklist(input))).toBe(33);
  });

  it("reports 0% for a bare company", () => {
    const items = computeChecklist({
      companyCreated: false,
      hasOwner: false,
      hasInvitation: false,
      locationCount: 0,
      hasBranding: false,
      hasProfileDetail: false,
    });
    expect(checklistPercent(items)).toBe(0);
  });

  it("never divides by zero when every item is unavailable", () => {
    expect(checklistPercent([{ key: "x", label: "x", state: "unavailable" }])).toBe(0);
    expect(checklistPercent([])).toBe(0);
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
    const allowed = block.slice(0, block.indexOf("]")).match(/"([a-z0-9_]+)"/g)?.map((s) => s.replace(/"/g, "")) ?? [];
    expect(allowed.length).toBeGreaterThan(0);
    for (const f of PROFILE_FIELD_DEFS) {
      expect(allowed).toContain(f.key);
    }
  });

  it("the server service persists every field the client can edit", () => {
    const src = readSrc(SERVER_SERVICE);
    const block = src.slice(src.indexOf("const PROFILE_FIELDS"));
    const persisted =
      block.slice(0, block.indexOf("] as const")).match(/"([a-z0-9_]+)"/g)?.map((s) => s.replace(/"/g, "")) ?? [];
    for (const f of PROFILE_FIELD_DEFS) {
      expect(persisted).toContain(f.key);
    }
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
   * partner_management_audit has CHECK chk_partner_management_audit_action restricting action_type to
   * a fixed list (migrations/0015 + 0031). Writing an action outside that list raises a constraint
   * violation at runtime — a 500 the admin sees as "something went wrong". This release adds NO new
   * action type, and this test fails if a future change introduces one without a migration.
   */
  it("every action type the service can write is permitted by the migration's CHECK constraint", () => {
    const migration = readSrc("migrations/0031_partner_user_management.sql");
    const constraintBlock = migration.slice(migration.lastIndexOf("chk_partner_management_audit_action"));
    const permitted = new Set(
      (constraintBlock.slice(0, constraintBlock.indexOf("));")).match(/'([a-z_]+)'/g) ?? []).map((s) =>
        s.replace(/'/g, "")
      )
    );
    expect(permitted.size).toBeGreaterThan(5);

    // The service's own AuditAction union is the exhaustive set of values it can pass as action_type.
    const service = readSrc(SERVER_SERVICE);
    const unionBlock = service.slice(service.indexOf("type AuditAction ="));
    const declared = (unionBlock.slice(0, unionBlock.indexOf(";")).match(/"([a-z_]+)"/g) ?? []).map((s) =>
      s.replace(/"/g, "")
    );
    expect(declared.length).toBeGreaterThan(5);

    const unpermitted = declared.filter((a) => !permitted.has(a));
    expect(unpermitted).toEqual([]);
  });

  it("this release adds no new audit action type (adding one would need a migration)", () => {
    const service = readSrc(SERVER_SERVICE);
    const unionBlock = service.slice(service.indexOf("type AuditAction ="));
    const declared = (unionBlock.slice(0, unionBlock.indexOf(";")).match(/"([a-z_]+)"/g) ?? []).map((s) =>
      s.replace(/"/g, "")
    );
    // The new operations deliberately reuse existing action types:
    //   rename        -> profile_updated
    //   amend invite  -> partner_user_invited
    expect(declared).toContain("profile_updated");
    expect(declared).toContain("partner_user_invited");
    expect(declared).not.toContain("legal_name_changed");
    expect(declared).not.toContain("partner_invitation_amended");
    expect(declared).not.toContain("duplicate_override");
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
    expect(src).toContain('data-testid={`pm-profile-field-${f.key}`}');
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
    expect(src).toContain("error={inviteErrors.email}");
  });
});

describe("detail page — checklist", () => {
  const src = readSrc(DETAIL_PAGE);

  it("renders the computed checklist with a percentage", () => {
    expect(src).toContain("computeChecklist(");
    expect(src).toContain("checklistPercent(");
    expect(src).toContain('data-testid="pm-checklist-percent"');
  });

  it("exposes progress to assistive technology, not colour alone", () => {
    expect(src).toContain('role="progressbar"');
    expect(src).toContain("aria-valuenow");
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
