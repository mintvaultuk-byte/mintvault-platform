import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { partnerErrorMessage, partnerLaunch } from "@/lib/partner-api";
import { CreditCard } from "lucide-react";

function money(pence: number, currency = "GBP") {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(pence / 100);
}

export default function PartnerBillingPage() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const key = useMemo(() => `partner-purchase-${Date.now()}-${Math.random().toString(36).slice(2)}`, []);
  const wallet = useQuery({ queryKey: ["/api/partner/wallet"], queryFn: () => partnerLaunch.wallet() });
  const packages = useQuery({ queryKey: ["/api/partner/purchases/packages"], queryFn: () => partnerLaunch.packages() });

  async function buy(packageId: string) {
    setBusy(packageId);
    try {
      const purchase = await partnerLaunch.createPurchase({ packageId, idempotencyKey: `${key}-${packageId}` });
      const checkout = await partnerLaunch.checkout(purchase.purchase.id, `${key}-${packageId}-checkout`);
      if (checkout.url) window.location.href = checkout.url;
      await qc.invalidateQueries({ queryKey: ["/api/partner/wallet"] });
    } finally {
      setBusy(null);
    }
  }

  if (wallet.isLoading) return <PartnerLoadingState label="Loading credits..." />;
  if (wallet.error)
    return <PartnerErrorState message={partnerErrorMessage(wallet.error)} onRetry={() => wallet.refetch()} />;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Credits</h1>
      <div className="grid gap-3 md:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Available</p>
            <p className="text-3xl font-semibold">{wallet.data?.credit?.available_balance ?? "0"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Reserved</p>
            <p className="text-3xl font-semibold">{wallet.data?.credit?.active_reserved ?? "0"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Consumed</p>
            <p className="text-3xl font-semibold">{wallet.data?.credit?.consumed_reservations ?? "0"}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Buy Credit Packages</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          {packages.error && <p className="text-sm text-muted-foreground">{partnerErrorMessage(packages.error)}</p>}
          {packages.data?.packages.length === 0 && (
            <p className="text-sm text-muted-foreground">No packages are available yet.</p>
          )}
          {packages.data?.packages.map((pkg) => (
            <div key={pkg.id} className="rounded-md border p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{pkg.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {pkg.credits} credits · {money(pkg.price_pence, pkg.currency)}
                  </p>
                </div>
                <Button size="sm" disabled={busy === pkg.id} onClick={() => buy(pkg.id)}>
                  <CreditCard className="mr-2 h-4 w-4" aria-hidden="true" />
                  Buy
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Purchase History</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {wallet.data?.purchases.length === 0 && <p className="text-sm text-muted-foreground">No purchases yet.</p>}
          {wallet.data?.purchases.map((purchase) => (
            <div key={purchase.id} className="flex justify-between gap-3 rounded-md border p-3 text-sm">
              <span>{purchase.package_name}</span>
              <span>{purchase.credits} credits</span>
              <Badge variant={purchase.status === "fulfilled" ? "default" : "secondary"}>{purchase.status}</Badge>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
