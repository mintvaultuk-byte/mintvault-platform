/** Super Admin operational view for canonical Partner supplies orders. */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { AdminShell, Badge, Panel } from "@/components/admin";
import { isAdminStepUpCancelled, runAdminProtected } from "@/components/admin/admin-step-up";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAdminSession } from "@/lib/admin-session";

const BASE = "/api/super-admin/partner-supplies/orders";
type SuppliesStatus = "RECEIVED" | "PROCESSING" | "DISPATCHED" | "CANCELLED";
type SuppliesOrder = {
  id: string;
  reference: string;
  status: SuppliesStatus;
  partnerName: string;
  shopName: string;
  contact: { name: string; email: string; phone: string | null };
  delivery: { address: string; postcode: string; country: string };
  notes: string | null;
  items: Array<{ productCode: string; label: string; quantity: number }>;
  createdAt: string;
  notificationStatus: "PENDING" | "CLAIMED" | "SENT" | "FAILED" | null;
  notificationRecovery: "RETRY_AVAILABLE" | "RECONCILIATION_REQUIRED" | null;
};

function allowedActions(status: SuppliesStatus): Array<{ status: SuppliesStatus; label: string }> {
  if (status === "RECEIVED") return [{ status: "PROCESSING", label: "Mark processing" }, { status: "CANCELLED", label: "Cancel" }];
  if (status === "PROCESSING") return [{ status: "DISPATCHED", label: "Mark dispatched" }, { status: "CANCELLED", label: "Cancel" }];
  return [];
}

function badgeVariant(status: SuppliesStatus): "act" | "wait" | "prog" | "red" | "neu" {
  if (status === "DISPATCHED") return "act";
  if (status === "PROCESSING") return "prog";
  if (status === "CANCELLED") return "red";
  return "wait";
}

function errorMessage(error: unknown): string {
  const body = (error as { body?: { error?: { message?: unknown }; message?: unknown } })?.body;
  if (typeof body?.error?.message === "string") return body.error.message;
  if (typeof body?.message === "string") return body.message;
  return "The supplies operation could not be completed. No order state was changed.";
}

export default function PartnerSuppliesOrdersAdminPage() {
  const [, navigate] = useLocation();
  const { principal } = useAdminSession();
  const authorized = principal?.isSuperAdmin === true;
  const [notice, setNotice] = useState<string | null>(null);

  const orders = useQuery<{ orders: SuppliesOrder[] }>({
    queryKey: [BASE],
    queryFn: () => apiRequest("GET", BASE).then((response) => response.json()),
    enabled: authorized,
    refetchInterval: 60_000,
  });
  const transition = useMutation({
    mutationFn: ({ orderId, status }: { orderId: string; status: SuppliesStatus }) =>
      runAdminProtected(() => apiRequest("POST", `${BASE}/${encodeURIComponent(orderId)}/status`, { status }).then((r) => r.json())),
    onSuccess: async (_result, input) => {
      setNotice(`Order status changed to ${input.status}.`);
      await queryClient.invalidateQueries({ queryKey: [BASE] });
    },
    onError: (error) => {
      if (!isAdminStepUpCancelled(error)) setNotice(errorMessage(error));
    },
  });
  const retryNotification = useMutation({
    mutationFn: ({ orderId }: { orderId: string }) =>
      runAdminProtected(() => apiRequest("POST", `${BASE}/${encodeURIComponent(orderId)}/notification/retry`).then((r) => r.json())),
    onSuccess: async () => {
      setNotice("Notification retry queued with the existing order reference.");
      await queryClient.invalidateQueries({ queryKey: [BASE] });
    },
    onError: (error) => {
      if (!isAdminStepUpCancelled(error)) setNotice(errorMessage(error));
    },
  });

  return (
    <AdminShell
      activeTab="dashboard"
      onTabChange={() => navigate("/admin")}
      title="Partner Supplies Orders"
      crumb="Partner Network / Supplies Orders"
    >
      {!authorized ? (
        <Panel title="Super Admin access required">
          <p role="alert">This supplies operation is restricted to a Super Admin.</p>
        </Panel>
      ) : (
      <Panel
        title="Partner Supplies Orders"
        sub="Canonical operational requests. Partner snapshots are immutable; status actions require a fresh Super Admin step-up."
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
          <Link href="/admin/partners" className="underline">
            Partner Network overview
          </Link>
          <span className="text-muted-foreground">{orders.data?.orders.length ?? 0} orders</span>
        </div>
        {notice && <p className="mb-3 text-sm" role="status">{notice}</p>}
        {orders.isLoading && <p>Loading canonical supplies orders…</p>}
        {orders.error && <p role="alert">{errorMessage(orders.error)}</p>}
        {orders.data && orders.data.orders.length === 0 && <p>No Partner supplies orders have been submitted.</p>}
        <div className="space-y-4" data-testid="admin-partner-supplies-orders">
          {orders.data?.orders.map((order) => (
            <article key={order.id} className="rounded border border-[var(--admin-line)] p-4" data-testid={`admin-supplies-order-${order.reference}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-mono text-base font-semibold">{order.reference}</h2>
                  <p className="text-sm opacity-75">{order.partnerName} · {order.shopName}</p>
                  <p className="text-xs opacity-60">Submitted {new Date(order.createdAt).toLocaleString("en-GB")}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={badgeVariant(order.status)}>{order.status}</Badge>
                  <span className="text-xs opacity-70">Notification: {order.notificationStatus ?? "PENDING"}</span>
                  {order.notificationRecovery === "RECONCILIATION_REQUIRED" && (
                    <span className="text-xs text-amber-700" role="alert">
                      Reconciliation required — verify Resend and the operational inbox before any resend.
                    </span>
                  )}
                  {order.notificationStatus === "FAILED" && order.notificationRecovery === "RETRY_AVAILABLE" && order.status === "RECEIVED" && (
                    <button
                      type="button"
                      className="admin-chip"
                      disabled={retryNotification.isPending}
                      onClick={() => retryNotification.mutate({ orderId: order.id })}
                      data-testid={`button-supplies-retry-notification-${order.reference}`}
                    >
                      {retryNotification.isPending ? "Retrying…" : "Retry notification"}
                    </button>
                  )}
                </div>
              </div>
              <div className="mt-4 grid gap-4 text-sm md:grid-cols-3">
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase opacity-60">Delivery address</p>
                  <address className="whitespace-pre-line not-italic">{order.delivery.address}{`\n`}{order.delivery.postcode}{`\n`}{order.delivery.country}</address>
                </div>
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase opacity-60">Operational contact</p>
                  <p>{order.contact.name}</p>
                  <p>{order.contact.email}</p>
                  {order.contact.phone && <p>{order.contact.phone}</p>}
                </div>
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase opacity-60">Items</p>
                  <ul className="space-y-1">
                    {order.items.map((item) => <li key={item.productCode}>{item.label} × {item.quantity}</li>)}
                  </ul>
                  {order.notes && <p className="mt-3 text-xs opacity-70">Notes: {order.notes}</p>}
                </div>
              </div>
              {allowedActions(order.status).length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {allowedActions(order.status).map((action) => (
                    <button
                      key={action.status}
                      type="button"
                      className="admin-chip"
                      disabled={transition.isPending}
                      onClick={() => transition.mutate({ orderId: order.id, status: action.status })}
                      data-testid={`button-supplies-${action.status.toLowerCase()}-${order.reference}`}
                    >
                      {transition.isPending ? "Updating…" : action.label}
                    </button>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      </Panel>
      )}
    </AdminShell>
  );
}
