import { adminFetch } from "@/lib/queryClient";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { AdminButton, AdminShell, Badge, Panel } from "@/components/admin";

type Product = {
  code: string;
  display_name: string;
  units_per_pack: number;
  pricing_mode: "LOCKED" | "CONFIGURABLE";
  active_price_pence: number | null;
  active: boolean;
  purchasable: boolean;
};
type Order = {
  id: string;
  status: string;
  partner_name: string;
  location_name: string;
  delivery_address: Record<string, string>;
  gross_total_pence: number;
  currency: string;
  tax_treatment: string;
  net_total_pence: number | null;
  vat_total_pence: number | null;
  tracking_reference: string | null;
  created_at: string;
  payment_status: string;
  refunded_total_pence: number;
  items: Array<{ name: string; quantity: number; unitsPerPack: number }>;
};
type Operations = {
  cardsCompleted: number;
  products: Array<{
    code: string;
    displayName: string;
    unitsPerPack: number;
    knownStockUnits: number | null;
    shopsWithRecordedStock: number;
    paidOrderedUnits: number;
    awaitingDispatchUnits: number;
  }>;
};

const money = (pence: number, currency = "GBP") =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(pence / 100);
const label = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());

async function supplyApi<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await adminFetch(`/api/super-admin/supplies${path}`, {
    method,
    credentials: "include",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(json.error ?? "Supply operation failed.");
  return json as T;
}

export default function AdminSupplyOrdersPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [tracking, setTracking] = useState<Record<string, string>>({});
  const [refundPence, setRefundPence] = useState<Record<string, string>>({});
  const [auditOrder, setAuditOrder] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const orders = useQuery({
    queryKey: ["supply-admin-orders"],
    queryFn: () => supplyApi<{ orders: Order[] }>("/orders"),
  });
  const catalogue = useQuery({
    queryKey: ["supply-admin-catalogue"],
    queryFn: () =>
      supplyApi<{
        products: Product[];
        taxTreatment: "UNCONFIGURED" | "VAT_INCLUDED";
        vatRateBasisPoints: number | null;
      }>("/catalogue"),
  });
  const operations = useQuery({
    queryKey: ["supply-admin-operations"],
    queryFn: () => supplyApi<Operations>("/operations"),
  });
  const audit = useQuery({
    queryKey: ["supply-admin-audit", auditOrder],
    enabled: !!auditOrder,
    queryFn: () =>
      supplyApi<{
        events: Array<{
          action: string;
          actor_type: string;
          actor_email: string | null;
          details: Record<string, unknown>;
          created_at: string;
        }>;
      }>(`/orders/${auditOrder}/audit`),
  });
  const mutation = useMutation({
    mutationFn: ({ path, body, successMessage }: { path: string; body?: unknown; successMessage?: string }) =>
      supplyApi(path, "POST", body).then(() => successMessage ?? "Supply order updated."),
    onSuccess: (successMessage) => {
      queryClient.invalidateQueries({ queryKey: ["supply-admin-orders"] });
      queryClient.invalidateQueries({ queryKey: ["supply-admin-audit"] });
      setMessage(successMessage);
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : "Supply operation failed."),
  });
  const saveProduct = useMutation({
    mutationFn: ({ code, body }: { code: string; body: { active: boolean; activePricePence: number | null } }) =>
      supplyApi(`/catalogue/${encodeURIComponent(code)}`, "PUT", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["supply-admin-catalogue"] });
      queryClient.invalidateQueries({ queryKey: ["/api/partner/supplies/products"] });
      setMessage("Catalogue updated.");
    },
    onError: (error) => setMessage(error instanceof Error ? error.message : "Catalogue update failed."),
  });

  return (
    <AdminShell
      activeTab="dashboard"
      onTabChange={() => navigate("/admin")}
      title="Supply Orders"
      crumb="Operations"
    >
      <div className="space-y-4" data-testid="admin-supply-orders-page">
        <div>
          <h1 className="text-xl font-semibold">Supply Orders</h1>
          <p className="text-sm opacity-75">
            Paid orders, immutable checkout snapshots, fulfilment, refunds and catalogue pricing.
          </p>
        </div>
        {message && (
          <div role="status" className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            {message}
          </div>
        )}

        <Panel
          title="Operations indicators"
          sub="Current shop-counted stock, paid order units and completed work items. These are indicators, not an inferred consumption model."
        >
          {operations.isLoading && <p>Loading operations indicators…</p>}
          {operations.error && (
            <p role="alert">
              {operations.error instanceof Error ? operations.error.message : "Could not load operations indicators."}
            </p>
          )}
          {operations.data && (
            <div className="space-y-3">
              <p>
                <strong>{operations.data.cardsCompleted.toLocaleString("en-GB")}</strong> completed Partner work items
              </p>
              <div className="grid gap-3 md:grid-cols-3">
                {operations.data.products.map((product) => (
                  <div key={product.code} className="rounded border border-white/10 p-3">
                    <strong>{product.displayName}</strong>
                    <p className="mt-1 text-sm opacity-75">
                      Known shop stock:{" "}
                      {product.knownStockUnits == null
                        ? "Not recorded"
                        : `${product.knownStockUnits.toLocaleString("en-GB")} units`}
                      {product.shopsWithRecordedStock > 0
                        ? ` across ${product.shopsWithRecordedStock} shop${product.shopsWithRecordedStock === 1 ? "" : "s"}`
                        : ""}
                    </p>
                    <p className="text-sm opacity-75">
                      Paid ordered: {product.paidOrderedUnits.toLocaleString("en-GB")} units · Awaiting dispatch:{" "}
                      {product.awaitingDispatchUnits.toLocaleString("en-GB")} units
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Panel>

        <Panel
          title="Current catalogue"
          sub="Gross prices only. A missing active price is deliberately not purchasable."
        >
          {catalogue.isLoading && <p>Loading catalogue…</p>}
          {catalogue.error && (
            <p role="alert">
              {catalogue.error instanceof Error ? catalogue.error.message : "Could not load catalogue."}
            </p>
          )}
          <div className="grid gap-3 md:grid-cols-3">
            {catalogue.data?.products.map((product) => (
              <CatalogueCard
                key={product.code}
                product={product}
                busy={saveProduct.isPending}
                onSave={(body) => saveProduct.mutate({ code: product.code, body })}
              />
            ))}
          </div>
          <p className="mt-3 text-sm opacity-75">
            Tax treatment:{" "}
            {catalogue.data?.taxTreatment === "VAT_INCLUDED"
              ? `VAT included at ${(catalogue.data.vatRateBasisPoints ?? 0) / 100}%`
              : "Not configured — gross prices only."}
          </p>
        </Panel>

        <Panel
          title="Paid and fulfilment orders"
          sub="No refund is automatic after dispatch or completion; those requests are recorded for manual exception review."
        >
          {orders.isLoading && <p>Loading orders…</p>}
          {orders.error && (
            <p role="alert">{orders.error instanceof Error ? orders.error.message : "Could not load orders."}</p>
          )}
          {!orders.isLoading && orders.data?.orders.length === 0 && <p>No supply orders yet.</p>}
          <div className="space-y-4">
            {orders.data?.orders.map((order) => (
              <article
                key={order.id}
                className="rounded border border-white/10 p-4"
                data-testid={`admin-supply-order-${order.id}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <strong>{order.partner_name}</strong>
                      <Badge variant={order.status === "PAID" ? "act" : order.status === "REFUNDED" ? "red" : "neu"}>
                        {label(order.status)}
                      </Badge>
                    </div>
                    <p className="text-sm opacity-75">
                      {order.location_name} · {new Date(order.created_at).toLocaleString("en-GB")}
                    </p>
                  </div>
                  <strong>{money(order.gross_total_pence, order.currency)}</strong>
                </div>
                <p className="mt-2 text-sm">
                  {order.items
                    .map((item) => `${item.quantity} × ${item.name} (${item.unitsPerPack} per pack)`)
                    .join(", ")}
                </p>
                <p className="mt-1 text-sm opacity-75">
                  Delivery snapshot:{" "}
                  {order.delivery_address.source === "approved_location"
                    ? `${order.delivery_address.locationName}: ${order.delivery_address.address}`
                    : `${order.delivery_address.line1}, ${order.delivery_address.city}, ${order.delivery_address.postcode}`}
                </p>
                {order.tax_treatment === "VAT_INCLUDED" && (
                  <p className="mt-1 text-sm opacity-75">
                    Net {money(order.net_total_pence ?? 0, order.currency)} · VAT{" "}
                    {money(order.vat_total_pence ?? 0, order.currency)} · Gross{" "}
                    {money(order.gross_total_pence, order.currency)}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {order.status === "PAID" && (
                    <AdminButton size="sm" onClick={() => mutation.mutate({ path: `/orders/${order.id}/processing` })}>
                      Mark processing
                    </AdminButton>
                  )}
                  {order.status === "PROCESSING" && (
                    <>
                      <input
                        className="rounded border border-white/20 bg-transparent px-2 py-1 text-sm"
                        placeholder="Tracking/reference (optional)"
                        value={tracking[order.id] ?? ""}
                        onChange={(event) => setTracking((all) => ({ ...all, [order.id]: event.target.value }))}
                      />
                      <AdminButton
                        size="sm"
                        onClick={() =>
                          mutation.mutate({
                            path: `/orders/${order.id}/dispatched`,
                            body: { trackingReference: tracking[order.id] },
                          })
                        }
                      >
                        Mark dispatched
                      </AdminButton>
                    </>
                  )}
                  {order.status === "DISPATCHED" && (
                    <AdminButton size="sm" onClick={() => mutation.mutate({ path: `/orders/${order.id}/completed` })}>
                      Mark completed
                    </AdminButton>
                  )}
                  {["PAID", "PROCESSING", "PARTIALLY_REFUNDED"].includes(order.status) && (
                    <>
                      <input
                        className="w-32 rounded border border-white/20 bg-transparent px-2 py-1 text-sm"
                        inputMode="numeric"
                        placeholder="Refund pence"
                        value={refundPence[order.id] ?? ""}
                        onChange={(event) => setRefundPence((all) => ({ ...all, [order.id]: event.target.value }))}
                      />
                      <AdminButton
                        size="sm"
                        variant="gold"
                        onClick={() =>
                          mutation.mutate({
                            path: `/orders/${order.id}/refund`,
                            body: { amountPence: refundPence[order.id] ? Number(refundPence[order.id]) : undefined },
                          })
                        }
                      >
                        Refund
                      </AdminButton>
                      <AdminButton
                        size="sm"
                        variant="ghost"
                        onClick={() => mutation.mutate({ path: `/orders/${order.id}/cancel` })}
                      >
                        Cancel / full refund
                      </AdminButton>
                    </>
                  )}
                  {["DISPATCHED", "COMPLETED"].includes(order.status) && (
                    <AdminButton
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        mutation.mutate({
                          path: `/orders/${order.id}/manual-exception`,
                          successMessage: "Manual exception review recorded in Needs Attention.",
                        })
                      }
                    >
                      Request manual exception review
                    </AdminButton>
                  )}
                  <AdminButton size="sm" variant="ghost" onClick={() => setAuditOrder(order.id)}>
                    View audit
                  </AdminButton>
                </div>
              </article>
            ))}
          </div>
        </Panel>

        {auditOrder && (
          <Panel title="Order audit" sub="Append-only order/payment/fulfilment evidence.">
            <div className="space-y-2">
              {audit.isLoading && <p>Loading audit…</p>}
              {audit.data?.events.map((event, index) => (
                <div key={`${event.action}-${index}`} className="rounded border border-white/10 p-2 text-sm">
                  <strong>{label(event.action)}</strong> · {event.actor_email ?? event.actor_type} ·{" "}
                  {new Date(event.created_at).toLocaleString("en-GB")}
                  <pre className="mt-1 overflow-auto text-xs opacity-75">{JSON.stringify(event.details, null, 2)}</pre>
                </div>
              ))}
            </div>
          </Panel>
        )}
      </div>
    </AdminShell>
  );
}

function CatalogueCard({
  product,
  onSave,
  busy,
}: {
  product: Product;
  onSave: (body: { active: boolean; activePricePence: number | null }) => void;
  busy: boolean;
}) {
  const [active, setActive] = useState(product.active);
  const [price, setPrice] = useState(product.active_price_pence?.toString() ?? "");
  return (
    <div className="rounded border border-white/10 p-3">
      <strong>{product.display_name}</strong>
      <p className="text-sm opacity-75">
        {product.units_per_pack.toLocaleString("en-GB")} per pack ·{" "}
        {product.pricing_mode === "LOCKED" ? "Locked £75 / £1.50 per slab" : "Super Admin configurable"}
      </p>
      <label className="mt-2 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> Active
      </label>
      <label className="mt-2 block text-sm">
        Gross price (pence)
        <input
          disabled={product.pricing_mode === "LOCKED"}
          className="mt-1 w-full rounded border border-white/20 bg-transparent px-2 py-1"
          inputMode="numeric"
          value={price}
          onChange={(event) => setPrice(event.target.value)}
        />
      </label>
      <AdminButton
        size="sm"
        className="mt-3"
        disabled={busy}
        onClick={() => onSave({ active, activePricePence: price.trim() ? Number(price) : null })}
      >
        Save
      </AdminButton>
    </div>
  );
}
