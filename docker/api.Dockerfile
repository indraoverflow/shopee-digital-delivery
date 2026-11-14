# syntax=docker/dockerfile:1
# One image for the API and the worker: they share every dependency and differ
# only in the command, so two images would double the build for no benefit.

FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV PNPM_CONFIG_STORE_DIR=/pnpm/store
RUN corepack enable
# Keep a blocked postinstall a warning, not a failed install (see .npmrc).
ENV PNPM_CONFIG_STRICT_DEP_BUILDS=false

WORKDIR /app

# Manifests first so the install layer survives source edits, plus a cache mount so the
# pnpm store survives image rebuilds.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json .npmrc ./
COPY vendor/shopee-integration/package.json ./vendor/shopee-integration/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/services/package.json ./packages/services/
COPY packages/shopee-adapter/package.json ./packages/shopee-adapter/
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline

# The vendored Shopee client is pinned by commit; the workspace links to it.
COPY vendor ./vendor
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker

RUN pnpm --filter shopee-integration build \
 && pnpm --filter @qansa/api build \
 && pnpm --filter @qansa/worker build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# node_modules stay on disk because the bundles keep runtime deps external.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=build /app/packages/db/drizzle ./migrations
COPY --from=build /app/package.json ./package.json

# Migrations are applied by the api container at start; the folder is copied so
# the image is self-contained.
ENV MIGRATIONS_DIR=/app/migrations
EXPOSE 4000
CMD ["node", "apps/api/dist/server.js"]
