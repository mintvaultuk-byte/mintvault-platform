import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { partnerErrorMessage, partnerSupplies, type PartnerSuppliesProductCode } from "@/lib/partner-api";
import { usePartnerSession } from "@/hooks/use-partner-session";
import { queryClient } from "@/lib/queryClient";
import { CheckCircle2, PackagePlus, Truck } from "lucide-react";

type QuantityByProduct = Partial<Record<PartnerSuppliesProductCode, number>>;

function requestKey(): string {
  return crypto.randomUUID();
}

function deliveryLines(address: string): string[] {
  return address.split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean);
}

export default function PartnerSuppliesPage() {
  const { hasPermission } = usePartnerSession();
  const canSubmit = hasPermission("partner.supplies.submit");
  const catalogue = useQuery({ queryKey: ["/api/partner/supplies/catalogue"], queryFn: partnerSupplies.catalogue });
  const delivery = useQuery({
    queryKey: ["/api/partner/supplies/delivery"],
    queryFn: partnerSupplies.delivery,
    enabled: canSubmit,
  });
  const [quantities, setQuantities] = useState<QuantityByProduct>({});
  const [notes, setNotes] = useState("");
  const [key, setKey] = useState(requestKey);

  const selected = useMemo(
    () =>
      (catalogue.data?.products ?? [])
        .map((product) => ({ productCode: product.code, quantity: quantities[product.code] ?? 0 }))
        .filter((item) => item.quantity > 0),
    [catalogue.data?.products, quantities]
  );

  const create = useMutation({
    mutationFn: () => partnerSupplies.create({ items: selected, notes, idempotencyKey: key }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/partner/supplies/orders"] });
      setKey(requestKey());
    },
  });

  const currentOrder = create.data?.order;

  return (
    <div className="space-y-6" data-testid="partner-supplies-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase text-primary">Shop stock</p>
          <h1 className="text-2xl font-semibold">Supplies</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Request operational supplies for your selected shop. No payment is taken on this page.
          </p>
        </div>
        <Button asChild variant="outline" data-testid="button-supplies-my-orders">
          <Link href="/partner/orders">My Orders</Link>
        </Button>
      </div>

      {catalogue.isLoading && <PartnerLoadingState label="Loading supplies…" />}
      {catalogue.error && <PartnerErrorState message={partnerErrorMessage(catalogue.error)} onRetry={() => catalogue.refetch()} />}

      {currentOrder && (
        <Card className="border-emerald-500/40" data-testid="partner-supplies-confirmation">
          <CardContent className="flex gap-3 p-5">
            <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-500" aria-hidden="true" />
            <div className="space-y-1 text-sm">
              <p className="font-semibold">Supplies order received</p>
              <p>
                Reference <span className="font-mono">{currentOrder.reference}</span> is recorded as {currentOrder.status}.
              </p>
              <p className="text-muted-foreground">
                {currentOrder.notificationStatus === "SENT"
                  ? "MintVault operations has been notified."
                  : "The order is saved and its operational notification is queued for safe delivery."}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {!canSubmit && (
        <Card data-testid="partner-supplies-submit-not-authorised">
          <CardContent className="p-5 text-sm text-muted-foreground">
            Your role can view supply orders but cannot submit a stock request. Ask a Partner Owner or Manager to submit it.
          </CardContent>
        </Card>
      )}

      {canSubmit && delivery.isLoading && <PartnerLoadingState label="Checking your delivery details…" />}
      {canSubmit && delivery.error && (
        <PartnerErrorState message={partnerErrorMessage(delivery.error)} onRetry={() => delivery.refetch()} />
      )}

      {catalogue.data && canSubmit && delivery.data && !currentOrder && (
        <form
          className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]"
          onSubmit={(event) => {
            event.preventDefault();
            if (selected.length > 0 && !create.isPending) create.mutate();
          }}
        >
          <section className="space-y-3" aria-labelledby="supplies-products-title">
            <div>
              <h2 id="supplies-products-title" className="text-base font-semibold">
                Select supplies
              </h2>
              <p className="text-sm text-muted-foreground">Quantities are operational requests, not a checkout or payment.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {catalogue.data.products.map((product) => (
                <Card key={product.code} data-testid={`supplies-product-${product.code}`}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">{product.label}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground" htmlFor={`supplies-quantity-${product.code}`}>
                      Quantity
                    </label>
                    <Input
                      id={`supplies-quantity-${product.code}`}
                      data-testid={`input-supplies-quantity-${product.code}`}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={1000}
                      value={quantities[product.code] ?? 0}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        setQuantities((current) => ({ ...current, [product.code]: Number.isFinite(next) ? next : 0 }));
                      }}
                    />
                  </CardContent>
                </Card>
              ))}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="supplies-notes">
                Notes <span className="text-muted-foreground">(optional)</span>
              </label>
              <Textarea
                id="supplies-notes"
                data-testid="input-supplies-notes"
                value={notes}
                maxLength={1000}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Delivery or handling notes only — never include passwords, tokens or other credentials."
              />
            </div>
            {create.error && <p className="text-sm text-destructive" role="alert">{partnerErrorMessage(create.error)}</p>}
            <Button type="submit" disabled={selected.length === 0 || create.isPending} data-testid="button-submit-supplies-order">
              <PackagePlus className="mr-1.5 h-4 w-4" aria-hidden="true" />
              {create.isPending ? "Submitting order…" : "Submit order"}
            </Button>
          </section>

          <Card className="h-fit" data-testid="partner-supplies-delivery-confirmation">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Truck className="h-4 w-4" aria-hidden="true" />
                Confirm delivery address
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div>
                <p className="font-medium">{delivery.data.partnerName}</p>
                <p className="text-muted-foreground">{delivery.data.shopName}</p>
              </div>
              <address className="not-italic text-muted-foreground">
                {deliveryLines(delivery.data.delivery.address).map((line) => (
                  <span key={line} className="block">{line}</span>
                ))}
                <span className="block">{delivery.data.delivery.postcode}</span>
                <span className="block">{delivery.data.delivery.country}</span>
              </address>
              <div className="border-t pt-3">
                <p className="font-medium">{delivery.data.contact.name}</p>
                <p className="text-muted-foreground">{delivery.data.contact.email}</p>
                {delivery.data.contact.phone && <p className="text-muted-foreground">{delivery.data.contact.phone}</p>}
              </div>
              <p className="text-xs text-muted-foreground">This address and contact are snapshotted when the order is submitted.</p>
            </CardContent>
          </Card>
        </form>
      )}
    </div>
  );
}
