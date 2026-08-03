FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY app ./app
COPY modules ./modules
RUN pnpm build

FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist ./dist
COPY migrations ./migrations

USER node
EXPOSE 8080
CMD ["sh", "-c", "node dist/app/migrate.js && node dist/app/main.js"]
