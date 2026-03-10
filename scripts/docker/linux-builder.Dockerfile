FROM node:20-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
  build-essential \
  curl \
  wget \
  file \
  pkg-config \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  ca-certificates \
  git \
  xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal --default-toolchain stable

ENV PATH="/root/.cargo/bin:${PATH}"
WORKDIR /work
