# --- build the static export -------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- serve it, plus the video counter ----------------------------------------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY server ./server
COPY --from=build /app/out ./out

# Mount a Railway volume at /data so the count survives redeploys.
ENV COUNTER_FILE=/data/counter.json

CMD ["node", "server/index.mjs"]
