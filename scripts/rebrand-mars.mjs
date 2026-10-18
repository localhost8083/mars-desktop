/**
 * One-shot MarsAI rebrand pass for the mars-gui workspace.
 *
 * Shields strings that must stay verbatim (ee/ package scope, the generated
 * SDK name, external docker image refs, the Den dev DB name), then applies
 * ordered replacements over every text file of the rebrand scope. Skipped:
 * ee/**, packages/sdk/**, node_modules, .git, binary assets, pnpm-lock.yaml.
 *
 * Run: node scripts/rebrand-mars.mjs
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SCAN_DIRS = ["apps", "packages", "evals", "scripts", "packaging", "docs", "."];
const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".json", ".md", ".mdx", ".html",
  ".css", ".scss", ".yml", ".yaml", ".toml", ".svg", ".xml", ".sh", ".txt",
  ".go", ".ps1", ".rb", ".astro", ".gitignore", ".env", ".nvmrc",
]);
const SKIP_DIR_PATTERN = /(^|\/|\\)(node_modules|\.git|\.turbo|dist|build|coverage)(\/|\\|$)/;
const SKIP_FILES = new Set(["pnpm-lock.yaml", "rebrand-mars-backup.txt"]);
// ee/ and the generated SDK keep their names; the extension icons and fonts
// are content-stable binaries.
const SKIP_PATH_PATTERN = /(^|\/|\\)(ee|packages\/sdk|packages\\sdk|Images|marscli-gui)(\/|\\|$)/;

/** Substrings never rewritten (shielded across the whole pass). */
const SHIELDS = [
  "omnirush-ai/box-base",
  "omnirush-ee",
  "omnirush/sdk",
  "omnirush_den",
];

/** Ordered replacements; longer/more specific first. */
const ORDERED = [
  ["https://marsai.click/v1", "https://marsai.click/v1"],
  ["http://127.0.0.1:8000/v1", "http://127.0.0.1:8000/v1"],
  ["ai.marsai.desktop", "ai.marsai.desktop"],
  ["marsai.click", "marsai.click"],
  ["MarsAI", "MarsAI"],
  ["Mars", "Mars"],
  ["MARS", "MARS"],
  ["mars", "mars"],
];

const SHIELD_TOKEN = "__MARS_REBRAND_SHIELD_%d__";

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_PATTERN.test(entry.name)) continue;
      yield* walk(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

function collectFiles() {
  const out = [];
  for (const dir of SCAN_DIRS) {
    const base = resolve(repoRoot, dir);
    for (const path of walk(base)) {
      const rel = path.slice(repoRoot.length + 1).replace(/\\/g, "/");
      if (SKIP_DIR_PATTERN.test(rel) || SKIP_PATH_PATTERN.test(rel)) continue;
      if (SKIP_FILES.has(entry(rel))) continue;
      const ext = (extname(rel) || "").toLowerCase();
      const noExt = rel.endsWith(".env.dev") || rel.endsWith(".gitignore") || rel.endsWith(".gitattributes");
      if (!(TEXT_EXTENSIONS.has(ext) || noExt)) continue;
      out.push(path);
    }
  }
  return [...new Set(out)];
}

function entry(path) {
  const idx = path.replace(/\\/g, "/").lastIndexOf("/");
  return idx < 0 ? path : path.slice(idx + 1);
}

function extname(path) {
  const name = entry(path);
  const idx = name.lastIndexOf(".");
  return idx <= 0 ? name : name.slice(idx);
}

function shield(text) {
  const mapped = [];
  let out = text;
  SHIELDS.forEach((literal, index) => {
    if (!out.includes(literal)) return;
    mapped.push([SHIELD_TOKEN.replace("%d", String(index)), literal]);
    out = out.split(literal).join(SHIELD_TOKEN.replace("%d", String(index)));
  });
  return { text: out, mapped };
}

let filesChanged = 0;
let replacements = 0;
const perToken = new Map();

for (const path of collectFiles()) {
  let text = readFileSync(path, "utf8");
  if (!text.toLowerCase().includes("mars")) continue;
  const { text: shielded, mapped } = shield(text);
  let next = shielded;
  for (const [from, to] of ORDERED) {
    if (!next.includes(from)) continue;
    const count = next.split(from).length - 1;
    replacements += count;
    perToken.set(from, (perToken.get(from) ?? 0) + count);
    next = next.split(from).join(to);
  }
  for (const [token, literal] of mapped) next = next.split(token).join(literal);
  if (next !== text) {
    writeFileSync(path, next);
    filesChanged += 1;
  }
}

console.log(`rebrand-mars: ${filesChanged} files changed, ${replacements} replacements`);
for (const [token, count] of [...perToken.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${count}\t${token}`);
}
