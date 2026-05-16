FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json turbo.json ./
COPY packages/core/package.json packages/core/tsconfig.json packages/core/tsup.config.ts ./packages/core/
COPY packages/function/package.json packages/function/tsconfig.json packages/function/tsup.config.ts ./packages/function/

RUN pnpm install --frozen-lockfile

COPY packages/core/src ./packages/core/src
COPY packages/function/src ./packages/function/src

RUN pnpm --filter @xplane/core build && pnpm --filter @xplane/function build

# Produce a deploy-ready node_modules with only production deps
RUN pnpm --filter @xplane/function deploy --prod /app/deploy

FROM node:24-alpine
WORKDIR /app

RUN mkdir -p /run/secrets

COPY --from=build /app/deploy/node_modules ./node_modules
COPY --from=build /app/deploy/dist ./dist


EXPOSE 9443
CMD ["node", "dist/serve.js"]
