FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY patches ./patches
COPY apps/web/package.json ./apps/web/package.json
COPY plugins/opensandbox/server/package.json ./plugins/opensandbox/server/package.json
COPY plugins/image-gen/server ./plugins/image-gen/server
RUN pnpm install --frozen-lockfile --filter @bubblepilot/image-gen-mcp...
RUN pnpm --dir plugins/image-gen/server build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY apps/web/package.json ./apps/web/package.json
COPY plugins/opensandbox/server/package.json ./plugins/opensandbox/server/package.json
COPY plugins/image-gen/server/package.json ./plugins/image-gen/server/package.json
RUN pnpm install --prod --frozen-lockfile --filter @bubblepilot/image-gen-mcp...
COPY --from=build /app/plugins/image-gen/server/dist ./plugins/image-gen/server/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8081/healthz || exit 1
CMD ["node", "plugins/image-gen/server/dist/main.js"]
