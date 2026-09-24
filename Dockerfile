# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates python3 build-essential pkg-config \
    libcairo2-dev libpango1.0-dev libjpeg62-turbo-dev libgif-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /usr/src/app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY styles/style.json styles/style.json
COPY scripts/build_sprites.js scripts/build_sprites.js
RUN npm run build:sprites && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production LIBGL_ALWAYS_SOFTWARE=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates xvfb libgl1 libegl1 libopengl0 libgles2 libcurl4 libuv1 \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg62-turbo libgif7 librsvg2-2 \
    tini gosu \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /usr/src/app
COPY --from=dependencies /usr/src/app/node_modules ./node_modules
COPY . .
COPY --from=dependencies /usr/src/app/assets/sprites ./assets/sprites
RUN chmod +x start.sh
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/src/app/start.sh"]
