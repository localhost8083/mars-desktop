// Ported from the CLI (mars-cli src/box/host-builds.js); keep the two in
// step. host-builds.json (the rules and the notices) is the same file in both,
// listed in PARITY.sha256.
//
// Builds in a project folder that only run on this macOS or Windows machine:
// native packages and addons in node_modules, a venv made from this
// machine's Python, Mach-O / PE programs in the usual output folders. A
// project that only the server's default would put in the Linux box stays on
// this machine when its folder has them (service.ts): they fail in the box,
// and rebuilding them there writes Linux builds into the folder this machine
// uses too. Linux hosts are never checked.
//
// Bounded (entries and time, host-builds.json `limits`) and cached per folder
// with a signature of the folders it reads (mtime + inode).

import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, renameSync, statSync, writeFileSync, type Dirent } from "node:fs";
import path from "node:path";

import rules from "./host-builds.json" with { type: "json" };

export type HostRules = { label: string; machine: string; format: string; packages: string; venv_home: string[]; venv_home_patterns: string[] };
export type HostBuildLimits = { entries: number; ms: number; binDepth: number; cacheEntries: number; cacheMs: number };
export type HostBuildHit = { kind: "node_modules" | "venv" | "binary"; path: string; why: string };
export type HostBuildScan = { host: string; found: boolean; hits: HostBuildHit[]; scanned: number; ms: number; truncated: boolean; cached?: true };
export type HostBuildNotice = "native" | "explicit" | "box";

export const HOST_BUILD_RULES: {
  limits: HostBuildLimits;
  hosts: Record<string, HostRules>;
  venv_dirs: string[];
  venv_host_files: string[];
  build_dirs: string[];
  binary_extensions: string[];
  notices: Record<"cli" | "desktop", Record<HostBuildNotice, string>>;
} = rules;

/** The rules of a host whose builds the Linux box cannot run (darwin, win32), else null. */
export function hostRules(platform: string = process.platform): HostRules | null {
  return HOST_BUILD_RULES.hosts[platform] ?? null;
}

/** "macho", "pe", "elf" or null, from a file's first bytes. */
export function binaryFormat(buf: Buffer | null | undefined): "macho" | "pe" | "elf" | null {
  if (!buf || buf.length < 4) return null;
  const be = buf.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(be)) return "macho";
  // A universal binary; Java class files share the magic, with a version (45+) where the arch count is.
  if ((be === 0xcafebabe || be === 0xcafebabf) && buf.length >= 8) {
    const count = buf.readUInt32BE(4);
    if (count > 0 && count < 30) return "macho";
  }
  if (be === 0x7f454c46) return "elf";
  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    if (buf.length < 0x40) return null;
    const at = buf.readUInt32LE(0x3c);
    if (at + 4 <= buf.length) return buf.toString("latin1", at, at + 4) === "PE\0\0" ? "pe" : null;
    return "pe";
  }
  return null;
}

function header(file: string, bytes = 1024): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* closed */ } }
  }
}

/** Whether a venv's interpreter path (pyvenv.cfg `home`, `executable`, its python link) is this host's. */
export function hostPath(value: unknown, platform: string = process.platform): boolean {
  const host = hostRules(platform);
  const text = String(value ?? "").trim();
  if (!host || !text) return false;
  if (host.venv_home.some((prefix) => text.startsWith(prefix))) return true;
  return host.venv_home_patterns.some((pattern) => new RegExp(pattern).test(text));
}

/** pyvenv.cfg's keys (home, executable, base-executable, command, version...). */
export function parseVenvConfig(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_.-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]!.toLowerCase()] = m[2]!;
  }
  return out;
}

/**
 * Scan `root` for this host's builds: { host, found, hits: [{ kind, path,
 * why }], scanned, ms, truncated }. One hit per kind is enough; the scan
 * stops at the limits (`truncated`).
 */
export function scanHostBuilds(root: string, { platform = process.platform, limits = HOST_BUILD_RULES.limits, now = Date.now }: { platform?: string; limits?: HostBuildLimits; now?: () => number } = {}): HostBuildScan {
  const host = hostRules(platform);
  const started = now();
  const result: HostBuildScan = { host: platform, found: false, hits: [], scanned: 0, ms: 0, truncated: false };
  if (!host) return result;
  const packages = new RegExp(host.packages);
  const over = (): boolean => {
    if (result.scanned > limits.entries || now() - started > limits.ms) result.truncated = true;
    return result.truncated;
  };
  const list = (dir: string): Dirent[] => {
    if (over()) return [];
    result.scanned += 1;
    try {
      // By name, so the same folder gives the same first hit on every filesystem.
      const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      result.scanned += entries.length;
      return entries;
    } catch {
      return [];
    }
  };
  const isHost = (file: string): boolean => {
    result.scanned += 1;
    return binaryFormat(header(file)) === host.format;
  };
  const rel = (p: string) => path.relative(root, p).split(path.sep).join("/");
  const hit = (kind: HostBuildHit["kind"], p: string, why: string) => { result.hits.push({ kind, path: rel(p), why }); };
  const has = (kind: HostBuildHit["kind"]) => result.hits.some((h) => h.kind === kind);

  // A venv made from this machine's Python (pyvenv.cfg's home, or its python link), or a Windows layout.
  for (const name of HOST_BUILD_RULES.venv_dirs) {
    if (has("venv") || over()) break;
    const dir = path.join(root, name);
    let cfg: Record<string, string> | null = null;
    try { cfg = parseVenvConfig(readFileSync(path.join(dir, "pyvenv.cfg"), "utf8").slice(0, 8192)); } catch { /* none */ }
    result.scanned += 1;
    if (!cfg) continue;
    const config = cfg;
    const from = ["home", "executable", "base-executable", "base-prefix"].map((k) => config[k]).find((v) => hostPath(v, platform));
    if (from) { hit("venv", dir, `pyvenv.cfg: ${from}`); continue; }
    if (platform === "win32") {
      const exe = HOST_BUILD_RULES.venv_host_files.find((f) => { try { return statSync(path.join(dir, f)).isFile(); } catch { return false; } });
      if (exe) { hit("venv", dir, exe); continue; }
    }
    for (const py of ["python3", "python"]) {
      let target: string | null = null;
      try { target = readlinkSync(path.join(dir, "bin", py)); } catch { /* not a link */ }
      if (target && path.isAbsolute(target) && hostPath(target, platform)) { hit("venv", dir, `bin/${py} -> ${target}`); break; }
    }
  }

  // node_modules: this host's platform packages (the cheapest sign: names only), then
  // .bin programs; compiled addons (build/Release/*.node) after the output folders.
  const nm = path.join(root, "node_modules");
  const top = list(nm);
  const pkgDirs: string[] = [];
  let binDir: string | null = null;
  for (const entry of top) {
    if (has("node_modules")) break;
    const name = entry.name;
    if (name === ".bin") { binDir = path.join(nm, name); continue; }
    if (name === ".pnpm") {
      const pnpm = list(path.join(nm, name)).find((e) => packages.test(e.name));
      if (pnpm) hit("node_modules", path.join(nm, name, pnpm.name), "platform package");
      continue;
    }
    if (name.startsWith(".") || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
    if (name.startsWith("@")) {
      for (const sub of list(path.join(nm, name))) {
        const full = `${name}/${sub.name}`;
        if (packages.test(full)) { hit("node_modules", path.join(nm, name, sub.name), "platform package"); break; }
        pkgDirs.push(path.join(nm, name, sub.name));
      }
      continue;
    }
    if (packages.test(name)) { hit("node_modules", path.join(nm, name), "platform package"); break; }
    pkgDirs.push(path.join(nm, name));
  }
  if (!has("node_modules") && binDir) {
    for (const entry of list(binDir)) {
      if (over()) break;
      if (/\.(cmd|ps1)$/i.test(entry.name)) continue;
      const file = path.join(binDir, entry.name);
      if (isHost(file)) { hit("node_modules", file, "program"); break; }
    }
  }

  // Programs in the usual output folders, a couple of levels down.
  const exts = new Set(HOST_BUILD_RULES.binary_extensions);
  const walk = (dir: string, depth: number): void => {
    for (const entry of list(dir)) {
      if (has("binary") || over()) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < limits.binDepth && !["node_modules", ".git", "deps", "incremental", ".fingerprint"].includes(entry.name)) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      let candidate = exts.has(ext);
      if (!candidate && !ext && platform !== "win32") {
        try { candidate = (lstatSync(full).mode & 0o111) !== 0; } catch { candidate = false; }
      }
      if (candidate && isHost(full)) hit("binary", full, host.format);
    }
  };
  for (const name of HOST_BUILD_RULES.build_dirs) {
    if (has("binary") || over()) break;
    walk(path.join(root, name), 1);
  }

  // Compiled addons last: one look per package (the most entries).
  if (!has("node_modules")) {
    outer: for (const dir of pkgDirs) {
      if (over()) break;
      for (const entry of list(path.join(dir, "build", "Release"))) {
        if (!entry.name.endsWith(".node")) continue;
        const file = path.join(dir, "build", "Release", entry.name);
        if (isHost(file)) { hit("node_modules", file, "native addon"); break outer; }
      }
    }
  }

  result.found = result.hits.length > 0;
  result.ms = now() - started;
  return result;
}

/** The folders a scan reads, as mtime + inode: a cached answer holds while none of them changed. */
export function hostBuildsSignature(root: string): string {
  const paths = [".", "node_modules", "node_modules/.bin", "node_modules/.pnpm", ...HOST_BUILD_RULES.venv_dirs.flatMap((d) => [d, `${d}/pyvenv.cfg`]), ...HOST_BUILD_RULES.build_dirs, "target/debug", "target/release", "build/Release"];
  return paths.map((p) => {
    try {
      const st = statSync(path.join(root, p));
      return `${Math.round(st.mtimeMs)}:${st.ino}`;
    } catch {
      return "-";
    }
  }).join(",");
}

function cacheFile(stateDir: string): string {
  return path.join(stateDir, "box-host-builds.json");
}

type CacheEntry = { sig: string; at: number; result: HostBuildScan };

/**
 * scanHostBuilds() with a per-folder cache in <stateDir>/box-host-builds.json
 * (`cached: true` on a hit). MARS_BOX_HOST_BUILDS=off: never found.
 */
export function hostBuilds(root: string, { platform = process.platform, stateDir = null, env = process.env, limits = HOST_BUILD_RULES.limits, now = Date.now }: { platform?: string; stateDir?: string | null; env?: NodeJS.ProcessEnv; limits?: HostBuildLimits; now?: () => number } = {}): HostBuildScan {
  if (!hostRules(platform) || String(env.MARS_BOX_HOST_BUILDS ?? "").trim().toLowerCase() === "off") return { host: platform, found: false, hits: [], scanned: 0, ms: 0, truncated: false };
  const key = `${platform}:${path.resolve(root)}`;
  const sig = hostBuildsSignature(root);
  let cache: Record<string, CacheEntry> = {};
  if (stateDir) {
    try { cache = JSON.parse(readFileSync(cacheFile(stateDir), "utf8")) ?? {}; } catch { cache = {}; }
    const seen = cache[key];
    if (seen && seen.sig === sig && now() - seen.at < limits.cacheMs && seen.result) return { ...seen.result, cached: true };
  }
  const result = scanHostBuilds(root, { platform, limits, now });
  if (stateDir) {
    try {
      cache[key] = { sig, at: now(), result };
      const keep = Object.entries(cache).sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0)).slice(0, limits.cacheEntries);
      mkdirSync(stateDir, { recursive: true });
      const tmp = `${cacheFile(stateDir)}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(keep)), { mode: 0o600 });
      renameSync(tmp, cacheFile(stateDir));
    } catch { /* best effort */ }
  }
  return result;
}

/** What a scan found, for a notice: "node_modules, .venv, bin/app". */
export function hostBuildThings(result: Pick<HostBuildScan, "hits"> | null | undefined): string {
  const things: string[] = [];
  for (const kind of ["node_modules", "venv", "binary"] as const) {
    const h = result?.hits?.find((x) => x.kind === kind);
    if (!h) continue;
    things.push(kind === "node_modules" ? "node_modules" : h.path);
  }
  return things.join(", ");
}

/**
 * One line: `which` is "native" (kept on this machine), "explicit" (in the
 * box by the user's choice anyway) or "box" (box chats on macOS/Windows);
 * `surface` is "cli" or "desktop".
 */
export function hostBuildsNotice(which: HostBuildNotice, { platform = process.platform, result = null, surface = "desktop" }: { platform?: string; result?: Pick<HostBuildScan, "hits"> | null; surface?: "cli" | "desktop" } = {}): string {
  const host = hostRules(platform) ?? { label: "this machine's", machine: "this machine" };
  return HOST_BUILD_RULES.notices[surface][which].replaceAll("{label}", host.label).replaceAll("{machine}", host.machine).replaceAll("{things}", hostBuildThings(result));
}
