import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { partnerErrorMessage, partnerSupplies } from "@/lib/partner-api";
import { usePartnerSession } from "@/hooks/use-partner-session";

const money = (pence: number, currency = "GBP") =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(pence / 100);

const orderStatus = (status: string) => status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

export default function PartnerSuppliesPage() {
  const { hasPermission } = usePartnerSession();
  const queryClient = useQueryClient();
  const products = useQuery({ queryKey: ["/api/partner/supplies/products"], queryFn: partnerSupplies.products });
  const orders = useQuery({ queryKey: ["/api/partner/supplies/orders"], queryFn: partnerSupplies.orders });
  const operations = useQuery({ queryKey: ["/api/partner/supplies/operations"], queryFn: partnerSupplies.operations });
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [stockInputs, setStockInputs] = useState<Record<string, string>>({});
  const [useOverride, setUseOverride] = useState(false);
  const [delivery, setDelivery] = useState({
    recipientName: "",
    line1: "",
    line2: "",
    city: "",
    postcode: "",
    country: "United Kingdom",
  });
  const canPurchase = hasPermission("partner.credits.purchase") && hasPermission("partner.orders.submit");
  const items = useMemo(
    () =>
      products.data?.products
        .filter((product) => (quantities[product.code] ?? 0) > 0)
        .map((product) => ({ productCode: product.code, quantity: quantities[product.code] })) ?? [],
    [products.data, quantities]
  );
  const total = useMemo(
    () =>
      products.data?.products.reduce(
        (sum, product) => sum + (product.active_price_pence ?? 0) * (quantities[product.code] ?? 0),
        0
      ) ?? 0,
    [products.data, quantities]
  );
  const checkout = useMutation({
    mutationFn: () =>
      partnerSupplies.checkout({
        items,
        deliveryAddress: useOverride
          ? Object.fromEntries(Object.entries(delivery).filter(([, value]) => value.trim()))
          : undefined,
        idempotencyKey: crypto.randomUUID(),
        returnPath: "/partner/supplies",
      }),
    onSuccess: ({ checkoutUrl }) => window.location.assign(checkoutUrl),
  });
  const recordStock = useMutation({
    mutationFn: ({ productCode, knownUnits }: { productCode: string; knownUnits: number }) =>
      partnerSupplies.recordStock(productCode, knownUnits),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/partner/supplies/operations"] }),
  });

  return (
    <div className="space-y-8" data-testid="partner-supplies-page">
      <header>
        <p className="text-xs font-semibold uppercase text-primary">MintVault Partner</p>
        <h1 className="text-2xl font-semibold">Supplies & Orders</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Prices are gross customer-facing prices. Every checkout preserves its final delivery address.
        </p>
      </header>

      <section aria-labelledby="supply-operations-title" className="space-y-3">
        <div>
          <h2 id="supply-operations-title" className="text-base font-semibold">
            Shop supply indicators
          </h2>
          <p className="text-sm text-muted-foreground">
            Recorded stock, paid ordered units and completed cards are shown separately; MintVault does not estimate
            consumption from them.
          </p>
        </div>
        {operations.isLoading && <PartnerLoadingState label="Loading supply indicators…" />}
        {operations.error && (
          <PartnerErrorState message={partnerErrorMessage(operations.error)} onRetry={() => operations.refetch()} />
        )}
        {operations.data && (
          <>
            <Card className="rounded-md">
              <CardContent className="p-4">
                <p className="text-sm text-muted-foreground">Cards completed at this shop</p>
                <p className="text-2xl font-semibold">{operations.data.cardsCompleted.toLocaleString("en-GB")}</p>
              </CardContent>
            </Card>
            <div className="grid gap-3 md:grid-cols-3">
              {operations.data.products.map((product) => {
                const entered = stockInputs[product.code] ?? product.knownUnits?.toString() ?? "";
                const count = Number(entered);
                const validCount = Number.isSafeInteger(count) && count >= 0;
                return (
                  <Card
                    key={product.code}
                    className="rounded-md"
                    data-testid={`partner-supply-operations-${product.code}`}
                  >
                    <CardContent className="space-y-2 p-4">
                      <p className="font-medium">{product.displayName}</p>
                      <p className="text-sm text-muted-foreground">
                        Known shop stock:{" "}
                        {product.knownUnits == null
                          ? "Not recorded"
                          : `${product.knownUnits.toLocaleString("en-GB")} units`}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Paid ordered: {product.paidOrderedUnits.toLocaleString("en-GB")} units · Awaiting dispatch:{" "}
                        {product.awaitingDispatchUnits.toLocaleString("en-GB")} units
                      </p>
                      {canPurchase && (
                        <div className="flex flex-wrap items-end gap-2 pt-1">
                          <div className="min-w-32 flex-1">
                            <Label htmlFor={`stock-${product.code}`}>Record known stock (units)</Label>
                            <Input
                              id={`stock-${product.code}`}
                              min={0}
                              inputMode="numeric"
                              type="number"
                              value={entered}
                              onChange={(event) =>
                                setStockInputs((current) => ({ ...current, [product.code]: event.target.value }))
                              }
                            />
                          </div>
                          <Button
                            variant="outline"
                            disabled={!validCount || recordStock.isPending}
                            onClick={() => recordStock.mutate({ productCode: product.code, knownUnits: count })}
                          >
                            Record count
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
            {recordStock.error && <PartnerErrorState message={partnerErrorMessage(recordStock.error)} />}
          </>
        )}
      </section>

      {products.isLoading && <PartnerLoadingState label="Loading supplies…" />}
      {products.error && (
        <PartnerErrorState message={partnerErrorMessage(products.error)} onRetry={() => products.refetch()} />
      )}
      {products.data && (
        <section aria-labelledby="supply-products-title" className="space-y-3">
          <div>
            <h2 id="supply-products-title" className="text-base font-semibold">
              Order supplies
            </h2>
            <p className="text-sm text-muted-foreground">Products without an active price cannot be purchased.</p>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {products.data.products.map((product) => {
              const quantity = quantities[product.code] ?? 0;
              return (
                <Card key={product.code} className="rounded-md">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base">{product.display_name}</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                      {product.units_per_pack.toLocaleString("en-GB")} per pack
                    </p>
                    <p className="text-lg font-semibold">
                      {product.active_price_pence == null
                        ? "Price not set"
                        : money(product.active_price_pence, products.data.currency)}
                    </p>
                    {canPurchase && product.purchasable ? (
                      <div className="flex items-center gap-2">
                        <Label htmlFor={`supply-${product.code}`} className="sr-only">
                          Quantity for {product.display_name}
                        </Label>
                        <Input
                          id={`supply-${product.code}`}
                          type="number"
                          min={0}
                          max={100}
                          value={quantity}
                          onChange={(event) =>
                            setQuantities((current) => ({
                              ...current,
                              [product.code]: Math.max(0, Math.min(100, Number(event.target.value) || 0)),
                            }))
                          }
                        />
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {product.purchasable
                          ? "Your role can view orders but cannot purchase."
                          : "Unavailable until Super Admin sets an active price."}
                      </p>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
          {canPurchase && (
            <Card className="rounded-md" data-testid="partner-supply-checkout">
              <CardContent className="space-y-4 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">Checkout total</p>
                    <p className="text-sm text-muted-foreground">
                      {products.data.taxTreatment === "VAT_INCLUDED"
                        ? "VAT-inclusive gross total; the VAT breakdown is saved at checkout."
                        : "Gross total. VAT treatment is not configured."}
                    </p>
                  </div>
                  <p className="text-xl font-semibold">{money(total, products.data.currency)}</p>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={useOverride}
                    onChange={(event) => setUseOverride(event.target.checked)}
                  />{" "}
                  Use a different delivery address for this order
                </label>
                {useOverride && (
                  <div className="grid gap-3 md:grid-cols-2" data-testid="partner-supply-delivery-override">
                    {(
                      [
                        ["recipientName", "Recipient name"],
                        ["line1", "Address line 1"],
                        ["line2", "Address line 2"],
                        ["city", "Town or city"],
                        ["postcode", "Postcode"],
                        ["country", "Country"],
                      ] as const
                    ).map(([field, label]) => (
                      <div key={field}>
                        <Label htmlFor={`delivery-${field}`}>
                          {label}
                          {["line1", "city", "postcode", "country"].includes(field) ? " *" : ""}
                        </Label>
                        <Input
                          id={`delivery-${field}`}
                          value={delivery[field]}
                          onChange={(event) => setDelivery((current) => ({ ...current, [field]: event.target.value }))}
                        />
                      </div>
                    ))}
                  </div>
                )}
                {checkout.error && <PartnerErrorState message={partnerErrorMessage(checkout.error)} />}
                <Button
                  disabled={items.length === 0 || checkout.isPending}
                  onClick={() => checkout.mutate()}
                  data-testid="button-supply-checkout"
                >
                  {checkout.isPending ? "Starting secure checkout…" : "Continue to secure payment"}
                </Button>
              </CardContent>
            </Card>
          )}
        </section>
      )}

      <section aria-labelledby="supply-order-history-title" className="space-y-3">
        <h2 id="supply-order-history-title" className="text-base font-semibold">
          Your orders
        </h2>
        {orders.isLoading && <PartnerLoadingState label="Loading orders…" />}
        {orders.error && (
          <PartnerErrorState message={partnerErrorMessage(orders.error)} onRetry={() => orders.refetch()} />
        )}
        {orders.data?.orders.length === 0 && <p className="text-sm text-muted-foreground">No supply orders yet.</p>}
        <div className="space-y-3">
          {orders.data?.orders.map((order) => (
            <Card key={order.id} className="rounded-md">
              <CardContent className="space-y-2 p-4">
                <div className="flex flex-wrap justify-between gap-2">
                  <div>
                    <p className="font-medium">{orderStatus(order.status)}</p>
                    <p className="text-sm text-muted-foreground">
                      {new Date(order.created_at).toLocaleString("en-GB")}
                    </p>
                  </div>
                  <p className="font-semibold">{money(order.gross_total_pence, order.currency)}</p>
                </div>
                <p className="text-sm">{order.items.map((item) => `${item.quantity} × ${item.name}`).join(", ")}</p>
                {order.tax_treatment === "VAT_INCLUDED" && (
                  <p className="text-sm text-muted-foreground">
                    Net {money(order.net_total_pence ?? 0, order.currency)} · VAT{" "}
                    {money(order.vat_total_pence ?? 0, order.currency)} · Gross{" "}
                    {money(order.gross_total_pence, order.currency)}
                  </p>
                )}
                <p className="text-sm text-muted-foreground">
                  Delivery snapshot:{" "}
                  {order.delivery_address.source === "approved_location"
                    ? `${order.delivery_address.locationName}: ${order.delivery_address.address}`
                    : `${order.delivery_address.line1}, ${order.delivery_address.city}, ${order.delivery_address.postcode}`}
                  {order.tracking_reference ? ` · Tracking: ${order.tracking_reference}` : ""}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
