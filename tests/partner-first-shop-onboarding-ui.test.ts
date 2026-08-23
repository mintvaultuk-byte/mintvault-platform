import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("first-shop guided onboarding UI contract", () => {
  it("collects the canonical delivery/contact/Owner fields and labels the current scope", () => {
    const page = read("client/src/pages/admin/partner-first-shop-onboarding.tsx");
    for (const required of [
      // ONE create form: shop, Owner, delivery address. The operations contact is revealed only
      // when a different one is wanted, and the Main location name is not asked for at all.
      "Shop / legal name",
      "Address line 1",
      "Town / city",
      "Postcode",
      "Country",
      "Use a different operations contact",
      "Operational email",
      "Current Partner:",
      "Current location:",
      "Station enrolment must come from the real shop Scanner",
      "Open credits / billing readiness",
    ]) expect(page).toContain(required);
    // The form must NOT ask for these: the server supplies both.
    expect(page).not.toContain('label="Main location name"');
    expect(page).toContain("/first-shop/location");
    expect(page).toContain("/first-shop/operations-contact");
    expect(page).toContain("first-shop-create-submit");
    const routes = read("server/partner/partner-management-routes.ts");
    expect(routes).toContain("snapshot.mainLocation.id");
  });

  it("routes both a new shop and an existing Partner to the guided workflow before generic partner matching", () => {
    const app = read("client/src/App.tsx");
    const newGuide = app.indexOf('path="/admin/partners/onboarding"');
    const existingGuide = app.indexOf('path="/admin/partners/:partnerId/onboarding"');
    const genericPartner = app.indexOf('path="/admin/partners/:partnerId"');
    expect(newGuide).toBeGreaterThan(-1);
    expect(existingGuide).toBeGreaterThan(-1);
    expect(genericPartner).toBeGreaterThan(existingGuide);
    expect(app).toContain("AdminPartnerFirstShopOnboardingPage");
  });

  it("replaces the primary generic create control with the guided first-shop entry", () => {
    const directory = read("client/src/pages/admin/partner-management.tsx");
    expect(directory).toContain('href="/admin/partners/onboarding"');
    expect(directory).toContain("Onboard first shop");
  });

  it("gives the authenticated Partner Owner one scoped confirmation page rather than a second authority", () => {
    const ownerPage = read("client/src/pages/partner/onboarding.tsx");
    const app = read("client/src/App.tsx");
    const routes = read("server/partner/routes.ts");
    const dashboard = read("client/src/pages/partner/dashboard.tsx");

    for (const required of [
      "Current Partner:",
      "Current location:",
      "Confirm delivery address",
      "Confirm operations contact",
      "Security &amp; Account",
      "Open Credits &amp; Billing",
      "ReadinessPanel",
    ]) expect(ownerPage).toContain(required);
    expect(app).toContain('path="/partner/onboarding"');
    expect(routes).toContain('r.get("/onboarding"');
    expect(routes).toContain('roles.includes("PARTNER_OWNER")');
    expect(routes).toContain('"/onboarding/main-location"');
    expect(routes).toContain('"/onboarding/operations-contact"');
    expect(routes).toContain("requireNotViewOnly");
    expect(routes).toContain("requireNotSensitiveFrozen");
    expect(dashboard).toContain('href="/partner/onboarding"');
    expect(dashboard).toContain("Complete shop setup");
  });
});

/**
 * The two confirmed Shop #1 blockers, proven at the wizard.
 *
 * Staging 2026-08-21 cost a whole onboarding session to these: a location-scoped operator with no
 * location (the Scanner offered nothing to enrol against) and a station approval that could only be
 * reached by hunting through Station Fleet. Both are now actions inside onboarding.
 */
describe("first-shop onboarding owns staff assignment and station approval", () => {
  const page = () => read("client/src/pages/admin/partner-first-shop-onboarding.tsx");

  it("has a Staff step that assigns an authorised location to a location-scoped operator", () => {
    const p = page();
    expect(p).toContain("Staff and operator access");
    expect(p).toContain("first-shop-staff-unassigned");
    expect(p).toContain("first-shop-staff-location-select");
    expect(p).toContain("first-shop-assign-location-");
    // Canonical audited authority — never a direct write.
    expect(p).toContain("/users/${userId}/locations");
    expect(p).toContain("locationIds");
    expect(p).toContain("reason:");
  });

  it("only offers assignment for LOCATION-SCOPED operators — org-wide roles keep their semantics", () => {
    const p = page();
    expect(p).toContain("ORG_WIDE_ROLE_CODES");
    expect(p).toContain('"PARTNER_OWNER", "PARTNER_MANAGER", "PARTNER_FINANCE_VIEWER"');
    expect(p).toContain("location_eligible !== true");
  });

  it("blocks assignment when the shop has no ACTIVE location, instead of offering a dead control", () => {
    expect(page()).toContain("first-shop-staff-no-location");
  });

  it("surfaces SCANNER WAITING FOR APPROVAL with an inline Approve Scanner action", () => {
    const p = page();
    expect(p).toContain("SCANNER WAITING FOR APPROVAL");
    expect(p).toContain("Approve Scanner");
    expect(p).toContain("first-shop-approve-station-");
    // The EXISTING canonical station transition, behind the EXISTING admin step-up.
    expect(p).toContain("/api/super-admin/fleet/stations/");
    expect(p).toContain("/active");
    expect(p).toContain("runAdminProtected");
  });

  it("refreshes onboarding state after approval rather than requiring a manual reload", () => {
    const p = page();
    expect(p).toContain("invalidateQueries");
    expect(p).toContain("refetchInterval");
  });

  it("renders calibration and credits state from the server readiness, not a client calculation", () => {
    const p = page();
    expect(p).toContain("dimensions.scanner.message");
    expect(p).toContain("dimensions.credits.message");
    expect(p).toContain("dimensions.staff?.message");
    /*
     * Ready remains server-authoritative — via `onboarding.complete` rather than `overall.ready`
     * since the test-card step landed. The two answer different questions (see the shared readiness
     * contract): `ready` is "can this shop grade a card now", which is true before any test card
     * exists, and `onboarding.complete` additionally requires the shop to have proven one end to
     * end. This assertion is about WHERE the verdict comes from, and it still comes from the server.
     */
    expect(p).toContain("shop.operational.onboarding.complete");
  });
});

/**
 * THE TEST-CARD STEP, and the Ready step it now gates.
 *
 * The wizard's numbering is the operator's mental model of onboarding, so the step's POSITION is
 * part of the contract, not decoration: Test Card is step 9 and Ready moved to step 10. These are
 * asserted against the page source because the wizard's data only arrives from a live server; what
 * can be proven statically is that the copy is rendered from the server verdict rather than
 * re-derived here, which is the property that actually matters.
 */
describe("first-shop wizard — the onboarding test card", () => {
  const page = () => read("client/src/pages/admin/partner-first-shop-onboarding.tsx");

  it("numbers ten steps, with Test Card at 9 and Ready at 10", () => {
    const source = page();
    expect(source).toContain('<Step number={9} title="Test card"');
    expect(source).toContain('<Step number={10} title="Ready"');
    // The eight steps before it are unchanged, so nothing was renumbered underneath the operator.
    for (const [number, title] of [
      [1, "Shop"],
      [2, "Main location delivery address"],
      [3, "Primary operations contact"],
      [4, "Partner Owner"],
      [5, "Staff and operator access"],
      [6, "Scanner station"],
      [7, "Calibration and Scanner health"],
      [8, "Credits"],
    ] as Array<[number, string]>) {
      expect(source).toContain(`<Step number={${number}} title="${title}"`);
    }
    expect(source).not.toContain("<Step number={11}");
  });

  it("renders the test-card sentence from the server verdict rather than deriving one", () => {
    const source = page();
    expect(source).toContain("{shop.operational.testCard.message}");
    expect(source).toContain('data-state={shop.operational.testCard.state}');
    // No client-side status interpretation: the six states are the server's to decide.
    expect(source).not.toMatch(/testCard\.cardJob\?\.status\s*===/);
    expect(source).not.toContain('cardJob.status === "READY_TO_GRADE"');
  });

  it("gates Ready on onboarding completion, not on the operational verdict alone", () => {
    const source = page();
    expect(source).toContain("complete={shop.operational.onboarding.complete}");
    expect(source).toContain("{shop.operational.onboarding.message}");
    // `overall.ready` answers a different question and must no longer decide this step.
    expect(source).not.toContain("complete={shop.operational.overall.ready}");
  });

  it("offers arming only when no test card has been started, and never claims an unreadable state is fine", () => {
    const source = page();
    expect(source).toContain('shop.operational.testCard.state === "NOT_STARTED"');
    expect(source).toContain("first-shop-arm-test-card");
    expect(source).toContain("/first-shop/test-card/arm");
    expect(source).toContain("Test card status unavailable.");
    expect(source).toContain("!shop.testCardArmingReadable");
  });
});

describe("permanent-deletion admin UI", () => {
  it("shows a destructive control only when the server says the shop is deletable", () => {
    const detail = read("client/src/pages/admin/partner-management-detail.tsx");
    expect(detail).toContain("deletion-assessment");
    expect(detail).toContain("CANNOT PERMANENTLY DELETE");
    expect(detail).toContain("Permanently delete setup-only partner");
    // The destructive button lives inside the canDelete branch; the blocked branch renders reasons.
    const blocked = detail.indexOf("pm-delete-blocked");
    const available = detail.indexOf("pm-delete-available");
    const button = detail.indexOf("pm-delete-partner");
    expect(blocked).toBeGreaterThan(-1);
    expect(available).toBeGreaterThan(-1);
    expect(button).toBeGreaterThan(available);
    expect(button).toBeGreaterThan(blocked);
  });

  it("collects a reason, a typed confirmation and an admin step-up before deleting", () => {
    const detail = read("client/src/pages/admin/partner-management-detail.tsx");
    const start = detail.indexOf('kind: "partner-permanent-delete"');
    expect(start).toBeGreaterThan(-1);
    const block = detail.slice(start, start + 2600);
    // highRisk renders the reason field plus the typed CONFIRM the rest of this surface uses.
    expect(block).toContain("highRisk: true");
    expect(block).toContain("pm-delete-confirm-name");
    expect(block).toContain("runAdminProtected");
    expect(block).toContain("confirmLegalName");
  });

  /**
   * REGRESSION (staging, 2026-08-22). The delete dialog opened with the confirmation box ALREADY
   * FILLED IN — it contained "shop", left behind by a previous dialog.
   *
   * ROOT CAUSE: `modalValue` is one piece of state shared by every dialog on this page, and several
   * openers seed it by hand (`openBrandingEdit` writes the branding display name into it). The
   * deletion panel opened its dialog with a bare `setModal`, which touches nothing, so the box
   * inherited the last value. `openModalSeeded` is the only opener that honours `initial: ""`.
   *
   * The server refused correctly and nothing was deleted — but a destructive confirmation that
   * arrives pre-filled and enabled is the precise trap that typing the shop's name exists to
   * prevent, so the UI must not be able to present one.
   */
  it("opens the delete confirmation EMPTY, and will not enable Confirm on text that cannot work", () => {
    const detail = read("client/src/pages/admin/partner-management-detail.tsx");

    // 1. The panel must go through the seeding opener, not setModal.
    const mount = detail.slice(detail.indexOf("<PermanentDeletionPanel"), detail.indexOf("<PermanentDeletionPanel") + 1500);
    expect(mount).toContain("openModal={openModalSeeded}");
    expect(mount).not.toContain("openModal={setModal}");

    // 2. openModalSeeded is what blanks the field from `initial`.
    expect(detail).toContain('setModalValue(m.input?.initial ?? "");');

    // 3. The dialog declares the exact string it must equal, and says so inline on a mismatch.
    expect(detail).toContain("mustEqual: data.confirmationPhrase,");
    expect(detail).toContain("pm-modal-input-mismatch");

    // 4. A non-empty but WRONG value must not enable the destructive button. "not empty" was the
    //    old guard, and it is what made a stale value look ready to submit.
    expect(detail).toContain("(!!modal.input?.mustEqual && modalValue.trim() !== modal.input.mustEqual) ||");
  });

  it("returns to the directory after deleting, rather than reloading a shop that no longer exists", () => {
    const detail = read("client/src/pages/admin/partner-management-detail.tsx");
    expect(detail).toContain('const deleted = modal?.kind === "partner-permanent-delete";');
    expect(detail).toContain("/admin/partners/directory");
  });
});

/**
 * Strip comments before a NEGATIVE assertion. These files explain the defect they fixed, so a naive
 * `not.toContain("Object.keys(readiness.dimensions)")` fails on the sentence describing why that
 * call is gone — which would punish documenting the reasoning.
 */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("next-action controller UI contract", () => {
  const page = () => read("client/src/pages/admin/partner-first-shop-onboarding.tsx");

  it("renders ONE dominant next-action card, driven by the server's verdict", () => {
    const src = page();
    expect(src).toContain("first-shop-next-action");
    expect(src).toContain("shop.operational.nextAction");
    // Title and sentence are the server's own, never re-worded per surface.
    expect(src).toContain("next.title");
    expect(src).toContain("{next.message}");
  });

  it("shows exactly one primary control — the branches are mutually exclusive", () => {
    const src = page();
    // run  ?  reveal  :  waiting-text — a single ternary chain, so two gold buttons cannot coexist.
    expect(src).toContain("first-shop-next-action-run");
    expect(src).toContain("first-shop-next-action-reveal");
    expect(src).toContain("first-shop-next-action-waiting");
    const runIdx = src.indexOf("first-shop-next-action-run");
    const revealIdx = src.indexOf("first-shop-next-action-reveal");
    const waitIdx = src.indexOf("first-shop-next-action-waiting");
    expect(runIdx).toBeLessThan(revealIdx);
    expect(revealIdx).toBeLessThan(waitIdx);
  });

  it("has no dead action: every control reports WORKING, and a failure offers RETRY", () => {
    const src = page();
    expect(src).toContain("Working");
    expect(src).toContain("Retry");
    expect(src).toContain("first-shop-next-action-error");
  });

  it("keeps the 10 authoritative checks, collapsed by default under one disclosure", () => {
    const src = page();
    expect(src).toContain("first-shop-all-checks");
    expect(src).toContain("Advanced setup diagnostics");
    // Collapsed by default: `open` is bound to state that starts false.
    expect(src).toContain("const [checksOpen, setChecksOpen] = useState(false);");
    expect(src).toContain("open={checksOpen}");
    // All ten steps survive.
    for (let n = 1; n <= 10; n += 1) expect(src).toContain(`<Step number={${n}}`);
  });

  it("reports each check with the four-status glyph vocabulary", () => {
    const src = page();
    expect(src).toContain('label: "READY"');
    expect(src).toContain('label: "IN PROGRESS"');
    expect(src).toContain('label: "BLOCKED"');
    expect(src).toContain('label: "NOT STARTED"');
    expect(src).toContain("data-check-status");
  });

  it("advances automatically — no manual next-step control anywhere on the page", () => {
    const src = page();
    expect(codeOnly(src)).not.toMatch(/Next step/i);
    // Every mutation refetches readiness, which is what makes the card re-pick by itself.
    expect(src.match(/onboarding\.refetch\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it("continues the intended action after Super Admin step-up rather than dropping it", () => {
    const src = page();
    expect(src).toContain("runAdminProtected");
    const stepUp = read("client/src/components/admin/admin-step-up.tsx");
    // try -> challenge -> RETRY THE SAME ACTION. The continuation is the point.
    expect(stepUp).toContain("await openChallenge();");
    expect(stepUp).toContain("return await action();");
  });

  it("shows the READY state with final facts instead of more setup prompts", () => {
    const src = page();
    expect(src).toContain("Shop ready to grade");
    expect(src).toContain("first-shop-ready-facts");
    expect(src).toContain("first-shop-open-shop");
  });
});

describe("no duplicate client blocker logic", () => {
  it("the Super Admin lifecycle strip reads nextAction and never ranks dimensions itself", () => {
    const src = read("client/src/pages/admin/partner-network-lifecycle.ts");
    expect(src).toContain("readiness.nextAction");
    // The original defect: choosing a blocker by JavaScript object key order.
    expect(codeOnly(src)).not.toContain("Object.keys(readiness.dimensions)");
  });

  it("the canonical order is imported from the shared contract, never re-declared", () => {
    const shared = read("shared/partner-readiness.ts");
    expect(shared).toContain("export const PARTNER_READINESS_DIMENSION_ORDER");
    for (const consumer of [
      "server/partner/operational-readiness.ts",
      "client/src/pages/admin/partner-network-lifecycle.ts",
    ]) {
      const src = read(consumer);
      expect(src).toContain("PARTNER_READINESS_DIMENSION_ORDER");
      // No local copy of the nine keys.
      expect(codeOnly(src)).not.toMatch(/=\s*\[\s*"organisation",\s*"location",\s*"delivery"/);
    }
  });
});

describe("five-stage setup controller UI contract", () => {
  const page = () => read("client/src/pages/admin/partner-first-shop-onboarding.tsx");

  it("shows CREATE -> ACTIVATE -> CONNECT -> TEST -> LIVE, from the server's stage", () => {
    const src = page();
    expect(src).toContain("first-shop-stage-bar");
    expect(src).toContain('["CREATE", "ACTIVATE", "CONNECT", "TEST", "LIVE"]');
    // Rendered from the verdict, never computed here — a client stage would be a second opinion.
    expect(src).toContain("shop.operational.nextAction.stage");
    expect(codeOnly(src)).not.toMatch(/function\s+deriveStage|computeStage/);
  });

  it("does not render ten setup cards by default — diagnostics are collapsed", () => {
    const src = page();
    expect(src).toContain("Advanced setup diagnostics");
    expect(src).toContain("const [checksOpen, setChecksOpen] = useState(false);");
    expect(src).toContain("open={checksOpen}");
  });

  it("gives each stage one standing instruction in the operator's words", () => {
    const src = page();
    expect(src).toContain("The Owner needs to open the MintVault email");
    expect(src).toContain("Open MintVault Scanner on this Mac and sign in");
    expect(src).toContain("Scan one test card");
  });

  it("resends the invitation from the canonical authority, without a trip into Staff", () => {
    const src = page();
    expect(src).toContain("/resend-invitation");
    expect(src).toContain("Resend invitation");
    // Reported beside the invitation, from the provider's own verdict — not a page banner.
    expect(src).toContain("first-shop-resend-notice");
    expect(src).toContain("data?.result?.deliveryStatus");
    // One invitation system: the route is the same one the Staff screen calls.
    const routes = read("server/partner/partner-management-routes.ts");
    expect(routes).toContain('r.post("/partners/:partnerId/users/:userId/resend-invitation"');
  });

  it("approves a single pending Scanner inline, and defers a real choice between Macs", () => {
    const src = page();
    expect(src).toContain("pendingStations.length === 1");
    // Behind the SAME canonical step-up, which retries the same action after the challenge.
    expect(src).toContain("runAdminProtected");
  });

  it("never pre-provisions a station identity — enrolment comes from the Mac itself", () => {
    const src = page();
    expect(src).toContain("Station enrolment must come from the real shop Scanner");
    // No client path that creates or copies a station identity.
    expect(codeOnly(src)).not.toMatch(/createStation|stationPrivateKey|copyStationIdentity/);
  });
});

describe("create form asks once", () => {
  const page = () => read("client/src/pages/admin/partner-first-shop-onboarding.tsx");

  it("does not ask for the Main location name, and does not send one", () => {
    const src = page();
    expect(src).not.toContain('label="Main location name"');
    expect(codeOnly(src)).not.toMatch(/^\s*locationName,\s*$/m);
  });

  it("only sends an operations contact when a different one was deliberately chosen", () => {
    const src = page();
    expect(src).toContain("operationsContact: useDifferentContact ?");
    expect(src).toContain("const [useDifferentContact, setUseDifferentContact] = useState(false);");
  });

  it("keeps the single atomic create button", () => {
    const src = page();
    expect(src).toContain("first-shop-create-submit");
    expect(src).toContain("If any part fails, nothing is saved.");
    // The label now comes from the tested decision module rather than being inlined in JSX.
    expect(src).toContain("createButtonLabel(");
    expect(read("client/src/pages/admin/owner-email-eligibility.ts")).toContain("Create shop & send invitation");
  });

  it("defaults live on the SERVER, so every caller writes the same canonical record", () => {
    const service = read("server/partner/partner-management-service.ts");
    expect(service).toContain('export const DEFAULT_MAIN_LOCATION_NAME = "Main location";');
    expect(service).toContain("input.locationName ?? \"\"");
    // Owner becomes the operations contact, through the SAME validator as a supplied one.
    expect(service).toContain("requireOperationalContact(`${ownerFirstName} ${ownerLastName}`, ownerEmail)");
  });
});

describe("shop workspace and network surfaces stay on one verdict", () => {
  it("the Shop workspace leads with SETUP STATUS + NEXT ACTION, diagnostics collapsed", () => {
    const src = read("client/src/pages/admin/partner-management-detail.tsx");
    expect(src).toContain("pm-setup-status");
    expect(src).toContain("pm-setup-stage");
    expect(src).toContain("pm-setup-next-action");
    expect(src).toContain("pm-advanced-diagnostics");
    // Nothing was deleted: the detail moved under the disclosure.
    expect(src).toContain("pm-setup-checklist");
    expect(src).toContain("ReadinessPanel");
    // It renders the verdict rather than deciding one.
    expect(src).toContain("onboarding.data?.operational?.nextAction");
  });

  it("the Shops NEXT link opens the simplified setup controller, not a sub-workspace", () => {
    const src = read("client/src/pages/admin/partner-network-shops.tsx");
    expect(src).toContain("shop-next-action-");
    expect(src).toContain("/onboarding`}");
    expect(src).toContain("NEXT: ");
    expect(src).toContain('"READY"');
  });

  it("Overview, Shops and the workspace all read the same nextAction field", () => {
    for (const surface of [
      "client/src/pages/admin/partner-network-attention.ts",
      "client/src/pages/admin/partner-network-shops.tsx",
      "client/src/pages/admin/partner-management-detail.tsx",
      "client/src/pages/admin/partner-first-shop-onboarding.tsx",
    ]) {
      expect(read(surface)).toMatch(/nextAction/);
    }
  });
});

describe("owner email blocker UX", () => {
  const page = () => read("client/src/pages/admin/partner-first-shop-onboarding.tsx");

  it("checks the Owner email before create, debounced rather than per keystroke", () => {
    const src = page();
    expect(src).toContain("/first-shop/owner-email-eligibility");
    expect(src).toContain("setDebouncedOwnerEmail");
  });

  it("renders the duplicate warning AT THE FIELD, between the email input and the next section", () => {
    const src = page();
    const emailInput = src.indexOf('label="Email"');
    const conflict = src.indexOf('data-testid="owner-email-conflict"');
    const nextSection = src.indexOf("Delivery address</div>");
    expect(emailInput).toBeGreaterThan(-1);
    // The whole reported bug was having to scroll UP to find out why Create did nothing.
    expect(conflict).toBeGreaterThan(emailInput);
    expect(conflict).toBeLessThan(nextSection);
  });

  it("shows the required wording: shop, status, and one plain instruction", () => {
    const src = page();
    expect(src).toContain("Owner email already in use");
    expect(src).toContain("Existing shop");
    expect(src).toContain("User status");
    expect(src).toContain("Use a different Owner email.");
    expect(src).toContain("owner-email-conflict-shop");
    expect(src).toContain("owner-email-conflict-status");
  });

  it("offers an amendment path ONLY where a canonical authority exists", () => {
    const src = page();
    // Gated on the server's own `releasable`, which is true only for INVITED.
    expect(src).toContain("ownerEmailConflict.releasable &&");
    expect(src).toContain("owner-email-conflict-amend");
  });

  it("guards the SUBMIT handler, not just the button's disabled attribute", () => {
    const src = page();
    // A disabled button does not stop an Enter keypress inside a text field.
    expect(src).toContain("if (createBlocked) return;");
    expect(src).toContain("disabled={create.isPending || createBlocked}");
  });

  it("covers every eligibility state at the field", () => {
    const src = page();
    for (const id of [
      "owner-email-checking",
      "owner-email-available",
      "owner-email-check-failed",
      "owner-email-conflict",
    ]) expect(src).toContain(id);
    // A failed lookup must offer a retry rather than silently reading as available.
    expect(src).toContain("owner-email-retry");
  });

  it("clears a stale refusal the moment any field changes", () => {
    const src = page();
    expect(src).toContain("if (create.isError) create.reset();");
    expect(src).toContain("setBanner(null);");
  });

  it("does NOT put create failures in the page banner any more", () => {
    const src = page();
    expect(src).toContain("first-shop-create-error");
    // The banner is above the fold; the operator is looking at the button.
    // Scoped to the CREATE mutation: other mutations legitimately use the banner for success notes.
    const createBlock = src.slice(src.indexOf("const create = useMutation"), src.indexOf("const saveAddress = useMutation"));
    expect(codeOnly(createBlock)).not.toContain("setBanner(errorMessage");
  });

  it("success leaves the form for the controller and names who was invited", () => {
    const src = page();
    expect(src).toContain("navigate(`/admin/partners/${id}/onboarding`)");
    expect(src).toContain("first-shop-invited-email");
    expect(src).toContain("Invitation sent to");
  });

  it("the pre-check and the create share ONE finder, so they cannot disagree", () => {
    const service = read("server/partner/partner-management-service.ts");
    expect(service).toContain("async function findOwnerEmailClash");
    expect(service.match(/findOwnerEmailClash\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(service).toContain("export async function checkOwnerEmailEligibility");
  });

  it("is Super Admin only, and registered before the parameterised sibling", () => {
    const routes = read("server/partner/partner-management-routes.ts");
    const eligibility = routes.indexOf('r.get("/first-shop/owner-email-eligibility"');
    const byId = routes.indexOf('r.get("/partners/:partnerId"');
    expect(eligibility).toBeGreaterThan(-1);
    expect(eligibility).toBeLessThan(byId);
  });

  it("keeps the vague Partner-facing wording off this Super Admin surface", () => {
    const partnerFacing = read("client/src/pages/partner/login.tsx");
    expect(partnerFacing).not.toContain("already used by");
    expect(partnerFacing).not.toContain("owner-email-conflict");
  });
});

describe("saved / edit pattern on already-complete records", () => {
  const page = () => read("client/src/pages/admin/partner-first-shop-onboarding.tsx");

  it("sends the DISPLAYED value, never the raw untouched state", () => {
    const src = page();
    /*
     * THE BUG: the field showed contactNameValue (falling back to the saved contact) while the
     * mutation sent contactName (""), so an untouched Save submitted an empty name and the server
     * correctly answered "fullName is required".
     */
    expect(src).toContain("fullName: contactNameValue");
    expect(src).toContain("email: contactEmailValue");
    expect(src).toContain("deliveryAddress: addressValue");
    /*
     * Scoped to the SAVE mutations. The CREATE payload legitimately sends the raw typed state —
     * there is no saved record to fall back to there, and the operator has just typed it.
     */
    const saveContactBlock = src.slice(src.indexOf("const saveContact = useMutation"), src.indexOf("const activate = useMutation"));
    expect(codeOnly(saveContactBlock)).not.toContain("fullName: contactName,");
    const saveAddressBlock = src.slice(src.indexOf("const saveAddress = useMutation"), src.indexOf("const saveContact = useMutation"));
    expect(codeOnly(saveAddressBlock)).not.toContain("deliveryAddress: address,");
  });

  it("renders a saved state with Edit instead of a permanent Save button", () => {
    const src = page();
    expect(src).toContain("first-shop-contact-saved");
    expect(src).toContain("Operations contact saved");
    expect(src).toContain("first-shop-edit-contact");
    expect(src).toContain("first-shop-address-saved");
    expect(src).toContain("first-shop-edit-address");
  });

  it("performs NO write when nothing changed", () => {
    const src = page();
    expect(src).toContain("if (contactUnchanged) { setContactNotice(\"No changes to save\"); return; }");
    expect(src).toContain("if (addressUnchanged) { setAddressNotice(\"No changes to save\"); return; }");
    // Compared against the canonical stored record, not against emptiness.
    expect(src).toContain("(contact?.full_name ?? \"\").trim()");
  });

  it("saved-ness comes from the SERVER's verdict, not from the form looking populated", () => {
    const src = page();
    expect(src).toContain('shop?.operational.dimensions.operationsContact.status === "PASS"');
    expect(src).toContain('shop?.operational.dimensions.delivery.status === "PASS"');
  });

  it("confirms success, offers Cancel, and reports failure beside the section", () => {
    const src = page();
    expect(src).toContain("✓ Operations contact updated");
    expect(src).toContain("✓ Main location address updated");
    expect(src).toContain("first-shop-cancel-contact");
    expect(src).toContain("first-shop-cancel-address");
    expect(src).toContain("first-shop-contact-error");
    expect(src).toContain("first-shop-address-error");
  });

  it("refetches canonical readiness rather than requiring a page refresh", () => {
    const src = page();
    expect((src.match(/onboarding\.refetch\(\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});

describe("honest invitation delivery status", () => {
  const page = () => read("client/src/pages/admin/partner-first-shop-onboarding.tsx");

  it("reads the canonical invitation status instead of assuming SENT", () => {
    const src = page();
    expect(src).toContain("shop?.owner?.invitationStatus");
    expect(src).toContain('invitationStatus === "SENT"');
    expect(src).toContain('invitationStatus === "DELIVERY_FAILED"');
    expect(src).toContain("Invitation delivery FAILED for");
    // Acceptance by the provider is not inbox delivery, and must not be worded as if it were.
    expect(src).toContain("Email accepted for delivery to");
  });

  it("offers Resend inside the controller, with sending and outcome states", () => {
    const src = page();
    expect(src).toContain("first-shop-resend-invitation");
    expect(src).toContain("Sending…");
    expect(src).toContain("✓ Email accepted for delivery");
    expect(src).toContain("Resend failed");
    // Disabled while in flight, so a double click cannot mint two invitations.
    expect(src).toContain("disabled={resendInvitation.isPending}");
  });
});

describe("the resend control is on the screen the operator actually lands on", () => {
  it("the Shop workspace offers Resend when the Owner has not finished setup", () => {
    const src = read("client/src/pages/admin/partner-management-detail.tsx");
    /*
     * Three separate resend attempts produced NO server request at all — from Station Fleet, from
     * the Shop workspace and from Staff — because the control was only ever on the onboarding page.
     * A repair action has to live where the problem is reported.
     */
    expect(src).toContain("pm-resend-owner-invitation");
    expect(src).toContain("pm-owner-invitation");
    expect(src).toContain('userStatus === "INVITED"');
  });

  it("uses the SAME canonical route, behind the same step-up, and never a second flow", () => {
    const src = read("client/src/pages/admin/partner-management-detail.tsx");
    expect(src).toContain("/resend-invitation");
    expect(src).toContain("runAdminProtected");
    // One invitation system: the identical path the onboarding controller and Staff both call.
    const onboarding = read("client/src/pages/admin/partner-first-shop-onboarding.tsx");
    expect(onboarding).toContain("/resend-invitation");
  });

  it("cannot fire twice from one double-click, and reports the provider's verdict", () => {
    const src = read("client/src/pages/admin/partner-management-detail.tsx");
    expect(src).toContain("disabled={resendOwnerInvitation.isPending}");
    expect(src).toContain("data?.result?.deliveryStatus");
    expect(src).toContain("Email accepted for delivery");
    expect(src).toContain("Resend failed");
  });
});
