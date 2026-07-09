// Vault Quest — design system preview / living reference (Phase 2).
// Composes every component so the set is type-checked together and the founder
// can view it in-app. Not yet wired to a route (additive, zero-risk) — wire to
// e.g. /admin/vault-quest/design-system when ready.
import { useState } from "react";
import {
  VQPage,
  VQPanel,
  VQButton,
  VQField,
  VQInput,
  VQSelect,
  VQTextarea,
  VQTabs,
  VQSearchBar,
  VQElementBadge,
  VQRarityBadge,
  VQStatusBadge,
  VQEmptyState,
  VQLoading,
  VQError,
  VQPlaytestBadge,
  VQ_ELEMENTS,
} from "./index";

const RARITIES = ["C", "U", "R", "SR", "GR", "UR"];

export default function DesignSystemPreview() {
  const [tab, setTab] = useState("buttons");
  const [search, setSearch] = useState("");

  return (
    <VQPage
      nav={[
        { href: "#", label: "Learn" },
        { href: "#", label: "Rules" },
        { href: "#", label: "Cards" },
      ]}
      active="Cards"
    >
      <div className="vq-stack">
        <div className="vq-row">
          <h1 className="vq-header__wordmark" style={{ fontSize: "var(--vq-text-3xl)" }}>
            Design system
          </h1>
          <VQPlaytestBadge version="v0.1" />
        </div>

        <VQTabs
          onNavy
          value={tab}
          onChange={setTab}
          tabs={[
            { id: "buttons", label: "Buttons" },
            { id: "forms", label: "Forms" },
            { id: "badges", label: "Badges" },
            { id: "states", label: "States" },
          ]}
        />

        <div className="vq-grid">
          <VQPanel title="Buttons" subtitle="Navy primary; gold is premium-only.">
            <div className="vq-row">
              <VQButton variant="primary">Primary</VQButton>
              <VQButton variant="secondary">Secondary</VQButton>
              <VQButton variant="ghost">Ghost</VQButton>
              <VQButton variant="premium">Premium</VQButton>
              <VQButton variant="primary" disabled>
                Disabled
              </VQButton>
            </div>
          </VQPanel>

          <VQPanel title="Forms" subtitle="White/silver UI, neon focus ring.">
            <div className="vq-stack">
              <VQSearchBar value={search} onChange={setSearch} placeholder="Search cards" />
              <VQField label="Card name" htmlFor="dsp-name">
                <VQInput id="dsp-name" placeholder="Flammi" />
              </VQField>
              <VQField label="Element" htmlFor="dsp-el">
                <VQSelect id="dsp-el" defaultValue="Flame">
                  {VQ_ELEMENTS.map((e) => (
                    <option key={e}>{e}</option>
                  ))}
                </VQSelect>
              </VQField>
              <VQField label="Notes" htmlFor="dsp-notes">
                <VQTextarea id="dsp-notes" placeholder="Playtest notes" />
              </VQField>
            </div>
          </VQPanel>

          <VQPanel title="Element badges" subtitle="Card-face palette (exempt from navy).">
            <div className="vq-row">
              {VQ_ELEMENTS.map((e) => (
                <VQElementBadge key={e} element={e} />
              ))}
            </div>
          </VQPanel>

          <VQPanel title="Rarity + status" subtitle="Gold only on SR/GR/UR.">
            <div className="vq-row" style={{ marginBottom: "var(--vq-space-3)" }}>
              {RARITIES.map((r) => (
                <VQRarityBadge key={r} rarity={r} />
              ))}
            </div>
            <div className="vq-row">
              <VQStatusBadge status="draft" />
              <VQStatusBadge status="approved" />
              <VQStatusBadge status="published" />
            </div>
          </VQPanel>

          <VQPanel title="Loading">
            <VQLoading label="Rendering card" />
          </VQPanel>

          <VQPanel title="Empty">
            <VQEmptyState
              title="No cards yet"
              message="Approved cards will appear here."
              action={<VQButton variant="primary">New card</VQButton>}
            />
          </VQPanel>

          <VQPanel title="Error">
            <VQError message="Couldn’t load cards. Try again." action={<VQButton>Retry</VQButton>} />
          </VQPanel>

          <VQPanel variant="navy" title="Navy panel" subtitle="For dark surfaces.">
            <p style={{ fontSize: "var(--vq-text-sm)", margin: 0 }}>
              Panels come in white (default) and navy.
            </p>
          </VQPanel>
        </div>
      </div>
    </VQPage>
  );
}
