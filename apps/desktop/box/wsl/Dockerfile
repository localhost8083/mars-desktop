# MarsBox, the WSL 2 distro the Windows backend imports (`wsl --import`): the same pinned
# Debian base the box images are built FROM, plus boxrun/boxd, which run each project's box
# inside it from the same pinned images (so a Windows box is the Linux box). Exported as a
# root filesystem tarball by build-rootfs.sh; pinned by sha256 in src/box/wsl.json.
FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
ARG VERSION=dev
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates; \
    rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /usr/share/info/* /var/cache/debconf/*-old /var/log/*.log; \
    command -v unshare nsenter; \
    mkdir -p /opt/mars /var/lib/mars/store /var/lib/mars/boxes
COPY wsl.conf /etc/wsl.conf
COPY boxrun boxd /opt/mars/
RUN chmod 0755 /opt/mars/boxrun /opt/mars/boxd \
 && echo "$VERSION" > /etc/mars-wsl-version \
 && /opt/mars/boxrun --version
