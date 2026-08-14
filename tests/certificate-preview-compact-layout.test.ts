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
  it("uses no empty shell and only one compact neutral line while rendering", async () => {
    let resolvePreview!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => {
        resolvePreview = resolve;
      }))
    );

    await renderPreview();
    expect(panel()?.dataset.previewState).toBe("empty");
    expect(panel()?.children).toHaveLength(0);
    expect(status()).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(panel()?.dataset.previewState).toBe("loading");
    expect(status()?.textContent).toContain("Preparing preview");
    expect(status()?.getAttribute("aria-live")).toBe("polite");
    expect(panel()?.children).toHaveLength(1);

    resolvePreview(new Response(new Blob(["png"]), { status: 200 }));
    await act(async () => Promise.resolve());
  });

  it("keeps render failures as a compact retry control and retries the real request", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Renderer unavailable" }), { status: 503 }))
        .mockResolvedValueOnce(new Response(new Blob(["png"]), { status: 200 }))
    );

    await renderPreview();
    await act(async () => vi.advanceTimersByTimeAsync(350));

    expect(panel()?.dataset.previewState).toBe("error");
    expect(status()?.textContent).toBe("Preview unavailable · Retry");
    expect(status()?.tagName).toBe("BUTTON");
    await act(async () => (status() as HTMLButtonElement).click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350);
      await Promise.resolve();
    });
    await act(async () => Promise.resolve());
    expect(panel()?.dataset.previewState).toBe("ready");
    expect(host.querySelector('[data-testid="certificate-preview-image"]')).not.toBeNull();
  });

  it("renders the authoritative label as a bare, aspect-correct thumbnail with no preview chrome", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["png"]), { status: 200 })));

    await renderPreview();
    await act(async () => vi.advanceTimersByTimeAsync(350));

    const image = host.querySelector<HTMLImageElement>('[data-testid="certificate-preview-image"]');
    expect(panel()?.dataset.previewState).toBe("ready");
    expect(status()).toBeNull();
    expect(image).not.toBeNull();
    expect(image?.parentElement).toBe(panel());
    expect(panel()?.children).toHaveLength(1);
    expect(image?.getAttribute("width")).toBe("266");
    expect(image?.getAttribute("height")).toBe("76");
    expect(266 / 76).toBeCloseTo(826 / 236, 2);
    expect(host.textContent).not.toContain("Live label preview");
    expect(host.textContent).not.toContain("Save a grade to prepare Review");
    expect(host.querySelector('[data-testid="certificate-preview-caption"]')).toBeNull();
  });
});

describe("workstation rail composition", () => {
  it("keeps the primary card as the grow allocation before the thumbnail in normal flex flow", async () => {
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
