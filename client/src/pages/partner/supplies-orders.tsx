import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PartnerErrorState, PartnerLoadingState } from "@/components/partner/partner-shell";
import { partnerErrorMessage, partnerSupplies, type PartnerSuppliesOrderStatus } from "@/lib/partner-api";

function statusLabel(status: PartnerSuppliesOrderStatus): string {
  return status.replaceAll("_", " ");
}

export default function PartnerSuppliesOrdersPage() {
  const query = useQuery({ queryKey: ["/api/partner/supplies/orders"], queryFn: partnerSupplies.orders });
  if (query.isLoading) return <PartnerLoadingState label="Loading your supplies orders…" />;
  if (query.error) return <PartnerErrorState message={partnerErrorMessage(query.error)} onRetry={() => query.refetch()} />;
  const orders = query.data?.orders ?? [];

  return (
    <div className="space-y-5" data-testid="partner-supplies-orders-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase text-primary">Shop stock</p>
          <h1 className="text-2xl font-semibold">My Orders</h1>
          <p className="mt-1 text-sm text-muted-foreground">Track the current status of supplies requested for this shop.</p>
        </div>
        <Button asChild data-testid="button-order-supplies">
          <Link href="/partner/supplies">Order supplies</Link>
        </Button>
      </div>
      {orders.length === 0 ? (
        <Card data-testid="partner-supplies-orders-empty">
          <CardContent className="p-6 text-sm text-muted-foreground">No supplies orders have been submitted from this account yet.</CardContent>
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
                <p className="text-xs text-muted-foreground">Submitted {new Date(order.createdAt).toLocaleString("en-GB")}</p>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase text-muted-foreground">Items</p>
                  <ul className="space-y-1">
                    {order.items.map((item) => <li key={item.productCode}>{item.label} × {item.quantity}</li>)}
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
