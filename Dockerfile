FROM node:20-alpine AS build

WORKDIR /app

# os-lock (file locking for saved settings) is an optional dependency with
# no prebuilt binary for Alpine, and npm skips an optional dependency that
# fails to build without saying so. It needs a toolchain, and its source
# passes a `long long *` where N-API declares `int64_t *`; the two are the
# same size on every 64-bit target, but GCC 14 makes the mismatch an error.
RUN apk add --no-cache python3 make g++

COPY package.json npm-shrinkwrap.json tsconfig.json ./
RUN CFLAGS="-Wno-error=incompatible-pointer-types" npm install
# Fail the build rather than ship an image that cannot lock.
RUN node -e "require('os-lock')"

# Optional development artifact; normal release builds use the published dependency.
ARG PROPIO_LOCAL_PROVIDERS_TARBALL=""
RUN --mount=type=bind,target=/provider-source \
    if [ -n "$PROPIO_LOCAL_PROVIDERS_TARBALL" ]; then \
      npm install --no-save --package-lock=false "/provider-source/$PROPIO_LOCAL_PROVIDERS_TARBALL"; \
    fi

COPY src ./src
RUN npm run build
# Prune can restore the published dependency from shrinkwrap. Reapply the
# development artifact afterwards, with production-only dependency resolution.
RUN --mount=type=bind,target=/provider-source \
    npm prune --omit=dev && \
    if [ -n "$PROPIO_LOCAL_PROVIDERS_TARBALL" ]; then \
      npm install --omit=dev --no-save --package-lock=false "/provider-source/$PROPIO_LOCAL_PROVIDERS_TARBALL"; \
    fi

FROM node:20-alpine

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

ENV IS_SANDBOX=true

RUN mkdir -p /workspace

WORKDIR /workspace

CMD ["node", "/app/dist/index.js"]
