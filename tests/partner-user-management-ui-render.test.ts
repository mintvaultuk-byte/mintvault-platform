// @vitest-environment happy-dom
/**
 * Super Admin Users tab — REAL component rendering.
 *
 * tests/partner-management-admin-ui.test.ts asserts on SOURCE TEXT (readFileSync + toContain).
 * That is not proof of behaviour: the first hostile review found a case there literally named
 * "gates mutations on reason + expectedVersion + typed-confirm for high-risk" passing green while
 * six destructive user actions fired on a single unconfirmed click — the asserted strings existed
 * elsewhere in the same file, attached to a different modal.
 *
 * Every assertion below mounts the actual page and would FAIL if its guard were removed.
 * Written with `createElement` rather than JSX, matching the house convention (vitest `include`
 * is tests/**\/*.test.ts) — same as tests/partner-dashboard-ui-render.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiRequest = vi.fn();
const navigate = vi.fn();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@/lib/queryClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queryClient")>()),
  apiRequest: (...args: unknown[]) => apiRequest(...args),
  queryClient: { invalidateQueries: vi.fn() },
}));
vi.mock("wouter", () => ({
  Link: ({ href, children, ...props }: any) => createElement("a", { href, ...props }, children),
  useLocation: () => ["/admin/partners/11111111-1111-4111-8111-111111111111/staff", navigate],
  useRoute: () => [true, { partnerId: "11111111-1111-4111-8111-111111111111", workspaceTab: "staff" }],
}));

interface Row {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  role: string;
  status: string;
  invitation_status: string | null;
  last_login_at: string | null;
  created_at: string;
}
const OWNER: Row = {
  id: "u-owner",
  email: "owner@partner.test",
  first_name: "Ada",
  last_name: "Owner",
  role: "OWNER",
  status: "ACTIVE",
  invitation_status: null,
  last_login_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
};
const SECOND_OWNER: Row = { ...OWNER, id: "u-owner-2", email: "owner2@partner.test" };
const ACTIVE_STAFF: Row = {
  ...OWNER,
  id: "u-staff",
  email: "staff@partner.test",
  role: "STAFF",
  invitation_status: "CONSUMED",
};
const INVITEE: Row = {
  ...OWNER,
  id: "u-invited",
  email: "new@partner.test",
  role: "STAFF",
  status: "INVITED",
  invitation_status: "SENT",
};

let container: HTMLDivElement;
let root: Root;

const res = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as unknown as Response);
const q = (sel: string) => container.querySelector<HTMLElement>(`[data-testid="${sel}"]`);
const posts = () => apiRequest.mock.calls.filter((c) => c[0] === "POST");

async function waitForTestId(id: string): Promise<HTMLElement> {
  for (let i = 0; i < 20; i += 1) {
    const el = q(id);
    if (el) return el;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`Timed out waiting for ${id}`);
}

function setValue(el: HTMLElement, value: string, evt = "input") {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(evt, { bubbles: true }));
}

async function mount(users: Row[]) {
  apiRequest.mockImplementation((method: string, url: string) => {
    if (url.endsWith("/users")) return res({ users });
    if (method === "GET")
      return res({ organisation: { id: "p1", legal_name: "P", status: "ACTIVE" }, profile: { version: 1 } });
    return res({ ok: true });
  });
  (globalThis as { fetch?: unknown }).fetch = vi.fn(() =>
    res({ authenticated: true, email: "admin@mintvault.test", isSuperAdmin: true })
  );
  const { AdminSessionProvider } = await import("../client/src/lib/admin-session");
  const { default: Page } = await import("../client/src/pages/admin/partner-management-detail");
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: ({ queryKey }) => apiRequest("GET", String(queryKey[0])).then((r) => r.json()),
      },
    },
  });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(AdminSessionProvider, { children: createElement(Page) })
      )
    );
  });
  const usersTab = await waitForTestId("pm-workspace-tab-staff");
  await act(async () => {
    usersTab.click();
  });
  if (users.length > 0) await waitForTestId(`pm-user-${users[0].id}`);
}

async function remount(users: Row[]) {
  await act(async () => root.unmount());
  container.remove();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  apiRequest.mockReset();
  await mount(users);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  apiRequest.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetModules();
});

describe("Super Admin Users tab — destructive actions are gated (real render)", () => {
  it("suspend does not fire on the first click; it opens the shared reason modal", async () => {
    await mount([OWNER, ACTIVE_STAFF]);
    const btn = q(`pm-user-suspend-${OWNER.id}`);
    expect(btn, "suspend control renders").toBeTruthy();
    await act(async () => btn!.click());
    expect(posts(), "no request may be sent on the first click").toHaveLength(0);
    expect(q("pm-modal-confirm"), "the reason modal opens instead").toBeTruthy();
  });

  it("suspend is high-risk: Confirm stays disabled until BOTH a reason and typed CONFIRM are given", async () => {
    await mount([OWNER, ACTIVE_STAFF]);
    await act(async () => q(`pm-user-suspend-${OWNER.id}`)!.click());
    expect((q("pm-modal-confirm") as HTMLButtonElement).disabled, "disabled with no reason").toBe(true);
    expect(q("pm-typed-confirm-wrap"), "typed CONFIRM demanded for suspend").toBeTruthy();

    await act(async () =>
      setValue(container.querySelector<HTMLTextAreaElement>("#pm-reason")!, "offboarding — ticket 4471")
    );
    expect((q("pm-modal-confirm") as HTMLButtonElement).disabled, "still disabled without typed CONFIRM").toBe(true);

    await act(async () => setValue(q("pm-typed-confirm")!, "CONFIRM"));
    expect((q("pm-modal-confirm") as HTMLButtonElement).disabled, "enabled once both supplied").toBe(false);
    expect(posts(), "nothing sent until Confirm is pressed").toHaveLength(0);
  });

  it("remove and revoke-sessions also require confirmation, never one click", async () => {
    await mount([OWNER, ACTIVE_STAFF]);
    for (const id of [`pm-user-remove-${OWNER.id}`, `pm-user-revoke-${OWNER.id}`]) {
      const btn = q(id);
      expect(btn, `${id} renders`).toBeTruthy();
      await act(async () => btn!.click());
      expect(posts(), `${id} must not fire on click`).toHaveLength(0);
      expect(q("pm-modal-confirm"), `${id} opens the modal`).toBeTruthy();
      expect(q("pm-typed-confirm-wrap"), `${id} is high-risk`).toBeTruthy();
      await act(async () => q("pm-modal-cancel")!.click());
    }
  });

  it("an ACTIVE user shows no setup-resend control; an INVITED one does", async () => {
    await mount([ACTIVE_STAFF, INVITEE]);
    expect(q(`pm-user-resend-${ACTIVE_STAFF.id}`), "no resend for an ACTIVE user").toBeNull();
    expect(q(`pm-user-resend-${INVITEE.id}`), "resend offered for an INVITED user").toBeTruthy();
  });

  it("revoke-invite is disabled when there is no live invitation", async () => {
    await mount([ACTIVE_STAFF, INVITEE]);
    expect((q(`pm-user-revoke-invite-${ACTIVE_STAFF.id}`) as HTMLButtonElement).disabled).toBe(true);
    expect((q(`pm-user-revoke-invite-${INVITEE.id}`) as HTMLButtonElement).disabled).toBe(false);
  });

  it("the final-owner warning appears only when the tenant really has one active owner", async () => {
    await mount([OWNER, ACTIVE_STAFF]);
    await act(async () => q(`pm-user-suspend-${OWNER.id}`)!.click());
    expect(q("pm-user-last-owner-warning"), "warned with a single active owner").toBeTruthy();

    await remount([OWNER, SECOND_OWNER]);
    await act(async () => q(`pm-user-suspend-${OWNER.id}`)!.click());
    expect(q("pm-user-last-owner-warning"), "silent when a second active owner exists").toBeNull();
  });

  it("the reason is cleared on cancel, so it cannot be submitted for a different action", async () => {
    await mount([OWNER, ACTIVE_STAFF]);
    await act(async () => q(`pm-user-suspend-${OWNER.id}`)!.click());
    await act(async () => setValue(container.querySelector<HTMLTextAreaElement>("#pm-reason")!, "left the company"));
    await act(async () => q("pm-modal-cancel")!.click());

    await act(async () => q(`pm-user-revoke-${OWNER.id}`)!.click());
    expect(container.querySelector<HTMLTextAreaElement>("#pm-reason")!.value, "reason must not carry over").toBe("");
    expect((q("pm-modal-confirm") as HTMLButtonElement).disabled, "Confirm re-disabled").toBe(true);
  });

  it("role change names the old and the new role, and is disabled until the role actually changes", async () => {
    await mount([OWNER, ACTIVE_STAFF]);
    expect((q(`pm-user-role-change-${OWNER.id}`) as HTMLButtonElement).disabled, "no-op change disabled").toBe(true);

    await act(async () => setValue(q(`pm-user-role-select-${OWNER.id}`)!, "STAFF", "change"));
    await act(async () => (q(`pm-user-role-change-${OWNER.id}`) as HTMLButtonElement).click());

    const title = container.querySelector("#pm-modal-title")?.textContent ?? "";
    expect(title, "confirmation names the current role").toContain("OWNER");
    expect(title, "confirmation names the new role").toContain("STAFF");
    expect(posts(), "nothing sent until Confirm").toHaveLength(0);
  });

  it("the whole flow sends exactly one request, carrying the OPERATOR's reason and no canned string", async () => {
    await mount([OWNER, ACTIVE_STAFF]);
    await act(async () => q(`pm-user-suspend-${ACTIVE_STAFF.id}`)!.click());
    await act(async () =>
      setValue(container.querySelector<HTMLTextAreaElement>("#pm-reason")!, "repeated policy breach")
    );
    await act(async () => setValue(q("pm-typed-confirm")!, "CONFIRM"));
    await act(async () => q("pm-modal-confirm")!.click());

    const sent = posts();
    expect(sent, "exactly one mutation").toHaveLength(1);
    expect(sent[0][1]).toContain(`/users/${ACTIVE_STAFF.id}/status`);
    expect(sent[0][2]).toMatchObject({ status: "SUSPENDED", reason: "repeated policy breach" });
    expect(JSON.stringify(sent[0][2])).not.toContain("by Super Admin");
  });
});
