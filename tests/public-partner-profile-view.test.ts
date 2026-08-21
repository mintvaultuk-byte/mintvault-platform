// @vitest-environment happy-dom
import { createElement } from "react";
import { act, useEffect, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PublicPartnerProfileView } from "../client/src/components/public-partner-profile-view";
import { Dialog, DialogContent, DialogTitle } from "../client/src/components/ui/dialog";
import type { PublicPartnerLocation } from "../shared/public-partner";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const storefront: PublicPartnerLocation = {
  publicRef: "storefront-ref-a",
  displayName: "A Cards",
  locationName: "Canterbury Shop",
  privacyState: "PUBLIC_STOREFRONT",
  address: "1 Public Street, Canterbury",
  serviceArea: null,
  designation: "MintVault Partner",
  websiteUrl: "https://cards.example.test/",
  phone: "+44 1227 123456",
  email: "public@example.test",
  mapsUrl: "https://www.google.com/maps/search/?api=1&query=1%20Public%20Street",
  cardsGraded: 0,
  cardsGradedMeaning: "Approved cards graded by MintVault through this Partner location",
  partnerSince: null,
};

describe("exact public Partner profile renderer", () => {
  it("renders only authoritative conditional storefront actions and explains the zero count", () => {
    const html = renderToStaticMarkup(createElement(PublicPartnerProfileView, { location: storefront }));
    expect(html).toContain("1 Public Street, Canterbury");
    expect(html).toContain("Get directions");
    expect(html).toContain("Visit website");
    expect(html).toContain("Call shop");
    expect(html).toContain("Contact shop");
    expect(html).toContain("Cards graded through this MintVault Partner");
    expect(html).toContain(">0<");
    expect(html).toContain("MintVault approves the resulting grades and certificates");
  });

  it("renders service-area truth with no street-address or Maps action", () => {
    const html = renderToStaticMarkup(createElement(PublicPartnerProfileView, {
      location: {
        ...storefront,
        privacyState: "SERVICE_AREA_PRIVATE_ADDRESS",
        address: null,
        serviceArea: "Kent and East Sussex",
        mapsUrl: null,
        websiteUrl: null,
        phone: null,
        email: null,
      },
    }));
    expect(html).toContain("Serves Kent and East Sussex");
    expect(html).toContain("operating address is private");
    expect(html).not.toContain("1 Public Street");
    expect(html).not.toContain("Get directions");
    expect(html).toContain("No public contact action is currently available");
  });

  it("is the renderer mounted by public, Partner preview and Super Admin preview surfaces", () => {
    for (const file of [
      "client/src/pages/public-partner-profile.tsx",
      "client/src/pages/partner/public-profile.tsx",
      "client/src/pages/admin/partner-management-detail.tsx",
    ]) {
      expect(readFileSync(file, "utf8"), file).toContain("PublicPartnerProfileView");
    }
    const partnerPreview = readFileSync("client/src/pages/partner/public-profile.tsx", "utf8");
    const adminPreview = readFileSync("client/src/pages/admin/partner-management-detail.tsx", "utf8");
    for (const source of [partnerPreview, adminPreview]) {
      expect(source).toContain("<Dialog");
      expect(source).toContain("<DialogContent");
      expect(source).toContain("onOpenChange=");
    }
    expect(partnerPreview).toContain("expectedProfileVersion: profileVersion");
    expect(partnerPreview).toContain("expectedLocationVersion: location.version");
    expect(partnerPreview).toContain("query.data.profile?.version ?? 0");
    expect(partnerPreview).not.toContain('DialogTitle id={`preview-');
    const publicProfile = readFileSync("client/src/pages/public-partner-profile.tsx", "utf8");
    expect(publicProfile).toContain('errorKind === "request_failed"');
    expect(publicProfile).toContain("This does not mean the Partner was removed or made private.");
    expect(publicProfile).toContain("Try again");
  });

  it("uses the established keyboard-modal primitive for focus, Escape and focus restoration", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    function Probe() {
      const [open, setOpen] = useState(false);
      const triggerRef = useRef<HTMLButtonElement | null>(null);
      const wasOpenRef = useRef(false);
      useEffect(() => {
        if (!open && wasOpenRef.current) {
          wasOpenRef.current = false;
          triggerRef.current?.focus();
        }
      }, [open]);
      return createElement(
        "div",
        null,
        createElement("button", {
          ref: triggerRef,
          "data-testid": "preview-trigger",
          onClick: () => {
            wasOpenRef.current = true;
            setOpen(true);
          },
        }, "Preview"),
        createElement(
          Dialog,
          {
            open,
            onOpenChange: setOpen,
          },
          createElement(
            DialogContent,
            { "data-testid": "preview-dialog" },
            createElement(DialogTitle, null, "Exact customer view"),
            createElement("button", { "data-testid": "preview-action" }, "Preview action")
          )
        )
      );
    }
    await act(async () => root.render(createElement(Probe)));
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="preview-trigger"]')!;
    trigger.focus();
    await act(async () => trigger.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    const dialog = document.querySelector<HTMLElement>('[data-testid="preview-dialog"]')!;
    expect(dialog).toBeTruthy();
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe("Exact customer view");
    expect(dialog.contains(document.activeElement)).toBe(true);
    const focusable = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button:not([disabled])"));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    last.focus();
    await act(async () => {
      last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(first);
    await act(async () => {
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector('[data-testid="preview-dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await act(async () => root.unmount());
    host.remove();
  });

  it("keeps the compact menu through tablet/1024 widths and exposes desktop navigation at xl", () => {
    const header = readFileSync("client/src/components/v2/header-v2.tsx", "utf8");
    expect(header).toContain('className="hidden xl:flex items-center gap-6"');
    expect(header).toContain('className="xl:hidden inline-flex items-center justify-center');
    expect(header).not.toContain('className="hidden md:flex items-center gap-6"');
  });
});
