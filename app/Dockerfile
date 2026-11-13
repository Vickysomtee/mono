FROM node:22-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim

ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=384

# Nothing at runtime shells out to npm, and it ships its own dependency tree
# that shows up in every image scan.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER node
EXPOSE 8080

CMD ["node", "src/server.js"]
