# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
# Keep a blocked postinstall a warning, not a failed install (see .npmrc).
ENV PNPM_CONFIG_STRICT_DEP_BUILDS=false
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json .npmrc ./
COPY vendor ./vendor
COPY packages ./packages
COPY apps/web ./apps/web

RUN pnpm install --frozen-lockfile
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
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
