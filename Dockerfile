FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js ./
COPY src ./src
COPY public ./public
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache su-exec
ENV NODE_ENV=production PORT=4000 DATA_DIR=/app/storage UPLOADS_DIR=/app/storage/uploads
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY server ./server
COPY package.json ./
RUN mkdir -p /app/storage
EXPOSE 4000
# Hosted disks (Render, Docker volumes) are often mounted root-owned: fix ownership, then run as the unprivileged node user.
CMD ["sh", "-c", "mkdir -p \"$DATA_DIR\" \"$UPLOADS_DIR\" && chown -R node:node \"$DATA_DIR\" \"$UPLOADS_DIR\" && exec su-exec node node server/index.mjs"]
# Client uploads fail closed until ClamAV is installed, updated and enabled.
