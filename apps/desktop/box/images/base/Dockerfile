# Mars box: base image (build tools, Python, Node). The other stacks
# build FROM this. Published as ghcr.io/omnirush-ai/box-base by
# .github/workflows/box-images.yml; the CLI pins it by digest (src/box/images.json).
#
# Notes from the 2026-10-11 bake-off:
# - python is Debian's (python-is-python3); never symlink uv's python into
#   /usr/local/bin/python3 (`python -m venv` then fails with "No module named encodings").
# - corepack is enabled in /usr/local, so pnpm/yarn work out of the box.
# - global npm installs go to /root/.local (NPM_CONFIG_PREFIX): HOME is /root
#   for every box user, root or the uid-matched user of a rootful Docker.
# - node's headers are left out (node-gyp fetches them on demand).
FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587

ARG TARGETARCH
ARG NODE_VERSION=22.23.3
ARG NODE_SHA256_AMD64=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
ARG NODE_SHA256_ARM64=a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f
ARG UV_VERSION=0.13.0
ARG UV_SHA256_AMD64=b0828fc4cdc47d65951e94b5f0a15a5364420e8dcd88723f3b21e7a2eb30bbc3
ARG UV_SHA256_ARM64=281ca6cf43f4e26e35474839ad4861be86de42af2682f74134460f5b2071b96d

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    HOME=/root \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NPM_CONFIG_PREFIX=/root/.local \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates curl wget git openssh-client gnupg sudo \
      build-essential pkg-config \
      python3 python3-venv python3-pip python3-dev python-is-python3 \
      unzip zip xz-utils bzip2 jq less procps file lsof tzdata; \
    rm -rf /var/lib/apt/lists/*; \
    case "${TARGETARCH:-amd64}" in \
      amd64) n=x64; ns=$NODE_SHA256_AMD64; u=x86_64; us=$UV_SHA256_AMD64 ;; \
      arm64) n=arm64; ns=$NODE_SHA256_ARM64; u=aarch64; us=$UV_SHA256_ARM64 ;; \
      *) echo "unsupported arch $TARGETARCH"; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${n}.tar.xz"; \
    echo "${ns}  /tmp/node.tar.xz" | sha256sum -c -; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
      --exclude='*/include' --exclude='*/share/doc' --exclude='*/share/man' --exclude='*/CHANGELOG.md' --exclude='*/README.md'; \
    rm /tmp/node.tar.xz; \
    corepack enable; \
    curl -fsSLo /tmp/uv.tgz "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${u}-unknown-linux-musl.tar.gz"; \
    echo "${us}  /tmp/uv.tgz" | sha256sum -c -; \
    tar -xzf /tmp/uv.tgz -C /usr/local/bin --strip-components=1 --no-same-owner; \
    rm /tmp/uv.tgz; \
    rm -rf /usr/share/doc/* /usr/share/man/* /usr/share/info/* /var/cache/debconf/*-old; \
    mkdir -p /opt/mars/bin /root/.local/bin; \
    node --version; npm --version; python --version; uv --version; git --version

LABEL ai.mars.box.image="1" ai.mars.box.stack="base" \
      org.opencontainers.image.source="https://github.com/mars-ai/mars-cli" \
      org.opencontainers.image.description="Mars box base: build tools, Python 3, Node 22"
WORKDIR /root
CMD ["/bin/bash"]
