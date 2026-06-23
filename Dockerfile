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

# Copy compiled node_modules (includes native canvas binary), built app, and brand assets
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public

ENV NODE_ENV=production
ENV PORT=5000

# Drop root: run as the built-in unprivileged `node` user. chown so the app
# keeps read/write access to /app (image processing may write temp files).
RUN chown -R node:node /app
USER node

EXPOSE 5000

# Liveness via node itself (no curl/wget in the slim image). Hits the in-process
# /health route, which never touches the DB.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:5000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.cjs"]
