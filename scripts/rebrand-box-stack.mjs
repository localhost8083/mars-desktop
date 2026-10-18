/**
 * Third pass: extensionless files the first passes skipped (Dockerfiles,
 * wsl.conf, PARITY.sha256, ...) under apps/desktop/box and other unmatched
 * text files in the box stack. Uses the same shields and token order.
 *
 * Run: node scripts/rebrand-box-stack.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_DIRS = ["apps/desktop/box", "examples", "integrations", "packaging"];
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".turbo", "dist", "build", "coverage"]);
const BINARIES = /\.(png|jpg|jpeg|ico|icns|gif|woff2?|ttf|otf|mp4|webm|webp|pdf|zip|gpx|sha256)$/i;

const SHIELDS = [
  "omnirush-ai/box-base",
  "omnirush-ee",
  "omnirush/sdk",
  "omnirush_den",
];
const ORDERED = [
  ["https://omnirush.ai/omnirush/v1", "https://marsai.click/v1"],
  ["ai.omnirush.desktop", "ai.marsai.desktop"],
  ["omnirush.ai", "marsai.click"],
  ["OmniRush.ai", "MarsAI"],
  ["OmniRush", "Mars"],
  ["OMNIRUSH", "MARS"],
  ["omnirush", "mars"],
];

const SHIELD_TOKEN = "__MARS_REBRAND_SHIELD_%d__";

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const item of entries) {
    const path = join(dir, item.name);
    if (item.isDirectory()) {
      if (SKIP_DIR_NAMES.has(item.name)) continue;
      yield* walk(path);
    } else if (item.isFile() && !BINARIES.test(item.name)) {
      yield path;
    }
  }
}

let changed = 0;
let replaced = 0;
for (const dir of TARGET_DIRS) {
  for (const path of walk(resolve(repoRoot, dir))) {
    let text = readFileSync(path, "utf8");
    if (!text.toLowerCase().includes("omnirush")) continue;
    const mapped = [];
    SHIELDS.forEach((literal, index) => {
      if (!text.includes(literal)) return;
      const token = SHIELD_TOKEN.replace("%d", String(index));
      mapped.push([token, literal]);
      text = text.split(literal).join(token);
    });
    for (const [from, to] of ORDERED) {
      if (!text.includes(from)) continue;
      replaced += text.split(from).length - 1;
      text = text.split(from).join(to);
    }
    for (const [token, literal] of mapped) text = text.split(token).join(literal);
    writeFileSync(path, text);
    changed += 1;
  }
}
console.log(`rebrand-box-stack: ${changed} files, ${replaced} replacements`);
