#!/usr/bin/env bash
# Build MarsBox's root filesystem tarball (the Windows backend's `wsl --import` input):
#   box/wsl/build-rootfs.sh <version> [amd64|arm64] [out dir]
# Needs docker (buildx for a foreign arch) and the Linux helpers in box/bin (scripts/build-box.mjs).
# Prints the asset line for src/box/wsl.json. Nothing is published from here.
set -euo pipefail
VERSION=${1:?version, e.g. 2026.10.1}; ARCH=${2:-amd64}; OUT=$(mkdir -p "${3:-dist}" && cd "${3:-dist}" && pwd)
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
for f in boxrun boxd; do [ -x "$ROOT/box/bin/linux-$ARCH/$f" ] || { echo "missing box/bin/linux-$ARCH/$f (node scripts/build-box.mjs)"; exit 1; }; done
CTX=$(mktemp -d); trap 'rm -rf "$CTX"; docker rm -f "mars-wsl-build-$$" >/dev/null 2>&1 || true' EXIT
cp "$HERE/Dockerfile" "$HERE/wsl.conf" "$CTX/"; cp "$ROOT/box/bin/linux-$ARCH/boxrun" "$ROOT/box/bin/linux-$ARCH/boxd" "$CTX/"
TAG="mars-wsl-build:$VERSION-$ARCH"
docker build -q --platform "linux/$ARCH" --build-arg "VERSION=$VERSION" -t "$TAG" "$CTX" >/dev/null
docker create --name "mars-wsl-build-$$" --platform "linux/$ARCH" "$TAG" /bin/true >/dev/null
FILE="$OUT/mars-wsl-$VERSION-$ARCH.tar.gz"
# A WSL root filesystem: the container's files without Docker's own marker; gzip without a timestamp.
docker export "mars-wsl-build-$$" | python3 -c '
import sys, tarfile
src = tarfile.open(fileobj=sys.stdin.buffer, mode="r|")
dst = tarfile.open(fileobj=sys.stdout.buffer, mode="w|", format=tarfile.PAX_FORMAT)
for m in src:
    if m.name in (".dockerenv", "./.dockerenv"):
        continue
    dst.addfile(m, src.extractfile(m) if m.isfile() else None)
dst.close()' | gzip -n -9 > "$FILE"
docker rm -f "mars-wsl-build-$$" >/dev/null; docker rmi "$TAG" >/dev/null
SHA=$(sha256sum "$FILE" | cut -d' ' -f1); BYTES=$(stat -c %s "$FILE")
echo "{\"$ARCH\": {\"url\": \"<release asset url>\", \"sha256\": \"$SHA\", \"bytes\": $BYTES}}"
echo "$FILE" >&2
