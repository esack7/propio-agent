FROM node:20-alpine

WORKDIR /app

COPY package.json npm-shrinkwrap.json ./
RUN npm install --omit=dev

COPY dist ./dist

ENV IS_SANDBOX=true

RUN mkdir -p /workspace

WORKDIR /workspace

CMD ["node", "/app/dist/index.js"]
