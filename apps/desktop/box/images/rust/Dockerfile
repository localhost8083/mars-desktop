# Mars box: Rust (rustup, stable, minimal profile). FROM the base image.
ARG BASE=ghcr.io/omnirush-ai/box-base:2026.10.1
FROM ${BASE}
ARG TARGETARCH
ARG RUSTUP_SHA256_AMD64=dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71
ARG RUSTUP_SHA256_ARM64=15f6e4ce9f583b929c996c91562bad6d4454f3281de858b02cdfdef615fac433
ARG RUST_TOOLCHAIN=stable
# In /usr/local and writable by every box user (a rootful Docker runs commands as the user's uid).
ENV CARGO_HOME=/usr/local/cargo RUSTUP_HOME=/usr/local/rustup PATH=/usr/local/cargo/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in amd64) t=x86_64-unknown-linux-gnu; s=$RUSTUP_SHA256_AMD64 ;; arm64) t=aarch64-unknown-linux-gnu; s=$RUSTUP_SHA256_ARM64 ;; *) exit 1 ;; esac; \
    curl -fsSLo /tmp/rustup-init "https://static.rust-lang.org/rustup/dist/${t}/rustup-init"; \
    echo "${s}  /tmp/rustup-init" | sha256sum -c -; chmod +x /tmp/rustup-init; \
    /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain "${RUST_TOOLCHAIN}" --component clippy,rustfmt; \
    rm /tmp/rustup-init; rm -rf /usr/local/rustup/downloads /usr/local/rustup/tmp; chmod -R a+rwX /usr/local/cargo /usr/local/rustup; \
    cargo --version; rustc --version
LABEL ai.mars.box.stack="rust"
