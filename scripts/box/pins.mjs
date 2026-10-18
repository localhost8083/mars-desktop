#!/usr/bin/env node
// Writes the sandbox image pins (images.json, wsl.json) from a published box release
// (the same file in mars-cli and mars-gui, scripts/box/pins.mjs). The pins come
// from the `box-<version>` release of the public mars-gui repository (asset
// box-pins.json, written by its box-images workflow), so both repositories get
// byte-identical files without any token.
//
//   node scripts/box/pins.mjs <box version>          e.g. 2026.10.1
//   node scripts/box/pins.mjs --file box-pins.json   a local copy
// Then run scripts/box/check-pins.mjs and commit the two files.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASES = "https://github.com/mars-ai/mars-gui/releases/download";

const line = (value) => `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ")} }`;

/** A pins file in the house style: top-level keys one per line, each image or asset on one line. */
export function render(doc, nested) {
  const keys = Object.keys(doc);
  const rows = keys.map((key, i) => {
    const comma = i < keys.length - 1 ? "," : "";
    if (key !== nested) return `  ${JSON.stringify(key)}: ${JSON.stringify(doc[key])}${comma}`;
    const inner = Object.entries(doc[key]);
    const body = inner.map(([name, value], j) => `    ${JSON.stringify(name)}: ${line(value)}${j < inner.length - 1 ? "," : ""}`).join("\n");
    return `  ${JSON.stringify(key)}: {\n${body}\n  }${comma}`;
  });
  return `{\n${rows.join("\n")}\n}\n`;
}

export function renderImages(images) { return render(images, "images"); }
export function renderWsl(wsl) { return render(wsl, "assets"); }

export function targetDir(root = process.cwd()) {
  const desktop = path.join(root, "apps", "server", "src", "box");
  return existsSync(path.join(desktop, "images.json")) ? desktop : path.join(root, "src", "box");
}

/** PARITY.sha256 beside the pins (the CLI/desktop parity list), its hashes taken again. */
export function refreshParity(dir) {
  const file = path.join(dir, "PARITY.sha256");
  if (!existsSync(file)) return false;
  const lines = readFileSync(file, "utf8").split("\n").map((row) => {
    const m = /^([0-9a-f]{64})  (\S+)$/.exec(row);
    return m ? `${createHash("sha256").update(readFileSync(path.join(dir, m[2]))).digest("hex")}  ${m[2]}` : row;
  });
  writeFileSync(file, lines.join("\n"));
  return true;
}

export async function loadPins(arg, { fetchImpl = fetch } = {}) {
  if (arg === "--file") throw new Error("--file needs a path");
  if (arg && existsSync(arg)) return JSON.parse(readFileSync(arg, "utf8"));
  if (!/^\d{4}\.\d{1,2}\.\d+$/.test(String(arg ?? ""))) throw new Error("usage: pins.mjs <box version, e.g. 2026.10.1> | --file box-pins.json");
  const url = `${RELEASES}/box-${arg}/box-pins.json`;
  const res = await fetchImpl(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] || "")).href) {
  const args = process.argv.slice(2);
  const source = args[0] === "--file" ? args[1] : args[0];
  const pins = await loadPins(args[0] === "--file" && !args[1] ? "--file" : source);
  if (!pins?.images?.images || !pins?.wsl?.assets) throw new Error("box-pins.json: no images or wsl block");
  const dir = targetDir();
  writeFileSync(path.join(dir, "images.json"), renderImages(pins.images));
  writeFileSync(path.join(dir, "wsl.json"), renderWsl(pins.wsl));
  refreshParity(dir);
  console.log(`wrote ${path.relative(process.cwd(), path.join(dir, "images.json"))} and wsl.json for box ${pins.images.version}`);
}
