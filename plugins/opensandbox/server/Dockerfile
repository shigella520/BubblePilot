FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY plugins/opensandbox/server ./plugins/opensandbox/server
RUN pnpm install --frozen-lockfile --filter bubblepilot --filter @bubblepilot/opensandbox-mcp...
RUN pnpm --dir plugins/opensandbox/server build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
COPY plugins/opensandbox/server/package.json ./plugins/opensandbox/server/package.json
RUN pnpm install --prod --frozen-lockfile --filter @bubblepilot/opensandbox-mcp...
COPY --from=build /app/plugins/opensandbox/server/dist ./plugins/opensandbox/server/dist
USER node
EXPOSE 8080
CMD ["node", "plugins/opensandbox/server/dist/main.js"]
