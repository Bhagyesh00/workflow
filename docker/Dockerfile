# syntax=docker/dockerfile:1.7
#
# Workflow platform image: one image for the main process (`start`) and queue workers (`worker`).
# Build from the repository root:
#   docker build -f docker/Dockerfile -t workflow-platform .
#
# The server runs its TypeScript sources through tsx; the editor SPA is built into
# packages/editor/dist when that package exists and is served by the main process.

ARG NODE_IMAGE=node:24-slim

# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
# toolchain only as a fallback: isolated-vm ships prebuilt binaries for linux x64/arm64
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable
WORKDIR /app

COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
RUN if [ -f packages/editor/package.json ]; then pnpm --filter @workflow/editor build; fi
# keep production dependencies only
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    find . -name node_modules -type d -prune -exec rm -rf {} + \
 && pnpm install --frozen-lockfile --prod --store-dir /pnpm/store \
 && rm -rf packages/*/test packages/*/coverage

# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=5678 \
    HOST=0.0.0.0 \
    BINARY_DATA_DIR=/data/binary \
    EDITOR_DIST=/app/packages/editor/dist

# unprivileged user; application files stay root-owned (read-only for the process)
RUN groupadd --system --gid 1001 workflow \
 && useradd --system --uid 1001 --gid workflow --home-dir /home/workflow --create-home workflow \
 && mkdir -p /data/binary \
 && chown -R workflow:workflow /data

COPY --from=build /app /app
WORKDIR /app/packages/server
USER workflow
EXPOSE 5678
VOLUME ["/data/binary"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5678)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# --no-node-snapshot is required by isolated-vm (Code node sandbox); the regexp flags make V8 switch
# to its linear-time engine when a user regex backtracks too much (expressions, Filter node)
ENTRYPOINT ["node", "--no-node-snapshot", "--enable-experimental-regexp-engine-on-excessive-backtracks", "--regexp-backtracks-before-fallback=1000", "--import", "tsx", "--import", "./src/register-hooks.mjs", "src/cli.ts"]
CMD ["start"]
