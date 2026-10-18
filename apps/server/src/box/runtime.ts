// Ported from the CLI (mars-cli src/box/runtime.js,
// feat/local-box-backends); keep the two in step. Only types were added here.
//
// The container engines a box backend can be (backends/container.ts): rootless
// Podman or Docker on Linux, Docker Desktop / OrbStack / colima / Rancher
// Desktop / Podman machine on macOS and Windows, Docker inside WSL2. Which
// backend runs a box is chosen by backends/index.ts. Never blocks a start: a
// probe has a short time limit, its result is cached, and "none" means the
// session runs on this machine with one line saying why.
//
// The old sandbox (CLI 2.2.3 to 2.3.6) failed users here: Docker Desktop's
// ~/.docker/bin not on PATH, a Windows docker.exe reached from WSL through
// /mnt/c, the docker-group permission error shown as "the reason is above".
// Each of those has a rule below and a test.

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand, type RunCommand, type RunResult } from "./run.js";

export { runCommand, type RunCommand, type RunOptions, type RunResult } from "./run.js";

/** Probe results are reused this long (ms): a working runtime, and a missing one. */
export const CACHE_OK_MS = 10 * 60_000;
export const CACHE_FAIL_MS = 2 * 60_000;

type Env = NodeJS.ProcessEnv;

/** A container CLI to probe; `prefix` goes before every call (`--context <name>`). */
export type RuntimeCandidate = { name: string; bin: string; skipped?: string; prefix?: string[] };

/** One backend as `all` lists it (the settings card's "others"). */
export type BackendAlternative = { backend: string; name: string; ok: boolean; version: string | null; flavor: string | null; reason: string | null; context?: string };

export type RuntimeInfo = {
  ok: true;
  name: string;
  bin: string;
  version: string;
  os: string;
  arch: string;
  rootless: boolean;
  flavor: string;
  vm: boolean;
  /** The backend id (backends/index.ts BACKENDS): what uploads record as sandbox.backend. */
  backend?: string;
  /** Why this backend: the ranked order, the setting, the server's allowlist. */
  why?: string;
  /** Arguments before the runtime's own (["-e", "docker"] through wsl.exe, ["--context", "colima"]). */
  prefix?: string[];
  /** The docker context the runtime answered through (macOS, Windows). */
  context?: string;
  wsl?: boolean;
  /** The Mars WSL distro: its name, whether it is imported yet. */
  distro?: string;
  installed?: boolean;
  state?: string | null;
  /** bubblewrap: the bwrap boxrun runs, the id mapping, the launcher. */
  bwrap?: string | null;
  idmap?: string;
  launcher?: string;
  kernel?: string;
  cached?: boolean;
  alternatives?: BackendAlternative[];
};
export type RuntimeTried = { backend?: string; name?: string; bin?: string; reason: string };
export type RuntimeFailure = {
  ok: false;
  name?: string;
  bin?: string;
  backend?: string;
  version?: string;
  code?: string;
  context?: string;
  reason: string;
  tried?: RuntimeTried[];
  cached?: boolean;
  /** The backend is set to native (this machine): no box, not a failure. */
  native?: boolean;
  /** macOS with nothing: the free option to offer (colima). */
  hint?: string;
  alternatives?: BackendAlternative[];
};
export type RuntimeResult = RuntimeInfo | RuntimeFailure;

/** Whether this Linux is WSL (the kernel says Microsoft). */
export function isWsl(env: Env = process.env, release = os.release()): boolean {
  return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP) || /microsoft/i.test(release);
}

/** Folders a runtime's CLI is installed in beyond PATH, per platform. */
export function searchDirs({ platform = process.platform, home = os.homedir(), env = process.env }: { platform?: NodeJS.Platform; home?: string; env?: Env } = {}): string[] {
  if (platform === "darwin") {
    return [
      "/usr/local/bin", "/opt/homebrew/bin", path.posix.join(home, ".docker", "bin"),
      "/Applications/Docker.app/Contents/Resources/bin", path.posix.join(home, ".orbstack", "bin"),
      path.posix.join(home, ".rd", "bin"), "/opt/podman/bin", "/opt/local/bin",
    ];
  }
  if (platform === "win32") {
    const pf = env.ProgramFiles || "C:\\Program Files";
    const local = env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local");
    return [
      path.win32.join(pf, "Docker", "Docker", "resources", "bin"),
      path.win32.join(pf, "RedHat", "Podman"),
      path.win32.join(local, "Programs", "Rancher Desktop", "resources", "resources", "win32", "bin"),
      path.win32.join(pf, "Rancher Desktop", "resources", "resources", "win32", "bin"),
    ];
  }
  return ["/usr/bin", "/usr/local/bin", "/snap/bin", path.posix.join(home, ".local", "bin"), path.posix.join(home, "bin"), path.posix.join(home, ".docker", "bin")];
}

/** A Windows binary seen from WSL (/mnt/c/...): it cannot mount this Linux's folders. */
export function windowsBinaryInWsl(file: string): boolean {
  return /^\/mnt\/[a-z](\/|$)/i.test(String(file));
}

/**
 * Runtime CLIs to try, best first: MARS_BOX_RUNTIME (docker, podman or a
 * path) alone when set; else on Linux Podman then Docker (rootless Podman
 * keeps files owned by the user with no daemon), on macOS and Windows Docker
 * then Podman (Docker Desktop, OrbStack, colima, Rancher all speak docker).
 */
export function candidates({ platform = process.platform, home = os.homedir(), env = process.env, exists = existsSync, wsl = platform === "linux" && isWsl(env) }: { platform?: NodeJS.Platform; home?: string; env?: Env; exists?: (file: string) => boolean; wsl?: boolean } = {}): RuntimeCandidate[] {
  const ext = platform === "win32" ? ".exe" : "";
  const sep = platform === "win32" ? ";" : ":";
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const pathDirs = String(env.PATH || env.Path || "").split(sep).filter(Boolean);
  const dirs = [...pathDirs, ...searchDirs({ platform, home, env })];
  const asked = String(env.MARS_BOX_RUNTIME || "").trim();
  const out: RuntimeCandidate[] = [];
  const seen = new Set<string>();
  const add = (name: string, file: string, skipped?: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    out.push({ name, bin: file, ...(skipped ? { skipped } : {}) });
  };
  if (asked && /[\\/]/.test(asked)) {
    add(/podman/i.test(path.basename(asked)) ? "podman" : "docker", asked);
    return out;
  }
  const names = asked ? [asked] : platform === "linux" ? ["podman", "docker"] : ["docker", "podman"];
  for (const name of names) {
    for (const dir of dirs) {
      const file = join(dir, name + ext);
      if (!exists(file)) continue;
      if (wsl && windowsBinaryInWsl(file)) {
        add(name, file, "a Windows program seen from WSL; install Docker in WSL or turn on Docker Desktop's WSL integration");
        continue;
      }
      add(name, file);
    }
  }
  return out;
}

function firstLine(text: unknown): string {
  return String(text ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

/** Cut at a word boundary (never mid-word), with an ellipsis when cut. */
export function clip(text: unknown, max = 200): string {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const at = cut.search(/\s\S*$/);
  return `${(at > max / 2 ? cut.slice(0, at) : s.slice(0, max)).replace(/[\s,;:.]+$/, "")}…`;
}

/**
 * Docker's socket on this machine, when it is a file we can look at:
 * DOCKER_HOST's unix:// path, else the platform's default (Linux:
 * /var/run/docker.sock; macOS: ~/.docker/run/docker.sock, then
 * /var/run/docker.sock). Null for a named pipe or a remote host.
 */
export function dockerSocket({ env = process.env, platform = process.platform, home = os.homedir(), exists = existsSync }: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string; exists?: (file: string) => boolean } = {}): string | null {
  const host = String(env.DOCKER_HOST || "").trim();
  if (host) return host.startsWith("unix://") ? host.slice("unix://".length) : null;
  if (platform === "linux") return "/var/run/docker.sock";
  if (platform === "darwin") {
    const mine = path.posix.join(home, ".docker", "run", "docker.sock");
    return exists(mine) ? mine : "/var/run/docker.sock";
  }
  return null;
}

/**
 * A user-facing reason for a failed probe: the exit and the socket first
 * (Docker 29 words its errors differently from 2x), then what the runtime
 * printed, cut at a word.
 */
export function explainFailure(name: string, result: Partial<RunResult>, { platform = process.platform, env = process.env, home = os.homedir(), exists = existsSync }: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string; exists?: (file: string) => boolean } = {}): string {
  const said = firstLine(result.stderr) || firstLine(result.stdout);
  if (result.error === "ENOENT") return `${name} is not installed`;
  if (result.error === "timeout") return `${name} did not answer in time (is it starting?)`;
  const notRunning = platform === "linux" ? "the Docker daemon is not running" : "Docker is installed but not running (start Docker Desktop, OrbStack or colima)";
  if (name === "docker" && /permission denied/i.test(said) && /docker\.sock|docker daemon socket|docker api/i.test(said)) {
    // macOS has no docker group: the socket is another account's (Docker Desktop links /var/run/docker.sock to its user's home).
    if (platform === "darwin") return "Docker's socket belongs to another macOS user (their Docker Desktop); start Docker Desktop, OrbStack or colima in this account";
    return "Docker refused this user (add it to the docker group: `sudo usermod -aG docker $USER`, then log in again), or use rootless Podman";
  }
  if (name === "docker" && result.code !== 0) {
    const socket = dockerSocket({ env, platform, home, exists });
    if (socket && !exists(socket)) return notRunning;
  }
  if (/cannot connect to the docker daemon|failed to connect to the docker api|is the docker daemon running|daemon is running|error during connect|docker_engine/i.test(said)) return notRunning;
  if (/podman machine|cannot connect to podman|unable to connect to podman/i.test(said)) return "Podman is installed but its machine is not running (`podman machine start`)";
  if (said) return `${name}: ${clip(said)}`;
  return `${name} exited with ${result.code}`;
}

type Info = Record<string, unknown> & {
  OperatingSystem?: unknown;
  Name?: unknown;
  host?: { distribution?: { distribution?: unknown }; os?: unknown; arch?: unknown; security?: { rootless?: unknown } };
  version?: { Version?: unknown };
  OSType?: unknown;
  ServerErrors?: unknown;
  SecurityOptions?: unknown;
  ServerVersion?: unknown;
  Architecture?: unknown;
};

/** What kind of installation answered (shown in status; recorded in uploads). */
export function flavorOf({ name, info = {}, platform = process.platform, wsl = false }: { name: string; info?: Info; platform?: NodeJS.Platform; wsl?: boolean }): string {
  const system = String(info.OperatingSystem || info.host?.distribution?.distribution || "");
  const host = String(info.Name || "");
  if (/docker desktop/i.test(system)) return "desktop";
  if (/orbstack/i.test(system) || /orbstack/i.test(host)) return "orbstack";
  if (/colima/i.test(host) || /colima/i.test(system)) return "colima";
  if (/rancher/i.test(system)) return "rancher";
  if (name === "podman" && platform !== "linux") return "podman-machine";
  if (wsl) return "wsl";
  return "engine";
}

/**
 * Probe one runtime CLI: { ok: true, name, bin, version, os, arch, flavor,
 * rootless, vm } or { ok: false, name, bin, reason }.
 */
export async function probe(candidate: RuntimeCandidate, { run = runCommand, env = process.env, platform = process.platform, wsl = platform === "linux" && isWsl(env), timeoutMs = 8_000 }: { run?: RunCommand; env?: Env; platform?: NodeJS.Platform; wsl?: boolean; timeoutMs?: number } = {}): Promise<RuntimeResult> {
  const { name, bin } = candidate;
  if (candidate.skipped) return { ok: false, name, bin, reason: `${bin}: ${candidate.skipped}` };
  if (name === "docker") {
    const host = String(env.DOCKER_HOST || "");
    if (/^(ssh|tcp|https?):\/\//i.test(host) && env.MARS_BOX_ALLOW_REMOTE !== "1") {
      return { ok: false, name, bin, reason: "DOCKER_HOST points at another machine, which cannot see this folder" };
    }
  }
  const prefix = Array.isArray(candidate.prefix) ? candidate.prefix : [];
  const args = [...prefix, ...(name === "podman" ? ["info", "--format", "json"] : ["info", "--format", "{{json .}}"])];
  const result = await run(bin, args, { env, timeoutMs });
  // A docker context (OrbStack, colima, Desktop) has its own socket: its words decide, not the default socket.
  const ownSocket = prefix.includes("--context") ? { exists: () => true } : {};
  if (result.code !== 0) return { ok: false, name, bin, reason: explainFailure(name, result, { platform, env, ...ownSocket }) };
  let info: Info;
  try {
    info = JSON.parse(result.stdout);
  } catch {
    return { ok: false, name, bin, reason: `could not read \`${name} info\`` };
  }
  if (name === "podman") {
    const hostInfo = info.host ?? {};
    return {
      ok: true, name, bin,
      version: String(info.version?.Version ?? ""),
      os: String(hostInfo.os ?? "linux"),
      arch: String(hostInfo.arch ?? ""),
      rootless: Boolean(hostInfo.security?.rootless),
      flavor: flavorOf({ name, info, platform, wsl }),
      vm: platform !== "linux",
    };
  }
  const osType = String(info.OSType ?? "linux");
  if (osType !== "linux") return { ok: false, name, bin, reason: `Docker is set to ${osType} containers; switch it to Linux containers` };
  if (Array.isArray(info.ServerErrors) && info.ServerErrors.length) return { ok: false, name, bin, reason: explainFailure(name, { code: 1, stderr: String(info.ServerErrors[0]) }, { platform, env }) };
  const security = Array.isArray(info.SecurityOptions) ? info.SecurityOptions.join(",") : "";
  const flavor = flavorOf({ name, info, platform, wsl });
  return {
    ok: true, name, bin,
    version: String(info.ServerVersion ?? ""),
    os: osType,
    arch: String(info.Architecture ?? ""),
    rootless: /rootless/.test(security),
    flavor,
    // Docker Desktop, OrbStack, colima: files cross into a VM; ownership is mapped there.
    vm: platform !== "linux" || flavor === "desktop",
  };
}

/** wsl.exe, when Windows has it (System32). */
export function wslLauncher({ env = process.env, exists = existsSync }: { env?: Env; exists?: (file: string) => boolean } = {}): string | null {
  const root = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  const file = path.win32.join(root, "System32", "wsl.exe");
  return exists(file) ? file : null;
}

/**
 * Docker (then Podman) in the default WSL 2 distro: { ok, name, bin: wsl.exe,
 * prefix: ["-e", name], flavor: "wsl", wsl: true } or { ok: false, reason }.
 * No distro, no engine in it, or a distro without networking (nested
 * virtualization often has none) is a reason, never an install.
 */
export async function probeWsl(wslExe: string, { run = runCommand, env = process.env, timeoutMs = 12_000 }: { run?: RunCommand; env?: Env; timeoutMs?: number } = {}): Promise<RuntimeResult> {
  for (const name of ["docker", "podman"]) {
    const args = name === "podman" ? ["-e", "podman", "info", "--format", "json"] : ["-e", "docker", "info", "--format", "{{json .}}"];
    const res = await run(wslExe, args, { env, timeoutMs });
    const said = String(res.stderr || res.stdout || "").replace(/\u0000/g, "");
    if (res.code !== 0) {
      if (/no installed distributions|has no installed distributions|WSL_E_DEFAULT_DISTRO_NOT_FOUND|not installed/i.test(said)) {
        return { ok: false, name: "wsl", bin: wslExe, reason: "WSL has no Linux distribution (install one with Docker or Podman in it, or install Docker Desktop)" };
      }
      continue;
    }
    let info: Info;
    try { info = JSON.parse(res.stdout); } catch { continue; }
    if (name === "docker" && String(info.OSType ?? "linux") !== "linux") continue;
    return {
      ok: true, name, bin: wslExe, prefix: ["-e", name], wsl: true, flavor: "wsl",
      version: String(name === "podman" ? info.version?.Version ?? "" : info.ServerVersion ?? ""),
      os: "linux",
      arch: String(name === "podman" ? info.host?.arch ?? "" : info.Architecture ?? ""),
      rootless: name === "podman" ? Boolean(info.host?.security?.rootless) : /rootless/.test((Array.isArray(info.SecurityOptions) ? info.SecurityOptions : []).join(",")),
      vm: true,
    };
  }
  return { ok: false, name: "wsl", bin: wslExe, reason: "no Docker or Podman engine answers in the default WSL distribution" };
}

/**
 * The backend for boxes on this machine (backends/index.ts: bubblewrap,
 * Apple container, WSL containers, the Mars WSL distro, then the
 * container engines above, in a ranked order per OS). Kept here under its
 * old name.
 */
export async function detectRuntime(opts: DetectOptions = {}): Promise<RuntimeResult> {
  const { detectBackend } = await import("./backends/index.js");
  return detectBackend(opts);
}

export type DetectOptions = {
  boxHome?: string;
  env?: Env;
  platform?: NodeJS.Platform;
  home?: string;
  exists?: (file: string) => boolean;
  run?: RunCommand;
  wsl?: boolean;
  now?: number;
  fresh?: boolean;
  /** Probe every backend and list them as `alternatives` (status). */
  all?: boolean;
  timeoutMs?: number;
  /** A backend id, "auto" or "native" (the desktop setting); default MARS_BOX_BACKEND. */
  asked?: string | null;
  /** The server's allowlist (local_box.backends); null: any. */
  allow?: string[] | null;
  arch?: string;
  release?: string;
};
