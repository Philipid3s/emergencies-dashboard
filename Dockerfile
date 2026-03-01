# syntax=docker/dockerfile:1

FROM node:20-alpine AS client-builder
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM node:20-alpine AS server-deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=server-deps /app/node_modules ./node_modules
COPY package*.json ./
COPY server.js ./
COPY usgs.js ./
COPY upstreamClient.js ./
COPY countries.json ./
COPY latlon.json ./
COPY feed_catalog.json ./
COPY --from=client-builder /app/client/dist ./client/dist

EXPOSE 5000
CMD ["node", "server.js"]
