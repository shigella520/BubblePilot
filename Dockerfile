FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile
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
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/web/dist ./public
COPY migrations ./migrations
COPY scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
RUN chmod 0555 ./scripts/docker-entrypoint.sh

USER node
EXPOSE 8080
ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
