# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# A pinned store directory is what makes the cache mount below useful: without it pnpm
# writes to ~/.local/share and every build starts from an empty store.
ENV PNPM_CONFIG_STORE_DIR=/pnpm/store
RUN corepack enable
# Keep a blocked postinstall a warning, not a failed install (see .npmrc).
ENV PNPM_CONFIG_STRICT_DEP_BUILDS=false
WORKDIR /app

# Manifests first, sources later. When the whole tree was copied before installing, any
# edit under apps/ or packages/ invalidated the install layer and cost about ninety
# seconds for a dependency set that rarely changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json .npmrc ./
COPY vendor/shopee-integration/package.json ./vendor/shopee-integration/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY packages/services/package.json ./packages/services/
COPY packages/shopee-adapter/package.json ./packages/shopee-adapter/
COPY apps/web/package.json ./apps/web/

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline

COPY vendor ./vendor
COPY packages ./packages
COPY apps/web ./apps/web

RUN pnpm --filter shopee-integration build
RUN NEXT_TELEMETRY_DISABLED=1 pnpm --filter @qansa/web build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# The standalone output already carries its own node_modules and server.js.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public

ENV PORT=3000
# Next's standalone server binds to $HOSTNAME when it is set; Docker sets it to
# the container id, which makes 127.0.0.1 health checks fail.
ENV HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
