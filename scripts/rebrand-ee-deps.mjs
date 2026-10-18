/**
 * ee/ keeps its scope, but its dependencies on workspace packages that were
 * renamed to @mars/* must match the new names.
 *
 * Run: node scripts/rebrand-ee-deps.mjs
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".json", ".md", ".mdx", ".html", ".yml", ".yaml", ".toml",
]);
const SKIP = ["node_modules", ".git", ".turbo", "dist", "build", "coverage", ".next"];

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const item of entries) {
    const path = join(dir, item.name);
    if (item.isDirectory()) {
      if (SKIP.includes(item.name)) continue;
      yield* walk(path);
    } else if (item.isFile()) {
      const ext = item.name.slice(item.name.lastIndexOf(".")) || "";
      if (TEXT_EXTENSIONS.has(ext)) yield path;
    }
  }
}

let changed = 0;
let replaced = 0;
for (const path of walk(resolve(repoRoot, "ee"))) {
  let text = readFileSync(path, "utf8");
  if (!text.includes("@omnirush/")) continue;
  const count = text.split("@omnirush/").length - 1;
  replaced += count;
  text = text.split("@omnirush/").join("@mars/");
  writeFileSync(path, text);
  changed += 1;
}
console.log(`rebrand-ee-deps: ${changed} files, ${replaced} replacements`);
