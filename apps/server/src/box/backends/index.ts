// Ported from the CLI (mars-cli src/box/backends/index.js,
// feat/local-box-backends); keep the two in step. Desktop differences: types;
// the "asked" reason names the desktop setting.
//
// Which backend runs this machine's boxes: the best one that works, in a
// ranked order per OS, unless the user (the desktop setting,
// MARS_BOX_BACKEND) or the server (its allowlist) says otherwise. Every
// backend gives the same thing: a persistent Linux box per project from the
// same pinned image, boxd inside, per-turn snapshots in the same
// `__sandbox__` format, so the converter and the rebuild do not change.
//
//   Linux:   bwrap (no daemon, no root) > rootless Podman > Docker
//   macOS:   OrbStack > colima > Docker Desktop > Rancher > Podman machine
//            (Apple container is opt-in only: never picked on its own, never started unasked)
//   Windows: WSL containers (wslc, WSL 3.0.1+) > Mars's WSL distro > Docker Desktop > Podman machine
//            > Docker in the default WSL distro
//
// Nothing found: the project runs on this machine with one line saying why
// (never an install, never a wait).

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand, type RunCommand } from "../run.js";
import { CACHE_FAIL_MS, CACHE_OK_MS, candidates, isWsl, probe as probeContainer, probeWsl, wslLauncher, type BackendAlternative, type DetectOptions, type RuntimeFailure, type RuntimeInfo, type RuntimeResult, type RuntimeTried } from "../runtime.js";
import { appleDriver, probeApple } from "./apple.js";
import { bwrapDriver, probeBwrap } from "./bwrap.js";
import { containerDriver } from "./container.js";
import type { BoxDriver } from "./types.js";
import { probeWslDistro, wslDriver } from "./wsl.js";
import { probeWslc, wslcDriver } from "./wslc.js";

type Env = NodeJS.ProcessEnv;

export const ORDER: Record<"linux" | "darwin" | "win32", string[]> = {
  linux: ["bwrap", "podman", "docker"],
  darwin: ["orbstack", "colima", "docker-desktop", "rancher", "podman", "docker"],
  win32: ["wslc", "wsl", "docker-desktop", "podman", "docker", "wsl-engine"],
};

/**
 * Backends used only when chosen by name (the sandbox backend setting,
 * MARS_BOX_BACKEND), never in the automatic order. Apple container: on
 * macOS 27 `container system start` can hang and leave the Mac's network
 * sharing stuck until a reboot (apple/container#2275), and it turns the
 * packet filter on for all host traffic (#2335).
 */
export const OPT_IN: Partial<Record<NodeJS.Platform, string[]>> = { darwin: ["apple"] };

/** What the backend setting takes (and what uploads record as sandbox.backend). */
export const BACKENDS = ["bwrap", "apple", "wslc", "wsl", "orbstack", "colima", "docker-desktop", "rancher", "docker", "podman", "wsl-engine"] as const;
export type BackendId = (typeof BACKENDS)[number];
export const LABELS: Record<string, string> = {
  bwrap: "bubblewrap (no daemon)", apple: "Apple container", wslc: "WSL containers (wslc)", wsl: "Mars WSL distro", orbstack: "OrbStack", colima: "colima",
  "docker-desktop": "Docker Desktop", rancher: "Rancher Desktop", docker: "Docker", podman: "Podman", "wsl-engine": "Docker/Podman in WSL",
};

/** The ranked backends of a platform (the setting's choices there). */
export function backendsFor(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "darwin" ? ORDER.darwin : platform === "win32" ? ORDER.win32 : ORDER.linux;
}

/** The driver (image, open, list, remove, ...) for a detected runtime. */
export function driverFor(runtime: { backend?: string } | null | undefined): BoxDriver {
  switch (runtime?.backend) {
    case "bwrap": return bwrapDriver;
    case "apple": return appleDriver;
    case "wsl": return wslDriver;
    case "wslc": return wslcDriver;
    default: return containerDriver;
  }
}

/** The backend id of a probed container runtime (from what answered `info`). */
export function containerBackendId(runtime: Pick<RuntimeInfo, "name" | "wsl" | "prefix" | "flavor">): string {
  if (runtime.name === "podman") return "podman";
  if (runtime.wsl && runtime.prefix?.[0] === "-e") return "wsl-engine";
  switch (runtime.flavor) {
    case "desktop": return "docker-desktop";
    case "orbstack": return "orbstack";
    case "colima": return "colima";
    case "rancher": return "rancher";
    default: return "docker";
  }
}

/** The backend an MARS_BOX_RUNTIME path names when it is not a Docker/Podman CLI. */
export function runtimeBackend(value: unknown, platform: NodeJS.Platform = process.platform): string | null {
  const base = String(value || "").split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, "") ?? "";
  if (base === "wslc") return "wslc";
  if (base === "container" && platform !== "win32") return "apple";
  if (base === "boxrun" || base === "bwrap") return "bwrap";
  const lower = String(value || "").toLowerCase();
  if (["bwrap", "apple", "wslc", "wsl"].includes(lower)) return lower;
  return null;
}

function isBackendId(value: string): value is BackendId {
  return BACKENDS.some((id) => id === value);
}

/** The backend setting's value: a backend id, "auto", or "native" (no box). Aliases accepted; null: unknown. */
export function normalizeBackend(value: unknown): BackendId | "auto" | "native" | null {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v || v === "auto" || v === "default") return "auto";
  const alias: Record<string, string> = { bubblewrap: "bwrap", "apple-container": "apple", container: "apple", "wsl-containers": "wslc", "wsl-container": "wslc", desktop: "docker-desktop", "docker desktop": "docker-desktop", "podman-machine": "podman", off: "native", none: "native", host: "native" };
  const id = alias[v] ?? v;
  if (id === "native") return "native";
  return isBackendId(id) ? id : null;
}

/** Docker contexts (macOS, Windows): OrbStack, colima, Docker Desktop and Rancher each register one. */
export async function dockerContexts(bin: string, { run = runCommand, env = process.env, timeoutMs = 5_000 }: { run?: RunCommand; env?: Env; timeoutMs?: number } = {}): Promise<Array<{ name: string; endpoint: string; current: boolean }>> {
  const res = await run(bin, ["context", "ls", "--format", "{{json .}}"], { env, timeoutMs });
  if (res.code !== 0) return [];
  const out = [];
  for (const line of String(res.stdout).split("\n")) {
    try {
      const row = JSON.parse(line);
      if (row && typeof row.Name === "string" && row.Name) out.push({ name: row.Name, endpoint: String(row.DockerEndpoint ?? ""), current: Boolean(row.Current) });
    } catch { /* skip */ }
  }
  return out;
}

type Probed = RuntimeResult & { backend: string };

function contextBackendGuess(name: string): string {
  if (/orbstack/i.test(name)) return "orbstack";
  if (/colima/i.test(name)) return "colima";
  if (/desktop/i.test(name)) return "docker-desktop";
  if (/rancher/i.test(name)) return "rancher";
  return "docker";
}

/** Every container runtime here, probed, each with its backend id. */
export async function probeContainers({ platform, env, home, exists, run, wsl, timeoutMs }: { platform: NodeJS.Platform; env: Env; home: string; exists: (file: string) => boolean; run: RunCommand; wsl: boolean; timeoutMs?: number | undefined }): Promise<Probed[]> {
  const out: Probed[] = [];
  const seen = new Set<string>();
  const limit = timeoutMs ? { timeoutMs } : {};
  for (const candidate of candidates({ platform, home, env, exists, wsl })) {
    // /bin/docker and /usr/bin/docker are one program on merged-/usr systems.
    let real = candidate.bin;
    try { real = realpathSync(candidate.bin); } catch { /* keep */ }
    if (seen.has(real)) continue;
    seen.add(real);
    if (candidate.name === "docker" && platform !== "linux" && !env.DOCKER_HOST && !env.DOCKER_CONTEXT && !candidate.skipped) {
      const contexts = await dockerContexts(candidate.bin, { run, env });
      const named = contexts.filter((c) => c.name !== "default");
      if (named.length) {
        for (const ctx of [...named, ...contexts.filter((c) => c.name === "default")]) {
          const prefix = ["--context", ctx.name];
          const probed = await probeContainer({ ...candidate, prefix }, { run, env, platform, wsl, ...limit });
          out.push(probed.ok
            ? { ...probed, prefix, context: ctx.name, backend: containerBackendId(probed) }
            : { ...probed, context: ctx.name, backend: contextBackendGuess(ctx.name) });
        }
        continue;
      }
    }
    const probed = await probeContainer(candidate, { run, env, platform, wsl, ...limit });
    out.push({ ...probed, backend: probed.ok ? containerBackendId(probed) : candidate.name });
  }
  return out;
}

function cacheFile(boxHome: string): string {
  return path.join(boxHome, "runtime.json");
}

function readCache(boxHome: string, now: number, key: string): RuntimeResult | null {
  try {
    const cached = JSON.parse(readFileSync(cacheFile(boxHome), "utf8"));
    if (cached?.key !== key) return null;
    const age = now - Number(cached.at);
    if (!(age >= 0)) return null;
    if (cached.result?.ok ? age < CACHE_OK_MS : age < CACHE_FAIL_MS) return cached.result;
  } catch { /* none */ }
  return null;
}

function writeCache(boxHome: string, key: string, result: RuntimeResult, now: number): void {
  try {
    mkdirSync(boxHome, { recursive: true });
    const file = cacheFile(boxHome);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ key, at: now, result }), { mode: 0o600 });
    renameSync(tmp, file);
  } catch { /* best effort */ }
}

/** One line when nothing works, with the free option to install. */
export function noneReason(platform: NodeJS.Platform): string {
  if (platform === "linux") return "no sandbox backend works here (install bubblewrap, Podman or Docker)";
  if (platform === "darwin") return "no container runtime found (free: `brew install colima docker && colima start`; also OrbStack, Docker Desktop, Podman; Apple container only when chosen in Settings)";
  return "no sandbox backend found (turn on WSL 2: `wsl --install --no-distribution` as administrator, then `wsl --update` for WSL containers; or Docker Desktop, Podman)";
}

function alternative(r: Probed | { backend: string; name: string; ok: false; reason: string }): BackendAlternative {
  const version = "version" in r && typeof r.version === "string" ? r.version : null;
  const flavor = r.ok ? r.flavor : null;
  const reason = r.ok ? null : r.reason;
  const context = "context" in r && typeof r.context === "string" ? r.context : undefined;
  return { backend: r.backend, name: r.name ?? r.backend, ok: r.ok, version, flavor, reason, ...(context ? { context } : {}) };
}

/**
 * The backend for boxes on this machine (cached; `fresh` skips the cache;
 * `all` probes every backend and lists them as `alternatives`, for the
 * status). Returns the runtime ({ ok: true, backend, name, bin, version,
 * flavor, ..., why }) or { ok: false, reason, tried }. `asked`: a backend id
 * or "auto" (the setting); `allow`: the server's allowlist (null: any).
 */
export async function detectBackend({ boxHome, env = process.env, platform = process.platform, home = os.homedir(), exists = existsSync, run = runCommand, wsl = platform === "linux" && isWsl(env), now = Date.now(), fresh = false, all = false, timeoutMs, asked = env.MARS_BOX_BACKEND, allow = null, arch = process.arch, release = os.release() }: DetectOptions = {}): Promise<RuntimeResult> {
  let wanted = normalizeBackend(asked);
  let legacyRuntime = String(env.MARS_BOX_RUNTIME || "").trim();
  // MARS_BOX_RUNTIME naming a backend's own program picks that backend (the host kits do).
  const named = runtimeBackend(legacyRuntime, platform);
  if (named && wanted === "auto") { wanted = normalizeBackend(named); legacyRuntime = ""; }
  const allowList = Array.isArray(allow) ? allow.map(normalizeBackend).filter((id): id is BackendId | "auto" | "native" => Boolean(id)) : null;
  const key = JSON.stringify([2, platform, wanted, allowList, legacyRuntime, env.DOCKER_HOST || "", env.PATH || env.Path || "", env.MARS_BOX_BWRAP || ""]);
  if (boxHome && !fresh && !all) {
    const cached = readCache(boxHome, now, key);
    if (cached) return { ...cached, cached: true };
  }
  if (wanted === null) return { ok: false, reason: `unknown sandbox backend "${asked}" (one of: auto, ${BACKENDS.join(", ")}, native)`, tried: [] };
  if (wanted === "native") return { ok: false, reason: "the sandbox backend is set to native (this machine)", tried: [], native: true };
  let order: string[] = backendsFor(platform);
  // MARS_BOX_RUNTIME (docker, podman or a path) keeps meaning "this container CLI".
  if (legacyRuntime) order = order.filter((id) => !["bwrap", "apple", "wslc", "wsl", "wsl-engine"].includes(id));
  let why = `the first that works here, in order: ${order.join(" > ")}`;
  if (wanted !== "auto") {
    order = [wanted];
    why = "chosen in Settings (sandbox backend)";
  }
  const skipped: Array<{ backend: string; name: string; ok: false; reason: string }> = [];
  if (allowList) {
    for (const id of order) if (!allowList.some((allowed) => allowed === id)) skipped.push({ backend: id, name: id, ok: false, reason: "not allowed by the server" });
    order = order.filter((id) => allowList.some((allowed) => allowed === id));
    why += `; the server allows ${allowList.join(", ")}`;
  }
  const limit = timeoutMs ? { timeoutMs } : {};
  let containers: Probed[] | null = null;
  const containerList = async () => (containers ??= await probeContainers({ platform, env, home, exists, run, wsl, timeoutMs }));
  const results: Array<Probed | { backend: string; name: string; ok: false; reason: string }> = [];
  let chosen: (RuntimeInfo & { backend: string }) | null = null;
  for (const id of order) {
    let found: Probed[];
    if (id === "bwrap") found = [{ backend: "bwrap", ...(await probeBwrap({ env, boxHome: boxHome ?? path.join(home, ".mars", "box"), run, exists, platform, arch, ...limit })) }];
    else if (id === "apple") found = [{ backend: "apple", ...(await probeApple({ env, platform, arch, release, run, exists, ...limit })) }];
    else if (id === "wsl") found = [{ backend: "wsl", ...(await probeWslDistro({ env, platform, run, exists, arch, ...limit })) }];
    else if (id === "wslc") found = [{ backend: "wslc", ...(await probeWslc({ env, platform, run, exists, arch, explicit: wanted === "wslc", ...limit })) }];
    else if (id === "wsl-engine") {
      if (platform !== "win32" || env.MARS_BOX_WSL === "0") continue;
      const bin = wslLauncher({ env, exists });
      if (!bin) continue;
      const probed = await probeWsl(bin, { run, env, ...limit });
      found = [{ ...probed, backend: "wsl-engine" }];
    } else {
      const list = await containerList();
      found = list.filter((r) => r.backend === id || (wanted === id && id === "docker" && r.name === "docker"));
      // A runtime that failed before its flavor was known (a stopped colima) shows up once, under its guess.
      if (!found.length) {
        if (all) results.push({ backend: id, name: id, ok: false, reason: "not found" });
        continue;
      }
    }
    for (const result of found) {
      results.push(result);
      if (result.ok && !chosen) chosen = result;
    }
    if (chosen && !all) break;
  }
  if (all && containers === null) await containerList();
  // Opt-in backends are listed for the status, never probed or started unless chosen.
  if (all && wanted === "auto") for (const id of OPT_IN[platform] ?? []) if (!results.some((r) => r.backend === id)) results.push({ backend: id, name: id, ok: false, reason: "opt-in only: choose it in Settings (sandbox backend)" });
  const probedContainers: Probed[] = containers ?? [];
  if (all) for (const r of probedContainers) if (!results.some((x) => "bin" in x && x.bin === r.bin && ("context" in x ? x.context : undefined) === r.context && x.name === r.name)) results.push(r);
  const failed = [...skipped, ...results.filter((r) => !r.ok)];
  const tried: RuntimeTried[] = failed.map((r) => ({ backend: r.backend, ...(r.name ? { name: r.name } : {}), ...("bin" in r && r.bin ? { bin: r.bin } : {}), reason: r.ok ? "" : r.reason }));
  let result: RuntimeResult;
  if (chosen) {
    result = { ...chosen, why };
  } else {
    const reasons = tried.filter((t) => t.reason).map((t) => `${t.backend}: ${t.reason}`);
    const failure: RuntimeFailure = { ok: false, reason: reasons.length ? reasons.join("; ") : noneReason(platform), tried };
    if (platform === "darwin" && !results.some((r) => r.ok)) failure.hint = "colima";
    result = failure;
  }
  if (all) result.alternatives = [...skipped, ...results].map(alternative);
  if (boxHome && !all) writeCache(boxHome, key, result, now);
  return result;
}
