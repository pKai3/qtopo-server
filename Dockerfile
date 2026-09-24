# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS node

# MapLibre's Linux native binary targets Ubuntu and requires libjpeg.so.8.
FROM ubuntu:24.04 AS base
ENV DEBIAN_FRONTEND=noninteractive NODE_ENV=production LIBGL_ALWAYS_SOFTWARE=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates xvfb libgl1 libegl1 libopengl0 libgles2 libglfw3 libcurl4t64 libuv1t64 libicu74 libwebp7 \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg-turbo8 libgif7 librsvg2-2 \
    tini gosu \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
COPY --from=node /usr/local /usr/local
WORKDIR /usr/src/app

FROM base AS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential pkg-config libcairo2-dev libpango1.0-dev libjpeg-turbo8-dev libgif-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
# Build canvas against the same libpng as MapLibre; its prebuilt bundle ships
# a conflicting libpng and can abort the renderer when sprites are decoded.
RUN --mount=type=cache,target=/root/.npm npm ci --include=dev --ignore-scripts \
    && npm rebuild @maplibre/maplibre-gl-native \
    && npm rebuild canvas --build-from-source
COPY styles/style.json styles/style.json
COPY scripts/build_sprites.js scripts/build_sprites.js
RUN npm run build:sprites && npm prune --omit=dev

FROM base
COPY --from=dependencies /usr/src/app/node_modules ./node_modules
COPY . .
COPY --from=dependencies /usr/src/app/assets/sprites ./assets/sprites
RUN chmod +x start.sh && node -e "require('@maplibre/maplibre-gl-native'); require('canvas')"
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/src/app/start.sh"]
