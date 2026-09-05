// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { PORTAL_ROLE_TO_PARTNER_ROLE, PORTAL_TEAM_ROLE_OPTIONS, isPortalTeamRole } from "../shared/partner-team-roles";

const principal = vi.hoisted(() => ({ permissions: [] as string[], userId: "owner" }));
vi.mock("../client/src/hooks/use-partner-session", () => ({
  usePartnerSession: () => ({
    session: { userId: principal.userId, permissions: principal.permissions },
    hasPermission: (permission: string) => principal.permissions.includes(permission),
  }),
}));
vi.mock("../client/src/components/partner/partner-step-up", () => ({
  usePartnerStepUp: () => ({ runProtected: (action: () => unknown) => action() }),
}));
import PaidOrders, { PartnerSuppliesRequestsPage } from "../client/src/pages/partner/supplies-orders";
import Supplies from "../client/src/pages/partner/supplies";
import Users from "../client/src/pages/partner/users";

let root: Root | undefined;
let container: HTMLDivElement;
let client: QueryClient;
async function render(component: typeof PaidOrders, data: Record<string, unknown>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("UI fixture forbids external requests")))
  );
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  for (const [key, value] of Object.entries(data)) client.setQueryData([key], value);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(QueryClientProvider, { client }, createElement(component)));
  });
  return container;
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  client?.clear();
  principal.permissions = [];
  vi.unstubAllGlobals();
});

const paid = {
  id: "paid-record",
  status: "PAID",
  payment_status: "PAID",
  created_at: "2026-09-05T12:00:00Z",
  gross_total_pence: 7500,
  tax_treatment: "UNCONFIGURED",
  vat_total_pence: null,
  net_total_pence: null,
  refunded_total_pence: 0,
  tracking_reference: "TRACK-SNAPSHOT",
  delivery_address: {
    source: "approved_location",
    locationName: "Historical shop",
    address: "1 Original Street, TE1 1ST",
  },
  items: [
    { productCode: "slab", name: "Original slab name", unitsPerPack: 50, quantity: 1, grossLineTotalPence: 7500 },
  ],
};

describe("Partner actual rendered contracts", () => {
  it("renders paid item/money/raw approved-address snapshots, with no invented VAT", async () => {
    const view = await render(PaidOrders, { "/api/partner/supplies/orders": { orders: [paid] } });
    expect(view.textContent).toContain("Original slab name");
    expect(view.textContent).toContain("£75.00");
    expect(view.textContent).toContain("1 Original Street, TE1 1ST");
    expect(view.textContent).toContain("TRACK-SNAPSHOT");
    expect(view.textContent).not.toContain("VAT");
    expect(view.textContent).not.toContain("Supply Requests");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("renders stored VAT/refund and structured override without calculating authoritative tax", async () => {
    const view = await render(PaidOrders, {
      "/api/partner/supplies/orders": {
        orders: [
          {
            ...paid,
            tax_treatment: "VAT_INCLUDED",
            vat_total_pence: 1250,
            net_total_pence: 6250,
            refunded_total_pence: 1500,
            delivery_address: {
              source: "partner_override",
              recipientName: "Receiving",
              line1: "2 Override Way",
              city: "Test City",
              postcode: "TE2 2ST",
              country: "GB",
            },
          },
        ],
      },
    });
    for (const value of ["£62.50", "VAT £12.50", "Refunded £15.00", "2 Override Way", "TE2 2ST"])
      expect(view.textContent).toContain(value);
  });
  it("renders legacy request snapshots only from the separately keyed contract", async () => {
    const view = await render(PartnerSuppliesRequestsPage, {
      "/api/partner/supplies/requests": {
        orders: [
          {
            id: "legacy",
            reference: "SUP-OLD",
            status: "RECEIVED",
            createdAt: paid.created_at,
            shopName: "Old shop",
            delivery: { postcode: "TE4 4ST" },
            items: [{ productCode: "NFC_TAGS", label: "Old tags", quantity: 3 }],
          },
        ],
      },
      "/api/partner/supplies/orders": { orders: [paid] },
    });
    expect(view.textContent).toContain("Supply Requests");
    expect(view.textContent).toContain("SUP-OLD");
    expect(view.textContent).toContain("TE4 4ST");
    expect(view.textContent).not.toContain("Original slab name");
  });
  for (const permissions of [
    [],
    ["partner.orders.submit"],
    ["partner.credits.purchase"],
    ["partner.orders.submit", "partner.credits.purchase"],
  ]) {
    it(`requires both existing capabilities for the purchase controls: ${permissions.join("+") || "read-only"}`, async () => {
      principal.permissions = permissions;
      const view = await render(Supplies, {
        "/api/partner/supplies/products": {
          currency: "GBP",
          products: [
            {
              code: "slab",
              display_name: "Slabs",
              units_per_pack: 50,
              active_price_pence: 7500,
              active: true,
              purchasable: true,
            },
            {
              code: "unpriced",
              display_name: "Unpriced",
              units_per_pack: 60,
              active_price_pence: null,
              active: true,
              purchasable: false,
            },
          ],
        },
      });
      expect(view.querySelector<HTMLButtonElement>('[data-testid="supply-buy-slab"]')?.disabled).toBe(
        permissions.length !== 2
      );
      expect(view.querySelector<HTMLButtonElement>('[data-testid="supply-buy-unpriced"]')?.disabled).toBe(true);
      expect(view.querySelector("nav")).toBeNull(); // route guard owns the one shell
      expect(fetch).not.toHaveBeenCalled();
    });
  }
  it("keeps Scanner Operator editable while Finance remains display-only", async () => {
    principal.permissions = ["partner.users.view", "partner.users.manage"];
    const member = (id: string, role: string) => ({
      id,
      firstName: id,
      lastName: "Test",
      email: `${id}@example.test`,
      role,
      status: "ACTIVE",
      createdAt: paid.created_at,
    });
    const view = await render(Users, {
      "/api/partner/users": {
        users: [member("owner", "OWNER"), member("scanner", "SCANNER_OPERATOR"), member("finance", "FINANCE_VIEWER")],
      },
    });
    expect(view.querySelector('[data-testid="select-team-role-scanner@example.test"]')).not.toBeNull();
    expect(view.querySelector('[data-testid="select-team-role-finance@example.test"]')).toBeNull();
    expect(PORTAL_TEAM_ROLE_OPTIONS.find((role) => role.value === "SCANNER_OPERATOR")?.label).toBe("Scanner Operator");
    expect(PORTAL_TEAM_ROLE_OPTIONS.map((role) => role.value).sort()).toEqual(
      Object.keys(PORTAL_ROLE_TO_PARTNER_ROLE).sort()
    );
    for (const value of ["FINANCE_VIEWER", "TRAINEE", "UNASSIGNED", "__proto__", "constructor", null, {}])
      expect(isPortalTeamRole(value)).toBe(false);
    expect(isPortalTeamRole("SCANNER_OPERATOR")).toBe(true);
  });
  it("binds route guards and navigation to distinct permissions with no parent active collision", () => {
    const app = readFileSync("client/src/App.tsx", "utf8");
    for (const [path, permission] of [
      ["/partner/orders", "partner.orders.view"],
      ["/partner/supplies", "partner.orders.view"],
      ["/partner/supplies/requests", "partner.supplies.view"],
    ]) {
      expect(app).toContain(
        `<Route path="${path}">\n            <PartnerRouteGuard requiredPermission="${permission}">`
      );
    }
    const shell = readFileSync("client/src/components/partner/partner-shell.tsx", "utf8");
    expect(shell).toContain('item.href === "/partner/supplies" && location.startsWith("/partner/supplies/requests")');
  });
});
