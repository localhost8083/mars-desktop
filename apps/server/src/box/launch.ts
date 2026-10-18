// Ported from the CLI (mars-cli src/box/launch.js,
// feat/local-box-backends); keep the shared parts in step. Desktop
// differences: the per-project choice lives in the workspace's Mars
// settings (service.ts), not box.json (box.json keeps only the machine's
// backend, as the CLI's does); the plan is per workspace (one engine serves
// every project); a run tracks its turns per chat; there is no --sandbox or
// --sandbox-backend flag (MARS_BOX=1|0 and MARS_BOX_BACKEND still
// override); a download with no detached command (the WSL distro) runs in
// this process.
//
// Whether a chat runs in its project's box, and the box's part in a run:
// the engine config bits (shell, plugin), the per-turn checkpoints, the
// trace label.
//
// Never blocking: the runtime probe and the image check are bounded; a
// missing image starts a download in the background and the project runs on
// this machine meanwhile (one line says so); the box itself starts in the
// background, and a shell call waits for it (boxsh).

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { boxKey, containerName, gcBoxes, installShell, openBox, recordFile, savedTurns, type Box, type BoxInstallLog, type BoxLabel, type BoxLog, type BoxRuntime, type CheckpointSummary } from "./box.js";
import { driverFor, normalizeBackend } from "./backends/index.js";
import type { BoxExec } from "./backends/types.js";
import { detectStack, imageFor, loadPins, type BoxImage } from "./images.js";
import { detectRuntime, runCommand, type RunCommand, type RuntimeResult } from "./runtime.js";

export const MODES = ["off", "offer", "on"] as const;
export type ServerBoxDefault = (typeof MODES)[number];
/** A project's own choice: "on", "off", or none (the server's default). */
export type ProjectBoxMode = "on" | "off" | null;

function isMode(value: unknown): value is ServerBoxDefault {
  return MODES.some((mode) => mode === value);
}

// --- the server's default -----------------------------------------------------------

/** The server's switch as last seen (GET /collect/capabilities -> local_box.default). */
export function serverDefault(stateDir: string): ServerBoxDefault {
  try {
    const value = JSON.parse(readFileSync(path.join(stateDir, "box-server.json"), "utf8"));
    return isMode(value?.default) ? value.default : "off";
  } catch {
    return "off";
  }
}

/** The server's allowlist of backends (local_box.backends; null: any). */
export function serverBackends(stateDir: string): string[] | null {
  try {
    const value = JSON.parse(readFileSync(path.join(stateDir, "box-server.json"), "utf8"));
    return Array.isArray(value?.backends) ? value.backends.filter((b: unknown): b is string => typeof b === "string") : null;
  } catch {
    return null;
  }
}

/** Remembers local_box.default (and its backends allowlist) of a capabilities answer; whether either changed. */
export function rememberServerDefault(stateDir: string, capabilities: { local_box?: unknown } | null | undefined): boolean {
  const block = capabilities?.local_box;
  if (!block || typeof block !== "object") return false;
  const fields: { default?: unknown; max_turn_bytes?: unknown; backends?: unknown } = block;
  const value = isMode(fields.default) ? fields.default : "off";
  const backends = Array.isArray(fields.backends) ? fields.backends.filter((b): b is string => typeof b === "string").slice(0, 32) : null;
  const before = JSON.stringify([serverDefault(stateDir), serverBackends(stateDir)]);
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "box-server.json"), JSON.stringify({ default: value, max_turn_bytes: fields.max_turn_bytes ?? null, backends, at: Date.now() }), { mode: 0o600 });
  } catch { /* best effort */ }
  return before !== JSON.stringify([value, backends]);
}

/**
 * Reads the server's default again every `everyMs` while the app runs (an app
 * started before a switch was flipped, or kept open for days, follows it
 * without a restart) and calls `apply` when it (or its backends allowlist)
 * changed. One read at a time; a failed one leaves the last answer. Returns
 * the stop.
 */
export function watchServerDefault({ stateDir, read, apply, everyMs }: { stateDir: string; read: () => Promise<{ local_box?: unknown } | null | undefined>; apply: () => Promise<unknown>; everyMs: number }): () => void {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void read()
      .then((capabilities) => (rememberServerDefault(stateDir, capabilities) ? apply() : undefined))
      .catch(() => undefined)
      .finally(() => { busy = false; });
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// --- the backend --------------------------------------------------------------------

/** What the backend setting holds: "auto" (the ranked order), one backend id, or "native" (no box). */
export type BackendSetting = string;

/** The machine's box settings file (the CLI's box.json; the desktop keeps only `backend` in it). */
export function settingsFile(stateDir: string): string {
  return path.join(stateDir, "box.json");
}

/** The saved backend setting ("auto" when none). */
export function readBackend(stateDir: string): BackendSetting {
  try {
    return normalizeBackend(JSON.parse(readFileSync(settingsFile(stateDir), "utf8"))?.backend) || "auto";
  } catch {
    return "auto";
  }
}

/** Save the backend boxes on this machine use: "auto" or one id (the desktop setting). */
export function saveBackend(stateDir: string, backend: unknown): BackendSetting {
  const id = normalizeBackend(backend);
  if (!id) throw new Error(`unknown sandbox backend "${String(backend)}"`);
  let current: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(readFileSync(settingsFile(stateDir), "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) current = Object.fromEntries(Object.entries(value));
  } catch { /* none */ }
  mkdirSync(stateDir, { recursive: true });
  const file = settingsFile(stateDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...current, backend: id }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return id;
}

/** The backend asked for, and by whom: MARS_BOX_BACKEND, then the saved setting. */
export function askedBackend({ env = process.env, stateDir }: { env?: NodeJS.ProcessEnv; stateDir: string }): { backend: string; source: "env" | "setting" | "auto" } {
  const flag = String(env.MARS_BOX_BACKEND || "").trim();
  if (flag) return { backend: normalizeBackend(flag) ?? flag, source: "env" };
  const saved = readBackend(stateDir);
  return { backend: saved, source: saved !== "auto" ? "setting" : "auto" };
}

/**
 * On or off for a project, and why: MARS_BOX=1|0 (every project), then
 * the project's setting, then (a buildathon project, buildathon-repro.ts) the
 * event's `repro.box`, then the server's default ("on"; "offer" shows a
 * one-line offer until the project was offered it once; "off"). A buildathon
 * project kept off by MARS_BOX=0 or its own switch says so (`lessRepro`).
 * CLI: src/box/launch.js resolveMode, the same order.
 */
export function resolveMode({ env = process.env, project, server, offered = false, buildathon = null }: { env?: NodeJS.ProcessEnv; project: ProjectBoxMode; server: ServerBoxDefault; offered?: boolean; buildathon?: "on" | "offer" | "off" | null }): { on: boolean; source: "env" | "project" | "server" | "default" | "buildathon"; offer: boolean; lessRepro?: true } {
  const lessRepro = buildathon === "on" || buildathon === "offer" ? { lessRepro: true as const } : {};
  const asked = String(env.MARS_BOX ?? "").trim().toLowerCase();
  if (["1", "on", "true"].includes(asked)) return { on: true, source: "env", offer: false };
  if (["0", "off", "false"].includes(asked)) return { on: false, source: "env", offer: false, ...lessRepro };
  if (project === "on" || project === "off") return { on: project === "on", source: "project", offer: false, ...(project === "off" ? lessRepro : {}) };
  if (buildathon === "on") return { on: true, source: "buildathon", offer: false };
  if (buildathon === "offer" && server !== "on") return { on: false, source: "buildathon", offer: !offered };
  if (server === "on") return { on: true, source: "server", offer: false };
  return { on: false, source: server === "offer" ? "server" : "default", offer: server === "offer" && !offered };
}

// --- background download ---------------------------------------------------------------

export function pullMarker(home: string, runtime: Pick<BoxRuntime, "backend" | "name">, image: string): string {
  return path.join(home, "pulls", `${runtime.backend ?? runtime.name}-${image.replace(/[^a-zA-Z0-9._-]+/g, "_")}.pid`);
}

/** The detached download's output (Desktop: its progress, pull-progress.ts). */
export function pullLog(marker: string): string {
  return marker.replace(/\.pid$/, ".log");
}

/** Downloads running in this process (a backend with no detached command: the WSL distro). */
const inProcess = new Set<string>();

/** Whether a background download of `image` with this backend is running. */
export function pulling(home: string, runtime: Pick<BoxRuntime, "backend" | "name">, image: string): boolean {
  const marker = pullMarker(home, runtime, image);
  if (inProcess.has(marker)) return true;
  try {
    const pid = Number(readFileSync(marker, "utf8"));
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the backend's download detached (survives this run); one at a time
 * per image. A backend without a detached command (the WSL distro, whose
 * download imports the distro first) downloads in this process instead.
 */
export function pullInBackground(runtime: BoxRuntime, image: BoxImage, home: string, { spawnImpl = spawn, env = process.env, log = () => {} }: { spawnImpl?: (command: string, args: string[], options: { detached: boolean; stdio: "ignore" | ["ignore", number, number]; windowsHide: boolean }) => Pick<ChildProcess, "pid" | "unref">; env?: NodeJS.ProcessEnv; log?: BoxLog } = {}): { started: boolean; pid: number | undefined } {
  const marker = pullMarker(home, runtime, image.pull);
  if (inProcess.has(marker)) return { started: false, pid: process.pid };
  try {
    const pid = Number(readFileSync(marker, "utf8"));
    if (pid) { process.kill(pid, 0); return { started: false, pid }; }
  } catch { /* none running */ }
  mkdirSync(path.dirname(marker), { recursive: true });
  const driver = driverFor(runtime);
  const cmd = driver.pullCommand(runtime, image, home);
  if (!cmd) {
    inProcess.add(marker);
    void driver.pull(runtime, image, { home, env, log })
      .then((res) => { if (!res.ok) log("warn", "box download failed", { backend: runtime.backend, error: res.error }); })
      .catch((error) => log("warn", "box download failed", { backend: runtime.backend, error: String(error?.message || error) }))
      .finally(() => inProcess.delete(marker));
    return { started: true, pid: process.pid };
  }
  // Its output goes to a log next to the marker (the Settings card reads its progress there).
  let out: number | null = null;
  try { out = openSync(pullLog(marker), "w", 0o600); } catch { /* no progress then */ }
  let child: Pick<ChildProcess, "pid" | "unref">;
  try {
    child = spawnImpl(cmd.bin, cmd.args, { detached: true, stdio: out === null ? "ignore" : ["ignore", out, out], windowsHide: true });
  } finally {
    if (out !== null) closeSync(out);
  }
  child.unref?.();
  try { writeFileSync(marker, String(child.pid ?? "")); } catch { /* best effort */ }
  return { started: true, pid: child.pid };
}

// --- one project -----------------------------------------------------------------------

export type ReadyPlan = {
  box: { key: string; home: string; root: string; runtime: BoxRuntime };
  notice: null;
  shell: string;
  /**
   * Open the box (once); resolves the Box (state "ready" or "failed").
   * `pkglog`: the install log's folder (phase 1: { root, bin, py } with
   * POSIX wrappers), mounted into a new box and put on its PATH.
   */
  start: (options?: { pkglog?: BoxInstallLog | null }) => Promise<Box>;
  /** What the box start is doing ("starting", "pulling", "ready", "failed"; null before it starts). */
  readonly phase: string | null;
};
export type NativePlan = { box: null; notice: string | null; runtime: RuntimeResult | null; image?: BoxImage; downloading?: boolean };
export type BoxPlan = ReadyPlan | NativePlan;

/**
 * Plan the box of the project at `root` (the project's box is on). Returns
 * { box: null, notice } when its chats run on this machine for now (no
 * runtime, no helpers, the image still downloading), else a ready plan.
 */
export async function planBox({ env = process.env, home, root, log = () => {}, run = runCommand, probeMs = 4_000, shims = null, asked = null, allow = null }: { env?: NodeJS.ProcessEnv; home: string; root: string; log?: BoxLog; run?: RunCommand; probeMs?: number; shims?: string | null; asked?: string | null; allow?: string[] | null }): Promise<BoxPlan> {
  const key = boxKey(root);
  const bounded = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> => Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
  const runtime = await bounded<RuntimeResult>(detectRuntime({ boxHome: home, env, run, ...(asked ? { asked } : {}), allow }), probeMs, { ok: false, reason: "the sandbox backend did not answer in time" });
  if (!runtime.ok) {
    log("info", "box unavailable", { reason: runtime.reason });
    return { box: null, notice: `Sandbox off for now: ${runtime.reason}.`, runtime };
  }
  let shell: string;
  try {
    shell = installShell(home, { env });
  } catch (error) {
    return { box: null, notice: `Sandbox off for now: ${error instanceof Error ? error.message : String(error)}.`, runtime };
  }
  // A box already made keeps its image (and its installs); a new one needs the image here.
  const driver = driverFor(runtime);
  const existing = await bounded(driver.exists(runtime, key, { run, home, env, timeoutMs: probeMs }), probeMs, false);
  if (!existing) {
    const image = imageFor(detectStack(root), { env });
    const present = await bounded(driver.imagePresent(runtime, image, { run, home, env }), probeMs, null);
    if (!present) {
      pullInBackground(runtime, image, home, { env, log });
      return { box: null, notice: `Sandbox is downloading (${image.approxMb ? `about ${image.approxMb} MB, ` : ""}once${runtime.backend === "wsl" && !runtime.installed ? ", with the Mars WSL distro" : ""}); chats here run on this machine until it is ready.`, runtime, image, downloading: true };
    }
  }
  if (env.MARS_BOX_GC !== "off") setTimeout(() => gcInBackground(runtime, home, { log }), 30_000).unref?.();
  let opening: Promise<Box> | null = null;
  let phase: string | null = null;
  return {
    box: { key, home, root, runtime },
    notice: null,
    shell,
    start: ({ pkglog = null } = {}) => {
      opening ??= openBox({ root, runtime, env, home, log, pull: false, shims, pkglog, onState: (state) => { phase = state; } });
      return opening;
    },
    get phase() { return phase; },
  };
}

/**
 * Old boxes and images, at most once a day, in the background (never on the
 * start path): containers of folders that are gone or unused for 30 days,
 * box images that are neither current nor used. Labelled/named ones only.
 */
export function gcInBackground(runtime: BoxRuntime, home: string, { log = () => {}, now = Date.now(), everyMs = 24 * 3_600_000, gc = gcBoxes }: { log?: BoxLog; now?: number; everyMs?: number; gc?: typeof gcBoxes } = {}): Promise<Array<{ kind: string; name: string; reason: string }>> | null {
  const marker = path.join(home, "gc.json");
  try {
    if (now - Number(JSON.parse(readFileSync(marker, "utf8")).at) < everyMs) return null;
  } catch { /* never ran */ }
  try { mkdirSync(home, { recursive: true }); writeFileSync(marker, JSON.stringify({ at: now })); } catch { return null; }
  return gc(runtime, { home, pins: loadPins() })
    .then((removed) => { if (removed.length) log("info", "box gc", { removed: removed.map((item) => `${item.kind}:${item.name}`) }); return removed; })
    .catch((error) => { log("warn", "box gc failed", { error: String(error?.message || error) }); return []; });
}

/** The package-manager wrappers' source folder (phase 1), mounted read-only when present. */
export function shimsDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const asked = String(env.MARS_BOX_SHIMS_DIR || "").trim();
  if (asked) return existsSync(path.join(asked, "install.sh")) ? path.resolve(asked) : null;
  return null;
}

/** Engine config additions for box runs: the shell and the plugin. */
export function engineConfig(bits: { shell: string; plugin: string } | null, config: Record<string, unknown>): Record<string, unknown> {
  if (!bits) return config;
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  return {
    ...config,
    shell: bits.shell,
    plugin: [...plugins, bits.plugin],
  };
}

/** Turn the record off (the project went on without the box). */
export function recordOff(home: string, key: string, reason: string): void {
  try {
    const file = recordFile(home, key);
    const rec = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...rec, state: "off", error: reason, updated: Date.now() }), { mode: 0o600 });
  } catch { /* none */ }
}

// --- the box during a run ------------------------------------------------------------

export type Frozen = {
  label: string;
  turn: number | null;
  copied: number;
  carried: number;
  save: (outDir?: string) => Promise<{ label: string; changed: number; bytes: number }>;
  discard: () => Promise<null>;
};

export type BoxRun = {
  key: string;
  container: string;
  runtimeBin: string;
  /** Arguments before the runtime's own (`-e docker` for a WSL engine). */
  runtimeArgs: string[];
  /** The backend id (backends/index.ts). */
  backend: string;
  /** How to run a program in the box with stdin open when it is not `docker exec` (files-used reads); null for container engines. */
  exec: BoxExec | null;
  root: string;
  readonly native: boolean;
  readonly box: Box | null;
  ready: () => Promise<Box | null>;
  /** environment.sandbox for a chat's uploads; null while it is not (or no longer) the chat's. */
  label: (sessionId: string) => BoxLabel | null;
  setTurn: (turn: number) => void;
  /** `sessionTurn`: the chat's own number of the prompt the checkpoint comes before (written as session_turn). */
  freeze: (label: string, options: { sessionId: string; turn?: number | null; sessionTurn?: number | null; chain?: string | null }) => Promise<Frozen | null>;
};

/**
 * What the capture wiring drives for one project's box: readiness, the
 * per-turn freeze, the label uploads carry (the toolchain probes run from
 * the capture worker: capture.ts). A box that
 * fails before any chat's first checkpoint turns the project native (record
 * "off"; the shell runs on this machine, its chats are not labelled); later
 * failures are logged and that turn has no checkpoint.
 */
export function boxRun(plan: ReadyPlan, { log = () => {}, readyWaitMs = 30_000, onNative = () => {}, tmpRoot, pkglog = null }: { log?: BoxLog; readyWaitMs?: number; onNative?: (reason: string) => void; tmpRoot?: string; pkglog?: BoxInstallLog | null } = {}): BoxRun {
  const { key, home, runtime, root } = plan.box;
  let box: Box | null = null;
  let native = false;
  const checkpoints = new Map<string, number>();
  const opening = plan.start({ pkglog }).then((opened) => { box = opened; return opened; });
  const goNative = (reason: string) => {
    if (native) return;
    native = true;
    recordOff(home, key, reason);
    log("warn", "box off for this project", { reason });
    onNative(reason);
  };
  // The time limit counts while the box starts, not while its image downloads (the CLI's
  // first --sandbox run on a slow link; here a box opens only once its image is in, so
  // this only matters if a start ever downloads).
  let settled = false;
  opening.finally(() => { settled = true; }).catch(() => {});
  const limit = () => new Promise<null>((resolve) => {
    let from = Date.now();
    const tick = () => {
      if (settled) return resolve(null);
      if (plan.phase === "pulling") from = Date.now();
      if (Date.now() - from >= readyWaitMs) return resolve(null);
      setTimeout(tick, Math.min(250, readyWaitMs)).unref?.();
    };
    tick();
  });
  const ready = async (): Promise<Box | null> => {
    if (native) return null;
    const opened = await Promise.race([opening, limit()]);
    if (opened?.ready) return opened;
    if ([...checkpoints.values()].every((count) => count === 0)) goNative(opened?.error || "the sandbox did not start in time");
    return null;
  };
  const pending = tmpRoot ?? path.join(home, "pending");
  return {
    key,
    container: containerName(key),
    runtimeBin: runtime.bin,
    runtimeArgs: runtime.prefix ?? [],
    backend: runtime.backend ?? runtime.name,
    exec: driverFor(runtime).kind === "container" ? null : driverFor(runtime).execCommand(runtime, { key, home }),
    root,
    get native() { return native; },
    get box() { return box; },
    ready,
    label: (sessionId) => (box?.ready && !native && (checkpoints.get(sessionId) ?? 0) > 0 ? box.label() : null),
    setTurn: (turn) => box?.setTurn(turn),
    /**
     * The old sandbox's freeze(label, { turn, chain }) -> { save(dir), discard() } | null:
     * the checkpoint is taken now and placed by save(); `final` (the state a
     * chat ends with) is a leaf, so a resumed chat chains on from its last turn.
     */
    freeze: async (label, { sessionId, turn = null, sessionTurn = null, chain = null }) => {
      const opened = await ready();
      if (!opened) return null;
      const n = Number(turn ?? /^turn-(\d+)$/.exec(label)?.[1] ?? 0) || null;
      const name = n ? `turn-${n}` : label;
      const dir = chain ?? path.join(pending, `${process.pid}-${Date.now()}`);
      const taken = await opened.checkpoint(dir, n, { label: name, leaf: !n, sessionTurn: n ? sessionTurn : null });
      checkpoints.set(sessionId, (checkpoints.get(sessionId) ?? 0) + 1);
      const summary: CheckpointSummary = taken.summary;
      return {
        label: name,
        turn: n,
        copied: summary.stats.copied,
        carried: Math.max(0, summary.stats.kept - summary.stats.copied),
        save: async (outDir) => {
          taken.commit(outDir ?? dir);
          return { label: name, changed: summary.delta.changed.length, bytes: summary.bytes };
        },
        discard: async () => { taken.discard(); return null; },
      };
    },
  };
}

/** A host path under the project, as the box sees it. */
export function mapToBox(p: string, root: string, croot: string): string {
  if (root === croot) return p;
  const rel = path.relative(root, p);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return croot;
  return rel ? `${croot}/${rel.split(path.sep).join("/")}` : croot;
}

export { savedTurns };
