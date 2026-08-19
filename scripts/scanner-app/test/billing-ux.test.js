const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { Window } = require("happy-dom");

const APP = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(APP, "renderer", "index.html"), "utf8");
const renderer = fs.readFileSync(path.join(APP, "renderer", "app.js"), "utf8");
const main = fs.readFileSync(path.join(APP, "main.js"), "utf8");

const PACKS = [
  { code: "PACK_5", credits: 5, displayPrice: "£50", vatIncluded: true, purchasable: true },
  { code: "PACK_10", credits: 10, displayPrice: "£100", vatIncluded: true, purchasable: true },
  { code: "PACK_25", credits: 25, displayPrice: "£250", vatIncluded: true, purchasable: true },
  { code: "PACK_50", credits: 50, displayPrice: "£500", vatIncluded: true, purchasable: true },
  { code: "PACK_100", credits: 100, displayPrice: "£1,000", vatIncluded: true, purchasable: true },
];

function delay(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mountScanner({ availableCredits, canPurchaseCredits = true, activeCapture = null, checkout = null }) {
  const window = new Window({ url: `file://${path.join(APP, "renderer", "index.html")}` });
  window.document.write(html);
  window.document.close();
  window.confirm = () => false;
  window.alert = () => {};
  window.setInterval = () => 0;
  window.clearInterval = () => {};
  window.setTimeout = (fn) => {
    if (typeof fn === "function") fn();
    return 0;
  };
  window.clearTimeout = () => {};

  let checkoutCalls = 0;
  let checkoutResolver = null;
  const checkoutPromise =
    checkout ||
    new Promise((resolve) => {
      checkoutResolver = resolve;
    });
  const state = {
    state: activeCapture ? "awaiting_scan" : "idle",
    activeCapture,
    openCardJob: null,
    availableCredits,
    walletRefreshGeneration: 1,
    scannerHealth: { status: "ready" },
    environment: { name: "staging", apiBase: "https://mintvault-v2.fly.dev" },
    recent: [],
    captureUploads: {},
    soundEnabled: false,
    autoOpenOnError: false,
  };
  window.scanner = {
    onStateUpdate(callback) {
      this.pushState = callback;
    },
    getState: async () => state,
    getStationSetup: async () => ({
      ok: true,
      stage: "active",
      stationCode: "STAGING-ZERO",
      summary: {
        organisationName: "Fixture Partner",
        locationName: "Staging",
        displayName: "Fixture Owner",
        availableCredits,
        canPurchaseCredits,
        canCalibrate: false,
      },
    }),
    creditPacks: async () => ({ ok: true, packs: PACKS }),
    refreshAvailableCredits: async () => ({ ok: true, availableCredits }),
    creditCheckout: async () => {
      checkoutCalls += 1;
      return checkoutPromise;
    },
    startNewCard: async () => ({ ok: false, code: "INSUFFICIENT_CREDITS", error: "No grading credits available." }),
    getCapturePreview: async () => ({ ok: false, error: "No preview" }),
    fetchOrphans: async () => ({ ok: true, orphans: [] }),
    hidePopover() {},
    openLogs() {},
    openLastCert() {},
    openForgotPassword() {},
    updateApp: async () => ({ ok: true }),
    resetScanner: async () => ({ ok: true }),
    setSetting: async () => ({ ok: true }),
    scanTarget: async () => ({ ok: false }),
    runPlacementPreview: async () => ({ ok: false }),
    runPositioningPreview: async () => ({ ok: false }),
    rescanCapturePreview: async () => ({ ok: false }),
    acknowledgeCardRegistered: async () => ({ ok: true }),
    armCapture: async () => ({ ok: false }),
    cancelCardJob: async () => ({ ok: false }),
    authoriseFix: async () => ({ ok: false }),
    saveCaptureWindow: async () => ({ ok: false }),
    stationSignIn: async () => ({ ok: false }),
    stationCompleteMfa: async () => ({ ok: false }),
    registerStation: async () => ({ ok: false }),
    stationSignOut: async () => ({ ok: true }),
  };

  window.eval(renderer);
  await delay();

  const document = window.document;
  const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  return {
    window,
    document,
    click,
    resolveCheckout: (value = { ok: true, url: "https://checkout.stripe.test/session", packCode: "PACK_5" }) =>
      checkoutResolver?.(value),
    checkoutCalls: () => checkoutCalls,
    updateCredits: async (nextCredits) => {
      state.availableCredits = nextCredits;
      state.walletRefreshGeneration += 1;
      window.scanner.pushState?.(state);
      await delay();
    },
    modal: () => document.getElementById("billingLockModal"),
    title: () => document.getElementById("billingLockTitle").textContent.trim(),
    subtitle: () => document.getElementById("billingLockSubtitle").textContent.trim(),
    stationCredits: () => document.getElementById("stationCredits").textContent.trim(),
    lowWarning: () => document.getElementById("lowCreditsWarning"),
    buyMore: () => document.getElementById("buyMoreCreditsBtn"),
    newCard: () => document.getElementById("newCardBtn"),
    packs: () => Array.from(document.querySelectorAll("#billingPackGrid [data-credits]")),
  };
}

test("BUY MORE CREDITS is available at 499 and 20 without opening the blocking zero-credit modal", async () => {
  for (const availableCredits of [499, 20]) {
    const ui = await mountScanner({ availableCredits });
    assert.equal(ui.stationCredits(), String(availableCredits));
    assert.equal(ui.buyMore().hidden, false);
    assert.equal(ui.lowWarning().hidden, true);
    assert.equal(ui.modal().classList.contains("visible"), false);
    assert.equal(ui.newCard().disabled, false);

    ui.click(ui.buyMore());
    await delay();

    assert.equal(ui.modal().classList.contains("visible"), true);
    assert.equal(ui.title(), "BUY GRADING CREDITS");
    assert.equal(ui.subtitle(), "GBP • VAT INCLUDED");
    assert.deepEqual(
      ui.packs().map((button) => button.textContent.trim()),
      [
        "5 CREDITS — £50 VAT INCLUDED",
        "10 CREDITS — £100 VAT INCLUDED",
        "25 CREDITS — £250 VAT INCLUDED",
        "50 CREDITS — £500 VAT INCLUDED",
        "100 CREDITS — £1,000 VAT INCLUDED",
      ]
    );
  }
});

test("LOW CREDITS is non-blocking at 5 and 1, while zero opens the hard-stop top-up modal", async () => {
  for (const availableCredits of [5, 1]) {
    const ui = await mountScanner({ availableCredits });
    assert.equal(ui.stationCredits(), String(availableCredits));
    assert.equal(ui.lowWarning().hidden, false);
    assert.equal(ui.lowWarning().textContent.trim(), "LOW CREDITS — TOP UP");
    assert.equal(ui.buyMore().hidden, false);
    assert.equal(ui.modal().classList.contains("visible"), false);
    assert.equal(ui.newCard().disabled, false);
  }

  const zero = await mountScanner({ availableCredits: 0 });
  assert.equal(zero.stationCredits(), "0");
  assert.equal(zero.lowWarning().hidden, true);
  assert.equal(zero.modal().classList.contains("visible"), true);
  assert.equal(zero.title(), "NO GRADING CREDITS AVAILABLE");
  assert.equal(zero.subtitle(), "TOP UP TO CONTINUE");
  assert.equal(zero.newCard().disabled, true);
});

test("wallet grant from zero closes the modal, shows LOW CREDITS at 5, and enables NEW CARD", async () => {
  const ui = await mountScanner({ availableCredits: 0 });
  assert.equal(ui.modal().classList.contains("visible"), true);
  assert.equal(ui.newCard().disabled, true);

  await ui.updateCredits(5);

  assert.equal(ui.stationCredits(), "5");
  assert.equal(ui.modal().classList.contains("visible"), false);
  assert.equal(ui.lowWarning().hidden, false);
  assert.equal(ui.buyMore().hidden, false);
  assert.equal(ui.newCard().disabled, false);
});

test("zero credits blocks the next card without interrupting an existing reserved capture", async () => {
  const ui = await mountScanner({
    availableCredits: 0,
    activeCapture: {
      id: "capture-existing",
      certId: "MV999",
      side: "front",
      stage: "awaiting_scan",
    },
  });

  assert.equal(ui.stationCredits(), "0");
  assert.equal(ui.newCard().disabled, true);
  assert.equal(ui.modal().classList.contains("visible"), false);
  assert.match(ui.document.getElementById("captureActionHint").textContent, /Scan unlocks when the box turns green/);
});

test("BUY MORE CREDITS double-click creates only one Checkout request while one is in flight", async () => {
  const ui = await mountScanner({ availableCredits: 20 });
  ui.click(ui.buyMore());
  await delay();
  const pack5 = ui.packs().find((button) => button.dataset.packCode === "PACK_5");
  assert.ok(pack5);

  ui.click(pack5);
  ui.click(pack5);
  await delay();

  assert.equal(ui.checkoutCalls(), 1);
  assert.match(ui.document.getElementById("billingLockStatus").textContent, /Starting checkout/);
  ui.resolveCheckout();
  await delay();
  assert.equal(ui.checkoutCalls(), 1);
});

test("manual top-up watches the wallet and closes after an authoritative credit grant", async () => {
  const ui = await mountScanner({ availableCredits: 20 });
  ui.click(ui.buyMore());
  await delay();
  const pack5 = ui.packs().find((button) => button.dataset.packCode === "PACK_5");
  assert.ok(pack5);

  ui.click(pack5);
  await delay();
  ui.resolveCheckout();
  await delay();

  assert.equal(ui.checkoutCalls(), 1);
  assert.equal(ui.modal().classList.contains("visible"), true);

  await ui.updateCredits(25);

  assert.equal(ui.stationCredits(), "25");
  assert.equal(ui.modal().classList.contains("visible"), false);
  assert.equal(ui.lowWarning().hidden, true);
  assert.equal(ui.newCard().disabled, false);
});

test("Scanner billing UX is permission-gated and wired to the existing pack/Checkout authority", () => {
  assert.match(main, /canPurchaseCredits: Array\.isArray\(sessionBody\.permissions\)/);
  assert.match(main, /sessionBody\.permissions\.includes\("partner\.credits\.purchase"\)/);
  assert.match(renderer, /function openBillingModal\(mode\)/);
  assert.match(renderer, /window\.scanner\.creditPacks\(\)/);
  assert.match(renderer, /window\.scanner\.creditCheckout\(\{ packCode \}\)/);
  assert.doesNotMatch(renderer, /appendFoundationCredit|fulfilPartnerCreditPurchase|availableCredits\s*[-+]=/);
});
