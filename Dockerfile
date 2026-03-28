# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

# System libs required to compile the canvas native module
RUN apt-get update && apt-get install -y \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    pkg-config \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:20-slim AS production

# Runtime libs for canvas (label/PDF generation)
RUN apt-get update && apt-get install -y \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libjpeg62-turbo \
    libgif7 \
    librsvg2-2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy compiled node_modules (includes native canvas binary), built app, and brand assets
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000
CMD ["node", "dist/index.cjs"]
