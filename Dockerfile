FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
COPY plugins/opensandbox/server/package.json ./plugins/opensandbox/server/package.json
RUN pnpm install --frozen-lockfile --filter bubblepilot --filter ./apps/web
COPY tsconfig.json tsconfig.build.json ./
COPY app ./app
COPY modules ./modules
COPY assets ./assets
COPY apps/web ./apps/web
RUN pnpm build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
COPY plugins/opensandbox/server/package.json ./plugins/opensandbox/server/package.json
RUN pnpm install --prod --frozen-lockfile --filter bubblepilot --filter ./apps/web
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/web/dist ./public
COPY migrations ./migrations
COPY scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
RUN apk add --no-cache git
RUN chmod 0555 ./scripts/docker-entrypoint.sh && mkdir -p /app/data/memes /app/data/plugins && chown -R node:node /app/data

USER node
RUN node --input-type=module -e "await import('./dist/modules/plugins/plugin-service.js'); await import('./dist/modules/plugins/plugin-session.js');"
EXPOSE 8080
ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
