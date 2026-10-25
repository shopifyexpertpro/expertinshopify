FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY index.html vite.config.js ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=4000 DATA_DIR=/app/storage UPLOADS_DIR=/app/storage/uploads
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY server ./server
COPY package.json ./
RUN mkdir -p /app/storage && chown -R node:node /app/storage
USER node
EXPOSE 4000
VOLUME ["/app/storage"]
CMD ["node", "server/index.mjs"]
# Client uploads fail closed until ClamAV is installed, updated and enabled.
