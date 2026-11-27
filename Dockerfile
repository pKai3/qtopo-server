# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS node

# Compile the same pinned tiler on amd64 and arm64; Ubuntu does not supply it.
FROM ubuntu:24.04 AS contour-tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl build-essential libsqlite3-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --retry 5 --retry-all-errors --connect-timeout 20 --max-time 600 \
      https://codeload.github.com/felt/tippecanoe/tar.gz/refs/tags/2.78.0 -o /tmp/tippecanoe.tar.gz \
    && echo 'da628c5fa1aec3aba318f6096d2f60d8b4cc78043e1c25e18a4d0975c8262f00  /tmp/tippecanoe.tar.gz' | sha256sum --check --status \
    && tar -xzf /tmp/tippecanoe.tar.gz -C /tmp \
    && make -C /tmp/tippecanoe-2.78.0 -j2 tippecanoe tile-join \
    && install -m755 /tmp/tippecanoe-2.78.0/tippecanoe /tmp/tippecanoe-2.78.0/tile-join /usr/local/bin/ \
    && install -D -m644 /tmp/tippecanoe-2.78.0/LICENSE.md /usr/local/share/doc/tippecanoe/LICENSE.md

# MapLibre's Linux native binary targets Ubuntu and requires libjpeg.so.8.
FROM ubuntu:24.04 AS base
ENV DEBIAN_FRONTEND=noninteractive NODE_ENV=production LIBGL_ALWAYS_SOFTWARE=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates xvfb x11-utils libgl1 libegl1 libopengl0 libgles2 libglfw3 libcurl4t64 libuv1t64 libicu74 libwebp7 \
    libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libjpeg-turbo8 libgif7 librsvg2-2 \
    tini gosu python3 gdal-bin libsqlite3-0 zlib1g \
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
ARG BUILD_REVISION=development
ENV BUILD_REVISION=$BUILD_REVISION
# Parallelism comes from the render process pool. Do not multiply it by every
# visible host CPU inside each Mesa process, or retain freed multi-MB buffers in
# glibc's growing heaps. These remain overridable Docker environment settings.
ENV LP_NUM_THREADS=1 MALLOC_ARENA_MAX=2 \
    MALLOC_MMAP_THRESHOLD_=131072 MALLOC_TRIM_THRESHOLD_=131072
LABEL org.opencontainers.image.revision=$BUILD_REVISION
COPY --from=dependencies /usr/src/app/node_modules ./node_modules
COPY --from=contour-tools /usr/local/bin/ /usr/local/bin/
COPY --from=contour-tools /usr/local/share/doc/tippecanoe/ /usr/local/share/doc/tippecanoe/
COPY . .
COPY --from=dependencies /usr/src/app/assets/sprites ./assets/sprites
RUN chmod +x start.sh && node -e "require('@maplibre/maplibre-gl-native'); require('canvas'); require('node:sqlite')" \
    && ogr2ogr --version && tippecanoe --version && tile-join --version
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/src/app/start.sh"]
