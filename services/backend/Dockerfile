ARG NODE_VERSION=24.18.0

FROM node:${NODE_VERSION}-bookworm-slim AS toolchain

ARG PNPM_VERSION=11.9.0

RUN corepack enable pnpm \
    && corepack install --global pnpm@${PNPM_VERSION}

WORKDIR /workspace

FROM toolchain AS build-dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY services/backend/package.json services/backend/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/game-engine/package.json packages/game-engine/package.json

RUN pnpm install --frozen-lockfile

FROM build-dependencies AS build

COPY tsconfig.base.json tsconfig.json ./
COPY services/backend/tsconfig.json services/backend/tsconfig.json
COPY packages/config/tsconfig.json packages/config/tsconfig.json
COPY packages/domain/tsconfig.json packages/domain/tsconfig.json
COPY packages/game-engine/tsconfig.json packages/game-engine/tsconfig.json
COPY services/backend/src services/backend/src
COPY packages/config/src packages/config/src
COPY packages/domain/src packages/domain/src
COPY packages/game-engine/src packages/game-engine/src

RUN pnpm --filter @project-booth/backend build

FROM toolchain AS production-dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY services/backend/package.json services/backend/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/game-engine/package.json packages/game-engine/package.json

RUN pnpm install --prod --frozen-lockfile

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="Project Booth Backend"
LABEL org.opencontainers.image.description="Project Booth API and worker runtime"

ENV HOST=0.0.0.0 \
    LOG_LEVEL=info \
    NODE_ENV=production \
    PORT=3000

WORKDIR /app

COPY --chown=node:node --from=production-dependencies /workspace/node_modules ./node_modules
COPY --chown=node:node --from=production-dependencies /workspace/services/backend/node_modules ./services/backend/node_modules
COPY --chown=node:node --from=production-dependencies /workspace/packages/config/node_modules ./packages/config/node_modules
COPY --chown=node:node --from=production-dependencies /workspace/packages/game-engine/node_modules ./packages/game-engine/node_modules
COPY --chown=node:node --from=build /workspace/services/backend/dist/src ./services/backend/dist/src
COPY --chown=node:node --from=build /workspace/packages/config/dist ./packages/config/dist
COPY --chown=node:node --from=build /workspace/packages/domain/dist ./packages/domain/dist
COPY --chown=node:node --from=build /workspace/packages/game-engine/dist ./packages/game-engine/dist
COPY --chown=node:node services/backend/migrations ./services/backend/migrations
COPY --chown=node:node services/backend/package.json ./services/backend/package.json
COPY --chown=node:node packages/config/package.json ./packages/config/package.json
COPY --chown=node:node packages/domain/package.json ./packages/domain/package.json
COPY --chown=node:node packages/game-engine/package.json ./packages/game-engine/package.json

USER node

EXPOSE 3000
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/health/live').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["node", "services/backend/dist/src/main.js"]
