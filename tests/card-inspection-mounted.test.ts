// @vitest-environment happy-dom
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardPreviewPanel } from "../client/src/components/grading-workflow/CardPreviewPanel";
import { createCardInspectionState } from "../client/src/components/grading-workflow/card-inspection-state";
import ImageViewer, { isInspectionShortcutTarget } from "../client/src/components/grading/image-viewer";
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
  it("excludes form and editable targets from inspection keyboard shortcuts", () => {
    for (const element of [
      document.createElement("input"),
      document.createElement("textarea"),
      document.createElement("select"),
      Object.assign(document.createElement("div"), { contentEditable: "true" }),
    ]) {
      document.body.appendChild(element);
      expect(isInspectionShortcutTarget(element)).toBe(true);
      element.remove();
    }
    const combobox = document.createElement("div");
    combobox.setAttribute("role", "combobox");
    const child = document.createElement("span");
    combobox.appendChild(child);
    document.body.appendChild(combobox);
    expect(isInspectionShortcutTarget(child)).toBe(true);
    expect(isInspectionShortcutTarget(document.createElement("button"))).toBe(false);
    combobox.remove();
  });

  it("leaves browser zoom keyboard chords untouched while plain inspection shortcuts still work", async () => {
    await act(async () =>
      root.render(
        /* @__PURE__ */ React.createElement(ImageViewer, {
          urls: { front_working: IMAGE, back_working: IMAGE },
          workingEvidence: ADMITTED_WORKING_EVIDENCE,
          defects: [],
          onDefectAdded: () => {},
          highlightId: null,
          fillHost: true,
        })
      )
    );
    const viewport = host.querySelector<HTMLElement>('[data-testid="grading-image-viewport"]')!;
    const browserZoom = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "=",
    });
    await act(async () => document.dispatchEvent(browserZoom));
    expect(browserZoom.defaultPrevented).toBe(false);
    expect(viewport.dataset.inspectionZoom).toBe("1");

    const inspectionZoom = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "+" });
    await act(async () => document.dispatchEvent(inspectionZoom));
    expect(inspectionZoom.defaultPrevented).toBe(true);
    expect(viewport.dataset.inspectionZoom).toBe("1.25");
  });

  it("does not turn the release of a pan drag into an extra click-to-zoom step", async () => {
    await act(async () =>
      root.render(
        /* @__PURE__ */ React.createElement(ImageViewer, {
          urls: { front_working: IMAGE, back_working: IMAGE },
          workingEvidence: ADMITTED_WORKING_EVIDENCE,
          defects: [],
          onDefectAdded: () => {},
          highlightId: null,
        })
      )
    );
    const viewport = host.querySelector<HTMLElement>('[data-testid="grading-image-viewport"]')!;
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
    expect(viewport.dataset.inspectionZoom).toBe("1.25");
    await act(async () =>
      viewport.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 100, clientY: 100 }))
    );
    await act(async () =>
      viewport.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 140, clientY: 100 }))
    );
    await act(async () =>
      viewport.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 140, clientY: 100 }))
    );
    await act(async () =>
      viewport.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 140, clientY: 100 }))
    );
    expect(viewport.dataset.inspectionZoom).toBe("1.25");
  });

  it("retains natural dimensions when FRONT and BACK share an already-loaded image URL", async () => {
    await act(async () =>
      root.render(
        /* @__PURE__ */ React.createElement(ImageViewer, {
          urls: { front_working: IMAGE, back_working: IMAGE },
          workingEvidence: ADMITTED_WORKING_EVIDENCE,
          defects: [],
          onDefectAdded: () => {},
          highlightId: null,
          fillHost: true,
        })
      )
    );
    const image = host.querySelector<HTMLImageElement>('[data-testid="grading-card-image"]')!;
    Object.defineProperties(image, {
      complete: { configurable: true, value: true },
      naturalWidth: { configurable: true, value: 500 },
      naturalHeight: { configurable: true, value: 700 },
    });
    await act(async () => image.dispatchEvent(new Event("load", { bubbles: true })));
    expect(host.querySelector<HTMLElement>('[data-testid="grading-image-viewport"]')!.dataset.cardNaturalW).toBe(
      "500"
    );

    const back = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "back"
    )!;
    await act(async () => back.click());
    const switched = host.querySelector<HTMLElement>('[data-testid="grading-image-viewport"]')!;
    expect(switched.dataset.inspectionSide).toBe("back");
    expect(switched.dataset.cardNaturalW).toBe("500");
    expect(switched.dataset.cardNaturalH).toBe("700");
  });

  it("keeps image deletion behind its explicit lifecycle capability", async () => {
    const props = {
      urls: { front_working: IMAGE, back_working: IMAGE },
      workingEvidence: ADMITTED_WORKING_EVIDENCE,
      defects: [],
      onDefectAdded: () => {},
      highlightId: null,
      certId: 42,
      mutationsEnabled: true,
      sourceImageMutationsEnabled: true,
    };
    await act(async () =>
      root.render(
        /* @__PURE__ */ React.createElement(ImageViewer, {
          ...props,
          sourceImageDeletionEnabled: false,
        })
      )
    );
    expect(host.querySelector('button[title="Delete front image"]')).toBeNull();

    await act(async () =>
      root.render(
        /* @__PURE__ */ React.createElement(ImageViewer, {
          ...props,
          sourceImageDeletionEnabled: true,
        })
      )
    );
    expect(host.querySelector('button[title="Delete front image"]')).not.toBeNull();
  });

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
    expect(observed.views.front).toEqual({ zoom: 1.25, focusX: 0.25, focusY: 0.75 });
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
    expect(observed.views.front).toEqual({ zoom: 1.25, focusX: 0.25, focusY: 0.75 });
    expect(added.map((defect) => defect.image_side)).toEqual(["front", "back"]);
  });

  it("keeps the image, defect pins, line measurements and centering on one transform plane", async () => {
    await act(async () =>
      root.render(
        /* @__PURE__ */ React.createElement(ImageViewer, {
          urls: { front_working: IMAGE, back_working: IMAGE },
          workingEvidence: ADMITTED_WORKING_EVIDENCE,
          defects: [
            {
              id: 7,
              image_side: "front",
              x_percent: 22.5,
              y_percent: 73.25,
              type: "Scratch",
              severity: "minor",
              description: "coordinate proof",
              location: "front",
            },
          ],
          whiteningLines: [
            {
              id: "wl-proof",
              side: "front",
              edge: "left",
              coveragePct: 10,
              start: { x: 10, y: 20 },
              end: { x: 10, y: 40 },
            },
          ],
          centeringFront: {
            ratioLR: "50/50",
            ratioTB: "50/50",
            outerFrame: { left_pct: 2, right_pct: 98, top_pct: 2, bottom_pct: 98 },
            innerFrame: { left_pct: 10, right_pct: 90, top_pct: 12, bottom_pct: 88 },
          },
          onDefectAdded: () => {},
          onDefectsChange: () => {},
          highlightId: null,
        })
      )
    );

    const plane = host.querySelector<HTMLElement>('[data-testid="grading-coordinate-plane"]')!;
    const image = host.querySelector('[data-testid="grading-card-image"]')!;
    const pin = host.querySelector('[aria-label^="Defect 1:"]')!;
    expect(plane.contains(image)).toBe(true);
    expect(plane.contains(pin)).toBe(true);
    expect(plane.querySelector('line[x1="10"][y1="20"]')).toBeTruthy();
    expect(pin.parentElement?.style.left).toBe("22.5%");
    expect(pin.parentElement?.style.top).toBe("73.25%");

    const centering = [...host.querySelectorAll("button")].find((button) => button.textContent === "Show Centering")!;
    await act(async () => centering.click());
    expect(plane.querySelector('rect[x="2"][y="2"]')).toBeTruthy();

    const mark = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Mark Defects"))!;
    await act(async () => mark.click());
    const markPlane = host.querySelector<HTMLElement>('[data-testid="grading-coordinate-plane"]')!;
    expect(markPlane.contains(host.querySelector('[data-testid="grading-card-image"]')!)).toBe(true);
    expect(markPlane.contains(host.querySelector('[aria-label^="Defect 1:"]')!)).toBe(true);
    expect(host.querySelector('[data-testid="grading-image-viewport"]')?.getAttribute("data-coordinate-mode")).toBe(
      "measurement"
    );
  });

  it("leaves ordinary page wheel input alone and reserves Ctrl/Cmd+wheel for image zoom", async () => {
    let observed = createCardInspectionState();
    function Host() {
      const [inspection, setInspection] = useState(observed);
      return /* @__PURE__ */ React.createElement(ImageViewer, {
        urls: { front_working: IMAGE, back_working: IMAGE },
        workingEvidence: ADMITTED_WORKING_EVIDENCE,
        defects: [],
        onDefectAdded: () => {},
        highlightId: null,
        inspectionState: inspection,
        onInspectionStateChange: (next) => {
          observed = next;
          setInspection(next);
        },
      });
    }
    await act(async () => root.render(/* @__PURE__ */ React.createElement(Host, null)));
    const viewport = host.querySelector<HTMLElement>('[data-testid="grading-card-viewport"]')!;
    const ordinary = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 });
    await act(async () => viewport.dispatchEvent(ordinary));
    expect(ordinary.defaultPrevented).toBe(false);
    expect(observed.views.front.zoom).toBe(1);

    const inspectionWheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -100,
      clientX: 100,
      clientY: 100,
    });
    // happy-dom does not currently retain WheelEvent modifier flags from the
    // constructor; define the browser-provided read-only value for this test.
    Object.defineProperty(inspectionWheel, "ctrlKey", { value: true });
    await act(async () => viewport.dispatchEvent(inspectionWheel));
    expect(observed.views.front.zoom).toBeCloseTo(Math.exp(0.2), 8);
    expect(inspectionWheel.defaultPrevented).toBe(true);
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

  it("keeps the Partner unavailable state visible and never mounts the admin-only upload recovery", async () => {
    await act(async () =>
      root.render(
        /* @__PURE__ */ React.createElement(ImageViewer, {
          urls: { front_display: "https://display.test/front-display.jpg" },
          defects: [],
          onDefectAdded: () => {},
          highlightId: null,
          certId: 279,
          mutationsEnabled: true,
          apiBase: "/api/partner/grading",
        })
      )
    );
    expect(host.querySelector('[data-testid="working-evidence-unavailable"]')).toBeTruthy();
    expect(host.querySelector('input[type="file"]')).toBeNull();
    expect(host.textContent).toContain("FULL-RESOLUTION EVIDENCE UNAVAILABLE");
  });

  it("keeps Partner inspection tools but removes dead source-image mutation controls", async () => {
    await act(async () =>
      root.render(
        /* @__PURE__ */ React.createElement(ImageViewer, {
          urls: {
            front_working: IMAGE,
            back_working: IMAGE,
            front_original: "https://legacy.test/front-original.jpg",
            back_original: "https://legacy.test/back-original.jpg",
          },
          workingEvidence: ADMITTED_WORKING_EVIDENCE,
          defects: [],
          onDefectAdded: () => {},
          onOpenCardTool: () => {},
          certId: 279,
          mutationsEnabled: true,
          sourceImageMutationsEnabled: false,
          apiBase: "/api/partner/grading",
          highlightId: null,
        })
      )
    );
    expect(host.querySelector('[data-testid="btn-card-tool-front"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="btn-card-tool-back"]')).toBeTruthy();
    expect([...host.querySelectorAll("button")].some((button) => button.textContent?.includes("Manual Crop"))).toBe(
      false
    );
    expect(host.querySelector('[title^="Delete"]')).toBeNull();
  });

  it("keeps the Partner Card Tool on admitted working evidence without exposing Auto-Detect", async () => {
    await act(async () =>
      root.render(
        /* @__PURE__ */ React.createElement(ManualCardTool, {
          certId: 279,
          side: "front",
          workingImageUrl: IMAGE,
          allowSourceImageMutations: false,
          onDone: () => {},
          onCancel: () => {},
        })
      )
    );
    expect(host.querySelector("img")?.getAttribute("src")).toBe(IMAGE);
    expect([...host.querySelectorAll("button")].some((button) => button.textContent?.includes("Auto-Detect"))).toBe(
      false
    );
  });

  it("renders admin-review authoritative FRONT/BACK images without weakening grader working-evidence fallback", async () => {
    await act(async () =>
      root.render(
        /* @__PURE__ */ React.createElement(ImageViewer, {
          urls: {
            front_display: "https://display.test/front-display.jpg",
            back_display: "https://display.test/back-display.jpg",
            front_review: "https://review.test/mv686-front.jpg",
            back_review: "https://review.test/mv686-back.jpg",
          },
          workingEvidence: {
            front: {
              available: false,
              reason: "Full-resolution working evidence has not been generated for this side.",
              recovery: "Regenerate the working evidence from the immutable 1200-DPI master.",
              master: null,
              working: null,
            },
            back: {
              available: false,
              reason: "Full-resolution working evidence has not been generated for this side.",
              recovery: "Regenerate the working evidence from the immutable 1200-DPI master.",
              master: null,
              working: null,
            },
          },
          reviewEvidence: {
            front: { available: true, reason: null, recovery: null, source: "certificate-bound-image" },
            back: { available: true, reason: null, recovery: null, source: "certificate-bound-image" },
          },
          defects: [
            {
              id: 1,
              image_side: "front",
              x_percent: 20,
              y_percent: 30,
              type: "Scratch",
              severity: "minor",
              description: "front scratch",
              location: "front",
            },
          ],
          onDefectAdded: () => {},
          highlightId: null,
        })
      )
    );
    const buttonByText = (text) =>
      [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === text);
    const viewport = host.querySelector('[data-testid="grading-image-viewport"]');
    expect(viewport.dataset.inspectionSource).toBe("review-evidence");
    expect(host.querySelector("img").getAttribute("src")).toBe("https://review.test/mv686-front.jpg");
    expect(host.querySelector("img").getAttribute("data-review-evidence")).toBe("certificate-bound-image");
    expect(host.querySelector('[data-testid="working-evidence-status"]')?.textContent).toContain(
      "Authoritative review image · front"
    );

    await act(async () => buttonByText("back").click());
    expect(viewport.dataset.inspectionSource).toBe("review-evidence");
    expect(host.querySelector("img").getAttribute("src")).toBe("https://review.test/mv686-back.jpg");
    expect(host.querySelector('[data-testid="working-evidence-status"]')?.textContent).toContain(
      "Authoritative review image · back"
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

  it("fails visibly when a supposedly admitted working URL cannot load", async () => {
    await act(async () =>
      root.render(
        /* @__PURE__ */ React.createElement(ImageViewer, {
          urls: { front_working: "https://evidence.test/missing-working.jpg" },
          workingEvidence: { front: ADMITTED_WORKING_EVIDENCE.front },
          defects: [],
          onDefectAdded: () => {},
          highlightId: null,
        })
      )
    );
    const image = host.querySelector("img")!;
    await act(async () => image.dispatchEvent(new Event("error", { bubbles: true })));
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector('[data-testid="working-evidence-unavailable"]')).toBeTruthy();
    expect(host.textContent).toContain("could not be loaded");
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
