# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20.20.2-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS builder

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
# Secondary privacy guard: CI plants content-free sentinels in these paths before
# the real image build. `.dockerignore` is the egress boundary; this guard proves
# its result and fails before compilation or a forbidden path reaches an image layer.
RUN set -eu; \
    for path in \
      .local .agents .codex .cursor .gemini .windsurf .replit \
      .engineering engineering .github .husky tests \
      attached_assets uploads graphify-out .graphify \
      mintvault-scans .mintvault-scanner-tools scans scanner-data \
      scanner-output scanner-runtime evidence runtime-evidence backups; do \
      if [ -e "$path" ]; then \
        echo "Forbidden Docker build-context path was copied: $path" >&2; \
        exit 1; \
      fi; \
    done; \
    leaked_root_file="$(find . -maxdepth 1 -type f \( \
      -name '.env*' -o -name '.npmrc' -o -name '.netrc' \
      -o -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' \
      -o -name '*.dump' -o -name '*.backup' -o -name '*.sqlite' -o -name '*.sqlite3' \
      -o -name '*.tif' -o -name '*.tiff' -o -name '*.raw' -o -name '*.dng' \
      -o -name '*.heic' -o -name '*.heif' \
    \) -print -quit)"; \
    if [ -n "$leaked_root_file" ]; then \
      echo "Forbidden Docker build-context file was copied: $leaked_root_file" >&2; \
      exit 1; \
    fi; \
    leaked_nested="$(find client server shared script scripts content migrations migrations-vq \
      \( -type d \( -name '.local' -o -name '.agents' -o -name '.codex' \
        -o -name '.cursor' -o -name '.gemini' -o -name '.windsurf' \) \
      -o -type f \( -name '.env*' -o -name '*.pem' -o -name '*.key' \
        -o -name '*.p12' -o -name '*.pfx' -o -name '*.dump' -o -name '*.backup' \
        -o -name '*.sqlite' -o -name '*.sqlite3' -o -name '*.tif' -o -name '*.tiff' \
        -o -name '*.raw' -o -name '*.dng' -o -name '*.heic' -o -name '*.heif' \) \
      \) -print -quit)"; \
    if [ -n "$leaked_nested" ]; then \
      echo "Forbidden nested Docker build-context artifact was copied: $leaked_nested" >&2; \
      exit 1; \
    fi
# GIT_SHA passed by the deploy (fly deploy --build-arg GIT_SHA=$(git rev-parse
# HEAD)). .git is dockerignored, so the build can't read it directly —
# this hands the committed SHA to script/build.ts, which embeds it so
# /api/version can prove which commit is live. Production builds must receive
# this explicitly: script/build.ts refuses to create an artifact with unknown
# provenance when the checkout is absent from the Docker context.
ARG GIT_SHA
ENV GIT_SHA=$GIT_SHA
# The builder intentionally has access to dev dependencies. This marker keeps
# provenance fail-closed without changing npm's install mode.
ENV BUILD_PROVENANCE_REQUIRED=1
# This is a Vite compile-time flag, not a runtime secret.  Keep the default
# fail-closed so an ordinary deploy preserves the legacy Partner admin surface.
ARG VITE_PARTNER_NETWORK_CONSOLIDATION=false
ENV VITE_PARTNER_NETWORK_CONSOLIDATION=$VITE_PARTNER_NETWORK_CONSOLIDATION
RUN npm run build

# CI uses this named stage to create the disposable release-readiness database
# from the same shared/schema.ts authority that produced the application. It is
# never shipped; keeping it before the prune preserves drizzle-kit only here.
FROM builder AS schema-tool

# The production stage must not inherit compilers, test runners, or other
# development-only packages merely because native dependencies were compiled in
# the builder. Derive a separate tree so `schema-tool` remains authoritative.
FROM builder AS production-dependencies
RUN npm prune --omit=dev && npm cache clean --force

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:20.20.2-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS production

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

# Copy production-only node_modules (including the compiled canvas binary), built app, brand assets,
# runtime legal content, and the numbered migration inventory needed by the one-off runner.
COPY --from=production-dependencies /app/package.json /app/package-lock.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/dist ./dist
COPY --from=production-dependencies /app/public ./public
COPY --from=production-dependencies /app/content/legal ./content/legal
COPY --from=production-dependencies /app/migrations/[0-9][0-9][0-9][0-9]*_*.sql ./migrations/
# Lineage exclusion declarations — the runner consults these at the identity guard; without
# them a staging-lineage host fails closed on the three declared collisions.
COPY --from=production-dependencies /app/migrations/lineage-exclusions.json ./migrations/

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000
# The application is immutable at runtime. The base image's built-in `node`
# account can read the root-owned bundle and dependencies, cannot modify /app,
# and retains access to the ordinary writable /tmp scratch boundary.
USER node
CMD ["node", "dist/index.cjs"]
