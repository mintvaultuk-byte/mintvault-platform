/**
 * Super Admin public-listing operations.
 *
 * This is intentionally a thin same-origin client for the existing audited routes. The browser
 * only proposes a status/detail/override; the server resolves the location tenant, validates the
 * lifecycle and coordinate pair, calculates ratings and writes the audit record.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { AdminButton, AdminShell, Badge, Chip, Panel } from "@/components/admin";
import { apiRequest } from "@/lib/queryClient";
import {
  listingReasonValid,
  listingStatusLabel,
  nextListingStatuses,
  parseCoordinatePair,
  publicListingSlugValid,
  ratingOverrideValid,
  type PublicListingStatus,
} from "./partner-public-listings-helpers";

const BASE = "/api/super-admin/partner-listings";
const FILTERS = ["", "DRAFT", "PENDING_REVIEW", "ACTIVE", "PAUSED", "SUSPENDED", "REMOVED"] as const;

type Listing = {
  id: string;
  slug: string;
  public_display_name: string;
  trading_name_snapshot: string | null;
  listing_status: PublicListingStatus;
  tenant_id: string;
  location_id: string;
  tenant_legal_name: string;
  address_line_1: string | null;
  address_line_2: string | null;
  town_city: string | null;
  county: string | null;
  postcode: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  public_phone: string | null;
  public_email: string | null;
  public_website: string | null;
  public_opening_info: string | null;
  public_description: string | null;
  verified_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  public_since: string | null;
  current_public_rating: number | null;
  current_rating_label: string | null;
  current_rating_available: boolean;
  current_sample_size: number;
  current_rating_is_override: boolean;
  current_rating_calculated_at: string | null;
};

type LocationChoice = {
  id: string;
  tenant_id: string;
  name: string;
  address: string | null;
  status: string;
  tenant_legal_name: string;
};

type DetailForm = {
  displayName: string;
  tradingName: string;
  addressLine1: string;
  addressLine2: string;
  townCity: string;
  county: string;
  postcode: string;
  country: string;
  phone: string;
  email: string;
  website: string;
  openingInfo: string;
  description: string;
  latitude: string;
  longitude: string;
};

type RatingInspection = {
  evidence: Record<string, unknown>;
  snapshots: Array<{
    id: string;
    public_rating: number | null;
    rating_label: string | null;
    rating_available: boolean;
    sample_size: number;
    minimum_sample: number;
    calculated_at: string;
  }>;
  overrides: Array<{
    id: string;
    override_public_rating: number | null;
    override_rating_label: string | null;
    reason: string;
    created_by: string;
    created_at: string;
    expires_at: string | null;
    removed_at: string | null;
  }>;
};

function listingForm(row: Listing): DetailForm {
  return {
    displayName: row.public_display_name ?? "",
    tradingName: row.trading_name_snapshot ?? "",
    addressLine1: row.address_line_1 ?? "",
    addressLine2: row.address_line_2 ?? "",
    townCity: row.town_city ?? "",
    county: row.county ?? "",
    postcode: row.postcode ?? "",
    country: row.country ?? "GB",
    phone: row.public_phone ?? "",
    email: row.public_email ?? "",
    website: row.public_website ?? "",
    openingInfo: row.public_opening_info ?? "",
    description: row.public_description ?? "",
    latitude: row.latitude == null ? "" : String(row.latitude),
    longitude: row.longitude == null ? "" : String(row.longitude),
  };
}

function statusVariant(status: string): "act" | "neu" | "prog" | "wait" | "gold" | "red" {
  if (status === "ACTIVE") return "act";
  if (status === "PENDING_REVIEW") return "wait";
  if (status === "PAUSED") return "prog";
  if (status === "SUSPENDED" || status === "REMOVED") return "red";
  return "neu";
}

function errorMessage(err: unknown, fallback = "Public listing operation failed."): string {
  const body = (err as { body?: { error?: { message?: string } | string } })?.body;
  if (typeof body?.error === "object" && body.error?.message) return body.error.message;
  if (typeof body?.error === "string") return body.error;
  return fallback;
}

function fieldValue(event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>, set: (value: string) => void) {
  set(event.target.value);
}

export default function AdminPartnerPublicListingsPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState<DetailForm | null>(null);
  const [draft, setDraft] = useState({ locationId: "", slug: "", displayName: "" });
  const [override, setOverride] = useState({ rating: "", label: "", expiresAt: "", reason: "" });
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/api/admin/session", { credentials: "include" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => live && setAuthed(!!data?.authenticated))
      .catch(() => live && setAuthed(false));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (authed === false) navigate("/admin/login?next=/admin/partner-listings", { replace: true });
  }, [authed, navigate]);

  const enabled = authed === true;
  const listings = useQuery({
    queryKey: [BASE, filter],
    queryFn: () =>
      apiRequest("GET", `${BASE}${filter ? `?status=${encodeURIComponent(filter)}` : ""}`).then((r) => r.json()),
    enabled,
  });
  const locations = useQuery({
    queryKey: [BASE, "locations"],
    queryFn: () => apiRequest("GET", `${BASE}/locations`).then((r) => r.json()),
    enabled,
  });
  const selected = useMemo(
    () => ((listings.data?.rows ?? []) as Listing[]).find((row) => row.id === selectedId) ?? null,
    [listings.data, selectedId]
  );
  const rating = useQuery({
    queryKey: [BASE, selectedId, "rating"],
    queryFn: () => apiRequest("GET", `${BASE}/${selectedId}/rating`).then((r) => r.json() as Promise<RatingInspection>),
    enabled: enabled && !!selectedId,
  });
  const needsAttention = useQuery({
    queryKey: [BASE, "needs-attention"],
    queryFn: () =>
      apiRequest("GET", `${BASE}/needs-attention`).then((r) => r.json() as Promise<{ ratings: unknown[] }>),
    enabled,
  });

  useEffect(() => {
    setDetails(selected ? listingForm(selected) : null);
    setReason("");
    setOverride({ rating: "", label: "", expiresAt: "", reason: "" });
  }, [selectedId, selected]);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: [BASE] });
  }

  const action = useMutation({
    mutationFn: ({ method, path, body }: { method: "POST" | "PUT" | "DELETE"; path: string; body?: unknown }) =>
      apiRequest(method, `${BASE}${path}`, body).then((response) => response.json()),
    onSuccess: () => {
      invalidate();
      setMessage("Listing operation recorded.");
    },
    onError: (error) => setMessage(errorMessage(error)),
  });

  const createDraft = useMutation({
    mutationFn: () => apiRequest("POST", BASE, draft).then((response) => response.json()),
    onSuccess: (created: { id: string }) => {
      invalidate();
      setDraft({ locationId: "", slug: "", displayName: "" });
      setSelectedId(created.id);
      setMessage("Draft listing created and audited.");
    },
    onError: (error) => setMessage(errorMessage(error, "Could not create the draft listing.")),
  });

  const coordinates = details ? parseCoordinatePair(details.latitude, details.longitude) : null;
  const draftReady = !!draft.locationId && publicListingSlugValid(draft.slug) && draft.displayName.trim().length > 0;
  const activeOverride = (rating.data?.overrides ?? []).find((item) => item.removed_at == null) ?? null;

  if (authed === null) {
    return <div data-testid="partner-listings-loading">Loading public listing operations…</div>;
  }

  return (
    <AdminShell
      activeTab="dashboard"
      onTabChange={() => navigate("/admin")}
      onLogout={() => navigate("/admin")}
      title="Public Listings"
      crumb="Partner Network"
    >
      <div data-testid="partner-listings-page" style={{ display: "grid", gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700 }}>Public listings</h1>
          <p style={{ fontSize: 13, opacity: 0.75 }}>
            Super Admin ownership of public identity, address, coordinates, approval and rating exceptions.
          </p>
        </div>
        {message && (
          <div role="status" data-testid="partner-listings-message">
            {message}
          </div>
        )}

        <Panel
          title="Create draft listing"
          sub="Locations are derived by the server; only active, unlisted Partner locations appear."
        >
          {locations.isLoading ? (
            <p>Loading eligible locations…</p>
          ) : (locations.data?.rows ?? []).length === 0 ? (
            <p data-testid="partner-listings-no-locations">No active unlisted Partner locations are available.</p>
          ) : (
            <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))" }}>
              <label>
                Location
                <select
                  value={draft.locationId}
                  onChange={(event) => setDraft((current) => ({ ...current, locationId: event.target.value }))}
                  data-testid="partner-listings-draft-location"
                >
                  <option value="">Choose a location</option>
                  {((locations.data?.rows ?? []) as LocationChoice[]).map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.tenant_legal_name} — {location.name}
                    </option>
                  ))}
                </select>
              </label>
              <TextField
                label="Public slug"
                value={draft.slug}
                onChange={(value) => setDraft((current) => ({ ...current, slug: value.toLowerCase() }))}
                testId="partner-listings-draft-slug"
                hint="Lowercase words separated by single hyphens."
              />
              <TextField
                label="Public display name"
                value={draft.displayName}
                onChange={(value) => setDraft((current) => ({ ...current, displayName: value }))}
                testId="partner-listings-draft-name"
              />
              <div style={{ alignSelf: "end" }}>
                <AdminButton
                  variant="gold"
                  disabled={!draftReady || createDraft.isPending}
                  onClick={() => createDraft.mutate()}
                  data-testid="partner-listings-create-draft"
                >
                  {createDraft.isPending ? "Creating…" : "Create draft"}
                </AdminButton>
              </div>
            </div>
          )}
        </Panel>

        <Panel
          title="Listing queue"
          sub="Only the existing server lifecycle is offered; every status change requires a reason and is audited."
        >
          <div
            style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}
            data-testid="partner-listings-filters"
          >
            {FILTERS.map((value) => (
              <Chip
                key={value || "all"}
                active={filter === value}
                onClick={() => setFilter(value)}
                testId={`partner-listings-filter-${value || "all"}`}
              >
                {value ? listingStatusLabel(value) : "All"}
              </Chip>
            ))}
          </div>
          {listings.isLoading && <p>Loading listings…</p>}
          {listings.error && <p role="alert">{errorMessage(listings.error, "Could not load public listings.")}</p>}
          {!listings.isLoading && (listings.data?.rows ?? []).length === 0 && <p>No listings match this filter.</p>}
          <div style={{ display: "grid", gap: 8 }}>
            {((listings.data?.rows ?? []) as Listing[]).map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => setSelectedId(row.id)}
                data-testid={`partner-listing-${row.id}`}
                style={{
                  textAlign: "left",
                  border:
                    row.id === selectedId ? "1px solid var(--admin-gold, #d4af37)" : "1px solid rgba(255,255,255,.14)",
                  borderRadius: 8,
                  padding: 12,
                  background: "transparent",
                }}
              >
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <strong>{row.public_display_name}</strong>
                  <Badge variant={statusVariant(row.listing_status)}>{listingStatusLabel(row.listing_status)}</Badge>
                  <span style={{ fontSize: 12, opacity: 0.75 }}>{row.tenant_legal_name}</span>
                </div>
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                  /shops/{row.slug} · {row.town_city ?? "No town"} ·{" "}
                  {row.latitude == null ? "No coordinates" : "Coordinates set"}
                </div>
              </button>
            ))}
          </div>
        </Panel>

        <Panel
          title="Needs attention"
          sub="Only failed rating recovery is an exception; ordinary stale ratings remain self-healing."
        >
          {needsAttention.isLoading ? (
            <p>Loading exception queue…</p>
          ) : (
            <p>{(needsAttention.data?.ratings ?? []).length} rating exception(s).</p>
          )}
        </Panel>

        {selected && details && (
          <Panel title={selected.public_display_name} sub={`${selected.tenant_legal_name} · ${selected.id}`}>
            <div style={{ display: "grid", gap: 16 }} data-testid="partner-listing-detail">
              <section>
                <h2 style={{ fontSize: 15, fontWeight: 700 }}>Lifecycle and verification</h2>
                <p style={{ fontSize: 13, opacity: 0.75 }}>
                  Status: {listingStatusLabel(selected.listing_status)} · Verification:{" "}
                  {selected.verified_at ? "verified" : "not verified"}
                </p>
                <label style={{ display: "grid", gap: 4, maxWidth: 620, marginTop: 8 }}>
                  Reason for this listing change
                  <textarea
                    value={reason}
                    onChange={(event) => fieldValue(event, setReason)}
                    maxLength={500}
                    rows={2}
                    data-testid="partner-listing-reason"
                  />
                </label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                  {nextListingStatuses(selected.listing_status).map((status) => (
                    <AdminButton
                      key={status}
                      size="sm"
                      variant={status === "REMOVED" || status === "SUSPENDED" ? "ghost" : "gold"}
                      disabled={!listingReasonValid(reason) || action.isPending}
                      onClick={() =>
                        action.mutate({ method: "POST", path: `/${selected.id}/status`, body: { status, reason } })
                      }
                      data-testid={`partner-listing-status-${status}`}
                    >
                      {listingStatusLabel(status)}
                    </AdminButton>
                  ))}
                  <AdminButton
                    size="sm"
                    variant="ghost"
                    disabled={!listingReasonValid(reason) || action.isPending}
                    onClick={() =>
                      action.mutate({
                        method: "POST",
                        path: `/${selected.id}/verify`,
                        body: { verified: !selected.verified_at, reason },
                      })
                    }
                    data-testid="partner-listing-verify"
                  >
                    {selected.verified_at ? "Remove verification" : "Mark verified"}
                  </AdminButton>
                </div>
              </section>

              <section>
                <h2 style={{ fontSize: 15, fontWeight: 700 }}>Public identity, address and coordinates</h2>
                <p style={{ fontSize: 12, opacity: 0.7 }}>
                  Coordinates must be both present or both absent. The server validates the pair again.
                </p>
                <div
                  style={{
                    display: "grid",
                    gap: 8,
                    gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
                    marginTop: 8,
                  }}
                >
                  <TextField
                    label="Display name"
                    value={details.displayName}
                    onChange={(value) => setDetails({ ...details, displayName: value })}
                    testId="partner-listing-display-name"
                  />
                  <TextField
                    label="Trading name"
                    value={details.tradingName}
                    onChange={(value) => setDetails({ ...details, tradingName: value })}
                    testId="partner-listing-trading-name"
                  />
                  <TextField
                    label="Address line 1"
                    value={details.addressLine1}
                    onChange={(value) => setDetails({ ...details, addressLine1: value })}
                    testId="partner-listing-address-1"
                  />
                  <TextField
                    label="Address line 2"
                    value={details.addressLine2}
                    onChange={(value) => setDetails({ ...details, addressLine2: value })}
                    testId="partner-listing-address-2"
                  />
                  <TextField
                    label="Town / city"
                    value={details.townCity}
                    onChange={(value) => setDetails({ ...details, townCity: value })}
                    testId="partner-listing-town"
                  />
                  <TextField
                    label="County"
                    value={details.county}
                    onChange={(value) => setDetails({ ...details, county: value })}
                    testId="partner-listing-county"
                  />
                  <TextField
                    label="Postcode"
                    value={details.postcode}
                    onChange={(value) => setDetails({ ...details, postcode: value })}
                    testId="partner-listing-postcode"
                  />
                  <TextField
                    label="Country"
                    value={details.country}
                    onChange={(value) => setDetails({ ...details, country: value.toUpperCase() })}
                    testId="partner-listing-country"
                  />
                  <TextField
                    label="Latitude"
                    value={details.latitude}
                    onChange={(value) => setDetails({ ...details, latitude: value })}
                    testId="partner-listing-latitude"
                  />
                  <TextField
                    label="Longitude"
                    value={details.longitude}
                    onChange={(value) => setDetails({ ...details, longitude: value })}
                    testId="partner-listing-longitude"
                  />
                  <TextField
                    label="Public phone"
                    value={details.phone}
                    onChange={(value) => setDetails({ ...details, phone: value })}
                    testId="partner-listing-phone"
                  />
                  <TextField
                    label="Public email"
                    value={details.email}
                    onChange={(value) => setDetails({ ...details, email: value })}
                    testId="partner-listing-email"
                  />
                  <TextField
                    label="Public website"
                    value={details.website}
                    onChange={(value) => setDetails({ ...details, website: value })}
                    testId="partner-listing-website"
                  />
                  <TextField
                    label="Opening information"
                    value={details.openingInfo}
                    onChange={(value) => setDetails({ ...details, openingInfo: value })}
                    testId="partner-listing-opening-info"
                  />
                </div>
                <label style={{ display: "grid", gap: 4, marginTop: 8 }}>
                  Public description
                  <textarea
                    value={details.description}
                    onChange={(event) => fieldValue(event, (value) => setDetails({ ...details, description: value }))}
                    maxLength={500}
                    rows={3}
                    data-testid="partner-listing-description"
                  />
                </label>
                {!coordinates && <p role="alert">Enter both latitude and longitude, or clear both coordinates.</p>}
                <div style={{ marginTop: 8 }}>
                  <AdminButton
                    size="sm"
                    variant="gold"
                    disabled={!listingReasonValid(reason) || !coordinates || action.isPending}
                    onClick={() =>
                      action.mutate({
                        method: "PUT",
                        path: `/${selected.id}/public-details`,
                        body: { ...details, ...coordinates, reason },
                      })
                    }
                    data-testid="partner-listing-save-details"
                  >
                    Save public details
                  </AdminButton>
                </div>
              </section>

              <section>
                <h2 style={{ fontSize: 15, fontWeight: 700 }}>Rating inspection and exception</h2>
                <p style={{ fontSize: 13, opacity: 0.75 }}>
                  Current:{" "}
                  {selected.current_rating_available
                    ? `${selected.current_public_rating ?? "—"} ${selected.current_rating_label ?? ""}`
                    : "Rating building"}{" "}
                  · Sample {selected.current_sample_size}
                  {selected.current_rating_is_override ? " · active override" : ""}
                </p>
                {rating.isLoading ? <p>Loading rating evidence…</p> : <RatingInspectionView data={rating.data} />}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                  <AdminButton
                    size="sm"
                    variant="ghost"
                    disabled={action.isPending}
                    onClick={() => action.mutate({ method: "POST", path: `/${selected.id}/rating/recalculate` })}
                    data-testid="partner-listing-recalculate-rating"
                  >
                    Recalculate rating
                  </AdminButton>
                  {activeOverride && (
                    <AdminButton
                      size="sm"
                      variant="ghost"
                      disabled={!listingReasonValid(override.reason) || action.isPending}
                      onClick={() =>
                        action.mutate({
                          method: "DELETE",
                          path: `/${selected.id}/rating/override`,
                          body: { reason: override.reason },
                        })
                      }
                      data-testid="partner-listing-remove-override"
                    >
                      Remove active override
                    </AdminButton>
                  )}
                </div>
                <div
                  style={{
                    display: "grid",
                    gap: 8,
                    gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
                    marginTop: 12,
                  }}
                >
                  <TextField
                    label="Override rating (0–5)"
                    value={override.rating}
                    onChange={(value) => setOverride({ ...override, rating: value })}
                    testId="partner-listing-override-rating"
                  />
                  <TextField
                    label="Override label"
                    value={override.label}
                    onChange={(value) => setOverride({ ...override, label: value })}
                    testId="partner-listing-override-label"
                  />
                  <TextField
                    label="Override expiry (optional)"
                    value={override.expiresAt}
                    onChange={(value) => setOverride({ ...override, expiresAt: value })}
                    testId="partner-listing-override-expiry"
                    type="datetime-local"
                  />
                  <TextField
                    label="Override reason"
                    value={override.reason}
                    onChange={(value) => setOverride({ ...override, reason: value })}
                    testId="partner-listing-override-reason"
                  />
                </div>
                <div style={{ marginTop: 8 }}>
                  <AdminButton
                    size="sm"
                    variant="gold"
                    disabled={
                      !ratingOverrideValid(override.rating, override.label, override.reason) || action.isPending
                    }
                    onClick={() =>
                      action.mutate({
                        method: "POST",
                        path: `/${selected.id}/rating/override`,
                        body: {
                          rating: override.rating.trim() ? Number(override.rating) : undefined,
                          label: override.label.trim() || undefined,
                          expiresAt: override.expiresAt || undefined,
                          reason: override.reason,
                        },
                      })
                    }
                    data-testid="partner-listing-create-override"
                  >
                    Create rating override
                  </AdminButton>
                </div>
              </section>
            </div>
          </Panel>
        )}
      </div>
    </AdminShell>
  );
}

function RatingInspectionView({ data }: { data: RatingInspection | undefined }) {
  if (!data) return null;
  const latest = data.snapshots[0] ?? null;
  return (
    <div data-testid="partner-listing-rating-inspection" style={{ fontSize: 12, opacity: 0.8 }}>
      <div>
        Latest computed snapshot:{" "}
        {latest ? `${latest.public_rating ?? "—"} · sample ${latest.sample_size}/${latest.minimum_sample}` : "None yet"}
      </div>
      <div>Rating overrides: {(data.overrides ?? []).filter((item) => item.removed_at == null).length} active</div>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  testId,
  hint,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  testId: string;
  hint?: string;
  type?: string;
}) {
  return (
    <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
      {label}
      <input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        data-testid={testId}
        maxLength={500}
      />
      {hint && <span style={{ opacity: 0.65 }}>{hint}</span>}
    </label>
  );
}
