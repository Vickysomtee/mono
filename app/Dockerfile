FROM node:22

WORKDIR /app

ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=512

COPY package.json .
RUN npm ci --omit=dev

COPY . .
RUN rm -f .env

EXPOSE 3000

ENTRYPOINT ["sh", "./entrypoint.sh"]
