/**
 * Second small token pass: camelCase "mars" identifiers that the first
 * pass missed (no case variant covered "mars").
 *
 * Run: node scripts/rebrand-omnirush-camel.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["apps", "packages", "evals", "scripts", "packaging", "docs", "."];
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".turbo", "dist", "build", "coverage", "ee", "sdk"]);
const SKIP_PATH_PATTERN = /(^|\/|\\)(ee|packages[\/\\]sdk)(\/|\\|$)/;
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".json", ".md", ".mdx", ".html",
  ".css", ".scss", ".yml", ".yaml", ".toml", ".svg", ".xml", ".sh", ".txt",
  ".go", ".ps1", ".rb", ".astro",
]);

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const item of entries) {
    const path = join(dir, item.name);
    if (item.isDirectory()) {
      if (SKIP_DIR_NAMES.has(item.name) || SKIP_PATH_PATTERN.test(path)) continue;
      yield* walk(path);
    } else if (item.isFile()) {
      const ext = item.name.slice(item.name.lastIndexOf(".")) || "";
      if (TEXT_EXTENSIONS.has(ext)) yield path;
    }
  }
}

let changed = 0;
let replaced = 0;
for (const dir of SCAN_DIRS) {
  for (const path of walk(resolve(repoRoot, dir))) {
    let text = readFileSync(path, "utf8");
    if (!text.includes("mars")) continue;
    const count = text.split("mars").length - 1;
    replaced += count;
    text = text.split("mars").join("mars");
    writeFileSync(path, text);
    changed += 1;
  }
}
console.log(`rebrand-camel: ${changed} files, ${replaced} replacements`);
