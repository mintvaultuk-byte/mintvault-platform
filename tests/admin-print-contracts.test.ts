// @vitest-environment happy-dom
/**
 * Admin printing contract — rendered proof for the retired browser endpoint.
 *
 * The Certificate Browser used to expose Reprint on every certificate and POST
 * to /api/admin/printing/reprint/:id, a removed route that returned the generic
 * JSON 404 while the client tried to read a PDF blob. These tests mount the real
 * AdminPrinting page, drive the real browser controls, and prove the replacement
 * command uses the canonical artifact-producing route with a durable retry key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { PRINT_STATES, type PrintState } from "../shared/print-lifecycle";

const apiRequest = vi.fn();
const adminFetch = vi.fn();
const toast = vi.fn();

vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...args: unknown[]) => apiRequest(...args),
  adminFetch: (...args: unknown[]) => adminFetch(...args),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

let container: HTMLDivElement;
let root: Root;
let anchorClick: ReturnType<typeof vi.spyOn>;
let generatedKeys: string[];
let reprintResults: Array<() => Promise<Response>>;
let workflowReprintResults: Array<() => Promise<Response>>;

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const ok = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response);
const httpError = (status: number, body: unknown) => {
  const error = new Error("http") as Error & { status: number; body: unknown };
  error.status = status;
  error.body = body;
  return error;
};

function browserCertificate(printState: PrintState, index: number) {
  return {
    id: index + 1,
    certId: `MV-PRINT-${index + 1}`,
    certificateNumber: `MV-PRINT-${index + 1}`,
    cardName: `Card ${index + 1}`,
    setName: "Proof Set",
    gradeOverall: "9",
    language: "English",
    year: "2026",
    variant: "Standard",
    printState,
    isPrinted: printState === "printed" || printState === "reprinted" || printState === "completed",
    reprintCount: printState === "reprinted" ? 1 : 0,
    ownershipStatus: "unclaimed",
    createdAt: new Date("2026-09-04T10:00:00.000Z"),
  };
}

const browserCerts = PRINT_STATES.map(browserCertificate);
const queueRows = ["MV-QUEUE-A", "MV-QUEUE-B"].map((certId) => ({
  certId,
  state: "printed",
  cardName: certId,
  cardGame: "pokemon",
  setName: "Proof Set",
  cardNumber: "1",
  gradeOverall: "9",
  customerName: "Proof Customer",
  trackingNumber: "TRACK-PROOF",
  approvedAt: "2026-09-04T10:00:00.000Z",
  approvedBy: "admin@example.test",
  printedAt: "2026-09-04T11:00:00.000Z",
  batchId: "batch-proof",
  reprintCount: 0,
  certificateExists: true,
  labelExists: true,
  pdfExists: true,
}));

function installApi() {
  apiRequest.mockImplementation((method: string, url: string) => {
    if (method === "POST" && url === "/api/admin/print-batch/reprint") {
      const next = reprintResults.shift();
      if (!next) throw new Error("unexpected direct reprint call");
      return next();
    }
    if (method === "POST" && url === "/api/admin/printing/workflow/reprint") {
      const next = workflowReprintResults.shift();
      if (!next) throw new Error("unexpected workflow reprint call");
      return next();
    }
    if (method === "GET" && url === "/api/admin/printing/workflow/queue") return ok({ rows: queueRows });
    if (method === "GET" && url === "/api/admin/printing/workflow/batches") return ok({ batches: [] });
    return ok([]);
  });
  adminFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve([]) } as unknown as Response);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  generatedKeys = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  vi.stubGlobal("crypto", { randomUUID: vi.fn(() => generatedKeys.shift()!) });
  anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  reprintResults = [];
  workflowReprintResults = [];
  toast.mockReset();
  apiRequest.mockReset();
  adminFetch.mockReset();
  installApi();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function settle(turns = 6) {
  for (let i = 0; i < turns; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountPrinting() {
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const Page = (await import("@/pages/admin-printing")).default;
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: ({ queryKey }) =>
          Promise.resolve(queryKey[0] === "/api/admin/printing/browser" ? browserCerts : []),
      },
      mutations: { retry: false },
    },
  });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(Page)));
  });
  await settle();
  await click("tab-cert-browser");
  await settle();
}

async function mountQueue() {
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const Page = (await import("@/pages/admin-print-queue")).default;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(Page)));
  });
  await settle();
  await click("print-filter-all");
  await settle();
}

async function click(testId: string) {
  const element = q(testId);
  expect(element, `${testId} must be rendered`).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function type(testId: string, value: string) {
  const element = q(testId) as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function directReprintCalls() {
  return apiRequest.mock.calls.filter(
    ([method, url]) => method === "POST" && url === "/api/admin/print-batch/reprint"
  );
}

function workflowReprintCalls() {
  return apiRequest.mock.calls.filter(
    ([method, url]) => method === "POST" && url === "/api/admin/printing/workflow/reprint"
  );
}

describe("Admin Certificate Browser reprint wiring", () => {
  it("offers Reprint only for lifecycle states whose labels were already produced", async () => {
    await mountPrinting();

    for (const [index, state] of PRINT_STATES.entries()) {
      const control = q(`btn-reprint-MV-PRINT-${index + 1}`);
      expect(Boolean(control), `unexpected Reprint visibility for ${state}`).toBe(
        state === "printed" || state === "reprinted" || state === "completed"
      );
    }
  });

  it("opens the reason gate before any POST and submits the canonical JSON artifact command", async () => {
    reprintResults = [
      () =>
        ok({
          batchId: "batch-browser-one",
          certIds: ["MV-PRINT-4"],
          pdfUrl: "/api/admin/print-batch/batch-browser-one/pdf",
          cricutSvgUrl: "/api/admin/print-batch/batch-browser-one/cut.svg",
        }),
    ];
    await mountPrinting();
    await click("btn-reprint-MV-PRINT-4");

    expect(q("reprint-reason-modal")).toBeTruthy();
    expect(directReprintCalls()).toHaveLength(0);
    await type("input-reprint-reason", "damaged during final packing");
    await click("btn-submit-reprint-reason");
    await settle();

    expect(directReprintCalls()).toEqual([
      [
        "POST",
        "/api/admin/print-batch/reprint",
        { certIds: ["MV-PRINT-4"], reason: "damaged during final packing" },
        { headers: { "Idempotency-Key": "11111111-1111-4111-8111-111111111111" } },
      ],
    ]);
    expect(anchorClick).toHaveBeenCalledTimes(2);
    expect(q("reprint-reason-modal")).toBeFalsy();
  });

  it("retains the same idempotency key after an unknown failure and consumes it only after success", async () => {
    reprintResults = [
      () => Promise.reject(new Error("connection lost after request")),
      () =>
        ok({
          batchId: "batch-replayed",
          certIds: ["MV-PRINT-4"],
          pdfUrl: "/api/admin/print-batch/batch-replayed/pdf",
        }),
    ];
    await mountPrinting();
    await click("btn-reprint-MV-PRINT-4");
    await type("input-reprint-reason", "printer jam damaged label");
    await click("btn-submit-reprint-reason");
    await settle();

    expect(q("reprint-reason-modal"), "unknown result keeps the operator intent available for retry").toBeTruthy();
    await click("btn-submit-reprint-reason");
    await settle();

    const calls = directReprintCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0][3]).toEqual(calls[1][3]);
    expect(calls[0][3]).toEqual({ headers: { "Idempotency-Key": "11111111-1111-4111-8111-111111111111" } });
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(q("reprint-reason-modal")).toBeFalsy();
  });

  it("retires a terminal artifact key so the operator can start a recoverable retry", async () => {
    reprintResults = [
      () => Promise.reject(httpError(409, { code: "OBJECT_WRITE_TERMINAL", retryable: false })),
      () =>
        ok({
          batchId: "batch-after-terminal",
          certIds: ["MV-PRINT-4"],
          pdfUrl: "/api/admin/print-batch/batch-after-terminal/pdf",
        }),
    ];
    await mountPrinting();
    await click("btn-reprint-MV-PRINT-4");
    await type("input-reprint-reason", "replacement after abandoned artifact write");
    await click("btn-submit-reprint-reason");
    await settle();
    await click("btn-submit-reprint-reason");
    await settle();

    const calls = directReprintCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0][3]).toEqual({ headers: { "Idempotency-Key": "11111111-1111-4111-8111-111111111111" } });
    expect(calls[1][3]).toEqual({ headers: { "Idempotency-Key": "22222222-2222-4222-8222-222222222222" } });
  });

  it("contains no client caller for the removed blob endpoint", () => {
    const browser = readFileSync("client/src/pages/admin-cert-browser.tsx", "utf8");
    const printing = readFileSync("client/src/pages/admin-printing.tsx", "utf8");
    expect(`${browser}\n${printing}`).not.toContain("/printing/reprint/");
    expect(browser).not.toContain("URL.createObjectURL");
    expect(printing).toContain("/print-batch/reprint");
  });
});

describe("Admin Print Queue reprint recovery", () => {
  it("retains each uncertain intent key even when another reprint succeeds in between", async () => {
    workflowReprintResults = [
      () => Promise.reject(new Error("response lost")),
      () => ok({ applied: ["MV-QUEUE-B"], rejected: [] }),
      () => ok({ applied: ["MV-QUEUE-A"], rejected: [] }),
    ];
    await mountQueue();

    await click("select-MV-QUEUE-A");
    await click("open-reprint");
    await type("reprint-reason", "damaged label for request A");
    await click("reprint-submit");
    await settle();
    await click("reprint-cancel");
    await click("select-MV-QUEUE-A");
    await click("select-MV-QUEUE-B");
    await click("open-reprint");
    await type("reprint-reason", "damaged label for request B");
    await click("reprint-submit");
    await settle();

    await click("select-MV-QUEUE-A");
    await click("open-reprint");
    await type("reprint-reason", "damaged label for request A");
    await click("reprint-submit");
    await settle();

    const calls = workflowReprintCalls();
    expect(calls).toHaveLength(3);
    expect(calls[0][3]).toEqual({ headers: { "Idempotency-Key": "11111111-1111-4111-8111-111111111111" } });
    expect(calls[1][3]).toEqual({ headers: { "Idempotency-Key": "22222222-2222-4222-8222-222222222222" } });
    expect(calls[2][3]).toEqual(calls[0][3]);
  });

  it("keeps the modal and selection when the server rejects every selected card", async () => {
    workflowReprintResults = [
      () => ok({ applied: [], rejected: [{ certId: "MV-QUEUE-A", code: "already_requested", message: "Already pending." }] }),
    ];
    await mountQueue();
    await click("select-MV-QUEUE-A");
    await click("open-reprint");
    await type("reprint-reason", "customer replacement already pending");
    await click("reprint-submit");
    await settle();

    expect(q("reprint-modal")).toBeTruthy();
    expect(q("select-MV-QUEUE-A")?.title).toBe("Deselect");
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "No cards were marked for reprint", description: "Already pending.", variant: "destructive" })
    );
  });
});
