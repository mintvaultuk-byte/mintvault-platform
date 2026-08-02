// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectControlFixtureOverview } from "../client/src/test-harness/project-control-visual-fixture";

const apiRequest = vi.fn();
const navigate = vi.fn();
const invalidateQueries = vi.fn();

vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...args: unknown[]) => apiRequest(...args),
  queryClient: { invalidateQueries },
}));

vi.mock("wouter", () => ({
  Link: ({ href, children, ...props }: { href: string; children?: ReactNode; [key: string]: unknown }) =>
    createElement("a", { href, ...props }, children),
  useLocation: () => ["/admin/project-control/package/pc-pn-pilot", navigate],
  useRoute: () => [true, { key: "pc-pn-pilot" }],
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

const pilotPackage =
  projectControlFixtureOverview.packages.find((item) => item.key === "pc-pn-pilot") ??
  projectControlFixtureOverview.packages[0];

const detail = {
  package: pilotPackage,
  assessment: pilotPackage.assessment,
  readiness: pilotPackage.assessment.readiness,
  nodePath: ["MintVault", "Partner Network", "Pilot with one or two shops"],
  nextActions: projectControlFixtureOverview.nextActions.all,
  audit: [
    {
      id: 1,
      field: "status",
      oldValue: "in_progress",
      newValue: "blocked",
      reason: "Evidence drift found",
      actor: "codex",
      anomaly: null,
      createdAt: "2026-08-02T09:00:00.000Z",
    },
  ],
  auditTotal: 1,
  tests: [{ id: 1, kind: "vitest", result: "passed", ranAt: "2026-08-02T09:00:00.000Z", detail: "741 tests" }],
};

const ok = (body: unknown) =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);

function fail(status: number, code: string, raw: string) {
  const err = new Error(raw) as Error & { status: number; body: unknown };
  err.status = status;
  err.body = { error: { code, message: raw } };
  return Promise.reject(err);
}

const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function waitFor(id: string) {
  for (let i = 0; i < 30; i += 1) {
    const el = q(id);
    if (el) return el;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error(`Timed out waiting for ${id}`);
}

async function mountWithPatchFailure(status: number, code: string, raw: string) {
  apiRequest.mockImplementation((method: string, url: string) => {
    if (method === "GET" && String(url).endsWith("/packages/pc-pn-pilot")) return ok(detail);
    if (method === "GET" && String(url).endsWith("/packages/pc-pn-pilot/prompts")) return ok([]);
    if (method === "PUT" && String(url).endsWith("/packages/pc-pn-pilot")) return fail(status, code, raw);
    return ok({});
  });
  const { default: Page } = await import("../client/src/pages/admin/project-control-package");
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(Page)));
  });
  await waitFor("pcp-root");
}

async function editAndSave() {
  const remaining = (await waitFor("pcp-edit-remaining")) as HTMLTextAreaElement;
  const reason = (await waitFor("pcp-edit-reason")) as HTMLInputElement;
  const save = await waitFor("pcp-save");

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      remaining,
      "Operator-entered retry text must survive a failed mutation."
    );
    remaining.dispatchEvent(new Event("input", { bubbles: true }));
    remaining.dispatchEvent(new Event("change", { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      reason,
      "Owner asked for a safe retry."
    );
    reason.dispatchEvent(new Event("input", { bubbles: true }));
    reason.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => save.click());
  await waitFor("pcp-conflict");
  return { remaining, reason, save };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: ({ queryKey }) => apiRequest("GET", String(queryKey[0])).then((res) => res.json()),
      },
      mutations: { retry: false },
    },
  });
  apiRequest.mockReset();
  navigate.mockReset();
  invalidateQueries.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("Project Control package rendered mutation failures", () => {
  it("retains operator-entered values after a failed mutation and keeps retry available", async () => {
    await mountWithPatchFailure(500, "server_error", "postgres://raw-secret stack trace");

    const { remaining, reason, save } = await editAndSave();

    expect(q("pcp-edit-remaining")).toBeTruthy();
    expect(q("pcp-edit-reason")).toBeTruthy();
    expect(remaining.value).toBe("Operator-entered retry text must survive a failed mutation.");
    expect(reason.value).toBe("Owner asked for a safe retry.");
    expect(save.hasAttribute("disabled")).toBe(false);
    expect(q("pcp-conflict")?.textContent).toContain("Your entered values are still available");
    expect(q("pcp-conflict")?.textContent).not.toContain("postgres://raw-secret");
  });

  it.each([
    ["version_conflict", "Someone else changed this work package"],
    ["illegal_transition", "status change is not allowed"],
    ["override_required", "explicit owner-approved override"],
    ["generic_conflict", "conflicts with the current work package state"],
  ])("renders distinct safe 409 copy for %s", async (code, expected) => {
    await mountWithPatchFailure(409, code, `raw backend ${code} detail`);

    await editAndSave();

    expect(q("pcp-conflict")?.textContent).toContain(expected);
    expect(q("pcp-conflict")?.textContent).not.toContain(`raw backend ${code} detail`);
  });
});
