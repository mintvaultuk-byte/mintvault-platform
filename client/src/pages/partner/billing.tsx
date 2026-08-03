import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { partnerCredits, partnerErrorMessage, type PartnerCreditLedgerEntry } from "@/lib/partner-api";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";

function credit(value: number | null, configured: boolean) {
  return value == null ? (configured ? "Unknown" : "Not available") : value.toLocaleString("en-GB");
}

function entryLabel(entry: PartnerCreditLedgerEntry) {
  return entry.type.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase());
}

export default function PartnerBillingPage() {
  const query = useQuery({ queryKey: ["/api/partner/credits"], queryFn: () => partnerCredits.view() });

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
