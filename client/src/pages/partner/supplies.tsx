/**
 * PARTNER → SUPPLIES. Where a shop buys MintVault operating supplies.
 *
 * PARTNER-ONLY, BY CONSTRUCTION. Every request below goes to `/api/partner/supplies/*`, which is
 * mounted behind the partner session, capability and freeze gates in mount.ts. There is no public
 * catalogue route and nothing here is reachable without an authenticated Partner session — an
 * unauthenticated caller is refused by the router, not by this page choosing to render less.
 *
 * WHAT A SHOP CAN SEE AND DO. Only ACTIVE products appear, and only priced ones can be bought:
 * `purchasable` is computed on the server as `active && active_price_pence != null`, so a product
 * that MintVault has catalogued but not yet priced is simply absent from the buyable set rather
 * than showing a £0 button. Partners cannot edit anything — price, name, description and
 * availability are Super Admin authority and are not writable from any partner route.
 *
 * The catalogue is OPEN-ENDED. Adding a fourth product in Super Admin makes a fourth card appear
 * here with no code change; the grid is driven entirely by the server's list.
 */
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { usePartnerSession } from "@/hooks/use-partner-session";
import { apiRequest } from "@/lib/queryClient";

interface SupplyProduct {
  code: string;
  display_name: string;
  description: string | null;
  units_per_pack: number;
  active_price_pence: number | null;
  active: boolean;
  image_url: string | null;
  purchasable: boolean;
}

interface Catalogue {
  currency: string;
  products: SupplyProduct[];
}

function money(pence: number | null): string {
  if (pence == null) return "—";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
}

function ProductCard({
  product,
  quantity,
  onQuantity,
  onBuy,
  busy,
  canPurchase,
}: {
  product: SupplyProduct;
  quantity: number;
  onQuantity: (next: number) => void;
  onBuy: () => void;
  busy: boolean;
  canPurchase: boolean;
}) {
  return (
    <div
      data-testid={`supply-card-${product.code}`}
      className="flex flex-col gap-3 rounded-xl p-4"
      style={{ border: "1px solid rgba(255,255,255,.12)", background: "rgba(255,255,255,.02)" }}
    >
      <div
        className="grid aspect-[4/3] w-full place-items-center overflow-hidden rounded-lg"
        style={{ background: "rgba(255,255,255,.04)" }}
      >
        {product.image_url ? (
          // A signed, short-lived url produced by the server. The object key never reaches the browser.
          <img
            src={product.image_url}
            alt={product.display_name}
            className="h-full w-full object-cover"
            data-testid={`supply-image-${product.code}`}
          />
        ) : (
          <span className="text-xs opacity-50">No image</span>
        )}
      </div>

      <div>
        <div className="font-semibold" data-testid={`supply-name-${product.code}`}>
          {product.display_name}
        </div>
        {product.description && <p className="mt-1 text-sm opacity-75">{product.description}</p>}
        <p className="mt-1 text-xs opacity-60">{product.units_per_pack} per pack</p>
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-3">
        <span className="text-lg tabular-nums" data-testid={`supply-price-${product.code}`}>
          {money(product.active_price_pence)}
        </span>
        <label className="flex items-center gap-2 text-xs">
          <span className="opacity-70">Qty</span>
          <input
            type="number"
            min={1}
            max={100}
            value={quantity}
            disabled={!canPurchase || busy}
            onChange={(event) => onQuantity(Number(event.target.value))}
            data-testid={`supply-qty-${product.code}`}
            className="w-16 rounded px-2 py-1"
            style={{ background: "#0d0d0d", color: "#fff", border: "1px solid #555" }}
          />
        </label>
        <button
          type="button"
          disabled={!canPurchase || !product.purchasable || busy}
          onClick={onBuy}
          data-testid={`supply-buy-${product.code}`}
          className="rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-40"
          style={{ background: "var(--admin-gold, #D4AF37)", color: "#1A1400" }}
        >
          {busy ? "Opening…" : "Buy"}
        </button>
      </div>
    </div>
  );
}

export default function PartnerSuppliesPage() {
  const { hasPermission } = usePartnerSession();
  const canPurchase = hasPermission("partner.orders.submit") && hasPermission("partner.credits.purchase");
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [banner, setBanner] = useState<string | null>(null);
  /*
   * ONE PRESS, ONE ORDER. The idempotency key is held per product and REUSED across retries of the
   * same press — a double-click, a dropped response or a refresh mid-request replays the same
   * pending order and the same Stripe session instead of creating a second one. It is regenerated
   * only after a checkout has successfully opened, so a genuinely new purchase gets a new key.
   * The server keys on (tenant_id, idempotency_key) with a UNIQUE constraint, so this is the
   * client half of a guarantee the database enforces.
   */
  const idempotencyKeys = useRef<Record<string, string>>({});

  const catalogue = useQuery<Catalogue>({
    queryKey: ["/api/partner/supplies/products"],
    queryFn: () => apiRequest("GET", "/api/partner/supplies/products").then((r) => r.json()),
  });

  // Only ACTIVE products are offered. A disabled product disappears from the shop's view while its
  // historical orders stay readable in Order history.
  const products = useMemo(
    () => (catalogue.data?.products ?? []).filter((product) => product.active),
    [catalogue.data]
  );

  const checkout = useMutation({
    mutationFn: async (product: SupplyProduct) => {
      if (!canPurchase) throw new Error("This role has read-only supply access.");
      const quantity = Math.max(1, Math.min(100, quantities[product.code] ?? 1));
      const key = (idempotencyKeys.current[product.code] ??= crypto.randomUUID());
      const response = await apiRequest("POST", "/api/partner/supplies/checkout", {
        items: [{ code: product.code, quantity }],
        idempotencyKey: key,
      });
      return { ...((await response.json()) as { checkoutUrl?: string }), code: product.code };
    },
    onSuccess: (data) => {
      if (data.checkoutUrl) {
        // The purchase is now Stripe's; the next press is a genuinely new order.
        delete idempotencyKeys.current[data.code];
        window.location.assign(data.checkoutUrl);
        return;
      }
      setBanner("Checkout could not be opened. Nothing has been charged.");
    },
    onError: (error) =>
      setBanner(
        (error as { body?: { error?: string } })?.body?.error ?? "Checkout could not be started. Nothing was charged."
      ),
  });

  return (
    <div data-testid="partner-supplies-root" className="grid gap-4">
      {!canPurchase && (
        <p className="text-sm text-muted-foreground">
          Read-only supply catalogue. Your account does not have purchase permission.
        </p>
      )}
      {banner && (
        <div
          role="alert"
          data-testid="partner-supplies-banner"
          className="rounded-lg px-3 py-2"
          style={{ background: "#3a2a0a" }}
        >
          {banner}
        </div>
      )}

      {/*
       * The shop's own order history. Supplies is where a purchase STARTS; what happened to
       * previous ones lives in Orders, and the two are one click apart in both directions.
       */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="opacity-70">Ordered something already?</span>
        <a href="/partner/orders" className="underline" data-testid="partner-supplies-orders-link">
          View your supply orders →
        </a>
      </div>

      {catalogue.isLoading ? (
        <div role="status">Loading supplies…</div>
      ) : catalogue.isError ? (
        <div role="alert">Supplies are temporarily unavailable.</div>
      ) : products.length === 0 ? (
        <div data-testid="partner-supplies-empty">No supplies are available to order right now.</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="partner-supplies-grid">
          {products.map((product) => (
            <ProductCard
              key={product.code}
              product={product}
              quantity={quantities[product.code] ?? 1}
              onQuantity={(next) => setQuantities((current) => ({ ...current, [product.code]: next }))}
              onBuy={() => checkout.mutate(product)}
              busy={checkout.isPending}
              canPurchase={canPurchase}
            />
          ))}
        </div>
      )}
    </div>
  );
}
