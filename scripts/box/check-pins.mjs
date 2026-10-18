#!/usr/bin/env node
// Release guard for the sandbox images (the same file in mars-cli and mars-gui,
// scripts/box/check-pins.mjs). Fails (exit 1) when a release would ship without working,
// pinned images:
//   - an image in images.json has no sha256 digest;
//   - a pinned digest is not an image index anonymously pullable for linux/amd64 and linux/arm64;
//   - wsl.json lacks a url or sha256 for amd64 or arm64, or the url does not return that sha256.
// No login is used, as a user's machine has none.
//
//   node scripts/box/check-pins.mjs [images.json] [wsl.json]
// Defaults: src/box/ (CLI) or apps/server/src/box/ (desktop), whichever exists.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ARCHES = ["amd64", "arm64"];
const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(",");

export function defaultDir(root = process.cwd()) {
  const desktop = path.join(root, "apps", "server", "src", "box");
  return existsSync(path.join(desktop, "images.json")) ? desktop : path.join(root, "src", "box");
}

/** Problems with the files alone (no network): missing digests, urls, sha256s. */
export function staticProblems(images, wsl) {
  const out = [];
  const entries = Object.entries(images?.images ?? {});
  if (!entries.length) out.push("images.json: no images");
  for (const [name, pin] of entries) {
    if (!/^[^\s@]+:[^\s@/]+$/.test(String(pin?.ref ?? ""))) out.push(`images.json: ${name}: bad ref ${JSON.stringify(pin?.ref)}`);
    if (!/^sha256:[0-9a-f]{64}$/.test(String(pin?.digest ?? ""))) out.push(`images.json: ${name}: no digest (publish the images and pin them: scripts/box/pins.mjs)`);
  }
  for (const arch of ARCHES) {
    const asset = wsl?.assets?.[arch];
    if (!/^https:\/\//.test(String(asset?.url ?? ""))) out.push(`wsl.json: ${arch}: no https url`);
    if (!/^[0-9a-f]{64}$/.test(String(asset?.sha256 ?? ""))) out.push(`wsl.json: ${arch}: no sha256`);
  }
  return out;
}

function repoOf(ref) {
  const name = ref.replace(/:[^/:]+$/, "");
  const slash = name.indexOf("/");
  return { host: name.slice(0, slash), repo: name.slice(slash + 1) };
}

async function anonymousToken(host, repo, fetchImpl) {
  if (host !== "ghcr.io") throw new Error(`only ghcr.io is checked (got ${host})`);
  const res = await fetchImpl(`https://ghcr.io/token?scope=repository:${repo}:pull`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.token) throw new Error(`no anonymous pull token for ${repo} (HTTP ${res.status}): is the package public?`);
  return body.token;
}

/** The pinned index of one image, checked anonymously: both platforms present and fetchable. */
export async function checkImage(name, pin, { fetchImpl = fetch } = {}) {
  const { host, repo } = repoOf(pin.ref);
  const token = await anonymousToken(host, repo, fetchImpl);
  const get = (ref) => fetchImpl(`https://${host}/v2/${repo}/manifests/${ref}`, { headers: { Authorization: `Bearer ${token}`, Accept: ACCEPT } });
  const res = await get(pin.digest);
  if (!res.ok) throw new Error(`${name}: ${repo}@${pin.digest}: HTTP ${res.status}`);
  const index = await res.json();
  const platforms = new Map((index.manifests ?? []).filter((m) => m.platform?.os === "linux").map((m) => [m.platform.architecture, m.digest]));
  const missing = ARCHES.filter((arch) => !platforms.has(arch));
  if (missing.length) throw new Error(`${name}: ${repo}@${pin.digest} is not an index for linux/${missing.join(", linux/")}`);
  for (const arch of ARCHES) {
    const one = await get(platforms.get(arch));
    if (!one.ok) throw new Error(`${name}: linux/${arch} manifest: HTTP ${one.status}`);
    await one.arrayBuffer();
  }
  return `${name}: ${repo}@${pin.digest.slice(0, 19)}… linux/amd64 + linux/arm64`;
}

/** One WSL asset: the url answers with exactly the pinned bytes. */
export async function checkAsset(arch, asset, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(asset.url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`wsl ${arch}: ${asset.url}: HTTP ${res.status}`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of res.body) { hash.update(chunk); bytes += chunk.length; }
  const got = hash.digest("hex");
  if (got !== asset.sha256) throw new Error(`wsl ${arch}: ${asset.url}: sha256 ${got} is not the pinned ${asset.sha256}`);
  if (Number.isInteger(asset.bytes) && asset.bytes !== bytes) throw new Error(`wsl ${arch}: ${bytes} bytes, pinned ${asset.bytes}`);
  return `wsl ${arch}: ${asset.url} sha256 ok (${bytes} bytes)`;
}

export async function check(imagesFile, wslFile, { fetchImpl = fetch, log = console.log } = {}) {
  const images = JSON.parse(readFileSync(imagesFile, "utf8"));
  const wsl = JSON.parse(readFileSync(wslFile, "utf8"));
  const problems = staticProblems(images, wsl);
  if (!problems.length) {
    for (const [name, pin] of Object.entries(images.images)) {
      try { log(await checkImage(name, pin, { fetchImpl })); } catch (error) { problems.push(String(error?.message ?? error)); }
    }
    for (const arch of ARCHES) {
      try { log(await checkAsset(arch, wsl.assets[arch], { fetchImpl })); } catch (error) { problems.push(String(error?.message ?? error)); }
    }
  }
  return problems;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] || "")).href) {
  const dir = defaultDir();
  const imagesFile = process.argv[2] || path.join(dir, "images.json");
  const wslFile = process.argv[3] || path.join(dir, "wsl.json");
  const problems = await check(imagesFile, wslFile);
  if (problems.length) {
    for (const problem of problems) console.error(`::error::sandbox images: ${problem}`);
    process.exit(1);
  }
  console.log("sandbox images: pinned and anonymously pullable; WSL image matches its sha256");
}
