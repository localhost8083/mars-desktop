/**
 * Renames files and directories whose names contain the old brand token,
 * after scripts/rebrand-mars.mjs rewrote their contents. Directories are
 * renamed deepest-first (post-order), so descendant paths stay valid.
 *
 * Run: node scripts/rebrand-rename-paths.mjs
 */
import { readdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["apps", "packages", "evals", "scripts", "packaging", "docs", "."];
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".turbo", "dist", "build", "coverage", ".next", "out"]);
const SKIP_PATH_PATTERN = /(^|\/|\\)(ee|packages[\/\\]sdk)(\/|\\|$)/;
const BINARIES = /\.(png|jpg|jpeg|ico|icns|gif|woff2?|ttf|otf|mp4|webm|webp|pdf|zip|gpx)$/i;

const TOKENS = [
  ["omnirush", "mars"],
  ["OmniRush", "Mars"],
  ["OMNIRUSH", "MARS"],
];

function hasToken(name) {
  return /omnirush/i.test(name);
}

function renameName(name) {
  let next = name;
  for (const [from, to] of TOKENS) next = next.split(from).join(to);
  return next;
}

const renamed = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const item of entries) {
    const path = join(dir, item.name);
    if (SKIP_PATH_PATTERN.test(path)) continue;
    if (item.isDirectory()) {
      if (SKIP_DIR_NAMES.has(item.name)) continue;
      walk(path);
      const nextName = renameName(item.name);
      if (hasToken(item.name)) {
        const nextPath = join(dirname(path), nextName);
        renameSync(path, nextPath);
        renamed.push(path.slice(repoRoot.length + 1) + " -> " + nextName);
      }
    } else if (item.isFile()) {
      if (BINARIES.test(item.name) && hasToken(item.name)) {
        const nextName = renameName(item.name);
        renameSync(path, join(dirname(path), nextName));
        renamed.push(path.slice(repoRoot.length + 1) + " -> (binary) " + nextName);
        continue;
      }
      if (hasToken(item.name)) {
        const nextName = renameName(item.name);
        renameSync(path, join(dirname(path), nextName));
        renamed.push(path.slice(repoRoot.length + 1) + " -> " + nextName);
      }
    }
  }
}

for (const dir of SCAN_DIRS) walk(resolve(repoRoot, dir));

console.log(`rebrand-paths: ${renamed.length} paths renamed`);
for (const line of renamed) console.log("  " + line);
