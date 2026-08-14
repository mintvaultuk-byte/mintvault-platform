// @vitest-environment happy-dom
import React from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CertificatePreviewPanel } from "../client/src/components/grading-workflow/CertificatePreviewPanel";
import { WorkstationPreviewAside } from "../client/src/components/grading-workflow/WorkstationPreviewAside";

let host: HTMLDivElement;
let root: Root;

const fields = {
  certificateId: 41,
  certId: "MV41",
  cardName: "Preview fixture",
  gradeOverall: "9",
};

async function renderPreview() {
  await act(async () => {
    root.render(
      React.createElement(CertificatePreviewPanel, {
        fields,
        revision: 1,
        onRevisionComplete: vi.fn(),
      })
    );
  });
}

const panel = () => host.querySelector<HTMLElement>('[data-testid="certificate-preview-panel"]');
const frame = () => host.querySelector('[data-testid="certificate-preview-frame"]');
const status = () => host.querySelector('[data-testid="certificate-preview-status"]');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:preview") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("CertificatePreviewPanel compact states", () => {
  it("uses one compact status row before and during a render instead of reserving label height", async () => {
    let resolvePreview!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => {
        resolvePreview = resolve;
      }))
    );

    await renderPreview();
    expect(panel()?.dataset.previewState).toBe("empty");
    expect(status()?.textContent).toContain("Preview unavailable / preparing");
    expect(frame()).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(panel()?.dataset.previewState).toBe("loading");
    expect(status()?.textContent).toContain("Preparing preview");
    expect(frame()).toBeNull();

    resolvePreview(new Response(new Blob(["png"]), { status: 200 }));
    await act(async () => Promise.resolve());
  });

  it("keeps render failures in the same compact status geometry and preserves the error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Renderer unavailable" }), { status: 503 }))
    );

    await renderPreview();
    await act(async () => vi.advanceTimersByTimeAsync(350));

    expect(panel()?.dataset.previewState).toBe("error");
    expect(status()?.textContent).toContain("Renderer unavailable");
    expect(frame()).toBeNull();
  });

  it("renders the authoritative label as a bounded, undistorted thumbnail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["png"]), { status: 200 })));

    await renderPreview();
    await act(async () => vi.advanceTimersByTimeAsync(350));

    const image = host.querySelector<HTMLImageElement>('[data-testid="certificate-preview-image"]');
    expect(panel()?.dataset.previewState).toBe("ready");
    expect(frame()).not.toBeNull();
    expect(status()).toBeNull();
    expect(image).not.toBeNull();
    // These runtime class assertions describe behavior, while the browser
    // verification covers their computed desktop geometry.
    expect(panel()?.className).toContain("max-w-[280px]");
    expect(image?.className).toContain("h-auto");
    expect(image?.className).toContain("object-contain");
  });
});

describe("workstation rail composition", () => {
  it("keeps the card before the compact preview in normal flex flow", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["png"]), { status: 200 })));
    await act(async () => {
      root.render(
        React.createElement(WorkstationPreviewAside, {
          certificateId: 41,
          interactiveCardHostRef: React.createRef<HTMLDivElement>(),
          below: React.createElement(CertificatePreviewPanel, {
            fields,
            revision: 1,
            onRevisionComplete: vi.fn(),
          }),
        })
      );
    });

    const aside = host.querySelector<HTMLElement>('[data-testid="grading-preview-panel"]');
    expect(aside).not.toBeNull();
    expect(aside?.className).toContain("flex-col");
    expect(aside?.children).toHaveLength(2);
    expect(aside?.children[0].className).toContain("flex-1");
    expect(aside?.children[1].className).toContain("shrink-0");
    expect(aside?.querySelector('[data-testid="certificate-preview-panel"]')).not.toBeNull();
  });
});
