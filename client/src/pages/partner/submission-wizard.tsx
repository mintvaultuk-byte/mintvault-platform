/**
 * Partner Portal — New Submission wizard (Increment B). Five clear steps: Customer, Service,
 * Cards, Review, Submit. A draft is created on entry (using the session's current location) and
 * every subsequent change is saved via the existing version-checked PATCH — so navigating between
 * steps never loses data, and a stale-write conflict is surfaced rather than silently overwritten.
 * Submit uses a STABLE idempotency key (generated once per submission attempt, not per render) so
 * a double-click or network retry can never create two submissions.
 */
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  partnerSubmissions,
  partnerCards,
  partnerCustomers,
  partnerServiceTiers,
  partnerErrorMessage,
  newIdempotencyKey,
  formatPence,
  type SubmissionSummary,
  type SubmissionCard,
  type PartnerCustomer,
  type AvailableServiceTier,
} from "@/lib/partner-api";
import { usePartnerSession } from "@/hooks/use-partner-session";
import { PARTNER_CARD_CATEGORIES } from "@shared/partner-card-categories";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { Trash2, Pencil, Check, X } from "lucide-react";

const STEPS = ["Customer", "Service", "Cards", "Review", "Submit"] as const;
type SaveStatus = "idle" | "saving" | "saved" | "error" | "conflict";

export default function PartnerSubmissionWizardPage() {
  const [, navigate] = useLocation();
  const { session } = usePartnerSession();
  const qc = useQueryClient();

  const [step, setStep] = useState(0);
  const [submission, setSubmission] = useState<SubmissionSummary | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");

  // Step 1 — customer
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [customerDisplay, setCustomerDisplay] = useState<string>("");
  const [internalReference, setInternalReference] = useState("");
  const [customerSearch, setCustomerSearch] = useState("");
  const [creatingCustomer, setCreatingCustomer] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [newCustomerEmail, setNewCustomerEmail] = useState("");
  const [newCustomerPhone, setNewCustomerPhone] = useState("");

  // Step 2 — service
  const [serviceTierCode, setServiceTierCode] = useState<string | null>(null);

  // Step 3 — cards
  const [cards, setCards] = useState<SubmissionCard[]>([]);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [removeCardError, setRemoveCardError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<SubmissionSummary | null>(null);
  const idempotencyKey = useMemo(() => (submission ? newIdempotencyKey(submission.id) : ""), [submission?.id]);

  // Create the draft ONCE on entry, using the session's currently-selected location.
  useEffect(() => {
    if (submission || initError) return;
    if (!session?.locationId) return; // waits for the "select a location" state below
    (async () => {
      try {
        const created = await partnerSubmissions.create({ locationId: session.locationId! });
        setSubmission(created);
      } catch (err) {
        setInitError(partnerErrorMessage(err));
      }
    })();
  }, [session?.locationId, submission, initError]);

  const { data: availableTiers } = useQuery({
    queryKey: ["/api/partner/service-tiers"],
    queryFn: () => partnerServiceTiers.list(),
    enabled: !!submission,
  });
  const { data: customerResults } = useQuery({
    queryKey: ["/api/partner/customers", customerSearch],
    queryFn: () => partnerCustomers.list(customerSearch || undefined),
    enabled: !!submission && customerSearch.length > 0,
  });

  const saveField = useCallback(
    async (patch: {
      customerId?: string | null;
      internalReference?: string | null;
      serviceTierCode?: string | null;
    }) => {
      if (!submission) return;
      setSaveStatus("saving");
      try {
        const updated = await partnerSubmissions.edit(submission.id, { version: submission.version, ...patch });
        setSubmission(updated);
        setSaveStatus("saved");
      } catch (err: any) {
        if (err?.code === "stale_version") {
          setSaveStatus("conflict");
        } else {
          setSaveStatus("error");
        }
      }
    },
    [submission]
  );

  // Free-text fields (unlike selects/buttons) fire on every keystroke — saving each one individually
  // would send several PATCHes carrying the SAME pre-request version, so the server correctly rejects
  // the out-of-order ones as stale_version even though it's the same user typing normally in one tab.
  // Debounce so only the settled value is saved.
  const internalReferenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveInternalReferenceDebounced = useCallback(
    (v: string) => {
      if (internalReferenceTimer.current) clearTimeout(internalReferenceTimer.current);
      internalReferenceTimer.current = setTimeout(() => saveField({ internalReference: v }), 600);
    },
    [saveField]
  );
  useEffect(() => {
    return () => {
      if (internalReferenceTimer.current) clearTimeout(internalReferenceTimer.current);
    };
  }, []);

  async function handleCreateCustomer() {
    if (!newCustomerName.trim()) return;
    try {
      const created = await partnerCustomers.create({
        fullName: newCustomerName.trim(),
        email: newCustomerEmail.trim() || null,
        phone: newCustomerPhone.trim() || null,
      });
      setCustomerId(created.id);
      setCustomerDisplay(created.fullName);
      setCreatingCustomer(false);
      await saveField({ customerId: created.id });
    } catch (err) {
      setSaveStatus("error");
    }
  }

  function selectExistingCustomer(c: PartnerCustomer) {
    setCustomerId(c.id);
    setCustomerDisplay(c.fullName);
    setCustomerSearch("");
    saveField({ customerId: c.id });
  }

  async function handleAddCard(input: Parameters<typeof partnerCards.add>[1]) {
    if (!submission) return;
    const created = await partnerCards.add(submission.id, input);
    setCards((c) => [...c, created]);
    setSubmission((s) => (s ? { ...s, cardCount: s.cardCount + 1 } : s));
  }

  async function handleEditCard(cardId: string, input: Parameters<typeof partnerCards.edit>[2]) {
    if (!submission) return;
    const updated = await partnerCards.edit(submission.id, cardId, input);
    setCards((c) => c.map((card) => (card.id === cardId ? updated : card)));
    setEditingCardId(null);
  }

  async function handleRemoveCard(cardId: string) {
    if (!submission) return;
    setRemoveCardError(null);
    try {
      await partnerCards.remove(submission.id, cardId, "Removed by partner");
      setCards((c) => c.filter((card) => card.id !== cardId));
      setSubmission((s) => (s ? { ...s, cardCount: Math.max(s.cardCount - 1, 0) } : s));
    } catch (err) {
      setRemoveCardError(partnerErrorMessage(err));
    }
  }

  async function handleSubmit() {
    if (!submission || submitting) return; // double-click safety: guard while a request is in flight
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await partnerSubmissions.submit(submission.id, idempotencyKey);
      setSubmitResult(result.submission);
      qc.invalidateQueries({ queryKey: ["/api/partner/dashboard/submissions"] });
      qc.invalidateQueries({ queryKey: ["/api/partner/submissions"] });
    } catch (err) {
      setSubmitError(partnerErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (initError) {
    return <PartnerErrorState message={initError} onRetry={() => setInitError(null)} />;
  }

  if (!session?.locationId) {
    return (
      <Card>
        <CardContent className="p-8 text-center space-y-3">
          <p className="font-medium" data-testid="text-select-location-first">
            Select a location before creating a submission.
          </p>
          <p className="text-sm text-muted-foreground">Use the location switcher at the top of the page.</p>
        </CardContent>
      </Card>
    );
  }

  if (!submission) {
    return <PartnerLoadingState label="Preparing your submission…" />;
  }

  if (submitResult) {
    return (
      <SubmitSuccessPanel
        submission={submitResult}
        onStartAnother={() => window.location.reload()}
        navigate={navigate}
      />
    );
  }

  // Single source of truth for "is this submission ready to send" — shared by the Review step's
  // warning banner AND the Submit step's button-disabled state, so a partner can never reach an
  // enabled Submit button by skipping past Review with something still missing.
  const missing: string[] = [];
  if (!customerDisplay) missing.push("Customer");
  if (!serviceTierCode) missing.push("Service");
  if (cards.length === 0) missing.push("At least one card");

  return (
    <div className="space-y-6" data-testid="wizard-new-submission">
      <WizardProgress currentStep={step} />
      <SaveStatusIndicator status={saveStatus} />

      {step === 0 && (
        <CustomerStep
          customerId={customerId}
          customerDisplay={customerDisplay}
          internalReference={internalReference}
          onInternalReferenceChange={(v) => {
            setInternalReference(v);
            saveInternalReferenceDebounced(v);
          }}
          customerSearch={customerSearch}
          onCustomerSearchChange={setCustomerSearch}
          customerResults={customerResults ?? []}
          onSelectCustomer={selectExistingCustomer}
          creatingCustomer={creatingCustomer}
          onToggleCreate={() => setCreatingCustomer((v) => !v)}
          newCustomerName={newCustomerName}
          setNewCustomerName={setNewCustomerName}
          newCustomerEmail={newCustomerEmail}
          setNewCustomerEmail={setNewCustomerEmail}
          newCustomerPhone={newCustomerPhone}
          setNewCustomerPhone={setNewCustomerPhone}
          onCreateCustomer={handleCreateCustomer}
        />
      )}

      {step === 1 && (
        <ServiceStep
          tiers={availableTiers ?? []}
          selected={serviceTierCode}
          onSelect={(code) => {
            setServiceTierCode(code);
            saveField({ serviceTierCode: code });
          }}
        />
      )}

      {step === 2 && (
        <CardsStep
          cards={cards}
          editingCardId={editingCardId}
          removeCardError={removeCardError}
          onStartEdit={setEditingCardId}
          onCancelEdit={() => setEditingCardId(null)}
          onAddCard={handleAddCard}
          onEditCard={handleEditCard}
          onRemoveCard={handleRemoveCard}
        />
      )}

      {step === 3 && (
        <ReviewStep
          customerDisplay={customerDisplay}
          internalReference={internalReference}
          serviceTierCode={serviceTierCode}
          tiers={availableTiers ?? []}
          cards={cards}
          missing={missing}
          onEditStep={setStep}
        />
      )}

      {step === 4 && (
        <SubmitStep missing={missing} submitting={submitting} error={submitError} onSubmit={handleSubmit} />
      )}

      <div className="flex items-center justify-between pt-4 border-t">
        <Button
          variant="outline"
          disabled={step === 0}
          onClick={() => setStep((s) => s - 1)}
          data-testid="button-wizard-back"
        >
          Back
        </Button>
        {step < STEPS.length - 1 && (
          <Button onClick={() => setStep((s) => s + 1)} data-testid="button-wizard-next">
            Continue
          </Button>
        )}
      </div>
    </div>
  );
}

function WizardProgress({ currentStep }: { currentStep: number }) {
  return (
    <nav aria-label="Submission steps" data-testid="wizard-progress">
      <ol className="flex items-center gap-2 flex-wrap text-sm">
        {STEPS.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <span
              aria-current={i === currentStep ? "step" : undefined}
              data-testid={`step-indicator-${i + 1}`}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-full ${
                i === currentStep
                  ? "bg-primary text-primary-foreground font-medium"
                  : i < currentStep
                    ? "text-primary"
                    : "text-muted-foreground"
              }`}
            >
              <span className="w-5 h-5 rounded-full border flex items-center justify-center text-xs">{i + 1}</span>
              {label}
            </span>
            {i < STEPS.length - 1 && (
              <span aria-hidden="true" className="text-muted-foreground">
                →
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function SaveStatusIndicator({ status }: { status: SaveStatus }) {
  if (status === "idle") return null;
  const copy: Record<SaveStatus, string> = {
    idle: "",
    saving: "Saving…",
    saved: "Saved.",
    error: "Not saved. Please try again.",
    conflict: "This submission was updated elsewhere. Refresh before saving again.",
  };
  return (
    <p
      role="status"
      aria-live="polite"
      data-testid="text-save-status"
      className={`text-sm ${status === "error" || status === "conflict" ? "text-destructive" : "text-muted-foreground"}`}
    >
      {copy[status]}
    </p>
  );
}

// ---------------- Step 1: Customer ----------------
function CustomerStep(props: {
  customerId: string | null;
  customerDisplay: string;
  internalReference: string;
  onInternalReferenceChange: (v: string) => void;
  customerSearch: string;
  onCustomerSearchChange: (v: string) => void;
  customerResults: PartnerCustomer[];
  onSelectCustomer: (c: PartnerCustomer) => void;
  creatingCustomer: boolean;
  onToggleCreate: () => void;
  newCustomerName: string;
  setNewCustomerName: (v: string) => void;
  newCustomerEmail: string;
  setNewCustomerEmail: (v: string) => void;
  newCustomerPhone: string;
  setNewCustomerPhone: (v: string) => void;
  onCreateCustomer: () => void;
}) {
  return (
    <Card data-testid="wizard-step-customer">
      <CardHeader>
        <CardTitle>Step 1 — Customer</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          We only collect what's needed to process this submission. Email and phone are optional.
        </p>

        {props.customerId ? (
          <div className="flex items-center justify-between rounded-md border p-3">
            <span data-testid="text-selected-customer">{props.customerDisplay}</span>
            <Button variant="ghost" size="sm" onClick={props.onToggleCreate} data-testid="button-change-customer">
              Change
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="customer-search">Search existing customers</Label>
              <Input
                id="customer-search"
                value={props.customerSearch}
                onChange={(e) => props.onCustomerSearchChange(e.target.value)}
                placeholder="Start typing a name…"
                data-testid="input-customer-search"
              />
              {props.customerResults.length > 0 && (
                <ul className="border rounded-md divide-y" data-testid="list-customer-results">
                  {props.customerResults.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        className="w-full text-left px-3 py-2 hover:bg-accent"
                        onClick={() => props.onSelectCustomer(c)}
                        data-testid={`button-select-customer-${c.id}`}
                      >
                        {c.fullName}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {!props.creatingCustomer ? (
              <Button variant="outline" onClick={props.onToggleCreate} data-testid="button-new-customer">
                + New customer
              </Button>
            ) : (
              <div className="space-y-3 rounded-md border p-3">
                <div className="space-y-2">
                  <Label htmlFor="new-customer-name">
                    Customer name <span aria-hidden="true">*</span>
                    <span className="sr-only">required</span>
                  </Label>
                  <Input
                    id="new-customer-name"
                    value={props.newCustomerName}
                    onChange={(e) => props.setNewCustomerName(e.target.value)}
                    required
                    data-testid="input-new-customer-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="new-customer-email">Customer email (optional)</Label>
                  <Input
                    id="new-customer-email"
                    type="email"
                    value={props.newCustomerEmail}
                    onChange={(e) => props.setNewCustomerEmail(e.target.value)}
                    data-testid="input-new-customer-email"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="new-customer-phone">Customer phone (optional)</Label>
                  <Input
                    id="new-customer-phone"
                    type="tel"
                    value={props.newCustomerPhone}
                    onChange={(e) => props.setNewCustomerPhone(e.target.value)}
                    data-testid="input-new-customer-phone"
                  />
                </div>
                <Button
                  onClick={props.onCreateCustomer}
                  disabled={!props.newCustomerName.trim()}
                  data-testid="button-save-new-customer"
                >
                  Save customer
                </Button>
              </div>
            )}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="internal-reference">Your internal reference (optional)</Label>
          <Input
            id="internal-reference"
            value={props.internalReference}
            onChange={(e) => props.onInternalReferenceChange(e.target.value)}
            data-testid="input-internal-reference"
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------- Step 2: Service ----------------
function ServiceStep({
  tiers,
  selected,
  onSelect,
}: {
  tiers: AvailableServiceTier[];
  selected: string | null;
  onSelect: (code: string) => void;
}) {
  return (
    <Card data-testid="wizard-step-service">
      <CardHeader>
        <CardTitle>Step 2 — Service</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {tiers.length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="text-no-tiers-available">
            Partner services are not currently available. Contact MintVault.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2" data-testid="grid-service-tiers">
          {tiers.map((t) => (
            <button
              type="button"
              key={t.tierCode}
              onClick={() => onSelect(t.tierCode)}
              data-testid={`button-select-tier-${t.tierCode}`}
              aria-pressed={selected === t.tierCode}
              className={`text-left rounded-lg border p-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${
                selected === t.tierCode ? "border-primary bg-primary/5" : "hover:bg-accent"
              }`}
            >
              <p className="font-medium">{t.label}</p>
              <p className="text-sm text-muted-foreground">{t.turnaroundDays} working days</p>
              <p className="text-sm mt-1">{formatPence(t.pricePerCardPence)}</p>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------- Step 3: Cards ----------------
const emptyCardForm = {
  cardName: "",
  game: PARTNER_CARD_CATEGORIES[0].value as string,
  cardSet: "",
  cardNumber: "",
  year: "",
  variant: "",
  language: "",
  declaredValuePence: "",
  quantity: "1",
  customerNotes: "",
  intakeNotes: "",
};

function CardsStep(props: {
  cards: SubmissionCard[];
  editingCardId: string | null;
  removeCardError: string | null;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onAddCard: (input: any) => Promise<void>;
  onEditCard: (id: string, input: any) => Promise<void>;
  onRemoveCard: (id: string) => Promise<void>;
}) {
  const [form, setForm] = useState(emptyCardForm);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitAdd() {
    if (!form.cardName.trim()) return;
    setAdding(true);
    setError(null);
    try {
      await props.onAddCard({
        cardName: form.cardName.trim(),
        game: form.game || null,
        cardSet: form.cardSet || null,
        cardNumber: form.cardNumber || null,
        year: form.year ? Number(form.year) : null,
        variant: form.variant || null,
        language: form.language || null,
        declaredValuePence: form.declaredValuePence ? Math.round(Number(form.declaredValuePence) * 100) : null,
        quantity: Number(form.quantity) || 1,
        customerNotes: form.customerNotes || null,
        intakeNotes: form.intakeNotes || null,
      });
      setForm(emptyCardForm);
    } catch (err) {
      setError(partnerErrorMessage(err));
    } finally {
      setAdding(false);
    }
  }

  return (
    <Card data-testid="wizard-step-cards">
      <CardHeader>
        <CardTitle>Step 3 — Cards ({props.cards.length})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {props.removeCardError && (
          <p role="alert" className="text-sm text-destructive" data-testid="text-remove-card-error">
            {props.removeCardError}
          </p>
        )}
        <ul className="space-y-2" data-testid="list-wizard-cards">
          {props.cards.map((c) =>
            props.editingCardId === c.id ? (
              <CardEditRow
                key={c.id}
                card={c}
                onSave={(input) => props.onEditCard(c.id, input)}
                onCancel={props.onCancelEdit}
              />
            ) : (
              <li
                key={c.id}
                className="flex items-center justify-between rounded-md border p-3"
                data-testid={`card-row-${c.id}`}
              >
                <div>
                  <p className="font-medium">
                    {c.sequence_number}. {c.card_name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {[c.game, c.card_set, c.year].filter(Boolean).join(" · ")}
                  </p>
                  {c.intake_notes && (
                    <p className="text-xs text-muted-foreground italic">
                      Intake observation — not a MintVault grade: {c.intake_notes}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit ${c.card_name}`}
                    onClick={() => props.onStartEdit(c.id)}
                    data-testid={`button-edit-card-${c.id}`}
                  >
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${c.card_name}`}
                    onClick={() => props.onRemoveCard(c.id)}
                    data-testid={`button-remove-card-${c.id}`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              </li>
            )
          )}
        </ul>

        <div className="rounded-md border p-4 space-y-3" data-testid="form-add-card">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="card-name">
                Card name <span aria-hidden="true">*</span>
                <span className="sr-only">required</span>
              </Label>
              <Input
                id="card-name"
                value={form.cardName}
                onChange={(e) => setForm({ ...form, cardName: e.target.value })}
                data-testid="input-card-name"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="card-game">Game / category</Label>
              <Select value={form.game} onValueChange={(v) => setForm({ ...form, game: v })}>
                <SelectTrigger id="card-game" data-testid="select-card-game">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PARTNER_CARD_CATEGORIES.map((cat) => (
                    <SelectItem key={cat.value} value={cat.value}>
                      {cat.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="card-set">Set</Label>
              <Input
                id="card-set"
                value={form.cardSet}
                onChange={(e) => setForm({ ...form, cardSet: e.target.value })}
                data-testid="input-card-set"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="card-number">Card number</Label>
              <Input
                id="card-number"
                value={form.cardNumber}
                onChange={(e) => setForm({ ...form, cardNumber: e.target.value })}
                data-testid="input-card-number"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="card-year">Year</Label>
              <Input
                id="card-year"
                type="number"
                value={form.year}
                onChange={(e) => setForm({ ...form, year: e.target.value })}
                data-testid="input-card-year"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="card-variant">Variant</Label>
              <Input
                id="card-variant"
                value={form.variant}
                onChange={(e) => setForm({ ...form, variant: e.target.value })}
                data-testid="input-card-variant"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="card-language">Language</Label>
              <Input
                id="card-language"
                value={form.language}
                onChange={(e) => setForm({ ...form, language: e.target.value })}
                data-testid="input-card-language"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="card-quantity">Quantity</Label>
              <Input
                id="card-quantity"
                type="number"
                min={1}
                value={form.quantity}
                onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                data-testid="input-card-quantity"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="card-value">Declared value (£)</Label>
              <Input
                id="card-value"
                type="number"
                step="0.01"
                value={form.declaredValuePence}
                onChange={(e) => setForm({ ...form, declaredValuePence: e.target.value })}
                data-testid="input-card-declared-value"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="card-customer-notes">Customer notes</Label>
            <Textarea
              id="card-customer-notes"
              value={form.customerNotes}
              onChange={(e) => setForm({ ...form, customerNotes: e.target.value })}
              data-testid="input-card-customer-notes"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="card-intake-notes">
              Intake observation <span className="text-xs text-muted-foreground">— not a MintVault grade</span>
            </Label>
            <Textarea
              id="card-intake-notes"
              placeholder="e.g. visible crease, customer requests authentication-only review"
              value={form.intakeNotes}
              onChange={(e) => setForm({ ...form, intakeNotes: e.target.value })}
              data-testid="input-card-intake-notes"
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive" data-testid="text-add-card-error">
              {error}
            </p>
          )}
          <Button onClick={submitAdd} disabled={adding || !form.cardName.trim()} data-testid="button-add-card">
            {adding ? "Adding…" : "Add card"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CardEditRow({
  card,
  onSave,
  onCancel,
}: {
  card: SubmissionCard;
  onSave: (input: any) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(card.card_name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="flex flex-col gap-2 rounded-md border p-3" data-testid={`card-edit-row-${card.id}`}>
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Card name"
          data-testid={`input-edit-card-name-${card.id}`}
        />
        <Button
          variant="ghost"
          size="icon"
          aria-label="Save"
          disabled={saving}
          data-testid={`button-save-card-${card.id}`}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              await onSave({ cardName: name });
            } catch (err) {
              setError(partnerErrorMessage(err));
            } finally {
              setSaving(false);
            }
          }}
        >
          <Check className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Cancel"
          onClick={onCancel}
          data-testid={`button-cancel-edit-card-${card.id}`}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive" data-testid={`text-edit-card-error-${card.id}`}>
          {error}
        </p>
      )}
    </li>
  );
}

// ---------------- Step 4: Review ----------------
function ReviewStep(props: {
  customerDisplay: string;
  internalReference: string;
  serviceTierCode: string | null;
  tiers: AvailableServiceTier[];
  cards: SubmissionCard[];
  missing: string[];
  onEditStep: (step: number) => void;
}) {
  const tier = props.tiers.find((t) => t.tierCode === props.serviceTierCode);
  const missing = props.missing;

  return (
    <Card data-testid="wizard-step-review">
      <CardHeader>
        <CardTitle>Step 4 — Review</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {missing.length > 0 && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3" data-testid="text-missing-info">
            <p className="font-medium text-sm">Missing information:</p>
            <ul className="text-sm list-disc list-inside">
              {missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        )}

        <ReviewRow label="Customer" value={props.customerDisplay || "Not set"} onEdit={() => props.onEditStep(0)} />
        <ReviewRow label="Your reference" value={props.internalReference || "—"} onEdit={() => props.onEditStep(0)} />
        <ReviewRow
          label="Service"
          value={tier ? `${tier.label} (${formatPence(tier.pricePerCardPence)})` : "Not set"}
          onEdit={() => props.onEditStep(1)}
        />
        <ReviewRow
          label="Cards"
          value={`${props.cards.length} card${props.cards.length === 1 ? "" : "s"}`}
          onEdit={() => props.onEditStep(2)}
        />

        <p className="text-xs text-muted-foreground">
          Intake observations recorded on cards are not MintVault grades. Estimated pricing is confirmed by MintVault.
        </p>
      </CardContent>
    </Card>
  );
}

function ReviewRow({ label, value, onEdit }: { label: string; value: string; onEdit: () => void }) {
  return (
    <div
      className="flex items-center justify-between border-b pb-2"
      data-testid={`review-row-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm">{value}</p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={onEdit}
        data-testid={`button-review-edit-${label.toLowerCase().replace(/\s+/g, "-")}`}
      >
        Edit
      </Button>
    </div>
  );
}

// ---------------- Step 5: Submit ----------------
function SubmitStep({
  missing,
  submitting,
  error,
  onSubmit,
}: {
  missing: string[];
  submitting: boolean;
  error: string | null;
  onSubmit: () => void;
}) {
  return (
    <Card data-testid="wizard-step-submit">
      <CardHeader>
        <CardTitle>Step 5 — Submit</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="text-sm text-muted-foreground list-disc list-inside space-y-1">
          <li>This submission is final once sent.</li>
          <li>Submitted data becomes locked.</li>
          <li>MintVault may request more information.</li>
          <li>Intake observations are not grades.</li>
          <li>Price remains subject to your approved Partner agreement where applicable.</li>
        </ul>
        {missing.length > 0 && (
          <div
            className="rounded-md border border-destructive/30 bg-destructive/5 p-3"
            data-testid="text-submit-missing-info"
          >
            <p className="font-medium text-sm">Missing information — go back and complete:</p>
            <ul className="text-sm list-disc list-inside">
              {missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive" data-testid="text-submit-error">
            {error}
          </p>
        )}
        <Button
          size="lg"
          className="w-full"
          disabled={submitting || missing.length > 0}
          onClick={onSubmit}
          data-testid="button-confirm-submit"
        >
          {submitting ? "Submitting…" : "Submit to MintVault"}
        </Button>
      </CardContent>
    </Card>
  );
}

function SubmitSuccessPanel({
  submission,
  onStartAnother,
  navigate,
}: {
  submission: SubmissionSummary;
  onStartAnother: () => void;
  navigate: (to: string) => void;
}) {
  return (
    <Card data-testid="wizard-submit-success">
      <CardHeader>
        <CardTitle>Submission sent</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p>
          Reference:{" "}
          <span className="font-mono font-medium" data-testid="text-submission-reference">
            {submission.publicRef}
          </span>
        </p>
        <Badge data-testid="badge-submitted">Submitted to MintVault</Badge>
        <div className="flex flex-wrap gap-2 pt-2">
          <Button
            onClick={() => navigate(`/partner/submissions/${submission.id}`)}
            data-testid="button-view-submission"
          >
            View Submission
          </Button>
          <Button variant="outline" onClick={() => window.print()} data-testid="button-print-receipt">
            Print Intake Receipt
          </Button>
          <Button variant="ghost" onClick={onStartAnother} data-testid="button-start-another">
            Start Another Submission
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
