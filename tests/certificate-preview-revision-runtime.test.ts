// @vitest-environment happy-dom
import React from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CertificatePreviewPanel,
  type CertificatePreviewFields,
} from "../client/src/components/grading-workflow/CertificatePreviewPanel";
import { GradingWorkstation } from "../client/src/components/grading-workflow/GradingWorkstation";
import { createCanonicalHarnessFetchFixture } from "../client/src/pages/dev-canonical-workstation-harness";
import type { CanonicalHarnessFixtureState } from "../client/src/pages/dev-canonical-workstation-harness";

let host: HTMLDivElement;
let root: Root;

const fields = (gradeOverall: string): CertificatePreviewFields => ({
  certificateId: 41,
  certId: "MV41",
  cardName: "Race fixture",
  gradeOverall,
});

async function renderPreview(props: {
  fields: CertificatePreviewFields;
  revision: number;
  onRevisionComplete: (revision: number, ok: boolean, fingerprint: string) => void;
  expectedRevision?: number;
  requireExpectedRevision?: boolean;
  requestTimeoutMs?: number;
}) {
  await act(async () => {
    root.render(React.createElement(CertificatePreviewPanel, props));
  });
}

async function mountProductionWorkstation(): Promise<CanonicalHarnessFixtureState> {
  window.localStorage.setItem("mv.aiIdentify", "0");
  const fixture = createCanonicalHarnessFetchFixture(vi.fn() as unknown as typeof fetch);
  vi.stubGlobal("fetch", fixture.fetch);
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        queryFn: async ({ queryKey }) => {
          const response = await fetch(String(queryKey[0]));
          if (!response.ok) throw new Error(`Fixture query failed (${response.status})`);
          return response.json();
        },
      },
      mutations: { retry: false },
    },
  });
  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(GradingWorkstation, {
          mode: "grader",
          apiBase: "/api/grader",
          graderMode: true,
          certId: 103,
          certIdStr: "MV-0000000103",
          cardName: "Charizard",
          cardSet: "Base Set",
          cardNumber: "4/102",
          cardYear: "1999",
          cardLanguage: "English",
          cardGame: "pokemon",
          existingGrade: "9.5",
          pendingAnalysis: null,
          onPendingAnalysisConsumed: () => {},
          onManualIdentification: () => {},
          onGradeApproved: () => {},
          onCertUpdated: async () => {},
        })
      )
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => vi.advanceTimersByTimeAsync(400));
  fixture.state.reset();
  const grade = host.querySelector<HTMLButtonElement>('[data-testid="workflow-stage-grade"]');
  expect(grade).not.toBeNull();
  await act(async () => grade!.click());
  return fixture.state;
}

const workstationStage = () =>
  host.querySelector('[data-testid="grading-workstation-slot"]')?.getAttribute("data-ws-stage");

async function advanceUntil(predicate: () => boolean, maxMs = 20_000): Promise<boolean> {
  for (let elapsed = 0; elapsed <= maxMs; elapsed += 100) {
    if (predicate()) return true;
    await act(async () => vi.advanceTimersByTimeAsync(100));
  }
  return predicate();
}

async function requestReview(doubleClick = false) {
  const review = host.querySelector<HTMLButtonElement>('[data-testid="workflow-stage-review"]');
  expect(review).not.toBeNull();
  await act(async () => {
    review!.click();
    if (doubleClick) review!.click();
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:preview") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("mounted CertificatePreviewPanel revision acknowledgement", () => {
  it("acknowledges the exact rendered revision and payload fingerprint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["png"]), { status: 200 }))
    );
    const acknowledgements = vi.fn();
    await renderPreview({ fields: fields("9"), revision: 7, onRevisionComplete: acknowledgements });
    await act(async () => vi.advanceTimersByTimeAsync(350));

    expect(fetch).toHaveBeenCalledOnce();
    expect(acknowledgements).toHaveBeenCalledWith(7, true, JSON.stringify(fields("9")));
    expect(host.querySelector('[data-testid="certificate-preview-image"]')).not.toBeNull();
  });

  it("sends the saved server revision and becomes ready only when the label response acknowledges that exact revision", async () => {
    const expectedRevision = 17;
    const fetchMock = vi.fn(async () =>
      new Response(new Blob(["png"]), {
        status: 200,
        headers: { "X-MintVault-Review-Revision": String(expectedRevision) },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const acknowledgements = vi.fn();
    await renderPreview({
      fields: fields("9"),
      revision: 70,
      expectedRevision,
      requireExpectedRevision: true,
      onRevisionComplete: acknowledgements,
    });
    await act(async () => vi.advanceTimersByTimeAsync(350));

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ expectedRevision });
    expect(acknowledgements).toHaveBeenCalledWith(70, true, JSON.stringify(fields("9")), expectedRevision);
  });

  it("fails closed when a prepared preview omits or mismatches the authoritative revision header", async () => {
    const acknowledgements = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["png"]), { status: 200 })));
    await renderPreview({
      fields: fields("9"),
      revision: 71,
      expectedRevision: 18,
      requireExpectedRevision: true,
      onRevisionComplete: acknowledgements,
    });
    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(acknowledgements).toHaveBeenCalledWith(71, false, JSON.stringify(fields("9")), null);
    expect(host.textContent).toContain("did not acknowledge");
  });

  it("settles the old revision false when an immediate sub-500ms edit supersedes it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["png"]), { status: 200 }))
    );
    const acknowledgements = vi.fn();
    await renderPreview({ fields: fields("8"), revision: 8, onRevisionComplete: acknowledgements });
    await act(async () => vi.advanceTimersByTimeAsync(100));
    await renderPreview({ fields: fields("9.5"), revision: 9, onRevisionComplete: acknowledgements });

    expect(acknowledgements).toHaveBeenCalledWith(8, false, JSON.stringify(fields("8")));
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(acknowledgements).toHaveBeenCalledWith(9, true, JSON.stringify(fields("9.5")));
  });

  it("never lets an old in-flight preview acknowledge a newer rapid change", async () => {
    let resolveOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => oldResponse)
      .mockResolvedValueOnce(new Response(new Blob(["new"]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const acknowledgements = vi.fn();
    await renderPreview({ fields: fields("8"), revision: 10, onRevisionComplete: acknowledgements });
    await act(async () => vi.advanceTimersByTimeAsync(350));
    await renderPreview({ fields: fields("9"), revision: 11, onRevisionComplete: acknowledgements });
    expect(acknowledgements).toHaveBeenCalledWith(10, false, JSON.stringify(fields("8")));
    await act(async () => vi.advanceTimersByTimeAsync(350));
    resolveOld(new Response(new Blob(["old"]), { status: 200 }));
    await act(async () => Promise.resolve());

    expect(acknowledgements).toHaveBeenCalledWith(11, true, JSON.stringify(fields("9")));
    expect(acknowledgements.mock.calls.filter(([revision, ok]) => revision === 10 && ok)).toHaveLength(0);
  });

  it("acknowledges HTTP failure and a hung request timeout as terminal failures", async () => {
    const acknowledgements = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "denied" }), { status: 403 }))
    );
    await renderPreview({ fields: fields("8"), revision: 12, onRevisionComplete: acknowledgements });
    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(acknowledgements).toHaveBeenCalledWith(12, false, JSON.stringify(fields("8")));

    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {}))
    );
    await renderPreview({
      fields: fields("9"),
      revision: 13,
      onRevisionComplete: acknowledgements,
      requestTimeoutMs: 50,
    });
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(acknowledgements).toHaveBeenCalledWith(13, false, JSON.stringify(fields("9")));
    expect(host.textContent).toContain("timed out");
  });

  it("settles a pending revision false on unmount", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {}))
    );
    const acknowledgements = vi.fn();
    await renderPreview({ fields: fields("8"), revision: 14, onRevisionComplete: acknowledgements });
    await act(async () => vi.advanceTimersByTimeAsync(350));
    act(() => root.unmount());

    expect(acknowledgements).toHaveBeenCalledWith(14, false, JSON.stringify(fields("8")));
  });

  it("emits a new fingerprint when edited after a successful ready preview", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["png"]), { status: 200 }))
    );
    const acknowledgements = vi.fn();
    await renderPreview({ fields: fields("8"), revision: 15, onRevisionComplete: acknowledgements });
    await act(async () => vi.advanceTimersByTimeAsync(350));
    await renderPreview({ fields: fields("9"), revision: 15, onRevisionComplete: acknowledgements });
    await act(async () => vi.advanceTimersByTimeAsync(350));

    expect(acknowledgements).toHaveBeenCalledWith(15, true, JSON.stringify(fields("8")));
    expect(acknowledgements).toHaveBeenCalledWith(15, true, JSON.stringify(fields("9")));
  });

  it("runs the real GradingWorkstation/GradingPanel immediate eye-appeal and double-Review flow", async () => {
    const state = await mountProductionWorkstation();
    const eyeAppeal = host.querySelector<HTMLButtonElement>('[data-testid="btn-eye-appeal-p1"]');
    expect(eyeAppeal).not.toBeNull();

    // Two distinct browser events, with no 500ms autosave delay between them.
    await act(async () => eyeAppeal!.click());
    await requestReview(true);
    expect(await advanceUntil(() => workstationStage() === "2", 2_000)).toBe(true);

    const puts = state.requests.filter((request) => request.method === "PUT");
    const previews = state.requests.filter(
      (request) => request.method === "POST" && request.pathname.endsWith("/label/preview")
    );
    expect(puts.length).toBeGreaterThan(0);
    expect((puts.at(-1)?.body as { eye_appeal_modifier?: number }).eye_appeal_modifier).toBe(1);
    expect(previews.length).toBeGreaterThan(0);
    const lastPreview = previews.at(-1)!;
    expect((lastPreview.body as { expectedRevision?: unknown }).expectedRevision).toBe(state.savedRevisions.grader);
    expect(typeof (lastPreview.body as { expectedRevision?: unknown }).expectedRevision).toBe("number");
    expect(workstationStage()).toBe("2");
    expect(host.querySelector('[data-testid="review-transition-status"]')).toBeNull();
  });

  it("keeps the full workstation on Grade with a terminal error after save failure", async () => {
    const state = await mountProductionWorkstation();
    state.failNext("save", 409);
    await requestReview();
    expect(
      await advanceUntil(
        () => host.querySelector('[data-testid="review-transition-status"]')?.textContent?.includes("locked") ?? false,
        1_000
      )
    ).toBe(true);
    expect(workstationStage()).toBe("1");
    expect(state.snapshot().filter((request) => request.operation === "preview")).toHaveLength(0);
  });

  it("keeps the full workstation locked after preview failure and preview timeout", async () => {
    const failedState = await mountProductionWorkstation();
    failedState.failNext("preview", 503);
    await requestReview();
    expect(
      await advanceUntil(
        () => host.querySelector('[data-testid="review-transition-status"]')?.textContent?.includes("locked") ?? false,
        2_000
      )
    ).toBe(true);
    expect(workstationStage()).toBe("1");

    act(() => root.unmount());
    host.replaceChildren();
    root = createRoot(host);
    const timedState = await mountProductionWorkstation();
    timedState.delayNext("preview", 13_000);
    await requestReview();
    expect(
      await advanceUntil(
        () => host.querySelector('[data-testid="review-transition-status"]')?.textContent?.includes("locked") ?? false,
        13_000
      )
    ).toBe(true);
    expect(workstationStage()).toBe("1");
  });

  it("rejects an edit arriving behind an old delayed save response", async () => {
    const state = await mountProductionWorkstation();
    state.delayNext("save", 500);
    await requestReview();
    await act(async () => vi.advanceTimersByTimeAsync(100));
    const eyeAppeal = host.querySelector<HTMLButtonElement>('[data-testid="btn-eye-appeal-p2"]');
    expect(eyeAppeal).not.toBeNull();
    await act(async () => eyeAppeal!.click());
    expect(
      await advanceUntil(
        () => host.querySelector('[data-testid="review-transition-status"]')?.textContent?.includes("locked") ?? false,
        1_000
      )
    ).toBe(true);
    expect(workstationStage()).toBe("1");
    const saved = state.snapshot().find((request) => request.operation === "save");
    expect((saved?.body as { eye_appeal_modifier?: number }).eye_appeal_modifier).not.toBe(2);
  });

  it("rejects an old delayed preview after navigation at the server revision boundary and accepts only the retry", async () => {
    const state = await mountProductionWorkstation();
    state.staleNextPreview(1_000);
    await requestReview();
    expect(await advanceUntil(() => state.snapshot().some((request) => request.operation === "preview"), 1_000)).toBe(
      true
    );
    const grade = host.querySelector<HTMLButtonElement>('[data-testid="workflow-stage-grade"]');
    await act(async () => grade!.click());
    expect(workstationStage()).toBe("1");
    await requestReview();
    expect(await advanceUntil(() => workstationStage() === "2", 2_000)).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    const previews = state.snapshot().filter((request) => request.operation === "preview");
    expect(previews).toHaveLength(2);
    // The delayed R2 request reaches the fixture after the retry saved R3, so
    // the server-side expectedRevision precondition rejects it rather than
    // returning stale pixels for the client to discard.
    expect(previews[0].outcome).toBe("blocked");
    expect(previews[0].completionSequence).toBeGreaterThan(previews[1].completionSequence!);
  });

  it("invalidates an edit made during preview and makes the same Review stage retry actionable", async () => {
    const state = await mountProductionWorkstation();
    state.delayNext("preview", 1_000);
    await requestReview();
    expect(await advanceUntil(() => state.snapshot().some((request) => request.operation === "preview"), 1_000)).toBe(
      true
    );
    const eyeAppeal = host.querySelector<HTMLButtonElement>('[data-testid="btn-eye-appeal-p2"]');
    await act(async () => eyeAppeal!.click());
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(await advanceUntil(() => workstationStage() === "2", 500)).toBe(true);
    await act(async () => Promise.resolve());

    // The old save/preview pair may paint Review, but it must not remain an
    // actionable ready revision after the live payload changed underneath it.
    expect(host.querySelector<HTMLButtonElement>('[data-testid="btn-approve-publish"]')?.disabled).toBe(true);
    await requestReview();
    const retryReady = await advanceUntil(
      () =>
        workstationStage() === "2" &&
        !host.querySelector<HTMLButtonElement>('[data-testid="btn-approve-publish"]')?.disabled,
      2_000
    );
    expect(
      retryReady,
      JSON.stringify({
        stage: workstationStage(),
        status: host.querySelector('[data-testid="review-transition-status"]')?.textContent,
        approveDisabled: host.querySelector<HTMLButtonElement>('[data-testid="btn-approve-publish"]')?.disabled,
        audit: state.snapshot(),
      })
    ).toBe(true);
    const audit = state.snapshot();
    expect(audit.filter((request) => request.operation === "save")).toHaveLength(2);
    expect(audit.filter((request) => request.operation === "preview")).toHaveLength(2);
    expect(
      (audit.filter((request) => request.operation === "save").at(-1)?.body as { eye_appeal_modifier?: number })
        .eye_appeal_modifier
    ).toBe(2);
  });

  it("invalidates approval and blocks the role action after a post-ready edit", async () => {
    const state = await mountProductionWorkstation();
    await requestReview();
    const enteredReview = await advanceUntil(() => workstationStage() === "2", 2_000);
    expect(
      enteredReview,
      JSON.stringify({
        stage: workstationStage(),
        status: host.querySelector('[data-testid="review-transition-status"]')?.textContent,
        audit: state.snapshot(),
      })
    ).toBe(true);
    const approve = host.querySelector<HTMLButtonElement>('[data-testid="btn-approve-publish"]');
    expect(approve?.disabled).toBe(false);
    const eyeAppeal = host.querySelector<HTMLButtonElement>('[data-testid="btn-eye-appeal-m1"]');
    await act(async () => eyeAppeal!.click());
    expect(host.querySelector<HTMLButtonElement>('[data-testid="btn-approve-publish"]')?.disabled).toBe(true);
    expect(host.querySelector('[data-testid="btn-approve-publish"]')?.textContent).toContain("Preparing saved review");

    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="btn-approve-publish"]')!.click());
    expect(state.snapshot().filter((request) => request.pathname.endsWith("/submit"))).toHaveLength(0);
  });

  it("gates double approval to one role action request", async () => {
    const state = await mountProductionWorkstation();
    await requestReview();
    expect(await advanceUntil(() => workstationStage() === "2", 2_000)).toBe(true);
    const approve = host.querySelector<HTMLButtonElement>('[data-testid="btn-approve-publish"]');
    await act(async () => approve!.click());
    const confirmationButtons = [...host.querySelectorAll<HTMLButtonElement>("button")].filter((button) =>
      button.textContent?.includes("Submit for approval")
    );
    const confirm = confirmationButtons.at(-1);
    expect(confirm).toBeDefined();
    await act(async () => {
      confirm!.click();
      confirm!.click();
      await Promise.resolve();
    });
    const submissions = state.snapshot().filter((request) => request.pathname.endsWith("/submit"));
    expect(submissions).toHaveLength(1);
  });

  it("aborts a delayed save on full-workstation unmount without preview or state-update warnings", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = await mountProductionWorkstation();
    state.delayNext("save", 1_000);
    await requestReview();
    expect(await advanceUntil(() => state.snapshot().some((request) => request.operation === "save"), 200)).toBe(true);
    act(() => root.unmount());
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(state.snapshot().filter((request) => request.operation === "preview")).toHaveLength(0);
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("unmounted component");
  });
});
