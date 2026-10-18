# Mars box: Go. FROM the base image (BASE is set by the build workflow to base@digest).
ARG BASE=ghcr.io/omnirush-ai/box-base:2026.10.1
FROM ${BASE}
ARG TARGETARCH
ARG GO_VERSION=1.27.2
ARG GO_SHA256_AMD64=ecbadb99091a3f46e31f5f934b068b1864eafa7995211b39eaddf76996045fe5
ARG GO_SHA256_ARM64=94f3e30b8e374bc285e7dadc11e0865726b9bc6e85b841ccceaabc0214c6b7c8
ENV GOPATH=/root/go PATH=/root/go/bin:/usr/local/go/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in amd64) s=$GO_SHA256_AMD64 ;; arm64) s=$GO_SHA256_ARM64 ;; *) exit 1 ;; esac; \
    curl -fsSLo /tmp/go.tgz "https://go.dev/dl/go${GO_VERSION}.linux-${TARGETARCH:-amd64}.tar.gz"; \
    echo "${s}  /tmp/go.tgz" | sha256sum -c -; \
    tar -xzf /tmp/go.tgz -C /usr/local --no-same-owner; rm /tmp/go.tgz; \
    go version
LABEL ai.mars.box.stack="go"
