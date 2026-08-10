import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { partnerCredits, partnerErrorMessage, type PartnerCreditLedgerEntry } from "@/lib/partner-api";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { usePartnerSession } from "@/hooks/use-partner-session";

function credit(value: number | null, configured: boolean) {
  return value == null ? (configured ? "Unknown" : "Not available") : value.toLocaleString("en-GB");
}

function entryLabel(entry: PartnerCreditLedgerEntry) {
  return entry.type.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
}

function returnPathFromSearch() {
  const value = new URLSearchParams(window.location.search).get("returnTo");
  return value?.startsWith("/partner/") && !value.startsWith("//") ? value : "/partner/billing";
}

export default function PartnerBillingPage() {
  const { hasPermission } = usePartnerSession();
  const query = useQuery({ queryKey: ["/api/partner/credits"], queryFn: () => partnerCredits.view() });
  const packages = useQuery({
    queryKey: ["/api/partner/credits/packages"],
    queryFn: () => partnerCredits.packages(),
    enabled: hasPermission("partner.credits.view"),
  });
  const checkout = useMutation({
    mutationFn: (packageId: string) => partnerCredits.checkout(packageId, returnPathFromSearch()),
    onSuccess: ({ checkoutUrl }) => window.location.assign(checkoutUrl),
  });
  const returnPath = returnPathFromSearch();

  return (
    <div className="space-y-8">
      <div>
        <p className="text-xs font-semibold uppercase text-primary">Wallet</p>
        <h1 className="text-2xl font-semibold" data-testid="text-billing-title">
          Credits & Billing
        </h1>
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
                Buy credits
              </h2>
              <p className="text-sm text-muted-foreground">
                Select a server-priced package. Credits are added only after Stripe confirms payment.
              </p>
            </div>
            {packages.isLoading && <p className="text-sm text-muted-foreground">Loading packages…</p>}
            {packages.error && (
              <PartnerErrorState message={partnerErrorMessage(packages.error)} onRetry={() => packages.refetch()} />
            )}
            {packages.data && (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="billing-credit-packages">
                {packages.data.packages.map((pkg) => (
                  <Card key={pkg.id} className="rounded-md">
                    <CardContent className="space-y-3 p-4">
                      <div>
                        <p className="font-medium">{pkg.label}</p>
                        <p className="text-sm text-muted-foreground">{pkg.credits} grading credits</p>
                      </div>
                      <p className="text-lg font-semibold">
                        {new Intl.NumberFormat("en-GB", { style: "currency", currency: packages.data.currency }).format(
                          pkg.pricePence / 100
                        )}
                      </p>
                      <Button
                        className="w-full"
                        disabled={!hasPermission("partner.credits.purchase") || checkout.isPending}
                        onClick={() => checkout.mutate(pkg.id)}
                        data-testid={`button-buy-credit-package-${pkg.id}`}
                      >
                        {checkout.isPending ? "Opening checkout…" : "Buy credits"}
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
            {checkout.error && (
              <p role="alert" className="text-sm text-destructive">
                {partnerErrorMessage(checkout.error)}
              </p>
            )}
            {returnPath !== "/partner/billing" && (
              <Button asChild variant="outline">
                <Link href={returnPath}>Return to draft</Link>
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
