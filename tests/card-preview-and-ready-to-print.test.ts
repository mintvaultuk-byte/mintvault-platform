/**
 * card-preview-and-ready-to-print.test.ts
 *
 * BUILD 1 — the canonical Live Certificate Preview now also renders on the Card
 * stage (workflow stage 0), in the same left-column slot directly under the card
 * image, using the SAME component, the SAME preview payload builder and the SAME
 * server renderer as the Review stage. No second preview, no Card-specific
 * formatter, no new endpoint, no new label line.
 *
 * BUILD 2 — the existing PR #240 print queue is the canonical "Ready To Print"
 * surface. Only the operator-facing title/filter wording and the queue-refresh
 * behaviour changed; the lifecycle, audit, numbering and capability boundary are
 * asserted to be UNCHANGED.
 *
 * Behavioural wherever practical: the preview-payload and lifecycle assertions run
 * the real shipped functions. Layout/mount facts that need a DOM are pinned to the
 * real source, because this repo has no jsdom/RTL.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { buildPreviewFields } from "../shared/label-preview-fields";
import { consolidatedVariantForLabel } from "../server/labels";
import {
  nextState,
  effectivePrintState,
  PRINT_QUEUE_FILTER_LABEL,
  isValidReprintReason,
  matchesFilter,
} from "../shared/print-lifecycle";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const FORM = read("client/src/components/certificate-form.tsx");
const ASIDE = read("client/src/components/grading-workflow/WorkstationPreviewAside.tsx");
const QUEUE = read("client/src/pages/admin-print-queue.tsx");
const STAFF_ROUTES = read("server/routes/staff.ts");
const PANEL = read("client/src/components/grading/grading-panel.tsx");

/** The label line the canonical renderer produces for a set of form values. */
const labelLineFor = (fields: Record<string, unknown>) =>
  consolidatedVariantForLabel(buildPreviewFields(fields) as never);

// ─────────────────────────────────────────────────────────────────────────────
// BUILD 1 · Card-stage preview
// ─────────────────────────────────────────────────────────────────────────────

describe("Card-stage live certificate preview (1-3, 13)", () => {
  it("1/2. the canonical preview renders on Card Details (0) and Review (2)", () => {
    // CONSOLIDATION (2026-07-26): this guard originally read
    // `wfStage === 0 || wfStage === 1 || wfStage === 3` — Card, Rarity and Review
    // under the FOUR-stage numbering. Card and Rarity are now the single
    // "Card Details" stage 0 and Review is 2, so this is the SAME coverage
    // expressed in the three-stage numbering, NOT a narrowing. Grade (now 1)
    // remains the one stage without the preview, exactly as before.
    expect(FORM).toContain("showsPreviewAside(wfStage)");
    // The retired four-stage gate must not come back.
    expect(FORM).not.toContain("wfStage === 0 || wfStage === 1 || wfStage === 3");
    // exactly ONE mount of the panel — the same element serves both stages
    expect((FORM.match(/<CertificatePreviewPanel/g) ?? []).length).toBe(1);
  });

  it("1. it sits directly UNDER the card image in the same left column", () => {
    // The aside stacks the single card-image render site first, then `below`.
    expect(ASIDE).toContain("<div className=\"min-h-0 flex-1\">{card}</div>");
    expect(ASIDE).toContain("<div className=\"shrink-0\">{below}</div>");
    // and the form passes the preview through that `below` slot
    expect(FORM).toMatch(/below=\{[\s\S]{0,1200}<CertificatePreviewPanel/);
  });

  it("3. no duplicate preview component, formatter or endpoint was introduced", () => {
    // one panel component file, one payload builder, role-authorised endpoint
    // adapters, and one renderer
    expect(FORM).not.toContain("CardStagePreview");
    expect(FORM).not.toContain("<LabelPreview");
    expect(read("server/routes.ts")).not.toContain('app.post("/api/admin/label-preview"');
    const preview = read("server/routes/admin/label-preview.ts");
    expect((preview.match(/app\.post\(/g) ?? []).length).toBe(3);
    expect(preview).toContain('"/api/admin/certificates/label/preview"');
    expect(preview).toContain('"/api/grader/certificates/label/preview"');
    expect(preview).toContain('"/api/admin/grade-review/certificates/label/preview"');
    expect(preview).toContain('generateLabelPNG(cert, "front")');
  });

  it("13. no new language or collectionCode label output was introduced", () => {
    const labels = read("server/labels.ts");
    // buildCollectionLine remains DEAD (declared, never called) — not activated
    expect((labels.match(/buildCollectionLine/g) ?? []).length).toBe(1);
    // the front label's line set is unchanged
    expect(labels).toContain("consolidatedVariantForLabel(cert)");
    // the payload builder still carries no collectionCode
    expect(read("shared/label-preview-fields.ts")).not.toContain("collectionCode");
  });
});

describe("the preview tracks CURRENT form values for every field the label prints (4-8, 12)", () => {
  const base = {
    cardName: "Rayquaza", setName: "Base Set", year: "2022", cardNumber: "014",
    gradeType: "numeric", gradeOverall: 9, language: "English",
  };

  it("4-7. each printed Card-stage field flows through the canonical payload builder", () => {
    // Behavioural: the builder is what the preview POSTs, so a changed keystroke
    // is visible in the payload the renderer receives.
    expect(buildPreviewFields({ ...base, cardName: "Charizard" }).cardName).toBe("Charizard");
    expect(buildPreviewFields({ ...base, setName: "Jungle" }).setName).toBe("Jungle");
    expect(buildPreviewFields({ ...base, cardNumber: "099" }).cardNumber).toBe("099");
    expect(buildPreviewFields({ ...base, year: "1999" }).year).toBe("1999");
  });

  it("8. clearing a printed field clears it in the payload (no stale value retained)", () => {
    expect(buildPreviewFields({ ...base, cardName: "" }).cardName).toBe("");
    expect(buildPreviewFields({ ...base, setName: "" }).setName).toBe("");
    expect(buildPreviewFields({ ...base, cardNumber: "" }).cardNumber).toBe("");
    expect(buildPreviewFields({ ...base, year: "" }).year).toBe("");
  });

  it("12. server preview and generated label agree for identical values", () => {
    // Same builder + same renderer on both sides ⇒ identical variant line.
    const withVariant = { ...base, rarityCode: "rare_holo", structuredVariantVersion: 2 };
    expect(labelLineFor(withVariant)).toBe(consolidatedVariantForLabel(buildPreviewFields(withVariant) as never));
    // and the value itself is the canonical wording
    expect(consolidatedVariantForLabel({ structuredVariantVersion: 2, rarityCode: "rare_holo" } as never)).toBe("HOLO RARE");
  });

  it("the preview is fed from `form`, never from the saved certificate prop", () => {
    // Slice to the END of the mount rather than a fixed character budget — the
    // mount grew when the truthful `persistence` caption prop was added, and a
    // fixed window silently stops covering the later fields.
    const mountStart = FORM.indexOf("<CertificatePreviewPanel");
    const mount = FORM.slice(mountStart, FORM.indexOf("/>", FORM.indexOf("labelType: form.labelType", mountStart)));
    for (const f of ["cardName", "setName", "year", "cardNumber"]) {
      expect(mount).toContain(`${f}: form.${f}`);
      expect(mount).not.toContain(`${f}: certificate?.${f}`);
    }
  });
});

describe("the preview cannot be rolled backwards (9-11)", () => {
  it("9. a stale save response cannot roll the form (and so the preview) back", () => {
    // the queued auto-save replay posts the NEWEST closure's state…
    expect(FORM).toContain("void (autoSaveNowRef.current ?? autoSaveNow)();");
    expect(FORM).not.toMatch(/\n\s*void autoSaveNow\(\);/);
    // …and a save response only refreshes the conflict snapshot, never `form`
    const refresh = FORM.slice(FORM.indexOf("function refreshSnapshotFromCert"), FORM.indexOf("function refreshSnapshotFromCert") + 900);
    expect(refresh).not.toContain("setForm(");
  });

  it("10. Card → Rarity keeps the latest in-memory values (one form object, no per-stage copy)", () => {
    // The preview is mounted ONCE, outside every stage container, and reads the single
    // `form` object — so stage navigation cannot substitute older server values and
    // there is no per-stage duplicate of the fields.
    expect((FORM.match(/<CertificatePreviewPanel/g) ?? []).length).toBe(1);
    const mountIdx = FORM.indexOf("<CertificatePreviewPanel");
    const firstStageContainer = FORM.indexOf('data-workflow-stage=');
    expect(mountIdx).toBeLessThan(firstStageContainer); // outside the stage containers
    // goToStage only moves UI state — it must not write form values
    const goTo = FORM.slice(FORM.indexOf("function goToStage"), FORM.indexOf("function goToStage") + 500);
    expect(goTo).not.toContain("setForm(");
  });

  it("the preview remounts per certificate, so a stale rendered label cannot linger", () => {
    const mount = FORM.slice(FORM.indexOf("<CertificatePreviewPanel"), FORM.indexOf("<CertificatePreviewPanel") + 900);
    expect(mount).toContain('key={certificate?.id ?? "new"}');
  });

  it("the preview carries the REAL certificate number, not the MV-PREVIEW placeholder", () => {
    expect(buildPreviewFields({ certId: "MV-0000012345", cardName: "X" }).certId).toBe("MV-0000012345");
    // create flow still falls back to the placeholder
    expect(buildPreviewFields({ cardName: "X" }).certId).toBe("MV-PREVIEW");
    // Slice to the END of the mount rather than a fixed character budget — the
    // mount grew when the truthful `persistence` caption prop was added, and a
    // fixed window silently stops covering the later fields.
    const mountStart = FORM.indexOf("<CertificatePreviewPanel");
    const mount = FORM.slice(mountStart, FORM.indexOf("/>", FORM.indexOf("labelType: form.labelType", mountStart)));
    expect(mount).toContain("certId:");
  });

  it("11. certificate A values never appear under certificate B", () => {
    const start = FORM.indexOf("const currentCertIdRef");
    const reset = FORM.slice(start, FORM.indexOf("}, [certificate?.id]);", start));
    expect(reset).toContain("setForm(buildFormStateFromCert(certificate));");
    expect(reset).toContain("autoSavePendingRef.current = false;");
    expect(reset).toMatch(/autoSaveSeqRef\.current \+= 1;/);
    // the picker remounts per cert, and the preview is keyed off the same cert id
    expect(FORM).toContain('key={certificate?.id ?? "new"}');
    expect(FORM).toContain("certificateId: certificate?.id ?? null,");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BUILD 2 · Ready To Print (existing queue, completed)
// ─────────────────────────────────────────────────────────────────────────────

describe("Ready To Print — title and reuse", () => {
  it("the operator-facing title is Ready To Print", () => {
    expect(QUEUE).toContain('<h1 className="admin-list-head__t">Ready To Print</h1>');
    expect(PRINT_QUEUE_FILTER_LABEL.needs_printing).toBe("Ready To Print");
  });

  it("the EXISTING queue is reused — no second printing panel was created", () => {
    // one canonical page, mounted for admin and for print-capable staff
    expect(read("client/src/pages/admin-dashboard.tsx")).toContain("<AdminPrintQueue />");
    expect(read("client/src/pages/staff.tsx")).toContain('<PrintQueueConsole apiBase="/api/staff/print" />');
    // and the existing actions/filters are all still present
    for (const t of ["print-selected", "print-all-ready", "print-queue", "print-search"]) {
      expect(QUEUE).toContain(`data-testid="${t}"`);
    }
    for (const f of ["needs_printing", "printed", "reprints"] as const) {
      expect(PRINT_QUEUE_FILTER_LABEL[f]).toBeTruthy();
    }
  });
});

describe("approval gating, print history, reprint and numbering (14-18)", () => {
  it("14/15. only an approved certificate is print-eligible; unapproved cannot batch", () => {
    // behavioural, via the shipped state machine
    expect(nextState("awaiting_approval", "create_batch")).toEqual(
      expect.objectContaining({ ok: false, code: "not_approved" })
    );
    expect(nextState("needs_printing", "create_batch")).toEqual(expect.objectContaining({ ok: true, to: "printing" }));
    // approval is what derives eligibility — no stored write required
    expect(effectivePrintState({ storedState: null, approved: true })).toBe("needs_printing");
    expect(effectivePrintState({ storedState: null, approved: false })).toBe("awaiting_approval");
  });

  it("15. an approved-but-already-printed cert is not silently re-batched", () => {
    expect(nextState("printed", "create_batch")).toEqual(expect.objectContaining({ ok: false, code: "already_printed" }));
    expect(nextState("printing", "create_batch")).toEqual(expect.objectContaining({ ok: false, code: "invalid_from" }));
  });

  it("16. a successful print moves the cert OUT of Ready and into printed history", () => {
    const printed = nextState("printing", "mark_printed", { batchKind: "batch" });
    expect(printed).toEqual(expect.objectContaining({ ok: true, to: "printed" }));
    // …and it no longer satisfies the Ready filter
    const day = new Date("2026-07-25T00:00:00Z").getTime();
    const printedRow = { state: "printed" as const, printedAt: null, reprintCount: 0 };
    const readyRow = { state: "needs_printing" as const, printedAt: null, reprintCount: 0 };
    expect(matchesFilter(readyRow as never, "needs_printing", day)).toBe(true);
    expect(matchesFilter(printedRow as never, "needs_printing", day)).toBe(false);
    expect(matchesFilter(printedRow as never, "printed", day)).toBe(true);
  });

  it("17. reprint requires a real reason and resolves to reprinted (not a new print)", () => {
    expect(isValidReprintReason("too short")).toBe(false);
    expect(isValidReprintReason("Damaged during slabbing")).toBe(true);
    expect(nextState("printed", "reprint", { hasReason: false })).toEqual(
      expect.objectContaining({ ok: false, code: "reason_required" })
    );
    expect(nextState("printed", "reprint", { hasReason: true })).toEqual(
      expect.objectContaining({ ok: true, to: "reprint_required" })
    );
    expect(nextState("printing", "mark_printed", { batchKind: "reprint" })).toEqual(
      expect.objectContaining({ ok: true, to: "reprinted" })
    );
  });

  it("18. nothing in the print lifecycle generates or changes a certificate number", () => {
    const wf = read("server/print-workflow.ts");
    expect(wf).not.toMatch(/cert_counter|nextCertNumber|allocateCert/);
    // it only ever READS the certificate number
    expect(wf).toContain("certificate_number");
    expect(wf).not.toMatch(/UPDATE certificates SET certificate_number/);
  });
});

describe("printing-only capability boundary (19-20)", () => {
  it("19/20. the staff proxy whitelists print lifecycle ONLY — no grading, approval, edit or completion", () => {
    // permitted
    for (const p of [
      '"/printing/workflow/queue"',
      '"/printing/workflow/batches"',
      '"/printing/workflow/events"',
      '"/printing/workflow/batch"',
      '"/printing/workflow/mark-printed"',
      '"/printing/workflow/reprint"',
    ]) {
      expect(STAFF_ROUTES).toContain(p);
    }
    // explicitly NOT permitted
    expect(STAFF_ROUTES).not.toContain('"/printing/workflow/complete"');
    expect(STAFF_ROUTES).toMatch(/workflow\/complete is intentionally NOT here/);
    // no wildcard re-dispatch (would be privilege escalation)
    expect(STAFF_ROUTES).not.toMatch(/app\.(get|post)\("\/api\/staff\/print\/\*/);
    // and no grading/approval/certificate-edit path is whitelisted for print staff
    const printBlock = STAFF_ROUTES.slice(STAFF_ROUTES.indexOf("Printer (can_print)"), STAFF_ROUTES.indexOf("Printer (can_print)") + 4000);
    for (const forbidden of ["/certificates/:id/grade", "/approve", "/grading/approve", "/certificates/:id/correction"]) {
      expect(printBlock).not.toContain(`"${forbidden}"`);
    }
  });

  it("the capability gate is server-side and print-scoped", () => {
    expect(STAFF_ROUTES).toContain("__graderProxy");
    expect(read("server/auth.ts")).toContain("(req as any).__graderProxy === true");
  });
});

describe("queue refresh (21)", () => {
  it("21. every print mutation invalidates the canonical queue + batches keys", () => {
    const inv = QUEUE.slice(QUEUE.indexOf("const invalidate ="), QUEUE.indexOf("const invalidate =") + 400);
    expect(inv).toContain("invalidateQueries({ queryKey: queueKey })");
    expect(inv).toContain("invalidateQueries({ queryKey: batchesKey })");
    // batch create, mark-printed, complete and reprint all call it
    expect((QUEUE.match(/invalidate\(\);/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("21. final approval also invalidates the Ready To Print queue", () => {
    // Anchored to the REAL approval function — asserting the loop exists anywhere in
    // the file would pass even if it sat in an unrelated handler (it originally did).
    const approveStart = PANEL.indexOf("async function approveGrade()");
    expect(approveStart).toBeGreaterThan(-1);
    const approveBody = PANEL.slice(approveStart, PANEL.indexOf("\n  }", approveStart));
    expect(approveBody).toContain('for (const b of ["/api/admin", "/api/staff/print"])');
    expect(approveBody).toContain("`${b}/printing/workflow/queue`");
    expect(approveBody).toContain("`${b}/printing/workflow/batches`");
    // covering BOTH bases matters: the queue keys off its own apiBase, so an
    // admin-only key is a silent no-op for a can_grade+can_print account.
  });

  it("21. the queue re-checks on window focus (no polling, no sockets added)", () => {
    expect(QUEUE).toContain("refetchOnWindowFocus: true");
    expect(QUEUE).not.toMatch(/refetchInterval:\s*\d/);
    expect(QUEUE).not.toContain("WebSocket");
    expect(QUEUE).not.toContain("EventSource");
  });
});

describe("grading origin (22)", () => {
  it("22. no origin is displayed, because no immutable snapshot exists to display", () => {
    // The queue row contract has no origin field, and the queue must NOT invent one
    // from the partner's MUTABLE current profile. Asserted so a future change has to
    // add the snapshot deliberately rather than silently deriving unreliable data.
    const schema = read("shared/schema.ts");
    const rowIdx = schema.indexOf("export interface PrintQueueRow");
    const row = schema.slice(rowIdx, schema.indexOf("}", rowIdx));
    for (const f of ["origin", "shopName", "gradingLocation", "partnerName", "tenant"]) {
      expect(row).not.toContain(f);
    }
    // the queue does not read partner profile tables either
    expect(QUEUE).not.toMatch(/partner_locations|partnerLocations|shopName/);
  });
});
