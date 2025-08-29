FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install required dependencies for MapLibre, headless rendering, and Node via NVM
RUN apt-get update && apt-get install -y \
    curl \
    git \
    build-essential \
    python3 \
    python3-pip \
    xvfb \
    libgl1 \
    libpng-dev \
    libjpeg-turbo8 \
    libjpeg-turbo8-dev \
    libjpeg-dev \
    libfreetype6 \
    libfreetype6-dev \
    libcurl4-openssl-dev \
    libglfw3-dev \
    libuv1-dev \
    libicu-dev \
    libwebp-dev \
    pkg-config \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js v18 using NVM in a single layer so npm stays available
ENV NVM_DIR=/root/.nvm
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash \
    && . "$NVM_DIR/nvm.sh" \
    && nvm install 18 \
    && nvm use 18 \
    && nvm alias default 18 \
    && npm install -g npm

# Make sure Node and npm are in the PATH for all subsequent layers
ENV NODE_VERSION=18
ENV PATH=$NVM_DIR/versions/node/v$NODE_VERSION/bin:$PATH

# Set up working directory and copy only package manifests first for better caching
WORKDIR /usr/src/app
COPY package*.json ./

# Install dependencies inside the container
RUN . "$NVM_DIR/nvm.sh" && npm install

# Copy the rest of the app source
COPY . .

# Expose internal port (external mapping handled at runtime)
EXPOSE 8080

COPY start.sh /usr/src/app/start.sh
RUN chmod +x /usr/src/app/start.sh

ENTRYPOINT ["/usr/src/app/start.sh"]
# no CMD needed; start.sh execs the exact command
