FROM node:22-slim

ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=384

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

USER node
EXPOSE 8080

CMD ["node", "src/server.js"]
