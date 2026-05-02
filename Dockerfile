FROM node:20-alpine AS build

WORKDIR /app

COPY package.json npm-shrinkwrap.json tsconfig.json ./
RUN npm install

COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-alpine

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

ENV IS_SANDBOX=true

RUN mkdir -p /workspace

WORKDIR /workspace

CMD ["node", "/app/dist/index.js"]
