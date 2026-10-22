# Issue #216, DE-2, DE-3, ADR 0011: the one container image that runs the one
# `enform` binary. The build emits `dist/`; the runtime image carries the
# emitted JavaScript, the event schemas and the migrations, and runs as the
# unprivileged `enform` user. There is no `--experimental-strip-types` here.
FROM node:26-alpine AS build
RUN npm install -g pnpm@10.7.1
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY engine ./engine
COPY server ./server
COPY cli ./cli
RUN pnpm build

FROM node:26-alpine AS runtime
RUN npm install -g pnpm@10.7.1
RUN addgroup -S enform && adduser -S enform -G enform
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts
COPY --from=build /app/dist ./dist
COPY schemas ./schemas
COPY server/migrations ./server/migrations
# Issue #224: the server serves the interface at the site root. The app is
# TypeScript, and ADR 0009 has no build step, so the runtime image carries the
# sources and the server strips the types on the way out.
COPY interface ./interface
USER enform
EXPOSE 8080
ENTRYPOINT ["node", "dist/cli/main.js"]
