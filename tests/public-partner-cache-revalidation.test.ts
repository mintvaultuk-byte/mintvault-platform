// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureFlagsContext, useFeatureFlagsQuery } from "../client/src/hooks/use-feature-flags";

vi.mock("@/components/seo-head", () => ({ default: () => null }));
vi.mock("wouter", () => ({
  Link: ({ href, children, ...props }: { href: string; children?: ReactNode }) =>
    createElement("a", { href, ...props }, children),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | null;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = null;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host.remove();
  vi.restoreAllMocks();
});

async function mount(client: QueryClient, node: ReactNode): Promise<void> {
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(QueryClientProvider, { client }, node));
  });
}

async function remount(client: QueryClient, node: ReactNode): Promise<void> {
  await act(async () => root?.unmount());
  root = null;
  host.replaceChildren();
  await mount(client, node);
}

async function waitForText(text: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (host.textContent?.includes(text)) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  throw new Error(`Timed out waiting for ${text}`);
}

function testClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const publicLocation = {
  publicRef: "11111111-1111-4111-8111-111111111111",
  displayName: "A Cards",
  locationName: "Canterbury Shop",
  privacyState: "PUBLIC_STOREFRONT",
  address: "1 High Street, Canterbury CT1 1AA",
  serviceArea: null,
  designation: "MintVault Partner",
  websiteUrl: null,
  phone: null,
  email: null,
  mapsUrl: "https://www.google.com/maps/search/?api=1&query=Canterbury",
  cardsGraded: null,
  cardsGradedMeaning: "Approved cards graded by MintVault through this Partner location",
  partnerSince: null,
};

describe("public Partner publication cache revalidation", () => {
  it("removes a cached profile after the server revokes it", async () => {
    let published = true;
    vi.stubGlobal("fetch", vi.fn(async () => published
      ? new Response(JSON.stringify({ location: publicLocation }), { status: 200 })
      : new Response(JSON.stringify({ error: "not found" }), { status: 404 })));
    const { default: Page } = await import("../client/src/pages/public-partner-profile");
    const client = testClient();
    const page = createElement(Page, { params: { publicRef: publicLocation.publicRef } });
    await mount(client, page);
    await waitForText(publicLocation.address);
    published = false;
    await remount(client, page);
    await waitForText("Partner profile not available");
    expect(host.textContent).not.toContain(publicLocation.address);
    client.clear();
  });

  it("revalidates a cached directory and removes unpublished cards on remount", async () => {
    let locations = [publicLocation];
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ locations }), { status: 200 })));
    const { default: Page } = await import("../client/src/pages/find-a-partner");
    const client = testClient();
    const page = createElement(
      FeatureFlagsContext.Provider,
      { value: { legalPagesLive: false, privacyNoticeLive: false, partnerApplicationsLive: false, publicPartnerDirectoryLive: true } },
      createElement(Page)
    );
    await mount(client, page);
    await waitForText(publicLocation.address);
    locations = [];
    await remount(client, page);
    await waitForText("No matching Partner locations");
    expect(host.textContent).not.toContain(publicLocation.address);
    client.clear();
  });

  it("revalidates the global kill switch instead of retaining a five-minute live value", async () => {
    let live = true;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      legalPagesLive: false,
      privacyNoticeLive: false,
      partnerApplicationsLive: false,
      publicPartnerDirectoryLive: live,
    }), { status: 200 })));
    function Probe() {
      const query = useFeatureFlagsQuery();
      return createElement("div", null, query.data?.publicPartnerDirectoryLive ? "directory-live" : "directory-off");
    }
    const client = testClient();
    await mount(client, createElement(Probe));
    await waitForText("directory-live");
    live = false;
    await remount(client, createElement(Probe));
    await waitForText("directory-off");
    client.clear();
  });
});
