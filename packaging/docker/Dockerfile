FROM node:22-bookworm-slim

ARG MARS_SERVER_VERSION=0.18.4
ARG OPENCODE_VERSION=1.17.11
ARG OPENCODE_DOWNLOAD_URL=

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    tar \
    unzip \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "mars-server@${MARS_SERVER_VERSION}"

RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) asset="opencode-linux-x64-baseline.tar.gz" ;; \
    arm64) asset="opencode-linux-arm64.tar.gz" ;; \
    *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
  esac; \
  url="$OPENCODE_DOWNLOAD_URL"; \
  if [ -z "$url" ]; then \
    url="https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/${asset}"; \
  fi; \
  tmpdir="$(mktemp -d)"; \
  curl -fsSL "$url" -o "$tmpdir/$asset"; \
  tar -xzf "$tmpdir/$asset" -C "$tmpdir"; \
  binary="$(find "$tmpdir" -type f -name opencode | head -n 1)"; \
  test -n "$binary"; \
  install -m 0755 "$binary" /usr/local/bin/opencode; \
  rm -rf "$tmpdir"

# Persistent directories (mount volumes here on PaaS/SSH).
# The data path deliberately keeps its historical name: existing deployments
# have volumes mounted at /data/mars-orchestrator, and renaming it here
# would silently orphan their state. The orchestrator CLI itself is gone; this
# is only a directory name kept for compatibility.
ENV MARS_DATA_DIR=/data/mars-orchestrator
ENV MARS_SIDECAR_DIR=/data/sidecars

# The workspace is mounted from the host/volume.
ENV MARS_WORKSPACE=/workspace

# MarsAI host contract surface.
EXPOSE 8787

VOLUME ["/workspace", "/data"]

# Defaults:
# - MarsAI server is published intentionally via --host 0.0.0.0
# - OpenCode is managed by mars-server and stays internal
CMD ["/bin/sh", "-lc", "plugin_dir=\"$(npm root -g)/mars-server/dist/opencode-plugins\"; test -d \"$plugin_dir\"; export MARS_MANAGE_OPENCODE=1 MARS_OPENCODE_BIN=/usr/local/bin/opencode MARS_EXTENSIONS_PLUGIN_DIR=\"$plugin_dir\"; exec mars-server --workspace \"${MARS_WORKSPACE:-/workspace}\" --host 0.0.0.0 --port \"${MARS_PORT:-8787}\" --cors \"${MARS_CORS_ORIGINS:-*}\" --approval \"${MARS_APPROVAL_MODE:-manual}\""]
