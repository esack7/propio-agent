FROM node:20-alpine AS build

WORKDIR /app

COPY package.json npm-shrinkwrap.json tsconfig.json ./
RUN npm install

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
