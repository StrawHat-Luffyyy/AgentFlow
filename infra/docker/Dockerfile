FROM node:24-bookworm-slim

RUN corepack enable
WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/telemetry/package.json packages/telemetry/package.json
RUN pnpm install --frozen-lockfile

COPY apps ./apps
COPY packages ./packages

CMD ["pnpm", "--filter", "@agentflow/api", "start"]
