import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { partnerCredits, partnerErrorMessage, type PartnerCreditLedgerEntry } from "@/lib/partner-api";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { usePartnerStepUp, isStepUpCancelled } from "@/components/partner/partner-step-up";
import { usePartnerSession } from "@/hooks/use-partner-session";
import { ArrowRight, Loader2, Lock } from "lucide-react";

function credit(value: number | null, configured: boolean) {
  return value == null ? (configured ? "Unknown" : "Not available") : value.toLocaleString("en-GB");
}

function entryLabel(entry: PartnerCreditLedgerEntry) {
  return entry.type.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
}

function unavailablePackLabel(reason: string | null | undefined) {
  if (reason === "stripe_environment_undeclared") return "Stripe TEST/LIVE mode not configured";
  if (reason === "stripe_environment_mismatch") return "Stripe mode does not match this environment";
  return "Pricing not yet configured";
}

export default function PartnerBillingPage() {
  const { hasPermission } = usePartnerSession();
  const canPurchase = hasPermission("partner.credits.purchase");
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const returnTo = params.get("returnTo");
  const purchaseOutcome = params.get("purchase");

  /**
   * The returning-from-Stripe state. `processing` is the ONLY thing the success URL is allowed to
   * mean: the browser has come back from a redirect it fully controls, so it is not evidence that
   * anything was paid, and it certainly cannot add capacity. All it does is make the wallet query
   * poll so the webhook's grant becomes visible without a manual refresh.
   */
  const awaitingWebhook = purchaseOutcome === "processing";

  const query = useQuery({
    queryKey: ["/api/partner/credits"],
    queryFn: () => partnerCredits.view(),
    /*
     * Poll only while we are waiting for a webhook we did not trigger and cannot confirm
     * client-side — and STOP the moment a poll fails.
     *
     * Without the error condition this interval has no terminal state. A tab left in the
     * post-checkout "processing" view whose session later ended kept requesting /api/partner/credits
     * every four seconds indefinitely, rendering "authentication required" forever and never
     * recovering. On staging that single tab produced a continuous 401 every four seconds across the
     * whole day and buried the real requests in the application log. A failed poll means this page
     * can no longer learn anything by asking again.
     */
    refetchInterval: (query) => (awaitingWebhook && !query.state.error ? 4000 : false),
  });

  const packs = useQuery({
    queryKey: ["/api/partner/credits/packs"],
    queryFn: () => partnerCredits.packs(),
    enabled: hasPermission("partner.credits.view"),
  });

  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [pendingPack, setPendingPack] = useState<string | null>(null);
  const { runProtected } = usePartnerStepUp();

  /**
   * Hands the operator to Stripe. The server decides the price and the quantity; this mutation's
   * entire output is a URL to navigate to. There is deliberately no success handler that touches
   * the wallet — a client that could "apply" a purchase locally would be a second balance authority.
   */
  const checkout = useMutation({
    // AG-3: spending the shop's money is step-up protected server-side. `runProtected` performs the
    // call, and ONLY if the server answers 403 step_up_required does it prompt and retry this exact
    // checkout once. A cancelled prompt leaves no charge started and no Stripe session created.
    mutationFn: (packCode: string) => runProtected(() => partnerCredits.checkout(packCode)),
    onMutate: (packCode: string) => {
      setCheckoutError(null);
      setPendingPack(packCode);
    },
    onSuccess: (result) => {
      // Stripe types checkout session `url` as nullable. Navigating to a missing URL would send the
      // operator to a page literally named "null" and look like a broken shop rather than a failed
      // call, so an absent URL is surfaced as the error it is.
      if (!result.url) {
        setPendingPack(null);
        setCheckoutError("Could not start checkout. Try again.");
        return;
      }
      window.location.assign(result.url);
    },
    onError: (err) => {
      setPendingPack(null);
      // Dismissing the confirmation is not a failure — nothing was bought and nothing was charged,
      // so the operator is returned to the page silently rather than shown an error they caused.
      if (isStepUpCancelled(err)) return;
      setCheckoutError(partnerErrorMessage(err));
    },
  });

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-semibold uppercase text-primary">Wallet</p>
        <h1 className="text-2xl font-semibold" data-testid="text-billing-title">
          Credits & Billing
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          1 credit = 1 grading slot/card unit according to backend rules.
        </p>
      </div>

      {query.isLoading && <PartnerLoadingState label="Loading credits…" />}
      {query.error && <PartnerErrorState message={partnerErrorMessage(query.error)} onRetry={() => query.refetch()} />}

      {query.data && (
        <>
          <section aria-label="Credit balances" className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              ["Available balance", query.data.summary.availableCredits, "available"],
              ["Reserved balance", query.data.summary.reservedCredits, "reserved"],
              ["Consumed this month", query.data.summary.consumedThisMonth, "consumed-month"],
              ["Lifetime consumed", query.data.summary.consumedLifetime, "consumed-lifetime"],
            ].map(([label, value, id]) => (
              <Card key={String(id)} className="rounded-md">
                <CardHeader className="pb-2">
                  <CardTitle className="text-xs text-muted-foreground">{label}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-semibold" data-testid={`billing-${id}`}>
                    {credit(value as number | null, query.data.summary.configured)}
                  </p>
                </CardContent>
              </Card>
            ))}
          </section>

          <section aria-labelledby="packages-title" className="space-y-3">
            <div>
              <h2 id="packages-title" className="text-base font-semibold">
                Buy more Grading Credits
              </h2>
              <p className="text-sm text-muted-foreground">
                Packages and prices come from the server catalogue. Payment is confirmed by Stripe and credits are added
                by the verified webhook — never by this page.
              </p>
            </div>

            {awaitingWebhook && (
              <Card className="rounded-md border-primary/40" data-testid="billing-purchase-processing">
                <CardContent className="p-4 flex items-start gap-3">
                  <Loader2 className="h-5 w-5 text-primary mt-0.5 animate-spin" aria-hidden="true" />
                  <div>
                    <p className="font-medium">Payment received — processing</p>
                    <p className="text-sm text-muted-foreground">
                      Your balance updates automatically as soon as Stripe confirms the payment. You can safely leave
                      this page; nothing is lost.
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

            {purchaseOutcome === "cancelled" && (
              <Card className="rounded-md" data-testid="billing-purchase-cancelled">
                <CardContent className="p-4">
                  <p className="font-medium">Checkout cancelled</p>
                  <p className="text-sm text-muted-foreground">Nothing was charged and your balance is unchanged.</p>
                </CardContent>
              </Card>
            )}

            {checkoutError && (
              <p className="text-sm text-rose-300" role="alert" data-testid="billing-checkout-error">
                {checkoutError}
              </p>
            )}

            {!canPurchase && (
              <Card className="rounded-md" data-testid="billing-purchase-not-authorised">
                <CardContent className="p-4 flex items-start gap-3">
                  <Lock className="h-5 w-5 text-muted-foreground mt-0.5" aria-hidden="true" />
                  <div>
                    <p className="font-medium">Your role cannot buy Grading Credits</p>
                    <p className="text-sm text-muted-foreground">
                      Ask an owner at your shop to buy credits, or to grant you billing permission.
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

            {canPurchase && packs.isLoading && <PartnerLoadingState label="Loading credit packages…" />}
            {canPurchase && packs.error && (
              <PartnerErrorState message={partnerErrorMessage(packs.error)} onRetry={() => void packs.refetch()} />
            )}
            {canPurchase && packs.data && packs.data.packs.length === 0 && (
              <p className="text-sm text-muted-foreground" data-testid="billing-packs-empty">
                No credit packages are available yet.
              </p>
            )}
            {canPurchase && packs.data && packs.data.packs.length > 0 && (
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-3" data-testid="billing-packs">
                {packs.data.packs.map((pack) => (
                  <Card key={pack.id} className="rounded-md" data-testid={`billing-pack-${pack.code}`}>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-xs font-medium text-muted-foreground">{pack.code}</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <p className="text-2xl font-semibold">{pack.credits.toLocaleString("en-GB")}</p>
                      <p className="text-xs text-muted-foreground">Grading Credits</p>
                      <p className="text-sm font-medium" data-testid={`billing-pack-price-${pack.code}`}>
                        {pack.displayPrice}
                        {pack.vatIncluded ? " VAT included" : ""}
                      </p>
                      {pack.purchasable ? (
                        <Button
                          className="w-full"
                          data-testid={`button-buy-pack-${pack.code}`}
                          disabled={checkout.isPending}
                          onClick={() => checkout.mutate(pack.code)}
                        >
                          {pendingPack === pack.code ? "Starting checkout…" : "Buy"}
                        </Button>
                      ) : (
                        <p
                          className="text-xs text-muted-foreground"
                          data-testid={`billing-pack-unavailable-${pack.code}`}
                        >
                          {unavailablePackLabel(pack.unavailableReason)}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            {returnTo && (
              <Button asChild variant="outline" data-testid="button-return-to-draft">
                <Link href={returnTo}>
                  Return to draft
                  <ArrowRight className="h-4 w-4 ml-1.5" aria-hidden="true" />
                </Link>
              </Button>
            )}
          </section>

          <section aria-labelledby="ledger-title" className="space-y-3">
            <div>
              <h2 id="ledger-title" className="text-base font-semibold">
                Credit ledger
              </h2>
              <p className="text-sm text-muted-foreground">Every movement is recorded as an immutable entry.</p>
            </div>
            {query.data.ledger.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="billing-ledger-empty">
                No activity yet
              </p>
            ) : (
              <div className="overflow-x-auto border border-border rounded-md" data-testid="billing-ledger-table-wrap">
                <table data-testid="billing-ledger-table">
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Type</th>
                      <th scope="col">Quantity</th>
                      <th scope="col">Reference</th>
                      <th scope="col">Actor / source</th>
                      <th scope="col">Running balance</th>
                      <th scope="col">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.ledger.map((entry) => (
                      <tr key={entry.id}>
                        <td className="whitespace-nowrap">{new Date(entry.date).toLocaleString("en-GB")}</td>
                        <td>{entryLabel(entry)}</td>
                        <td className={entry.quantity > 0 ? "text-emerald-300" : "text-rose-300"}>
                          {entry.quantity > 0 ? "+" : ""}
                          {entry.quantity}
                        </td>
                        <td>{entry.submissionReference || entry.cardReference || "Not available"}</td>
                        <td>
                          {entry.actor}
                          <span className="block text-xs text-muted-foreground">{entry.source}</span>
                        </td>
                        <td>{entry.runningBalance}</td>
                        <td className="min-w-52">{entry.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section aria-labelledby="purchases-title" className="space-y-3">
            <h2 id="purchases-title" className="text-base font-semibold">
              Package purchase history
            </h2>
            {query.data.purchaseHistory.length === 0 ? (
              <p className="text-sm text-muted-foreground">No purchase history available</p>
            ) : (
              <div className="space-y-2">
                {query.data.purchaseHistory.map((entry) => (
                  <div key={entry.id} className="flex justify-between gap-4 border-b border-border py-3 text-sm">
                    <span>{new Date(entry.date).toLocaleDateString("en-GB")}</span>
                    <span>{entry.quantity} credits</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
