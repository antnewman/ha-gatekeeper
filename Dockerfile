FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine
RUN addgroup -S gatekeeper && adduser -S gatekeeper -G gatekeeper
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
RUN mkdir -p /app/data && chown gatekeeper:gatekeeper /app/data
USER gatekeeper
EXPOSE 8200 8201 8202 9090
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:8201/health || exit 1
CMD ["node", "dist/index.js"]
