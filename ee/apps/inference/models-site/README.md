# MarsAI Model Catalog

This directory is the static publish root for the generated MarsAI model catalog.

Cloudflare Pages can deploy this directory directly:

- Build command: `pnpm --dir ee/apps/inference models:build`
- Build output directory: `ee/apps/inference/models-site`
- Catalog URL: `/models/api.json`

The generated `models/api.json` file is ignored by git. It is rebuilt from `src/models/base.json` and the active MarsAI overlay by `scripts/build-models.mjs`.

MarsAI-specific models live in `src/models/mars-models.json`. `scripts/build-models.mjs` turns that list into the provider overlay at build time and switches the provider API URL based on `OMNIRUSH_DEV_MODE`.
(The provider id and env names stay stable: they are runtime contract identifiers for the stored model aliases.)

Local development still serves the generated catalog from the inference Hono app at `/models/api.json` so one local service can provide both the proxy API and model catalog during dev.
