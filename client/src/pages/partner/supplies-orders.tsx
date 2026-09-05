import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { partnerErrorMessage, partnerSupplies, partnerSupplyOrders } from "@/lib/partner-api";

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

export default function PartnerSuppliesOrdersPage() {
  const query = useQuery({ queryKey: ["/api/partner/supplies/orders"], queryFn: partnerSupplyOrders.list });
  if (query.isLoading) return <PartnerLoadingState label="Loading your paid supply orders…" />;
  if (query.error)
    return <PartnerErrorState message={partnerErrorMessage(query.error)} onRetry={() => query.refetch()} />;
  const orders = query.data?.orders ?? [];
  const money = (pence: number) =>
    new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
  return (
    <div className="space-y-5" data-testid="partner-supplies-orders-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">My Orders</h1>
          <p className="mt-1 text-sm text-muted-foreground">Supply purchases and payment status for this shop.</p>
        </div>
        <Button asChild>
          <Link href="/partner/supplies">View supplies</Link>
        </Button>
      </div>
      {orders.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">No supply purchases yet.</CardContent>
        </Card>
      ) : (
        orders.map((order) => (
          <Card key={order.id} data-testid={`partner-paid-order-${order.id}`}>
            <CardHeader>
              <div className="flex flex-wrap justify-between gap-2">
                <CardTitle className="break-all font-mono text-sm">{order.id}</CardTitle>
                <Badge>{statusLabel(order.status)}</Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                Created {new Date(order.created_at).toLocaleString("en-GB")} · Payment:{" "}
                {statusLabel(order.payment_status)}
              </p>
            </CardHeader>
            <CardContent className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <ul className="space-y-1">
                  {order.items.map((item) => (
                    <li key={item.productCode}>
                      {item.name} × {item.quantity} ({item.unitsPerPack} per pack) — {money(item.grossLineTotalPence)}
                    </li>
                  ))}
                </ul>
                <p className="mt-3 font-semibold">Total {money(order.gross_total_pence)}</p>
                {order.tax_treatment === "VAT_INCLUDED" &&
                  order.net_total_pence !== null &&
                  order.vat_total_pence !== null && (
                    <p>
                      Net {money(order.net_total_pence)} · VAT {money(order.vat_total_pence)}
                    </p>
                  )}
                {order.refunded_total_pence > 0 && <p>Refunded {money(order.refunded_total_pence)}</p>}
              </div>
              <div>
                <p className="mb-1 font-semibold">Delivery address at checkout</p>
                {[
                  order.delivery_address.locationName,
                  order.delivery_address.address,
                  order.delivery_address.recipientName,
                  order.delivery_address.line1,
                  order.delivery_address.line2,
                  order.delivery_address.city,
                  order.delivery_address.postcode,
                  order.delivery_address.country,
                ]
                  .filter(Boolean)
                  .map((line, index) => (
                    <p key={index}>{line}</p>
                  ))}
                {order.tracking_reference && <p className="mt-2 break-all">Tracking: {order.tracking_reference}</p>}
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

/** Operational requests retain their own route and capability, independent of paid commerce. */
export function PartnerSuppliesRequestsPage() {
  const query = useQuery({ queryKey: ["/api/partner/supplies/requests"], queryFn: partnerSupplies.orders });
  if (query.isLoading) return <PartnerLoadingState label="Loading your supplies orders…" />;
  if (query.error)
    return <PartnerErrorState message={partnerErrorMessage(query.error)} onRetry={() => query.refetch()} />;
  const orders = query.data?.orders ?? [];

  return (
    <div className="space-y-5" data-testid="partner-supplies-requests-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase text-primary">Shop stock</p>
          <h1 className="text-2xl font-semibold">Supply Requests</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Track the current status of supplies requested for this shop.
          </p>
        </div>
      </div>
      {orders.length === 0 ? (
        <Card data-testid="partner-supplies-orders-empty">
          <CardContent className="p-6 text-sm text-muted-foreground">
            No supplies orders have been submitted from this account yet.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {orders.map((order) => (
            <Card key={order.id} data-testid={`partner-supplies-order-${order.reference}`}>
              <CardHeader className="space-y-2 pb-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="font-mono text-base">{order.reference}</CardTitle>
                  <Badge>{statusLabel(order.status)}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Submitted {new Date(order.createdAt).toLocaleString("en-GB")}
                </p>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Items</p>
                  <ul className="space-y-1">
                    {order.items.map((item) => (
                      <li key={item.productCode}>
                        {item.label} × {item.quantity}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Delivery shop</p>
                  <p>{order.shopName}</p>
                  <p className="text-muted-foreground">{order.delivery.postcode}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
