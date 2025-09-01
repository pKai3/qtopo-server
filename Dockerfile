# syntax=docker/dockerfile:1.7

############################
# 1) Base OS deps layer
############################
FROM ubuntu:22.04 AS base

ENV DEBIAN_FRONTEND=noninteractive

# Use BuildKit cache for apt (speeds rebuilds)
RUN --mount=type=cache,target=/var/cache/apt \
    apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils \
      xvfb libgl1 libpng-dev \
      libjpeg-turbo8 libjpeg-turbo8-dev libjpeg-dev \
      libfreetype6 libfreetype6-dev \
      libcurl4-openssl-dev libglfw3-dev libuv1-dev libicu-dev libwebp-dev \
      build-essential python3 pkg-config unzip \
    && rm -rf /var/lib/apt/lists/*

############################
# 2) Fetch Node once (cacheable by version)
############################
FROM base AS nodefetch

ARG NODE_VERSION=18.20.8
RUN curl -fsSLo /tmp/node.tar.xz https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz \
 && mkdir -p /opt/node \
 && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1

############################
# 3) Final runtime image
############################
FROM base

# Bring in Node from the nodefetch stage
COPY --from=nodefetch /opt/node /opt/node
ENV PATH=/opt/node/bin:$PATH
ENV NODE_ENV=production

WORKDIR /usr/src/app

# ---- deps layer (cacheable) ----
COPY package*.json ./
# Cache npm downloads between builds
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# ---- app code (small diffs here) ----
COPY . .

# Make sure your launcher is executable
RUN chmod +x /usr/src/app/start.sh

EXPOSE 8080
ENTRYPOINT ["/usr/src/app/start.sh"]