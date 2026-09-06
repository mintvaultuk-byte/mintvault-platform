/**
 * SUPER ADMIN → SUPPLIES. One area, two tabs: PRODUCTS and ORDERS.
 *
 * PRODUCTS is the catalogue an operator can actually run without touching code or opening Stripe.
 * Add a product, give it a picture, name it, describe it, price it, take it off sale, put it back.
 * Adding product #4 makes a fourth card appear here and in every Partner's Supplies page; there is
 * no three-product limit, because migration 0111 removed the CHECK constraint that used to enforce
 * one in the database.
 *
 * PRICE CHANGES ARE FORWARD-ONLY, and that is a property of the data model rather than a promise
 * this screen makes. An order line stores `gross_unit_price_pence` when it is placed and nothing
 * ever writes to that column again, so editing a price here cannot reach a completed order. There
 * are no Stripe Price objects to replace either — checkout builds `price_data` inline from the
 * current row — so a price is only ever read forward.
 *
 * ORDERS reuses the existing fulfilment authority unchanged: processing → dispatched → completed,
 * plus refund and cancel, each behind the Super Admin routes that already own them.
 */
import { useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AdminButton, AdminShell, Badge, Chip, Panel } from "@/components/admin";
import { adminFetch, apiRequest } from "@/lib/queryClient";

/*
 * The path the supply admin router is ACTUALLY mounted on (supply-admin-routes.ts). Distinct from
 * /api/super-admin/partner-supplies, which serves the earlier request-and-email supplies surface —
 * two different bases for two different systems, deliberately not merged.
 */
const BASE = "/api/super-admin/supplies";

interface AdminProduct {
  code: string;
  display_name: string;
  description: string | null;
  units_per_pack: number;
  active_price_pence: number | null;
  active: boolean;
  image_url: string | null;
  purchasable: boolean;
}

interface SupplyOrder {
  id: string;
  status: string;
  gross_total_pence: number;
  created_at: string;
  tenant_id: string;
}

function money(pence: number | null): string {
  if (pence == null) return "Not priced";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(pence / 100);
}

/** Pounds in the box, pence on the wire. Money is never held as a float. */
function poundsToPence(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) throw new Error("Enter a price like 75 or 75.00");
  return Math.round(Number(trimmed) * 100);
}

function penceToPounds(pence: number | null): string {
  return pence == null ? "" : (pence / 100).toFixed(2);
}

function ProductEditor({ product, onDone }: { product: AdminProduct | null; onDone: (message: string) => void }) {
  const qc = useQueryClient();
  const creating = product === null;
  const [displayName, setDisplayName] = useState(product?.display_name ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [price, setPrice] = useState(penceToPounds(product?.active_price_pence ?? null));
  const [unitsPerPack, setUnitsPerPack] = useState(String(product?.units_per_pack ?? 1));
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const save = useMutation({
    mutationFn: async () => {
      let activePricePence: number | null;
      try {
        activePricePence = poundsToPence(price);
      } catch (err) {
        throw new Error((err as Error).message);
      }
      const body = {
        displayName,
        description: description.trim() || null,
        unitsPerPack: Number(unitsPerPack),
        activePricePence,
      };
      if (creating) {
        const created = await apiRequest("POST", `${BASE}/catalogue`, body).then((r) => r.json());
        return created as { code: string };
      }
      await apiRequest("PUT", `${BASE}/catalogue/${product!.code}`, { ...body, active: product!.active });
      return { code: product!.code };
    },
    onSuccess: async (result) => {
      // Upload the picture AFTER the product exists — a new product has no code until it is created.
      const file = fileInput.current?.files?.[0];
      if (file) {
        const form = new FormData();
        form.append("image", file);
        const response = await adminFetch(`${BASE}/catalogue/${result.code}/image`, {
          method: "POST",
          body: form,
          credentials: "include",
        });
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}) as { error?: string });
          setError(detail.error ?? "The product was saved but its image was not accepted.");
          await qc.invalidateQueries({ queryKey: [`${BASE}/catalogue`] });
          return;
        }
      }
      await qc.invalidateQueries({ queryKey: [`${BASE}/catalogue`] });
      onDone(creating ? "Product added." : "Product updated.");
    },
    onError: (err) =>
      setError((err as { body?: { error?: string } })?.body?.error ?? (err as Error).message ?? "Could not save."),
  });

  return (
    <div
      className="grid gap-3"
      data-testid={creating ? "supply-product-create" : `supply-product-edit-${product!.code}`}
    >
      {error && (
        <div role="alert" style={{ color: "var(--admin-red, #ff6b6b)", fontSize: 12 }}>
          {error}
        </div>
      )}
      <label className="grid gap-1 text-xs">
        <span className="opacity-80">Product name *</span>
        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          data-testid="supply-product-name"
          className="rounded px-2 py-1.5"
          style={{ background: "#0d0d0d", color: "#fff", border: "1px solid #555" }}
        />
      </label>
      <label className="grid gap-1 text-xs">
        <span className="opacity-80">Description</span>
        <textarea
          value={description}
          rows={2}
          onChange={(event) => setDescription(event.target.value)}
          data-testid="supply-product-description"
          className="rounded px-2 py-1.5"
          style={{ background: "#0d0d0d", color: "#fff", border: "1px solid #555" }}
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="grid gap-1 text-xs">
          <span className="opacity-80">Selling price (£)</span>
          <input
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            placeholder="Leave blank = not on sale"
            data-testid="supply-product-price"
            className="w-40 rounded px-2 py-1.5"
            style={{ background: "#0d0d0d", color: "#fff", border: "1px solid #555" }}
          />
        </label>
        <label className="grid gap-1 text-xs">
          <span className="opacity-80">Units per pack</span>
          <input
            type="number"
            min={1}
            value={unitsPerPack}
            onChange={(event) => setUnitsPerPack(event.target.value)}
            data-testid="supply-product-units"
            className="w-28 rounded px-2 py-1.5"
            style={{ background: "#0d0d0d", color: "#fff", border: "1px solid #555" }}
          />
        </label>
      </div>
      <label className="grid gap-1 text-xs">
        <span className="opacity-80">Product image (PNG, JPEG or WEBP, up to 4 MB)</span>
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          ref={fileInput}
          data-testid="supply-product-image"
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <AdminButton
          size="sm"
          variant="gold"
          disabled={!displayName.trim() || save.isPending}
          onClick={() => {
            setError(null);
            save.mutate();
          }}
          data-testid="supply-product-save"
        >
          {save.isPending ? "Saving…" : creating ? "Add product" : "Save changes"}
        </AdminButton>
        <AdminButton size="sm" variant="ghost" onClick={() => onDone("")} data-testid="supply-product-cancel">
          Cancel
        </AdminButton>
      </div>
    </div>
  );
}

function ProductCard({
  product,
  onEdit,
  onBanner,
}: {
  product: AdminProduct;
  onEdit: () => void;
  onBanner: (m: string) => void;
}) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: () =>
      apiRequest("PUT", `${BASE}/catalogue/${product.code}`, { active: !product.active }).then((r) => r.json()),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [`${BASE}/catalogue`] });
      // Disabling never deletes: historical orders keep the product name and the price paid.
      onBanner(product.active ? "Product disabled. Historical orders are unaffected." : "Product re-enabled.");
    },
  });
  const removeImage = useMutation({
    mutationFn: () => apiRequest("DELETE", `${BASE}/catalogue/${product.code}/image`).then((r) => r.json()),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: [`${BASE}/catalogue`] });
      onBanner("Product image removed.");
    },
  });

  return (
    <div
      data-testid={`supply-admin-card-${product.code}`}
      data-active={product.active ? "true" : "false"}
      className="flex flex-col gap-3 rounded-xl p-4"
      style={{ border: "1px solid rgba(255,255,255,.12)" }}
    >
      <div
        className="grid aspect-[4/3] w-full place-items-center overflow-hidden rounded-lg"
        style={{ background: "rgba(255,255,255,.04)" }}
      >
        {product.image_url ? (
          <img src={product.image_url} alt={product.display_name} className="h-full w-full object-cover" />
        ) : (
          <span className="text-xs opacity-50">No image</span>
        )}
      </div>
      <div>
        <div className="font-semibold">{product.display_name}</div>
        {product.description && <p className="mt-1 text-xs opacity-70">{product.description}</p>}
        <div className="mt-1 text-lg tabular-nums" data-testid={`supply-admin-price-${product.code}`}>
          {money(product.active_price_pence)}
        </div>
        <div className="mt-1">
          <Badge variant={product.active ? "act" : "neu"}>{product.active ? "ACTIVE" : "DISABLED"}</Badge>
          {product.active && !product.purchasable && (
            // Catalogued but unpriced: visible to MintVault, deliberately not buyable.
            <Badge variant="wait">NOT ON SALE</Badge>
          )}
        </div>
      </div>
      <div className="mt-auto flex flex-wrap gap-2">
        <AdminButton size="sm" variant="gold" onClick={onEdit} data-testid={`supply-admin-edit-${product.code}`}>
          Edit
        </AdminButton>
        <AdminButton
          size="sm"
          variant="ghost"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate()}
          data-testid={`supply-admin-toggle-${product.code}`}
        >
          {product.active ? "Disable" : "Enable"}
        </AdminButton>
        {product.image_url && (
          <AdminButton
            size="sm"
            variant="ghost"
            disabled={removeImage.isPending}
            onClick={() => removeImage.mutate()}
            data-testid={`supply-admin-remove-image-${product.code}`}
          >
            Remove image
          </AdminButton>
        )}
      </div>
    </div>
  );
}

export default function AdminPartnerSuppliesPage() {
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<"products" | "orders">("products");
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const catalogue = useQuery<{ products: AdminProduct[] }>({
    queryKey: [`${BASE}/catalogue`],
    queryFn: () => apiRequest("GET", `${BASE}/catalogue`).then((r) => r.json()),
  });
  const orders = useQuery<{ orders?: SupplyOrder[] } | SupplyOrder[]>({
    queryKey: [`${BASE}/orders`],
    queryFn: () => apiRequest("GET", `${BASE}/orders`).then((r) => r.json()),
    enabled: tab === "orders",
  });

  const products = useMemo(() => catalogue.data?.products ?? [], [catalogue.data]);
  const orderRows = useMemo(() => {
    const raw = orders.data;
    return Array.isArray(raw) ? raw : (raw?.orders ?? []);
  }, [orders.data]);

  return (
    <AdminShell
      activeTab="dashboard"
      onTabChange={() => navigate("/admin")}
      title="Partner Network"
      crumb="Supplies"
    >
      <div data-testid="admin-supplies-root">
        {banner && (
          <div
            data-testid="admin-supplies-banner"
            className="mb-3 rounded-lg px-3 py-2"
            style={{ background: "#24200e" }}
          >
            {banner}
          </div>
        )}
        <div className="mb-3 flex flex-wrap gap-2" data-testid="admin-supplies-tabs">
          <Chip active={tab === "products"} onClick={() => setTab("products")} testId="admin-supplies-tab-products">
            Products
          </Chip>
          <Chip active={tab === "orders"} onClick={() => setTab("orders")} testId="admin-supplies-tab-orders">
            Orders
          </Chip>
        </div>

        {tab === "products" ? (
          <Panel
            title="Supply products"
            sub="The catalogue every Partner shop sees. Changing a price never rewrites a completed order."
            actions={
              <AdminButton
                size="sm"
                variant="gold"
                onClick={() => {
                  setCreating(true);
                  setEditing(null);
                }}
                data-testid="admin-supplies-add"
              >
                + Add supply product
              </AdminButton>
            }
          >
            {creating && (
              <div className="mb-4 rounded-lg p-3" style={{ border: "1px solid rgba(255,255,255,.16)" }}>
                <ProductEditor
                  product={null}
                  onDone={(message) => {
                    setCreating(false);
                    if (message) setBanner(message);
                  }}
                />
              </div>
            )}
            {catalogue.isLoading ? (
              <div role="status">Loading catalogue…</div>
            ) : catalogue.isError ? (
              <div role="alert">The supply catalogue could not be loaded.</div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="admin-supplies-grid">
                {products.map((product) =>
                  editing === product.code ? (
                    <div
                      key={product.code}
                      className="rounded-lg p-3"
                      style={{ border: "1px solid rgba(255,255,255,.16)" }}
                    >
                      <ProductEditor
                        product={product}
                        onDone={(message) => {
                          setEditing(null);
                          if (message) setBanner(message);
                        }}
                      />
                    </div>
                  ) : (
                    <ProductCard
                      key={product.code}
                      product={product}
                      onEdit={() => {
                        setEditing(product.code);
                        setCreating(false);
                      }}
                      onBanner={setBanner}
                    />
                  )
                )}
              </div>
            )}
          </Panel>
        ) : (
          <Panel title="Supply orders" sub="Paid orders and their fulfilment state.">
            {orders.isLoading ? (
              <div role="status">Loading orders…</div>
            ) : orderRows.length === 0 ? (
              <div data-testid="admin-supplies-orders-empty">No supply orders yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm" data-testid="admin-supplies-orders-table">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Status</th>
                      <th>Total</th>
                      <th>Placed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orderRows.map((order) => (
                      <tr key={order.id} style={{ borderTop: "1px solid rgba(255,255,255,.08)" }}>
                        <td className="py-2">
                          <code className="text-xs">{order.id.slice(0, 8)}</code>
                        </td>
                        <td>
                          <Badge variant={order.status === "COMPLETED" ? "act" : "wait"}>{order.status}</Badge>
                        </td>
                        <td className="tabular-nums">{money(order.gross_total_pence)}</td>
                        <td>{new Date(order.created_at).toLocaleString("en-GB")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        )}
      </div>
    </AdminShell>
  );
}
