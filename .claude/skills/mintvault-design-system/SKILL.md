---
name: mintvault-design-system
description: Use this skill whenever building or editing any MintVault page, component, or UI element — marketing pages (home, pricing, AI Pre-Grade, Vault Club, Verify, SEO landing, journal), transactional pages (submit wizard, logbook, pop report, auth, checkout), or admin tooling. Covers the two-layer system — universal foundation (tokens, header, footer, buttons, forms, cards) applied everywhere, and editorial chrome (Fraunces display, Roman numeral markers, gradient slabs, outlined dark panels) applied to customer-facing surfaces only. Not used for Tiny Legends Ranch, Apex Digital Co, or Concrete Driveways Last — those are separate brands.
---

# mintvault-design-system

## When to apply

**Always (Layer A — Universal foundation):**
- All new MintVault pages, regardless of surface
- Every form input, button, link, card, table
- Every header and footer instance
- Every color, font, and spacing decision
- Admin tools share these tokens — no separate admin palette

**Sometimes (Layer B — Editorial chrome):**
- Marketing pages: Home, Pricing, AI Pre-Grade, Vault Club, Verify, Journal, SEO landing pages → apply editorial chrome
- Customer-facing read surfaces: Pop Report, Logbook → apply editorial chrome
- Task surfaces: Submit wizard steps (not the intro), checkout, auth, admin grading → foundation only, no editorial chrome

---

## Layer A — Universal foundation

### Tokens — use only these, never hardcode

All tokens live in `client/src/styles/v2-tokens.css`. Reference via CSS custom properties: `var(--v2-gold)`. Never hardcode hex anywhere in components.

**Ink (text on paper):**
- `--v2-ink` `#0F0E0B` — primary headings, body text
- `--v2-ink-soft` `#3A362E` — secondary text, nav links
- `--v2-ink-mute` `#6B6454` — tertiary / meta text, labels

**Paper (surfaces):**
- `--v2-paper` `#FAF7F1` — default page background
- `--v2-paper-raised` `#FFFFFF` — elevated cards, slabs
- `--v2-paper-sunk` `#F4F0E6` — footers, section subtitle backgrounds

**Lines:**
- `--v2-line` `#E8E1D0` — default 1px border
- `--v2-line-soft` `#EFE9DA` — whisper-quiet dividers

**Gold:**
- `--v2-gold` `#B8960C` — primary gold, key CTAs, accent text
- `--v2-gold-soft` `#D4AF37` — outlined borders, decorative gold
- `--v2-gold-dark` `#8A6F08` — hover states, muted gold on paper

**Dark panels:**
- `--v2-panel-dark` `#1A1612` — primary dark section fill
- `--v2-panel-dark-soft` `#2A241C` — secondary dark surface

### Fonts

- **Display** (`--v2-font-display`) — Fraunces, italic for display; reserved for editorial chrome sections only (Layer B)
- **Body** (`--v2-font-body`) — Geist Variable, used for everything: nav, body copy, UI labels, buttons
- **Mono** (`--v2-font-mono`) — JetBrains Mono, used for data (grades, cert numbers, ticker values, turnaround labels, eyebrow markers)

Tailwind classes: `font-display`, `font-body`, `font-mono-v2`.

### Type scale

Use the `--v2-text-*` scale (xs → 7xl). No inline px values except where explicitly dictated by a component spec. Ranges:

- **Display** (7xl–4xl): Fraunces italic, Layer B only
- **Headings** (3xl–xl): Geist, weight 500–600
- **Body** (lg, base, sm): Geist, weight 400
- **Meta / data** (xs): Mono or Geist, depending on context

### Spacing

- `--v2-space-section` `8rem` — default section vertical padding (desktop)
- `--v2-space-section-sm` `5rem` — mobile section padding

Follow Tailwind's 4px grid for all other spacing. No custom spacing unless it's in the tokens.

### Shadows — banned except for two cases

**Outlines only, not shadows.** Separation is achieved with `1px solid var(--v2-line)` or `--v2-gold-soft` at various opacities, or with dark panel fills.

Exceptions:
1. **Modals and dropdowns** — use a single standard shadow (`box-shadow: 0 20px 40px -12px rgba(15,14,11,0.25)`)
2. **Interactive hover affordance on slabs/cards** — subtle shadow on hover only, not baseline

### Border radius

- `rounded-sm` `3px` — tight elements (badges, pills)
- `rounded-md` `6px` — inputs, small cards
- `rounded-lg` `9px` — standard cards, panels
- `rounded-full` — pill buttons, circular badges

### Buttons — 4 canonical variants, no others

**Variant 1: Dark pill**
- Background: `var(--v2-ink)`, Color: `var(--v2-paper)`
- Padding: `px-5 py-2`, `rounded-full`, `font-body font-semibold text-sm`
- Use: primary CTA in light-background contexts (e.g. header "Submit a card")
- Hover: darken to `#000` or add subtle opacity

**Variant 2: Gold filled**
- Background: `var(--v2-gold)`, Color: `var(--v2-ink)`
- Padding: `px-5 py-2`, `rounded-full`, `font-body font-semibold text-sm`
- Use: featured tier CTAs on dark panels (e.g. Standard tier "Start a submission")
- Hover: shift to `var(--v2-gold-soft)`

**Variant 3: Gold outlined**
- Background: transparent, Border: `1px solid var(--v2-gold-soft)` at 60% opacity
- Color: `var(--v2-gold-soft)`, padding/size same as above
- Use: secondary tier CTAs on dark panels (Vault Queue, Express)
- Hover: border to 100% opacity + subtle gold fill 5% opacity

**Variant 4: Text link with arrow**
- No background, no border
- Color: `var(--v2-gold)` or `var(--v2-ink)` depending on ground
- `inline-flex items-center gap-1 font-body text-sm`, followed by a lucide `ArrowRight` or `ArrowUpRight` at 14px
- Use: inline CTAs ("Try it now →", "View all benefits →")
- Hover: underline

**Never invent a fifth variant.** If you want a new button treatment, it must be added to this skill and the tokens first, with a specific named variant.

### Form inputs

**Text input:**
- Border `1px solid var(--v2-line)`, radius `rounded-md`, padding `px-4 py-2.5`
- Background `var(--v2-paper-raised)`, text `var(--v2-ink)`
- Placeholder `var(--v2-ink-mute)`
- Focus: border `var(--v2-gold)`, no glow/shadow ring — outline discipline

**Select, textarea, checkbox, radio:** inherit the same token palette, same 1px borders, same focus treatment.

**Labels:** `font-body text-xs font-semibold uppercase tracking-widest text-[var(--v2-ink-mute)] mb-2`.

### Cards

**Default card on light ground:**
- Background `var(--v2-paper-raised)`
- Border `1px solid var(--v2-line)`
- Radius `rounded-lg`
- Padding `p-8` (adjust per density needs)
- No shadow at rest

**Card on dark panel:**
- Background `transparent` or `var(--v2-panel-dark-soft)` if elevation needed
- Border `1px solid rgba(212, 175, 55, 0.25)` (gold at low opacity)
- Radius `rounded-lg`
- Emphasis variant: border opacity `0.6`

### Header and footer

Use `<HeaderV2 />` and `<FooterV2 />` from `client/src/components/v2/`. Do not rebuild. If you need a variant (e.g. logged-in state), extend the component with a prop — do not fork.

Footer contact email is canonical at `support@mintvaultuk.com` — any other email in the codebase is stale and must be updated when touched.

---

## Layer B — Editorial chrome (marketing & public-read surfaces only)

### When to apply
Home, Pricing, AI Pre-Grade, Vault Club, Verify, Journal, SEO landing pages, Pop Report, Logbook. Nothing else.

### Section markers
Roman numeral + middot + label, in mono at meta size.

Tailwind: `font-mono-v2 text-sm tracking-widest text-[var(--v2-gold)] uppercase`.

### Display headlines
Fraunces italic at 5xl–7xl on desktop, scaled on mobile. Example:

```jsx
<h1 className="font-display italic text-5xl md:text-7xl leading-[1.05] text-[var(--v2-ink)]">
  The standard for <span className="text-[var(--v2-gold)]">graded</span> collectibles.
</h1>
```

Gold-emphasised words inside display headlines use `var(--v2-gold)` with italic preserved.

### Eyebrow labels
`EST. KENT · MINTVAULT UK` style — mono, uppercase, gold, letter-spaced.

Tailwind: `font-mono-v2 text-xs tracking-[0.2em] text-[var(--v2-gold)] uppercase`.

### Dark panels
Section fill `var(--v2-panel-dark)`. Use for Pricing tier panel, final CTAs, data-density sections. Text in dark panels: primary `#E8E4DC` or `var(--v2-paper)`, mute `rgba(255,255,255,0.5)`.

### Outlined tier cards on dark panels
See Card on dark panel spec above. Featured/emphasis card gets the stronger 0.6 opacity border.

### Ticker / data strips (Bloomberg-terminal aesthetic)
Horizontal scrolling mono strip, gold value on dark, separated by middots:

Use the existing `animate-marquee` keyframe. 30s linear infinite.

### Gradient slabs (hero illustration)
Canonical hero visual for marketing pages. Stack of 3 rotated slabs pulling live data from `/api/v2/homepage-stats` → `recent_certs`. Each slab has: top-right mono gold pill with `MV[number]`, central display field with moody radial-gradient (deep navy → petrol blue → muted teal-green → warm bronze edge) and faded MintVault monogram at 20% opacity, bottom panel with card name (Geist) and grade (JetBrains Mono, gold). No card artwork — generic moody gradient + monogram only, per IP discipline. Rotations: slab 1 -8deg, slab 2 +4deg, slab 3 -2deg. Responsive width via `clamp(120px, 40vw, 220px)`.

---

## Anti-patterns — things that WILL break the system

1. **Hardcoding hex colors** anywhere in a component. Every color must resolve through `var(--v2-*)`. If a shade is missing, add it to tokens with a comment.
2. **Custom shadows as baseline elevation.** Outlines do the work. Shadows only on modals, dropdowns, and hover states.
3. **Fraunces italic in forms, admin UI, or transactional steps.** Editorial chrome does not belong on task surfaces.
4. **Inventing a 5th button variant.** Four variants is the contract.
5. **Porting Claude Design mockup content verbatim.** Mockups contain fabricated data (Hatton Garden, fake cert numbers, fake stats, fake press). Always substitute with real data from `/api/v2/homepage-stats` or flagged placeholders before merge.
6. **Cross-brand references.** MintVault, Tiny Legends Ranch, Apex Digital Co, Concrete Driveways Last are separate universes. Never cross them.
7. **Adding a new third-party font.** Fraunces, Geist, JetBrains Mono. Full stop.
8. **Using TCG card artwork without legal sign-off.** Pokémon Company IP is not ours. Post-launch conversation.

---

## Responsive breakpoints

Tailwind defaults:
- `sm` 640px — large phones
- `md` 768px — tablet / small laptop — **primary desktop/mobile split for MintVault**
- `lg` 1024px — standard laptop
- `xl` 1280px — large desktop

Mobile-first. Specify mobile styles as defaults, override upward with `md:` etc. Use `clamp()` for fluid sizing where breakpoint-hopping would be jarring (see slab width).

---

## Pop Registry / data tables

- Header row: `font-mono-v2 text-xs uppercase tracking-widest text-[var(--v2-ink-mute)]`
- Cells: `font-body text-sm text-[var(--v2-ink)]`
- Cert numbers: `font-mono-v2 text-sm text-[var(--v2-gold)]`
- Row divider: `border-b border-[var(--v2-line)]`
- Mobile: hide low-priority columns with `hidden md:table-cell`, never horizontal-scroll unless unavoidable

---

## Admin UI guidance (Foundation only)

Admin pages use Layer A tokens and components. They do **not** use:
- Fraunces italic display headlines
- Roman numeral section markers
- Editorial gradient slabs
- Eyebrow labels with tracking

They **do** use:
- v2 tokens (colors, spacing, radii)
- Geist + JetBrains Mono fonts
- HeaderV2 (possibly a compact admin variant) and FooterV2
- The 4 button variants
- Form input styles
- Default card styles with minimal padding

Density priority: admin tables, grading panels, and dashboards should prioritize information density and scanability over breathing room. `p-4` over `p-8`. `text-sm` over `text-base`. Inline status chips instead of full bordered badges.

---

## When to extend this skill

Extend only when:
- A new token is genuinely needed (e.g. a new neutral for a data visualization)
- A new component pattern emerges that's reused 3+ times (promote to the skill before the 4th use)
- A new page category appears that doesn't fit marketing/transactional/admin

Every extension needs: rationale, token name, usage example, anti-pattern warning. Added to this file + to `v2-tokens.css`. Commit to `feat/v2-redesign` with message prefix `ds:`.

---

## Pre-commit checklist for any new page

- [ ] Every color resolves to a `--v2-*` token (grep for `#` in your diff — should return near zero)
- [ ] Fonts use `font-display`, `font-body`, or `font-mono-v2` — never raw `font-family`
- [ ] Buttons match one of the 4 variants — no new styles
- [ ] Live data from API endpoints — no hardcoded stats, cert numbers, locations, or testimonials
- [ ] Header and footer are the shared components, not custom
- [ ] Contact references `support@mintvaultuk.com`
- [ ] Layer B chrome applied only if page is marketing/public-read
- [ ] Mobile tested at 390px viewport, desktop at 1440px
- [ ] Type checks pass (`npm run check`)
- [ ] Deploy verified (200 response, data correct)

---

**End of skill.**
