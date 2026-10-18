# Releasing

## How a release gets its sandbox images

The Linux sandbox runs every project on a prebuilt image, `ghcr.io/mars-ai/box-{base,go,rust,java,ruby}`. On Windows, the Mars WSL backend imports its own root filesystem. The app pins both:

- `apps/server/src/box/images.json`: each image by its multi-arch digest (linux/amd64 and linux/arm64);
- `apps/server/src/box/wsl.json`: the WSL image's URL and sha256, for amd64 and arm64.

The CLI ships byte-identical copies in `src/box/`. Both repos list them in `PARITY.sha256`.

The images have their own version, the **box version** (`apps/desktop/box/VERSION`, for example `2026.10.2`). App releases don't change it, so most releases reuse the pinned images as they are and need nothing extra.

The release workflow refuses to publish unless `node scripts/box/check-pins.mjs` passes. That means:

- every image has a digest, and is pullable without a login for amd64 and arm64;
- the WSL URL returns the pinned sha256.

## When the images change

Rebuild only when `apps/desktop/box/images/` or `apps/desktop/box/wsl/` changes. The CLI's `box/` must stay the same (`apps/desktop/box/PARITY.sha256`).

1. Bump the box version in both repos, the one command being:

   ```sh
   echo 2026.10.3 > apps/desktop/box/VERSION   # CLI: box/VERSION
   ```

   Merge that to `main`. The `box-images` workflow runs on its own (or start it from Actions). It:
   - builds and pushes the five images for amd64 and arm64;
   - builds the WSL image for both;
   - attaches both WSL images and `box-pins.json` to the `box-<version>` release.

   The packages are public because this repository is.
2. Take the pins, in each repository, and commit them:

   ```sh
   node scripts/box/pins.mjs 2026.10.3      # writes images.json, wsl.json and their PARITY list
   node scripts/box/check-pins.mjs          # the release guard, run locally
   ```

A run is safe to repeat. An image or WSL asset that already exists with the same sources is reused. One that exists with other sources fails the run, which means the box version needs a bump.

## Desktop release

Push a signed `v<version>` tag on `main`. `release-desktop.yml` checks the sandbox pins first, then builds, signs and publishes.
