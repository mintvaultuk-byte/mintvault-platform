/**
 * Partner Portal — submission wizard UI (Increment B) — source-assertion tests (the Partner Portal
 * is an isolated, unmounted-in-production surface with no RTL/jsdom harness, so we assert on the
 * committed source the way tests/grading-workstation-ux-redesign.test.ts does for grading UI).
 * Proves:
 *   - all 5 steps (Customer, Service, Cards, Review, Submit) exist with a visible progress indicator;
 *   - a stable idempotency key guards submit against double-click / retry duplication;
 *   - submit is disabled while a request is in flight (no way to fire twice);
 *   - version-checked edits surface a conflict state rather than silently overwriting;
 *   - copy never uses internal jargon ("tenant", "RLS", raw error JSON, "[object Object]");
 *   - intake observations are explicitly labelled as not a MintVault grade wherever a card note is shown;
 *   - pricing is always shown via formatPence(), which appends "price confirmed by MintVault";
 *   - the wizard never imports/touches protected grading surfaces.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const WIZARD = read("client/src/pages/partner/submission-wizard.tsx");
const DETAIL = read("client/src/pages/partner/submission-detail.tsx");
const API = read("client/src/lib/partner-api.ts");
const ROUTES = read("server/partner/submission-routes.ts");
const COMING_SOON = read("client/src/pages/partner/coming-soon.tsx");
const LOCATIONS_PAGE = read("client/src/pages/partner/locations.tsx");
const BILLING_PAGE = read("client/src/pages/partner/billing.tsx");
const SHELL = read("client/src/components/partner/partner-shell.tsx");

describe("wizard has all 5 steps with a visible progress indicator", () => {
  it("declares all 5 step labels in order", () => {
    expect(WIZARD).toContain('const STEPS = ["Customer", "Service", "Cards", "Review", "Submit"]');
  });
  it("renders a step indicator for each step with aria-current on the active one", () => {
    expect(WIZARD).toContain('data-testid="wizard-progress"');
    expect(WIZARD).toContain("data-testid={`step-indicator-${i + 1}`}");
    expect(WIZARD).toContain('aria-current={i === currentStep ? "step" : undefined}');
  });
  it("renders one step panel per step, each with its own data-testid", () => {
    for (const key of ["customer", "service", "cards", "review", "submit"]) {
      expect(WIZARD).toContain(`data-testid="wizard-step-${key}"`);
    }
  });
});

describe("double-submit / duplication safety", () => {
  it("generates the idempotency key once via useMemo, keyed off the submission id (not per render)", () => {
    expect(WIZARD).toContain('useMemo(() => (submission ? newIdempotencyKey(submission.id) : ""), [submission?.id])');
  });
  it("guards handleSubmit against re-entry while a request is in flight", () => {
    const fn = WIZARD.slice(
      WIZARD.indexOf("async function handleSubmit"),
      WIZARD.indexOf("async function handleSubmit") + 600
    );
    expect(fn).toMatch(/if \(!submission \|\| submitting\) return;/);
  });
  it("disables the confirm-submit button while submitting or while anything required is still missing", () => {
    // Submit's enabled state must reuse the SAME "missing" check as the Review step's warning
    // banner (a real bug found in review: Submit was previously enabled by card-count alone,
    // letting a partner skip past an incomplete Review straight to an active Submit button).
    expect(WIZARD).toContain("disabled={submitting || missing.length > 0 || (shortfall != null && shortfall > 0)}");
    expect(WIZARD).toContain('data-testid="button-confirm-submit"');
  });
  it("Review and Submit steps share one computed 'missing' list, not two independent checks", () => {
    expect(WIZARD).toContain('if (!submission.customerId) missing.push("Customer");');
    expect(WIZARD).toContain('if (!submission.serviceTierCode) missing.push("Service");');
    expect(WIZARD).toContain('if (savedCardCount === 0) missing.push("At least one card");');
    expect(WIZARD).toContain('missing.push("Front and back images for every card")');
    // ReviewStep/SubmitStep receive it as a prop rather than recomputing their own copy.
    expect(WIZARD).toMatch(/<ReviewStep[\s\S]*?missing=\{missing\}/);
    expect(WIZARD).toMatch(/<SubmitStep[\s\S]*?missing=\{missing\}/);
  });
  it("passes the idempotency key through to partnerSubmissions.submit", () => {
    expect(WIZARD).toContain("partnerSubmissions.submit(submission.id, idempotencyKey)");
  });
  it("newIdempotencyKey is not called anywhere inside a render-path JSX expression", () => {
    // Only the single useMemo call site should exist.
    const matches = WIZARD.match(/newIdempotencyKey\(/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe("optimistic-concurrency conflict is surfaced, never silently overwritten", () => {
  it("saveField distinguishes stale_version from a generic save error", () => {
    // Narrowed through the typed error class rather than `catch (err: any)` + optional chaining —
    // the project bans `any`, and the old form silently tolerated any shape reaching this branch.
    expect(WIZARD).toContain('err instanceof PartnerApiError && err.code === "stale_version"');
    expect(WIZARD).toContain('setSaveStatus("conflict")');
    expect(WIZARD).not.toContain("catch (err: any)");
  });
  it("a rejected new-customer save shows the server's reason instead of swallowing it", () => {
    expect(WIZARD).toContain("setCustomerError(partnerErrorMessage(err))");
    expect(WIZARD).toContain('data-testid="text-new-customer-error"');
  });
  it("every PATCH-style edit call includes the current submission.version", () => {
    expect(WIZARD).toContain("partnerSubmissions.edit(submission.id, { version: submission.version, ...patch })");
  });
  it("the wizard rehydrates from submission detail after create, field edits, and card/image mutations", () => {
    expect(WIZARD).toContain("const syncDraftDetail = useCallback((detail: SubmissionDetail)");
    expect(WIZARD).toContain("const detail = await partnerSubmissions.detail(created.id)");
    expect(WIZARD).toContain("await refreshDraft(updated.id)");
    expect(WIZARD).toContain("await refreshDraft(submission.id)");
  });
  it("existing/new customer selection does not mark the customer selected until the PATCH persists", () => {
    const create = WIZARD.slice(
      WIZARD.indexOf("async function handleCreateCustomer"),
      WIZARD.indexOf("async function selectExistingCustomer")
    );
    const select = WIZARD.slice(
      WIZARD.indexOf("async function selectExistingCustomer"),
      WIZARD.indexOf("async function clearCustomer")
    );
    expect(create).not.toContain("setCustomerDisplay(created.fullName)");
    expect(select).not.toContain("setCustomerDisplay(c.fullName)");
    expect(select).toContain("const saved = await saveField({ customerId: c.id })");
  });
  it("customer change is a real tri-state clear persisted as customerId: null", () => {
    expect(WIZARD).toContain("async function clearCustomer()");
    expect(WIZARD).toContain("saveField({ customerId: null })");
    expect(WIZARD).toContain("onClick={props.onClearCustomer}");
    expect(ROUTES).toContain("customerId: asStringOrExplicitNull(body.customerId)");
  });
  it("Continue is gated by authoritative saved step state, not optimistic local display fields", () => {
    expect(WIZARD).toContain("const canContinue =");
    expect(WIZARD).toContain("!!submission.customerId");
    expect(WIZARD).toContain("!!submission.serviceTierCode");
    expect(WIZARD).toContain("savedCardCount > 0 && !cardsMissingImages");
    expect(WIZARD).toContain("disabled={!canContinue}");
  });
  it("the save-status indicator shows a plain-English conflict message, not a technical one", () => {
    expect(WIZARD).toContain("This submission was updated elsewhere. Refresh before saving again.");
  });
});

describe("no internal jargon leaks into wizard copy", () => {
  const FORBIDDEN = ["tenant", "RLS", "row-level security", "feature key", "credential version", "[object Object]"];
  it("wizard source contains none of the forbidden internal terms in user-facing copy", () => {
    for (const term of FORBIDDEN) {
      expect(WIZARD.toLowerCase()).not.toContain(term.toLowerCase());
    }
  });
  it("detail page source contains none of the forbidden internal terms", () => {
    for (const term of FORBIDDEN) {
      expect(DETAIL.toLowerCase()).not.toContain(term.toLowerCase());
    }
  });
  it("partnerErrorMessage() is the only path from a caught error to displayed text (never err.message raw JSON)", () => {
    expect(WIZARD).toContain("partnerErrorMessage(err)");
    expect(WIZARD).not.toMatch(/data-testid="text-(submit|add-card)-error"[^]*?\{err\.message\}/);
  });
});

describe("intake observations are never presented as a MintVault grade", () => {
  it("wizard cards list labels intake notes explicitly as not a grade", () => {
    expect(WIZARD).toContain("Intake observation — not a MintVault grade:");
  });
  it("wizard's add-card form labels the intake field the same way", () => {
    expect(WIZARD).toContain(
      'Intake observation <span className="text-xs text-muted-foreground">— not a MintVault grade</span>'
    );
  });
  it("submission-detail page repeats the same disclaimer for any shown intake note", () => {
    expect(DETAIL).toContain("Intake observation — not a MintVault grade:");
  });
  it("review step reminds the partner intake notes are not grades before they submit", () => {
    expect(WIZARD).toContain("Intake observations recorded on cards are not MintVault grades.");
  });
});

describe("pricing is always shown as an estimate confirmed by MintVault", () => {
  it("formatPence never returns a bare price with no confirmation caveat", () => {
    const fn = API.slice(API.indexOf("export function formatPence"), API.indexOf("export function formatPence") + 300);
    expect(fn).toContain("price confirmed by MintVault");
  });
  it("wizard's review step renders price via formatPence, not a raw pence value", () => {
    expect(WIZARD).toContain("formatPence(tier.pricePerCardPence)");
  });
  it("detail page renders price via formatPence, not a raw pence value", () => {
    expect(DETAIL).toContain("formatPence(submission.estimatedPricePence)");
  });
});

describe("wizard never touches protected grading surfaces", () => {
  it("does not import from client/src/components/grading or shared/schema grade constants", () => {
    expect(WIZARD).not.toMatch(/from ["']@\/components\/grading/);
    expect(WIZARD).not.toMatch(/gradeLabel|isNonNumericGrade|MVGS/);
  });
});

describe("success screen offers the required next actions without duplicating submission", () => {
  it("renders View Submission, Open Grading, and Start Another Submission", () => {
    expect(WIZARD).toContain('data-testid="button-view-submission"');
    expect(WIZARD).toContain('data-testid="button-open-grading"');
    expect(WIZARD).toContain('data-testid="button-start-another"');
  });
  it("does not call partnerSubmissions.create again from the success panel (no accidental double draft)", () => {
    const panel = WIZARD.slice(WIZARD.indexOf("function SubmitSuccessPanel"));
    expect(panel).not.toContain("partnerSubmissions.create");
  });
  it("Open Grading is a real navigation action (no fake network call, no dead onClick)", () => {
    const panel = WIZARD.slice(WIZARD.indexOf("function SubmitSuccessPanel"));
    const gradingButton = panel.slice(
      panel.indexOf('data-testid="button-open-grading"') - 200,
      panel.indexOf('data-testid="button-open-grading"') + 100
    );
    expect(gradingButton).toContain('navigate("/partner/grading")');
  });
});

describe("strict quantity error copy matches the repo's established convention", () => {
  it("card-add form's quantity field never silently defaults an invalid value — errors surface via partnerErrorMessage", () => {
    const addForm = WIZARD.slice(WIZARD.indexOf("async function submitAdd"), WIZARD.indexOf("function CardEditRow"));
    expect(addForm).toContain('data-testid="text-add-card-error"');
    expect(addForm).toContain("setError(partnerErrorMessage(err))");
    expect(addForm).toContain("quantity: Number(form.quantity)");
    expect(addForm).not.toContain("quantity: Number(form.quantity) || 1");
  });
});

describe("no grade, subgrade, or certificate input exists anywhere in the wizard", () => {
  // "grade" alone would false-positive on legitimate copy ("Standard Grading" tier label, the
  // "not a MintVault grade" disclaimer) — check for an actual INPUT/field pattern instead.
  const FORBIDDEN_FIELDS = [
    "subgrade",
    "certId",
    "certificateId",
    "certNumber",
    "mvgs",
    "numericGrade",
    "assignGrade",
    "gradeValue",
  ];
  it("wizard source never collects a grade/subgrade/certificate value from the partner", () => {
    for (const term of FORBIDDEN_FIELDS) {
      expect(WIZARD.toLowerCase()).not.toContain(term.toLowerCase());
    }
  });
  it("the only appearances of 'grade' are the service-tier label and the not-a-grade disclaimer, never an input field", () => {
    const graded = WIZARD.match(/.{20}grade.{20}/gi) ?? [];
    for (const snippet of graded) {
      expect(snippet).toMatch(/Grading|not a MintVault grade|not MintVault grades/i);
    }
  });
});

describe("service tier selection is API-backed only — no free-text/arbitrary service code entry", () => {
  it("the service step renders tiers from the API list, never a free-text or manually-typed code field", () => {
    const serviceStep = WIZARD.slice(
      WIZARD.indexOf("function ServiceStep"),
      WIZARD.indexOf("// ---------------- Step 3")
    );
    expect(serviceStep).not.toMatch(/<Input/);
    expect(serviceStep).toContain("tiers.map");
  });
});

describe("draft save-status and stale-conflict wording is plain English, not technical", () => {
  it("save status copy never says 'version', 'PATCH', 'HTTP', or exposes a raw error code", () => {
    const indicator = WIZARD.slice(
      WIZARD.indexOf("function SaveStatusIndicator"),
      WIZARD.indexOf("function SaveStatusIndicator") + 700
    );
    expect(indicator.toLowerCase()).not.toMatch(/\bversion\b|\bpatch\b|\bhttp\b/);
  });
});

describe("Locations and Billing use their real partner APIs", () => {
  it("shared coming-soon component says 'Not available yet' with no data-driven content", () => {
    expect(COMING_SOON).toContain("Not available yet.");
    expect(COMING_SOON).not.toMatch(/useQuery|fetch\(|apiRequest/);
  });
  it("Locations lists only the server-scoped partner locations", () => {
    expect(LOCATIONS_PAGE).not.toContain("PartnerComingSoon");
    expect(LOCATIONS_PAGE).toMatch(/useQuery|partnerLocations\.list/);
    expect(LOCATIONS_PAGE).toContain("Active grading location");
  });
  it("Billing renders real wallet and ledger values without fabricating missing data", () => {
    expect(BILLING_PAGE).not.toContain("PartnerComingSoon");
    expect(BILLING_PAGE).toContain("partnerCredits.view()");
    expect(BILLING_PAGE).toContain("Not available");
    expect(BILLING_PAGE).toContain("runningBalance");
  });
  it("Billing uses the authoritative package and checkout contracts without client-side prices", () => {
    expect(API).toContain('"GET", "/api/partner/credits/packages"');
    expect(API).toContain('"POST", "/api/partner/credits/checkout"');
    expect(BILLING_PAGE).toContain("partnerCredits.packages()");
    expect(BILLING_PAGE).toContain("partnerCredits.checkout(packageId, returnPathFromSearch())");
    expect(BILLING_PAGE).toContain("window.location.assign(checkoutUrl)");
    expect(BILLING_PAGE).not.toContain("credits-10");
  });
  it("a credit shortfall returns to the same draft and blocks submission until the wallet can cover it", () => {
    expect(WIZARD).toContain('const draftId = useMemo(() => readQueryValue("draft"), []);');
    expect(WIZARD).toContain("void refreshDraft(draftId)");
    expect(WIZARD).toContain("billingReturnPath");
    expect(WIZARD).toContain('data-testid="button-buy-credits-shortfall"');
    expect(WIZARD).toContain("shortfall != null && shortfall > 0");
  });
});

describe("no internal tenant/RLS terminology is shown anywhere in the shell", () => {
  const FORBIDDEN = ["tenant", "RLS", "row-level security", "feature key", "credential version", "[object Object]"];
  it("partner-shell.tsx source contains none of the forbidden internal terms in JSX copy", () => {
    // Allow the terms in code comments (developer-facing) but not inside rendered strings/JSX text.
    const withoutComments = SHELL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const term of FORBIDDEN) {
      expect(withoutComments.toLowerCase()).not.toContain(term.toLowerCase());
    }
  });
});

describe("rejected location switch is handled, not an unhandled crash", () => {
  it("LocationSwitcher catches a failed switch and shows a plain-English message instead of throwing", () => {
    const switcher = SHELL.slice(SHELL.indexOf("function LocationSwitcher"));
    expect(switcher).toContain("try {");
    expect(switcher).toContain("catch");
    expect(switcher).toContain('data-testid="text-location-switch-error"');
    expect(switcher).toContain("Couldn't switch to that location. You may not be assigned there.");
  });
  it("a single-location user sees a plain name ONLY once the session is bound to that location", () => {
    const switcher = SHELL.slice(SHELL.indexOf("function LocationSwitcher"));
    expect(switcher).toContain("locations.length === 1");
    expect(switcher).toContain('data-testid="text-single-location"');
    // The plain-name branch must ALSO require that the session already holds this location.
    // Guarding on set size alone was an unrecoverable dead end: the wizard refuses to start
    // without a location and directs the operator to a switcher that rendered as an inert <span>.
    expect(switcher).toContain("session?.locationId === locations[0].id");
  });
  it("a single-location user with NO location bound still gets an interactive control, not an inert span", () => {
    const switcher = SHELL.slice(SHELL.indexOf("function LocationSwitcher"));
    const plainBranch = switcher.indexOf('data-testid="text-single-location"');
    const selectControl = switcher.indexOf('data-testid="select-location-switcher"');
    // The real <Select> must sit AFTER the plain-name early return, i.e. it is what an
    // unbound single-location user falls through to.
    expect(plainBranch).toBeGreaterThan(-1);
    expect(selectControl).toBeGreaterThan(plainBranch);
  });
  it("the location switcher is reachable on mobile too, not desktop-only (review finding: it was hidden below sm, but the wizard's own copy tells a locationless user to use it)", () => {
    // Rendered twice: once desktop-only in the header, once inside the mobile menu panel.
    const matches = SHELL.match(/<LocationSwitcher wrapperClassName=/g) ?? [];
    expect(matches.length).toBe(2);
    expect(SHELL).toContain('wrapperClassName="hidden md:flex"');
    expect(SHELL).toMatch(/mobile[\s\S]{0,300}LocationSwitcher wrapperClassName="flex/i);
  });
});

describe("submission-detail page never links to an unbuilt resume/edit route (review finding: dead link to /partner/submissions/:id/edit)", () => {
  it("does not reference a submissions/:id/edit path anywhere", () => {
    expect(DETAIL).not.toMatch(/submissions\/\$\{[^}]*\}\/edit/);
    expect(DETAIL).not.toContain("Resume this draft");
  });
});

describe("card edit and remove failures are surfaced, never a silent no-op or a stuck UI state (review findings F5/F6)", () => {
  it("CardEditRow's save button wraps onSave in try/catch, always clears the saving flag, and shows a real error", () => {
    const row = WIZARD.slice(WIZARD.indexOf("function CardEditRow"), WIZARD.indexOf("// ---------------- Step 4"));
    expect(row).toContain("try {");
    expect(row).toContain("} catch (err) {");
    expect(row).toContain("setError(partnerErrorMessage(err))");
    expect(row).toContain("} finally {");
    expect(row).toContain("setSaving(false)");
    expect(row).toMatch(/data-testid=\{`text-edit-card-error-\$\{card\.id\}`\}/);
  });
  it("handleRemoveCard catches a failed delete and surfaces it instead of leaving the card silently stuck", () => {
    const fn = WIZARD.slice(
      WIZARD.indexOf("async function handleRemoveCard"),
      WIZARD.indexOf("async function handleRemoveCard") + 500
    );
    expect(fn).toContain("try {");
    expect(fn).toContain("} catch (err) {");
    expect(fn).toContain("setRemoveCardError(partnerErrorMessage(err))");
  });
  it("CardsStep renders the remove-card error to the user", () => {
    expect(WIZARD).toContain('data-testid="text-remove-card-error"');
  });
});

describe("free-text field saves are debounced, so normal typing never produces a false stale-version conflict (review finding F3)", () => {
  it("internal reference changes go through a debounced save, not an immediate saveField call on every keystroke", () => {
    expect(WIZARD).toContain("saveInternalReferenceDebounced");
    expect(WIZARD).not.toContain(
      "onInternalReferenceChange={(v) => {\n            setInternalReference(v);\n            saveField({ internalReference: v });\n          }}"
    );
  });
});
