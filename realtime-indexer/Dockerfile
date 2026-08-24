FROM node:20-bookworm-slim

ARG SOURCE_COMMIT=unset
ENV SOURCE_COMMIT=$SOURCE_COMMIT

# Install CA certificates (critical for TLS trust)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (cache-friendly).
# Coolify injects NODE_ENV=production as a build ARG, which makes npm skip
# devDependencies. tsc and @types/* must still be present for this step.
COPY package*.json ./
RUN npm install --include=dev --no-audit --no-fund

# Copy the rest of the service code (context is realtime-indexer/)
COPY . .

# Build TypeScript -> dist/
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "run", "start"]
