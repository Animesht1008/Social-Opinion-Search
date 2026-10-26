# syntax=docker/dockerfile:1
# Production image for Social Opinion Search.
# NOT built with Docker in the authoring environment (no Docker available there); the same steps were
# simulated by hand (npm ci -> prisma generate -> npm run build -> npm prune --omit=dev -> node dist/src/server.js).

# ---------- build stage ----------
FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma.config.ts tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src
COPY public ./public
RUN npx prisma generate        # creates src/generated/prisma (git-ignored, so never in the build context)
RUN npm run build              # tsc -> dist/
RUN npm prune --omit=dev       # keep only runtime dependencies

# ---------- runtime stage ----------
FROM node:22-slim AS run
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts /app/package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/server.js"]
