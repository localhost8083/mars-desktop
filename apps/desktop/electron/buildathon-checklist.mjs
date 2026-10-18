// The buildathon rebuild checklist, checked in the project folder with cheap
// file checks (contract "Reproducibility mode"). Ported word for word from the
// CLI (mars-cli assets/extensions/mars/buildathon-lib.js, "the
// checklist, checked here"); keep the two in step.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_CHECKLIST = Object.freeze([
  { id: "git", text: "A git repository with commits" },
  { id: "lockfile", text: "A dependency lockfile" },
  { id: "runtime_pin", text: "The runtime version pinned" },
  { id: "dockerfile", text: "A Dockerfile that builds and runs it" },
  { id: "test_cmd", text: "One test command" },
  { id: "readme", text: "A README with setup, run and test steps" },
  { id: "env_example", text: "Settings in .env.example, no secrets in files" },
  { id: "no_abs_paths", text: "No absolute paths from this machine" },
]);


const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "target", ".next", ".cache", "vendor", ".mars", ".opencode"]);
const TEXT_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|rb|java|kt|php|sh|bash|zsh|ps1|json|ya?ml|toml|ini|cfg|conf|env|md|txt|html|css|scss|sql|dockerfile|mk)$|(^|\/)(Dockerfile|Makefile|Containerfile|Procfile|justfile)$/i;

function exists(root, name) {
  try {
    return fs.statSync(path.join(root, name));
  } catch {
    return null;
  }
}

function readSmall(root, name, max = 256 * 1024) {
  try {
    const st = fs.statSync(path.join(root, name));
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(path.join(root, name), "utf8");
  } catch {
    return null;
  }
}

function anyOf(root, names) {
  return names.some((n) => exists(root, n));
}

/** The project's text files (bounded walk, build/dependency folders left out). */
function projectFiles(root, { maxFiles = 3000, maxDepth = 6 } = {}) {
  const out = [];
  const walk = (rel, depth) => {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(child, depth + 1);
      } else if (e.isFile() && TEXT_EXT.test(child)) out.push(child);
    }
  };
  walk("", 0);
  return out;
}

const CHECKS = {
  git: (root) => {
    const git = exists(root, ".git");
    if (!git) return false;
    if (git.isFile()) return true; // a worktree
    try {
      return fs.readdirSync(path.join(root, ".git", "refs", "heads")).length > 0 || Boolean(exists(root, ".git/packed-refs"));
    } catch {
      return false;
    }
  },
  lockfile: (root) => anyOf(root, ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "npm-shrinkwrap.json", "poetry.lock", "uv.lock", "Pipfile.lock", "pdm.lock", "requirements.lock", "Cargo.lock", "go.sum", "Gemfile.lock", "composer.lock", "mix.lock", "pubspec.lock", "packages.lock.json", "gradle.lockfile", "flake.lock"])
    || /^[A-Za-z0-9_.\-\[\]]+==\S+/m.test(readSmall(root, "requirements.txt") || ""),
  runtime_pin: (root) => {
    if (anyOf(root, [".nvmrc", ".node-version", ".python-version", ".tool-versions", "rust-toolchain", "rust-toolchain.toml", ".ruby-version", ".java-version", "runtime.txt", "mise.toml", ".mise.toml", ".sdkmanrc", ".bun-version"])) return true;
    if (/^(toolchain|go)\s+\S+/m.test(readSmall(root, "go.mod") || "")) return true;
    try {
      const pkg = JSON.parse(readSmall(root, "package.json") || "{}");
      if (pkg?.engines?.node || pkg?.volta?.node || pkg?.packageManager) return true;
    } catch {
      /* not JSON */
    }
    return /requires-python\s*=/.test(readSmall(root, "pyproject.toml") || "");
  },
  dockerfile: (root) => anyOf(root, ["Dockerfile", "Containerfile", "docker/Dockerfile", ".devcontainer/Dockerfile"]),
  test_cmd: (root) => {
    if (/^test\s*:/m.test(readSmall(root, "Makefile") || "") || /^test\b/m.test(readSmall(root, "justfile") || "")) return true;
    try {
      const test = JSON.parse(readSmall(root, "package.json") || "{}")?.scripts?.test;
      if (typeof test === "string" && test.trim() && !/no test specified/.test(test)) return true;
    } catch {
      /* not JSON */
    }
    if (/\[tool\.pytest|pytest/.test(readSmall(root, "pyproject.toml") || "") || anyOf(root, ["pytest.ini", "tox.ini", "noxfile.py"])) return true;
    return anyOf(root, ["Cargo.toml", "go.mod"]);
  },
  readme: (root) => {
    try {
      return fs.readdirSync(root).some((n) => /^readme(\.|$)/i.test(n) && (exists(root, n)?.size ?? 0) > 0);
    } catch {
      return false;
    }
  },
  env_example: (root) => {
    if (anyOf(root, [".env.example", ".env.sample", ".env.template", ".env.dist", "env.example"])) return true;
    try {
      return !fs.readdirSync(root).some((n) => /^\.env(\.|$)/.test(n));
    } catch {
      return false;
    }
  },
  no_abs_paths: (root, { home }) => {
    const user = String(home || "").split(/[\\/]/).filter(Boolean).pop() || "";
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const needles = [home, root].filter((p) => p && p.length > 4).map((p) => new RegExp(`${escape(p)}(?![\\w.-])`));
    // /Users/<me>, /home/<me>, C:\Users\<me> (also with the backslashes escaped in source).
    const generic = user ? new RegExp(`(/Users/|/home/|[A-Za-z]:(?:\\\\){1,2}Users(?:\\\\){1,2})${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([/\\\\]|\\b)`, "i") : null;
    for (const rel of projectFiles(root)) {
      const text = readSmall(root, rel);
      if (!text) continue;
      if (needles.some((n) => n.test(text)) || (generic && generic.test(text))) return false;
    }
    return true;
  },
};

/**
 * The checklist against the project folder: [{ id, text, ok }], ok null for
 * an id this version does not know.
 */
export function evaluateChecklist(root, checklist = DEFAULT_CHECKLIST, { home = os.homedir() } = {}) {
  return checklist.map((item) => {
    const check = CHECKS[item.id];
    let ok = null;
    if (check) {
      try {
        ok = Boolean(check(root, { home }));
      } catch {
        ok = false;
      }
    }
    return { id: item.id, text: item.text, ok };
  });
}


function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** The `repro.checklist` list; missing or empty: the default list (CLI parseRepro, the same rule). */
export function parseChecklist(value) {
  const checklist = Array.isArray(value)
    ? value.filter((c) => c && typeof c === "object" && str(c.id)).map((c) => ({ id: c.id.trim(), text: str(c.text) || DEFAULT_CHECKLIST.find((d) => d.id === c.id.trim())?.text || c.id.trim() }))
    : [];
  return checklist.length ? checklist.slice(0, 30) : DEFAULT_CHECKLIST.map((c) => ({ ...c }));
}

/** A drive or file-system root, the home folder or the temp folder: never a project of its own. */
export function genericFolder(dir, { home = os.homedir() } = {}) {
  const key = path.resolve(dir);
  if (path.dirname(key) === key) return true;
  return [home, os.tmpdir()].filter(Boolean).map((d) => path.resolve(d)).includes(key);
}

/**
 * The checklist for one project folder (the app's IPC): null for anything
 * but an existing absolute folder that is a real project.
 * @param {{ path?: unknown, checklist?: unknown }} [input]
 * @returns {Array<{ id: string, text: string, ok: boolean | null }> | null}
 */
export function projectChecklist(input = {}, { home = os.homedir() } = {}) {
  const dir = typeof input.path === "string" ? input.path.trim() : "";
  if (!dir || !path.isAbsolute(dir) || genericFolder(dir, { home })) return null;
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  return evaluateChecklist(dir, parseChecklist(input.checklist), { home });
}
