import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import GradingPanel from "@/components/grading/grading-panel";
import { WorkstationHeaderStrip } from "@/components/grading-workflow/WorkstationHeaderStrip";
import { WorkstationPreviewAside } from "@/components/grading-workflow/WorkstationPreviewAside";
import {
  CertificatePreviewPanel,
  type CertificatePreviewFields,
} from "@/components/grading-workflow/CertificatePreviewPanel";
import {
  CanonicalGradingWorkstationShell,
  WORKSTATION_BODY_SCROLL_CLASS,
  WORKSTATION_HEADER_REGION_CLASS,
} from "@/components/grading-workflow/CanonicalGradingWorkstationShell";
import { runReviewTransitionBarrier, type PersistedReviewRevision } from "@shared/grading-review-barrier";
import { createCardInspectionState } from "@/components/grading-workflow/card-inspection-state";

/**
 * GradingWorkstation — a THIN role adapter for /staff, /grader and /admin/staff.
 *
 * It owns NO layout: all workstation geometry (full width, two-panel columns,
 * internal scroll, sticky actions, responsive breakpoints) comes from the single
 * CanonicalGradingWorkstationShell — the exact same shell the /admin dashboard
 * and every focused role route render. Role differences are capabilities + data
 * source only.
 *
 * HEIGHT CONTRACT: the shell fills its parent (h-full). This adapter's own root
 * is `flex min-h-0 flex-1 flex-col`, so it fills whatever bounded flex slot the
 * route gives it (each active grading view is a `h-[100dvh] flex flex-col`
 * focused container). It does NOT set a viewport-relative height and does NOT
 * wrap the shell in an `admin-root` (min-height:100vh) box — both of those made
 * the shell shorter than its container and left a black band at the bottom. The
 * `--admin-*` tokens are global (:root), so colours work without admin-root.
 *
 * `identityEditor` (Admin Review) and `scannerControls` (station-capable roles)
 * render INSIDE the workstation scroll body. They are capability slots, not
 * alternate stage or viewer implementations, so every role still shares one
 * inspection rail, three-stage controller, preview and review barrier.
 */
export type GradingWorkstationMode = "super-admin" | "admin" | "admin-review" | "staff" | "grader" | "partner";

/** 3-stage flow: 0 = Card Details, 1 = Grade, 2 = Review. */
const GRADE_STAGE = 1;
/** M-2 · Approve/Publish lives on Review, so the Ctrl+Enter shortcut does too. */
const REVIEW_STAGE = 2;

type GradingPanelProps = React.ComponentProps<typeof GradingPanel>;

/**
 * PR A (hostile review M-1) · `active` is OMITTED from this adapter's public
 * props ON PURPOSE.
 *
 * /grader, /staff and /admin/staff all mount the workstation through here, and
 * the stage that decides whether Grade is on screen is THIS component's own
 * `stage` state (below) — the pages never see it. Letting a page pass `active`
 * would let it contradict the stage the user is actually looking at, which is
 * precisely the fail-open shape the review flagged. The adapter derives the flag
 * from its own state and passes it explicitly to GradingPanel, so all three
 * standalone surfaces are covered by construction rather than by remembering.
 */
// MUST stay multi-line. Collapsed onto one line, `Omit<` and `GradingPanelProps`
// become adjacent and form the JSX open-tag literal for the grading panel. The
// protected architecture suite locates the single real render site by the FIRST
// occurrence of that literal (it asserts the identity-editor slot comes above
// it), so a one-line form silently breaks that check. Hence prettier-ignore.
// prettier-ignore
type Props = Omit<
  GradingPanelProps,
  "active" | "approvalStageActive"
> & {
  mode: GradingWorkstationMode;
  /** Optional queue position for the header strip (e.g. Staff "3 / 40"). */
  queue?: { position: number; total: number };
  batch?: { customer?: string; submissionId?: string; remaining?: number };
  /** Admin Review identity editor, rendered inside the workstation body (top of
   *  the right column, beside the preview). When present, the preview aside is
   *  forced on so the card sits left / editor right. */
  identityEditor?: ReactNode;
  /** Scanner/station controls belong to Card Details inside this canonical
   *  workstation. Routes may provide the existing, capability-authorised
   *  control, but may not mount an independent scanner/viewer surface. */
  scannerControls?: ReactNode;
  /** Create mode has no certificate row to grade yet. */
  gradingEnabled?: boolean;
  previewCertificateId?: number | null;
};

export function GradingWorkstation({
  mode,
  queue,
  batch,
  identityEditor,
  scannerControls,
  gradingEnabled = true,
  previewCertificateId,
  ...panelProps
}: Props) {
  const apiBase = panelProps.apiBase ?? "/api/admin";
  const rootRef = useRef<HTMLDivElement>(null);
  // Every grading role enters the same three-stage flow at Card Details. Pending
  // Review is the one capability-driven exception: reviewers land directly on
  // Review, with every stage still reachable from the shared strip.
  const [stage, setStage] = useState(() => (mode === "admin-review" ? REVIEW_STAGE : 0));
  const [interactiveCardHost, setInteractiveCardHost] = useState<HTMLDivElement | null>(null);
  const [draftPreview, setDraftPreview] = useState<CertificatePreviewFields | null>(null);
  const [authoritativePreview, setAuthoritativePreview] = useState<CertificatePreviewFields | null>(null);
  const [inspectionState, setInspectionState] = useState(createCardInspectionState);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [previewExpectedRevision, setPreviewExpectedRevision] = useState<number | null>(null);
  const previewRequestSeqRef = useRef(0);
  const transitionSeqRef = useRef(0);
  const previewWaitersRef = useRef(
    new Map<number, { expectedFingerprint: string; expectedRevision: number; resolve: (ok: boolean) => void }>()
  );
  const [reviewTransitionHandler, setReviewTransitionHandler] = useState<
    (() => Promise<PersistedReviewRevision<CertificatePreviewFields>>) | null
  >(null);
  const [reviewReady, setReviewReady] = useState<PersistedReviewRevision<CertificatePreviewFields> | null>(null);
  const [reviewBarrierStatus, setReviewBarrierStatus] = useState<"idle" | "saving" | "previewing" | "error">("idle");
  const interactiveCardHostRef = useCallback((node: HTMLDivElement | null) => setInteractiveCardHost(node), []);
  useEffect(
    () => () => {
      for (const waiter of previewWaitersRef.current.values()) waiter.resolve(false);
      previewWaitersRef.current.clear();
    },
    []
  );

  // The stage bar GATES content (hidden-not-unmounted via the .grading-stage-gate
  // CSS on the body wrapper below): selecting a stage shows only that stage's
  // GradingPanel sections. Scroll back to the top so the new stage starts at the
  // top of the scroll body.
  const scrollStageTop = useCallback(() => {
    rootRef.current?.querySelector<HTMLElement>('[data-testid="grading-workstation-slot"]')?.scrollTo({ top: 0 });
  }, []);

  const handlePreviewRevisionComplete = useCallback(
    (revision: number, ok: boolean, fingerprint: string, authoritativeRevision?: number | null) => {
    const waiter = previewWaitersRef.current.get(revision);
    if (!waiter) return;
    previewWaitersRef.current.delete(revision);
    const exact =
      ok &&
      fingerprint === waiter.expectedFingerprint &&
      authoritativeRevision === waiter.expectedRevision;
    if (!exact) setAuthoritativePreview(null);
    waiter.resolve(exact);
    },
    []
  );
  const registerReviewTransitionHandler = useCallback(
    (handler: (() => Promise<PersistedReviewRevision<CertificatePreviewFields>>) | null) =>
      setReviewTransitionHandler(() => handler),
    []
  );
  const handleReviewValidityChange = useCallback((valid: boolean, revision: number) => {
    if (valid) return;
    setReviewReady((ready) => {
      if (!ready || ready.revision !== revision) return ready;
      setAuthoritativePreview(null);
      setReviewBarrierStatus("idle");
      return null;
    });
  }, []);

  const requestAuthoritativePreview = useCallback(
    (snapshot: PersistedReviewRevision<CertificatePreviewFields>): Promise<boolean> => {
      const requestRevision = ++previewRequestSeqRef.current;
      setAuthoritativePreview(snapshot.preview);
      setPreviewExpectedRevision(snapshot.revision);
      setPreviewRevision(requestRevision);
      setReviewBarrierStatus("previewing");
      const expectedFingerprint = JSON.stringify(snapshot.preview);
      return new Promise<boolean>((resolve) =>
        previewWaitersRef.current.set(requestRevision, {
          expectedFingerprint,
          expectedRevision: snapshot.revision,
          resolve,
        })
      );
    },
    []
  );

  const establishReview = useCallback(async () => {
    if (!reviewTransitionHandler) {
      setReviewBarrierStatus("error");
      return;
    }
    const attempt = ++transitionSeqRef.current;
    setReviewReady(null);
    setReviewBarrierStatus("saving");
    const result = await runReviewTransitionBarrier({
      persist: reviewTransitionHandler,
      preview: requestAuthoritativePreview,
      isCurrent: () => transitionSeqRef.current === attempt,
    });
    if (transitionSeqRef.current !== attempt) return;
    if (!result.ok) {
      setAuthoritativePreview(null);
      setPreviewExpectedRevision(null);
      setReviewBarrierStatus("error");
      return;
    }
    setReviewReady(result.snapshot);
    setReviewBarrierStatus("idle");
    setStage(REVIEW_STAGE);
    scrollStageTop();
  }, [requestAuthoritativePreview, reviewTransitionHandler, scrollStageTop]);

  const goToStage = useCallback(
    (index: number) => {
      if (gradingEnabled && index === REVIEW_STAGE && (stage !== REVIEW_STAGE || !reviewReady)) {
        void establishReview();
        return;
      }
      transitionSeqRef.current += 1;
      for (const waiter of previewWaitersRef.current.values()) waiter.resolve(false);
      previewWaitersRef.current.clear();
      setAuthoritativePreview(null);
      if (index !== REVIEW_STAGE) setReviewReady(null);
      setReviewBarrierStatus("idle");
      setStage(index);
      scrollStageTop();
    },
    [establishReview, gradingEnabled, reviewReady, scrollStageTop, stage]
  );

  const certId = panelProps.certId;
  const resolvedPreviewCertificateId = previewCertificateId === undefined ? certId : previewCertificateId;
  useEffect(() => {
    transitionSeqRef.current += 1;
    for (const waiter of previewWaitersRef.current.values()) waiter.resolve(false);
    previewWaitersRef.current.clear();
    setAuthoritativePreview(null);
    setPreviewExpectedRevision(null);
    setReviewReady(null);
    setReviewBarrierStatus("idle");
    setInspectionState(createCardInspectionState());
    setStage(mode === "admin-review" ? REVIEW_STAGE : 0);
  }, [certId, mode]);

  // Pending Review opens on Review by design. Establish the same persisted +
  // exact-preview barrier as soon as its panel has hydrated and registered.
  useEffect(() => {
    if (mode === "admin-review" && stage === REVIEW_STAGE && reviewTransitionHandler && !reviewReady) {
      void establishReview();
    }
  }, [establishReview, mode, reviewReady, reviewTransitionHandler, stage]);
  const panelPreviewFields = useMemo<CertificatePreviewFields>(
    () =>
      draftPreview?.certificateId === certId
        ? draftPreview
        : {
            certificateId: certId,
            certId: panelProps.certIdStr,
            cardName: panelProps.cardName,
            setName: panelProps.cardSet,
            year: panelProps.cardYear ?? undefined,
            cardNumber: panelProps.cardNumber ?? undefined,
            language: panelProps.cardLanguage ?? undefined,
            variant: panelProps.cardVariant ?? undefined,
            gradeOverall: panelProps.existingGrade,
          },
    [
      draftPreview,
      certId,
      panelProps.certIdStr,
      panelProps.cardName,
      panelProps.cardSet,
      panelProps.cardYear,
      panelProps.cardNumber,
      panelProps.cardLanguage,
      panelProps.cardVariant,
      panelProps.existingGrade,
    ]
  );
  const previewFields = authoritativePreview ?? panelPreviewFields;
  const handleDraftPreviewChange = useCallback((preview: CertificatePreviewFields) => {
    if (previewWaitersRef.current.size === 0) setDraftPreview(preview);
  }, []);
  const handlePreviewSaved = useCallback((revision: number | null) => {
    // Existing certificate previews are server-authorised against the revision
    // read from hydration or returned by a grade save. Create-mode previews
    // intentionally have no persisted revision yet.
    // A grading-query refetch can arrive while the Review barrier is rendering
    // its exact saved revision. Do not let that secondary hydration effect
    // supersede/cancel the prepared preview waiter; the waiter itself owns the
    // only transition to Review-ready.
    if (previewWaitersRef.current.size > 0) return;
    setPreviewExpectedRevision(revision);
    setPreviewRevision(++previewRequestSeqRef.current);
  }, []);
  const previewEndpoint = `${apiBase}/certificates/label/preview`;
  const workstationCapabilities =
    mode === "partner"
      ? {
    catalogueEndpoint: "/api/partner/catalogue/snapshot",
    customSetMutations: false,
    identify: false,
    imageMutations: false,
    generateDescription: false,
        }
      : undefined;

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="grading-workstation"
      data-mode={mode}
      data-api-base={apiBase}
    >
      <CanonicalGradingWorkstationShell
        rootRef={rootRef}
        previewAside={
          resolvedPreviewCertificateId != null ? (
            <WorkstationPreviewAside
              certificateId={resolvedPreviewCertificateId ?? null}
              inspectionState={inspectionState}
              onInspectionStateChange={setInspectionState}
              apiBase={apiBase}
              interactiveCardHostRef={gradingEnabled ? interactiveCardHostRef : undefined}
              below={
                <CertificatePreviewPanel
                  key={certId}
                  fields={previewFields}
                  endpoint={previewEndpoint}
                  persistence={reviewReady ? "saved" : "unsaved"}
                  revision={previewRevision}
                  expectedRevision={previewExpectedRevision}
                  requireExpectedRevision={resolvedPreviewCertificateId != null}
                  onRevisionComplete={handlePreviewRevisionComplete}
                />
              }
            />
          ) : null
        }
      >
        {/* Fixed (shrink-0) header region — canonical class, same as /admin. */}
        <div className={WORKSTATION_HEADER_REGION_CLASS}>
          <WorkstationHeaderStrip
            workflowCurrent={stage}
            workflowMax={3}
            onStageClick={(i) => goToStage(i)}
            queue={queue}
            batch={batch}
            sessionCompleted={0}
          />
          {reviewBarrierStatus !== "idle" && (
            <div
              className={`px-3 py-1 text-xs ${reviewBarrierStatus === "error" ? "text-red-300" : "text-amber-300"}`}
              data-testid="review-transition-status"
            >
              {reviewBarrierStatus === "saving"
                ? "Saving the authoritative grade before Review…"
                : reviewBarrierStatus === "previewing"
                  ? "Refreshing the certificate preview for that saved revision…"
                  : "Review is locked because save or preview failed. Retry Review."}
            </div>
          )}
        </div>
        {/* Canonical scroll body — same class as the /admin <form> body. The
            grading-stage-gate + data-ws-stage drive stage-content gating (CSS in
            admin-tokens.css) so the stage bar controls which GradingPanel
            sections are shown — hidden-not-unmounted, no grading-logic change. */}
        <div
          className={`${WORKSTATION_BODY_SCROLL_CLASS} grading-stage-gate`}
          data-testid="grading-workstation-slot"
          data-ws-stage={stage}
        >
          {/* Scanner/station entry controls share the canonical right-column
              scroll body and stage owner. CSS makes this Card Details-only;
              the control itself owns capture-session transport, not another
              card viewer, inspection state or workflow stage. */}
          {scannerControls && (
            <div data-canonical-section="scanner-controls" data-testid="workstation-scanner-controls">
              {scannerControls}
            </div>
          )}
          {/* Admin Review identity editor — inside the workstation body (right
              column), above the grading panel; never a detached section. */}
          {identityEditor && <div data-testid="workstation-identity-editor">{identityEditor}</div>}
          {/* Remount per card so no identity/grade/approval state leaks between
              records (GradingPanel seeds a lot of state from props at mount). */}
          {/* PR A · EXPLICIT lifecycle. The Grade panel is hidden-not-unmounted
              by the stage gate above, so it must be told when it is genuinely on
              screen — otherwise its debounced auto-save keeps running behind
              Card Details / Review and persists UI defaults as grading data.
              Derived from this adapter's own stage, which is the only thing that
              knows; `active` is not accepted from the page for that reason. */}
          {/* M-2 · each shortcut is wired to the stage that OWNS it: Ctrl+S to
              Grade (`active`), Ctrl+Enter to Review (`approvalStageActive`).
              Both derive from THIS adapter's own stage for the same reason —
              a page must not be able to contradict what is on screen. */}
          {gradingEnabled && (
          <GradingPanel
            key={`${apiBase}:${certId}`}
            {...panelProps}
            active={stage === GRADE_STAGE}
            approvalStageActive={stage === REVIEW_STAGE}
              previewHost={gradingEnabled ? interactiveCardHost : null}
              inspectionState={inspectionState}
              onInspectionStateChange={setInspectionState}
              onPreviewChange={handleDraftPreviewChange}
              onPreviewSaved={handlePreviewSaved}
              onReviewTransitionReady={registerReviewTransitionHandler}
              reviewBarrierReady={reviewReady}
              onReviewValidityChange={handleReviewValidityChange}
            workstationCapabilities={workstationCapabilities}
          />
          )}
        </div>
      </CanonicalGradingWorkstationShell>
    </div>
  );
}

export default GradingWorkstation;
