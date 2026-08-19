# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

# System libs required to compile canvas and sharp native modules
RUN apt-get update && apt-get install -y \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    libvips-dev \
    pkg-config \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
# GIT_SHA passed by the deploy (fly deploy --build-arg GIT_SHA=$(git rev-parse
# --short HEAD)). .git is dockerignored, so the build can't read it directly —
# this hands the committed SHA to script/build.ts, which embeds it so
# /api/version can prove which commit is live. Defaults to "unknown".
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA
# This is a Vite compile-time flag, not a runtime secret.  Keep the default
# fail-closed so an ordinary deploy preserves the legacy Partner admin surface.
ARG VITE_PARTNER_NETWORK_CONSOLIDATION=false
ENV VITE_PARTNER_NETWORK_CONSOLIDATION=$VITE_PARTNER_NETWORK_CONSOLIDATION
RUN npm run build

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:20-slim AS production

# Runtime libs for canvas (label/PDF generation) and sharp (image processing)
RUN apt-get update && apt-get install -y \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libjpeg62-turbo \
    libgif7 \
    librsvg2-2 \
    libvips \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy compiled node_modules (includes native canvas binary), built app, brand assets,
# and the numbered migration inventory needed by the one-off runner.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/migrations/[0-9][0-9][0-9][0-9]*_*.sql ./migrations/
# Lineage exclusion declarations — the runner consults these at the identity guard; without
# them a staging-lineage host fails closed on the three declared collisions.
COPY --from=builder /app/migrations/lineage-exclusions.json ./migrations/

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000
CMD ["node", "dist/index.cjs"]
