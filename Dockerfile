# Single container: the api also serves the login page (WEB_DIST_DIR) and accepts
# the /auth/api/* prefix, so a reverse proxy only needs to forward /auth/ to it.
# Build and runtime share one base image so the Prisma query engine matches.
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Workspace packages are consumed as TS source (loaded by tsx) and migrations
# need the prisma CLI, so the whole workspace ships with its dependencies.
COPY --from=build /app /app
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4020 \
    DATABASE_URL=file:/data/feishu-sso.db \
    WEB_DIST_DIR=/app/web/dist \
    CHECKPOINT_DISABLE=1

USER node
VOLUME /data
EXPOSE 4020
WORKDIR /app/api
ENTRYPOINT ["/usr/bin/tini", "--"]
# Apply pending migrations (no-op when up to date), then start the server.
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && exec node --import tsx dist/index.js"]
