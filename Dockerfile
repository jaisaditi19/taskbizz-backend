# Stage 1: build
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat

# Copy package files AND prisma schema before npm ci
COPY package.json package-lock.json ./
COPY prisma ./prisma

# Now npm ci can run prisma generate successfully
RUN npm ci

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Stage 2: runtime
FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache tini

# Create app user
RUN addgroup -S app && adduser -S app -G app

# Copy built application and node_modules from builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json

# Change ownership to app user
RUN chown -R app:app /app
USER app

# Health check (optional)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node healthcheck.js

EXPOSE 3000

# Use tini as entrypoint for proper signal handling
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]