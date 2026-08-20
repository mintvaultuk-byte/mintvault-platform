// @vitest-environment happy-dom
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardPreviewPanel } from "../client/src/components/grading-workflow/CardPreviewPanel";
import { createCardInspectionState } from "../client/src/components/grading-workflow/card-inspection-state";
import ImageViewer from "../client/src/components/grading/image-viewer";
import ManualCardTool from "../client/src/components/grading/manual-card-tool";
const IMAGE = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='500' height='700'/>";
const ADMITTED_WORKING_EVIDENCE = {
  front: {
    available: true,
    reason: null,
    recovery: null,
    master: { dpi: 1200, width: 4724, height: 6136 },
    working: { width: 4724, height: 6136, format: "jpeg" },
  },
  back: {
    available: true,
    reason: null,
    recovery: null,
    master: { dpi: 1200, width: 4724, height: 6136 },
    working: { width: 4724, height: 6136, format: "jpeg" },
  },
};
let host;
let root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

async function flushQuery(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

describe("mounted controlled card inspection", () => {
  it("keeps real drag pan, zoom and side state while the workstation stage changes", async () => {
    function Host() {
      const [inspection, setInspection] = useState(createCardInspectionState);
      const [stage, setStage] = useState(0);
      return /* @__PURE__ */ React.createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { queryFn: async () => ({}) } } }) },
        /* @__PURE__ */ React.createElement(
          "button",
          { "data-testid": "stage", onClick: () => setStage((value) => value + 1) },
          stage
        ),
        /* @__PURE__ */ React.createElement(CardPreviewPanel, {
          certificateId: null,
          frontFile: new File(["front"], "front.png", { type: "image/png" }),
          backFile: new File(["back"], "back.png", { type: "image/png" }),
          inspectionState: inspection,
          onInspectionStateChange: setInspection,
        })
      );
    }
    vi.spyOn(URL, "createObjectURL").mockImplementation((file) => `blob:${file.name}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    await act(async () => root.render(/* @__PURE__ */ React.createElement(Host, null)));
    const viewport = host.querySelector('[data-testid="card-preview-viewport"]');
    const image = host.querySelector('[data-testid="card-preview-image"]');
    Object.defineProperty(image, "offsetWidth", { configurable: true, value: 400 });
    Object.defineProperty(image, "offsetHeight", { configurable: true, value: 560 });
    const zoomIn = host.querySelector('[aria-label="Zoom in"]');
    await act(async () => zoomIn.click());
    await act(async () => {
      viewport.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 200, clientY: 280 }));
      viewport.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 240, clientY: 224 }));
      viewport.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 240, clientY: 224 }));
    });
    expect(viewport.dataset.inspectionZoom).toBe("1.75");
    expect(Number(viewport.dataset.inspectionFocusX)).toBeCloseTo(0.4);
    expect(Number(viewport.dataset.inspectionFocusY)).toBeCloseTo(0.6);
    await act(async () => host.querySelector('[data-testid="stage"]').click());
    expect(viewport.dataset.inspectionZoom).toBe("1.75");
    expect(Number(viewport.dataset.inspectionFocusX)).toBeCloseTo(0.4);
    await act(async () => host.querySelector('[data-testid="card-preview-back"]').click());
    expect(viewport.dataset.inspectionSide).toBe("back");
    expect(viewport.dataset.inspectionZoom).toBe("1");
    await act(async () => host.querySelector('[aria-label="Zoom in"]').click());
    expect(viewport.dataset.inspectionZoom).toBe("1.75");
    await act(async () => host.querySelector('[data-testid="card-preview-front"]').click());
    expect(viewport.dataset.inspectionZoom).toBe("1.75");
    await act(async () => host.querySelector('[aria-label="Fit to screen / reset zoom"]').click());
    expect(viewport.dataset.inspectionZoom).toBe("1");
    expect(viewport.dataset.inspectionFocusX).toBe("0.5");
    expect(viewport.dataset.inspectionFocusY).toBe("0.5");
    await act(async () => host.querySelector('[data-testid="card-preview-back"]').click());
    expect(viewport.dataset.inspectionZoom).toBe("1.75");
  });
  it("atomically publishes click focus+zoom and never mixes inspection with mark coordinates", async () => {
    let observed = createCardInspectionState();
    const added = [];
    function Host() {
      const [inspection, setInspection] = useState(observed);
      return /* @__PURE__ */ React.createElement(ImageViewer, {
        urls: { front_working: IMAGE, back_working: IMAGE },
        workingEvidence: ADMITTED_WORKING_EVIDENCE,
        defects: [],
        onDefectAdded: (defect) => added.push(defect),
        highlightId: null,
        inspectionState: inspection,
        onInspectionStateChange: (next) => {
          observed = next;
          setInspection(next);
        },
      });
    }
    await act(async () => root.render(/* @__PURE__ */ React.createElement(Host, null)));
    const viewport = host.querySelector('[data-testid="grading-image-viewport"]');
    Object.defineProperty(viewport, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, top: 0, width: 400, height: 560, right: 400, bottom: 560, x: 0, y: 0, toJSON() {} }),
    });
    await act(async () =>
      viewport.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 100, clientY: 420 }))
    );
    expect(observed.views.front).toEqual({ zoom: 1.5, focusX: 0.25, focusY: 0.75 });
    const mark = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Mark Defects"));
    expect(mark).toBeDefined();
    await act(async () => mark.click());
    const markViewport = host.querySelector<HTMLElement>('[data-testid="grading-image-viewport"]')!;
    expect(markViewport.dataset.coordinateMode).toBe("measurement");
    const beforeMarkClick = structuredClone(observed);
    vi.spyOn(Date, "now").mockReturnValueOnce(1e3).mockReturnValueOnce(2e3);
    const setImageRect = () =>
      Object.defineProperty(host.querySelector("img"), "getBoundingClientRect", {
        configurable: true,
        value: () => ({
          left: 20,
          top: 30,
          width: 200,
          height: 280,
          right: 220,
          bottom: 310,
          x: 20,
          y: 30,
          toJSON() {},
        }),
      });
    setImageRect();
    await act(async () => {
      markViewport.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 120, clientY: 170 }));
      markViewport.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 120, clientY: 170 }));
    });
    expect(observed).toEqual(beforeMarkClick);
    expect(host.querySelector("img").style.transform).toBe("");
    const assign = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Assign Type"));
    await act(async () => assign.click());
    await act(async () => document.querySelector('[data-testid="mvgs-pick-WH"]').click());
    expect(added[0]).toMatchObject({ x_percent: 50, y_percent: 50, image_side: "front" });
    const back = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "back");
    await act(async () => back.click());
    setImageRect();
    const activeViewport = host.querySelector('[data-testid="grading-image-viewport"]');
    await act(async () => {
      activeViewport.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 70, clientY: 100 }));
      activeViewport.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 70, clientY: 100 }));
    });
    const assignBack = [...host.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Assign Type")
    );
    await act(async () => assignBack.click());
    await act(async () => document.querySelector('[data-testid="mvgs-pick-WH"]').click());
    expect(added[1]).toMatchObject({ x_percent: 25, y_percent: 25, image_side: "back" });
    const done = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Done Marking"));
    await act(async () => done.click());
    const front = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "front");
    await act(async () => front.click());
    expect(observed.views.front).toEqual({ zoom: 1.5, focusX: 0.25, focusY: 0.75 });
    expect(added.map((defect) => defect.image_side)).toEqual(["front", "back"]);
  });

  it("automatically shows FRONT/BACK working evidence and has no full-resolution toggle", async () => {
    await act(async () =>
      root.render(
        /* @__PURE__ */ React.createElement(ImageViewer, {
          urls: {
            front_working: "https://evidence.test/front-working.jpg",
            front_display: "https://display.test/front-display.jpg",
            front_original: "https://legacy.test/front-original.jpg",
            back_working: "https://evidence.test/back-working.jpg",
            back_display: "https://display.test/back-display.jpg",
            back_original: "https://legacy.test/back-original.jpg",
          },
          workingEvidence: ADMITTED_WORKING_EVIDENCE,
          defects: [],
          onDefectAdded: () => {},
          highlightId: null,
        })
      )
    );
    const buttonByText = (text) =>
      [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === text);
    const viewport = host.querySelector('[data-testid="grading-image-viewport"]');

    expect(buttonByText("Full-Resolution Working Evidence")).toBeUndefined();
    expect(viewport.dataset.inspectionSource).toBe("working-evidence");
    expect(host.querySelector("img").getAttribute("src")).toBe("https://evidence.test/front-working.jpg");

    await act(async () => buttonByText("back").click());
    expect(viewport.dataset.inspectionSource).toBe("working-evidence");
    expect(host.querySelector("img").getAttribute("src")).toBe("https://evidence.test/back-working.jpg");
    expect(host.querySelector('[data-testid="working-evidence-status"]')?.textContent).toContain(
      "Full-resolution working evidence · back"
    );
  });

  it("fails visibly instead of silently substituting a display derivative when working evidence is absent", async () => {
    await act(async () =>
      root.render(
        /* @__PURE__ */ React.createElement(ImageViewer, {
          urls: {
            front_display: "https://display.test/front-display.jpg",
            front_original: "https://legacy.test/front-original.jpg",
          },
          defects: [],
          onDefectAdded: () => {},
          highlightId: null,
        })
      )
    );
    const viewport = host.querySelector('[data-testid="grading-image-viewport"]');
    expect(viewport.dataset.inspectionSource).toBe("working-evidence-unavailable");
    expect(host.querySelector('[data-testid="working-evidence-unavailable"]')).toBeTruthy();
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("FRONT cannot be graded from a display derivative");
    expect(host.querySelector('[data-testid="working-evidence-status"]')?.textContent).toContain(
      "Working evidence unavailable · front"
    );
  });

  it("honours a server rejection even if a stale working URL remains in client state", async () => {
    await act(async () =>
      root.render(
        /* @__PURE__ */ React.createElement(ImageViewer, {
          urls: { front_working: "https://stale.test/front-working.jpg" },
          workingEvidence: {
            front: {
              available: false,
              reason: "Working evidence dimensions do not match the canonical master.",
              recovery: "Regenerate the working evidence from the immutable 1200-DPI master.",
              master: { dpi: 1200, width: 4724, height: 6136 },
              working: { width: 1600, height: 2079, format: "jpeg" },
            },
          },
          defects: [],
          onDefectAdded: () => {},
          highlightId: null,
        })
      )
    );
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("FULL-RESOLUTION EVIDENCE UNAVAILABLE");
    expect(host.textContent).toContain("dimensions do not match");
    expect(host.textContent).toContain("immutable 1200-DPI master");
  });

  it("keeps the Card Details and Review preview fail-closed too", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          queryFn: async () => ({ urls: { front_display: "https://display.test/front-display.jpg" } }),
          retry: false,
        },
      },
    });
    await act(async () =>
      root.render(
        /* @__PURE__ */ React.createElement(
          QueryClientProvider,
          { client: queryClient },
          /* @__PURE__ */ React.createElement(CardPreviewPanel, {
            certificateId: 99,
            inspectionState: createCardInspectionState(),
            onInspectionStateChange: () => {},
          })
        )
      )
    );
    await flushQuery();
    expect(host.querySelector('[data-testid="card-preview-image"]')).toBeNull();
    expect(host.textContent).toContain("FULL-RESOLUTION EVIDENCE UNAVAILABLE");
    expect(host.textContent).toContain("FRONT cannot be inspected from a display derivative");
  });

  it("keeps Card Details closed when a stale working URL is explicitly rejected", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          queryFn: async () => ({
            urls: { front_working: "https://stale.test/front-working.jpg" },
            workingEvidence: {
              front: {
                available: false,
                reason: "Working evidence dimensions do not match the canonical master.",
                recovery: "Regenerate the working evidence from the immutable 1200-DPI master.",
              },
            },
          }),
          retry: false,
        },
      },
    });
    await act(async () =>
      root.render(
        /* @__PURE__ */ React.createElement(
          QueryClientProvider,
          { client: queryClient },
          /* @__PURE__ */ React.createElement(CardPreviewPanel, {
            certificateId: 100,
            inspectionState: createCardInspectionState(),
            onInspectionStateChange: () => {},
          })
        )
      )
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.querySelector('[data-testid="card-preview-image"]')).toBeNull();
    expect(host.textContent).toContain("FULL-RESOLUTION EVIDENCE UNAVAILABLE");
    expect(host.textContent).toContain("dimensions do not match");
  });

  it("mounts the selected side's Card Tool directly and keeps FRONT/BACK actions isolated", async () => {
    const opened: Array<"front" | "back"> = [];
    await act(async () =>
      root.render(
        /* @__PURE__ */ React.createElement(ImageViewer, {
          urls: { front_working: IMAGE, back_working: IMAGE },
          workingEvidence: ADMITTED_WORKING_EVIDENCE,
          defects: [],
          onDefectAdded: () => {},
          onOpenCardTool: (side) => opened.push(side),
          highlightId: null,
        })
      )
    );
    await act(async () => host.querySelector('[data-testid="btn-card-tool-front"]').click());
    await act(async () =>
      [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "back").click()
    );
    await act(async () => host.querySelector('[data-testid="btn-card-tool-back"]').click());
    expect(opened).toEqual(["front", "back"]);
  });

  it("disables a side's Card Tool when its working evidence is rejected", async () => {
    await act(async () =>
      root.render(
        /* @__PURE__ */ React.createElement(ImageViewer, {
          urls: { front_working: IMAGE, back_working: IMAGE },
          workingEvidence: {
            front: {
              available: true,
              reason: null,
              recovery: null,
              master: { dpi: 1200, width: 4724, height: 6136 },
              working: { width: 4724, height: 6136, format: "jpeg" },
            },
            back: {
              available: false,
              reason: "The 1200-DPI master is unavailable.",
              recovery: "Restore canonical evidence.",
              master: null,
              working: null,
            },
          },
          defects: [],
          onDefectAdded: () => {},
          onOpenCardTool: () => {},
          highlightId: null,
        })
      )
    );
    expect(host.querySelector<HTMLButtonElement>('[data-testid="btn-card-tool-front"]')?.disabled).toBe(false);
    expect(host.querySelector<HTMLButtonElement>('[data-testid="btn-card-tool-back"]')?.disabled).toBe(true);
  });

  it("runs each Card Tool side from its admitted full-resolution working source", async () => {
    await act(async () =>
      root.render(
        /* @__PURE__ */ React.createElement(ManualCardTool, {
          certId: 99,
          side: "front",
          workingImageUrl: "https://evidence.test/front-working.jpg",
          onDone: () => {},
          onCancel: () => {},
        })
      )
    );
    expect(host.querySelector("img")?.getAttribute("src")).toBe("https://evidence.test/front-working.jpg");

    await act(async () =>
      root.render(
        /* @__PURE__ */ React.createElement(ManualCardTool, {
          certId: 99,
          side: "back",
          workingImageUrl: "https://evidence.test/back-working.jpg",
          onDone: () => {},
          onCancel: () => {},
        })
      )
    );
    expect(host.querySelector("img")?.getAttribute("src")).toBe("https://evidence.test/back-working.jpg");
  });
});
