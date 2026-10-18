// Ported from the CLI (mars-cli src/box/backends/bwrap.js,
// feat/local-box-backends); keep the two in step. Desktop differences: types;
// the one-time admin step (`sudo mars sandbox enable`) is the CLI's, so
// the AppArmor reason names the CLI; boxrun missing from the sidecars is a
// reason, not a path.
//
// The bubblewrap backend (Linux; also what runs inside the Mars WSL
// distro): no daemon, no root, nothing to install where unprivileged user
// namespaces work. `boxrun` (box/go/cmd/boxrun) pulls the pinned image and
// unpacks it (~/.mars/box/bwrap/store), and runs each project's box as
// that root filesystem under a per-project overlay upper layer
// (~/.mars/box/bwrap/boxes/<key>), in its own user, mount, PID, IPC and
// UTS namespaces, on the host's network. The upper layer stays on disk, so
// installs survive restarts; boxd is the same helper the containers run.
//
// Ubuntu 23.10+ blocks unprivileged user namespaces through AppArmor
// (kernel.apparmor_restrict_unprivileged_userns=1): the probe says so in one
// line and the next backend (rootless Podman, Docker) is used.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { GOARCH, RUN_DIR, SHIMS_DIR, containerName, containerRoot, helperPath, newToken, readJson, writeJson, type BoxInstallLog, type BoxRuntime } from "../common.js";
import { runCommand, type RunCommand, type RunOptions } from "../run.js";
import type { RuntimeResult } from "../runtime.js";
import { boxshExec, num, parseOut, str } from "./shared.js";
import type { BoxDriver, ListedBox, OpenContext, Opened, PresentImage, Removed } from "./types.js";

export { parseOut } from "./shared.js";

type Env = NodeJS.ProcessEnv;

/** Where `sudo mars sandbox enable` (the CLI) puts Mars's bwrap (root-owned, profiled). */
export const ENABLED_BWRAP = "/usr/local/lib/mars/bwrap";
export const APPARMOR_PROFILE = "/etc/apparmor.d/mars-bwrap";
/** boxd exits (and the box with it) after this long with no request. */
export const IDLE_MINUTES = 120;

export function bwrapHome(home: string): string {
  return path.join(home, "bwrap");
}
const storeDir = (home: string) => path.join(bwrapHome(home), "store");
const boxDir = (home: string, key: string) => path.join(bwrapHome(home), "boxes", key);
const metaFile = (home: string, key: string) => path.join(bwrapHome(home), "boxes", `${key}.json`);

/** A box's own record (boxes/<key>.json under the backend's folder). */
export type BoxMeta = {
  v: 1; key: string; root: string; croot: string; image: string; arch: string; ref: string; pull: string; digest: string | null;
  config?: string; stack: string; token: string; instance: string; created_at: string; mounts?: string[];
};

/** boxrun for this machine's architecture (inside a box: linux/<arch>); null when this install has none. */
export function boxrunPath({ env = process.env, arch = process.arch }: { env?: Env; arch?: string } = {}): string | null {
  return helperPath("boxrun", { goos: "linux", goarch: GOARCH[arch] || "amd64", env });
}

/**
 * The bwrap to use, best first: MARS_BOX_BWRAP, the profiled copy
 * `sandbox enable` installed, the one shipped with Mars (static, for
 * systems without bubblewrap). Null: boxrun looks for the system's.
 */
export function bwrapPath({ env = process.env, arch = process.arch, exists = existsSync }: { env?: Env; arch?: string; exists?: (file: string) => boolean } = {}): string | null {
  const asked = String(env.MARS_BOX_BWRAP || "").trim();
  if (asked) return asked;
  if (exists(ENABLED_BWRAP)) return ENABLED_BWRAP;
  const shipped = helperPath("bwrap", { goos: "linux", goarch: GOARCH[arch] || "amd64", env });
  return shipped && exists(shipped) ? shipped : null;
}

/** One line for each reason boxrun's probe gives. */
export function explainProbe(out: Record<string, unknown> | null): string {
  const reason = str(out?.reason) || "bubblewrap could not start";
  switch (out?.code) {
    case "apparmor":
      return `${reason}; one-time admin fix: \`sudo mars sandbox enable\` (Mars CLI)`;
    case "no_bwrap":
      return `${reason} (\`sudo apt install bubblewrap\` or your system's package)`;
    case "userns_off":
      return `${reason}; an admin can allow them, or use Podman or Docker`;
    case "container":
      return `${reason}; run Mars on the host, or give this container a Docker or Podman engine`;
    default:
      return reason;
  }
}

/** Can boxes run here with bubblewrap? A real start (5–20 ms), never a guess from the distro. */
export async function probeBwrap({ env = process.env, boxHome, run = runCommand, timeoutMs = 6_000, arch = process.arch, exists = existsSync, platform = process.platform }: { env?: Env; boxHome: string; run?: RunCommand; timeoutMs?: number; arch?: string; exists?: (file: string) => boolean; platform?: NodeJS.Platform }): Promise<RuntimeResult> {
  const base = { name: "bwrap", backend: "bwrap" };
  if (platform !== "linux") return { ...base, ok: false, reason: "bubblewrap is Linux only" };
  const bin = boxrunPath({ env, arch });
  if (!bin || !exists(bin)) return { ...base, ok: false, ...(bin ? { bin } : {}), reason: "the sandbox helper boxrun is missing from this install" };
  try { mkdirSync(boxHome, { recursive: true }); } catch { /* the probe says */ }
  const args = ["probe", "--dir", boxHome];
  const bw = bwrapPath({ env, arch, exists });
  if (bw) args.push("--bwrap", bw);
  const res = await run(bin, args, { env: { PATH: env.PATH || "/usr/bin:/bin", USER: env.USER || "" }, timeoutMs });
  const out = parseOut(res.stdout);
  if (!out) return { ...base, ok: false, bin, reason: res.error === "timeout" ? "the bubblewrap probe did not answer in time" : `boxrun probe failed: ${String(res.stderr || "").trim().slice(0, 200)}` };
  if (!out.ok) return { ...base, ok: false, bin, code: str(out.code), reason: explainProbe(out) };
  return {
    ...base, ok: true, bin, bwrap: str(out.bwrap) || bw || null,
    version: str(out.bwrap_version),
    os: "linux", arch: GOARCH[arch] || arch,
    flavor: out.overlay === "fuse" ? "fuse-overlayfs" : "overlayfs",
    idmap: str(out.idmap) || "single", launcher: str(out.launcher) || "bwrap",
    rootless: !out.root, vm: false, kernel: str(out.kernel) || os.release(),
  };
}

function storeArgs(home: string): string[] {
  return ["--store", storeDir(home)];
}

function presentOf(out: Record<string, unknown> | null): PresentImage | null {
  if (!out?.present) return null;
  return { id: str(out.id), digest: str(out.digest) || null, arch: str(out.arch), config: str(out.config) };
}

async function imagePresent(runtime: BoxRuntime, image: { pull: string }, { run = runCommand, home = "" }: { run?: RunCommand; home?: string } = {}): Promise<PresentImage | null> {
  const res = await run(runtime.bin, ["image", ...storeArgs(home), "--ref", image.pull, "--arch", runtime.arch || GOARCH[process.arch] || "amd64"], { timeoutMs: 15_000 });
  return presentOf(parseOut(res.stdout));
}

/** `onLine`: boxrun's output lines as they come (its progress, for a progress line). */
async function pull(runtime: BoxRuntime, image: { pull: string }, { run = runCommand, home = "", onLine }: { run?: RunCommand; home?: string; onLine?: RunOptions["onLine"] } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await run(runtime.bin, ["pull", ...storeArgs(home), "--ref", image.pull, "--arch", runtime.arch || GOARCH[process.arch] || "amd64"], { timeoutMs: 60 * 60_000, ...(onLine ? { onLine } : {}) });
  const out = parseOut(res.stdout);
  return out?.ok ? { ok: true } : { ok: false, error: String(out?.error || res.stderr || `boxrun pull exited ${res.code}`).slice(0, 300) };
}

/** boxd's environment in a box (what `docker create -e` gives the containers). */
export function boxdEnv({ token, croot, idleMinutes = IDLE_MINUTES, listen = "127.0.0.1:0" }: { token: string; croot: string; idleMinutes?: number; listen?: string }): string[] {
  return [
    `BOXD_TOKEN=${token}`, "BOXD_UID=0", "BOXD_GID=0", "BOXD_HOME=/root", `BOXD_ROOT=${croot}`,
    `BOXD_ENV_FILE=${RUN_DIR}/env`, `BOXD_LISTEN=${listen}`, `BOXD_PORT_FILE=${RUN_DIR}/boxd.port`, `BOXD_IDLE_EXIT=${idleMinutes}`,
    "LANG=C.UTF-8", "DEBIAN_FRONTEND=noninteractive",
  ];
}

/** `boxrun up` arguments for a project's box. */
export function upArgs({ box, store, image, boxd, portFile, root, croot, runFolder, shims = null, pkglog = null, token, bwrap = null, idleMinutes = IDLE_MINUTES, listen, platform = "linux", mapPath = (p: string) => p }: { box: string; store: string; image: string; boxd: string; portFile: string; root: string; croot: string; runFolder: string; shims?: string | null; pkglog?: Pick<BoxInstallLog, "root"> | null; token: string; bwrap?: string | null; idleMinutes?: number; listen?: string; platform?: NodeJS.Platform; mapPath?: (p: string) => string }): string[] {
  const args = ["up", "--box", box, "--store", store, "--image", image, "--boxd", boxd, "--port-file", portFile,
    "--bind", `${mapPath(root)}=${croot}`, "--bind", `${mapPath(runFolder)}=${RUN_DIR}`];
  if (shims) args.push("--ro-bind", `${mapPath(shims)}=${SHIMS_DIR}-src`);
  if (pkglog) args.push("--bind", `${mapPath(pkglog.root)}=${containerRoot(pkglog.root, platform)}`);
  for (const kv of boxdEnv({ token, croot, idleMinutes, ...(listen ? { listen } : {}) })) args.push("--env", kv);
  if (bwrap) args.push("--bwrap", bwrap);
  return args;
}

/** A new box's own record. */
export function newMeta({ key, root, croot, present, image }: { key: string; root: string; croot: string; present: PresentImage; image: { ref: string; pull: string; digest: string | null; stack: string } }): BoxMeta {
  return { v: 1, key, root, croot, image: present.id, arch: present.arch, ref: image.ref, pull: image.pull, digest: image.digest || present.digest, ...(present.config ? { config: present.config } : {}), stack: image.stack, token: newToken(), instance: newToken().slice(0, 12), created_at: new Date().toISOString() };
}

async function open(ctx: OpenContext): Promise<Opened> {
  const { key, root, croot, runtime, run, home, runFolder, image, pull: mayPull, shims, pkglog, env, log, onPulling, onLine } = ctx;
  const file = metaFile(home, key);
  let meta = readJson<BoxMeta>(file);
  if (meta && meta.root !== root) return { ok: false, error: `box ${key} belongs to another folder` };
  let created = null;
  if (!meta || !existsSync(boxDir(home, key))) {
    let present = await imagePresent(runtime, image, { run, home });
    if (!present) {
      if (!mayPull) return { ok: false, error: "the sandbox image is not downloaded yet" };
      onPulling();
      const pulled = await pull(runtime, image, { run, home, onLine });
      if (!pulled.ok) return { ok: false, error: `could not download the sandbox image: ${pulled.error}` };
      present = await imagePresent(runtime, image, { run, home });
      if (!present) return { ok: false, error: "the sandbox image is not there after the download" };
    }
    meta = newMeta({ key, root, croot, present, image });
    mkdirSync(path.dirname(file), { recursive: true });
    writeJson(file, meta);
    created = { ref: image.ref, pull: image.pull, digest: meta.digest, id: present.config || present.id, stack: image.stack };
    log("info", "box created", { key, image: image.pull, stack: image.stack, backend: "bwrap" });
  }
  const boxd = helperPath("boxd", { goos: "linux", goarch: GOARCH[meta.arch] || runtime.arch || "amd64", env });
  if (!boxd) return { ok: false, error: "the sandbox helper boxd is missing from this install" };
  const portFile = path.join(runFolder, "boxd.port");
  const idle = Number(env.MARS_BOX_IDLE_MIN) > 0 ? Number(env.MARS_BOX_IDLE_MIN) : IDLE_MINUTES;
  const args = upArgs({ box: boxDir(home, key), store: storeDir(home), image: meta.image, boxd, portFile, root, croot, runFolder, shims, pkglog, token: meta.token, bwrap: runtime.bwrap ?? null, idleMinutes: idle });
  // MARS_BOX_OVERLAY=fuse: fuse-overlayfs only (a kernel without overlayfs in user namespaces, or a test of one).
  if (String(env.MARS_BOX_OVERLAY || "").toLowerCase() === "fuse") args.push("--overlay", "fuse");
  const res = await run(runtime.bin, args, { timeoutMs: 45_000, env: { PATH: env.PATH || "/usr/bin:/bin", USER: env.USER || "" } });
  const out = parseOut(res.stdout);
  const port = num(out?.port);
  if (!out?.ok || !port) return { ok: false, error: `could not start the sandbox: ${String(out?.error || res.stderr || res.error || res.code).slice(0, 300)}` };
  // The folders this running box was started with (a box another session
  // started keeps its own until it stops).
  const mounts = [croot, RUN_DIR, ...(shims ? [`${SHIMS_DIR}-src`] : []), ...(pkglog ? [containerRoot(pkglog.root)] : [])];
  if (!out.reused) writeJson(file, { ...meta, mounts, started_at: new Date().toISOString(), launcher: out.launcher, idmap: out.idmap, overlay: out.overlay });
  return { ok: true, created, endpoint: { host: "127.0.0.1", port, token: meta.token }, uid: 0, gid: 0, containerId: `bwrap_${key}_${meta.instance}`, imageId: meta.config || meta.image, mounts: out.reused ? (meta.mounts ?? mounts) : mounts, timing: { ...(num(out.ms) !== null ? { ms: num(out.ms) ?? 0 } : {}), reused: Boolean(out.reused) } };
}

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM"; }
}

async function list(_runtime: BoxRuntime, { home = "" }: { home?: string } = {}): Promise<ListedBox[]> {
  const dir = path.join(bwrapHome(home), "boxes");
  let names: string[] = [];
  try { names = readdirSync(dir).filter((name) => name.endsWith(".json")); } catch { return []; }
  const out: ListedBox[] = [];
  for (const name of names) {
    const meta = readJson<BoxMeta>(path.join(dir, name));
    if (!meta?.key) continue;
    let running = false;
    try { running = pidAlive(JSON.parse(readFileSync(path.join(boxDir(home, meta.key), "state.json"), "utf8")).pid); } catch { /* stopped */ }
    out.push({ key: meta.key, name: containerName(meta.key), root: meta.root, running, image: meta.pull || meta.ref || meta.image, created: meta.created_at || "" });
  }
  return out;
}

export const bwrapDriver: BoxDriver = {
  kind: "bwrap",
  execFallback: false,
  imagePresent,
  pull,
  pullCommand(runtime, image, home) {
    return { bin: runtime.bin, args: ["pull", ...storeArgs(home), "--ref", image.pull, "--arch", runtime.arch || GOARCH[process.arch] || "amd64"] };
  },
  async exists(_runtime, key, { home = "" } = {}) {
    return existsSync(metaFile(home, key)) && existsSync(boxDir(home, key));
  },
  open,
  list,
  async remove(runtime, key, { run = runCommand, home = "" } = {}) {
    const res = await run(runtime.bin, ["rm", "--box", boxDir(home, key), ...(runtime.bwrap ? ["--bwrap", runtime.bwrap] : [])], { timeoutMs: 120_000 });
    const had = existsSync(metaFile(home, key));
    rmSync(metaFile(home, key), { force: true });
    return { removed: had && Boolean(parseOut(res.stdout)?.ok) };
  },
  async stop(runtime, key, { run = runCommand, home = "" } = {}) {
    const res = await run(runtime.bin, ["stop", "--box", boxDir(home, key)], { timeoutMs: 60_000 });
    return { stopped: Boolean(parseOut(res.stdout)?.ok) };
  },
  async gcImages(runtime, { run = runCommand, home = "", current, used }) {
    const removed: Removed[] = [];
    const dir = path.join(storeDir(home), "images");
    let ids: string[] = [];
    try { ids = readdirSync(dir); } catch { return removed; }
    const usedIds = new Set<string>();
    for (const box of await list(runtime, { home })) {
      const meta = readJson<BoxMeta>(metaFile(home, box.key));
      if (meta?.image) usedIds.add(meta.image);
    }
    const plain = (ref: unknown) => String(ref || "").replace(/@sha256:[0-9a-f]{64}$/, "").replace(/^docker\.io\//, "");
    const currentPlain = new Set([...current].map(plain));
    for (const id of ids) {
      const img = readJson<{ ref?: string }>(path.join(dir, id, "image.json"));
      if (!img || usedIds.has(id) || used.has(String(img.ref)) || currentPlain.has(plain(img.ref))) continue;
      if (!/(^|\/)mars-ai\/box-[a-z]+:/.test(String(img.ref))) continue;
      const res = await run(runtime.bin, ["rmimage", ...storeArgs(home), "--id", id], { timeoutMs: 120_000 });
      if (parseOut(res.stdout)?.ok) removed.push({ kind: "image", name: String(img.ref), reason: "not current" });
    }
    return removed;
  },
  async upperBytes(runtime, key, { run = runCommand, home = "" } = {}) {
    const res = await run(runtime.bin, ["status", "--box", boxDir(home, key)], { timeoutMs: 60_000 });
    return num(parseOut(res.stdout)?.upper_bytes);
  },
  shellCommand(runtime, { key, croot, home }) {
    return { bin: runtime.bin, args: ["enter", "--box", boxDir(home, key), "--wd", croot, "--", "/bin/bash", "-l"] };
  },
  execCommand: (_runtime, { key, home }) => boxshExec({ key, home }),
};

/** The AppArmor profile `sudo mars sandbox enable` (the CLI) installs for Mars's own bwrap copy. */
export function apparmorProfile(bwrap = ENABLED_BWRAP): string {
  return `# Mars sandbox: lets Mars's own bubblewrap copy (root-owned) create
# user namespaces on systems that restrict them (Ubuntu 23.10+). Written by
# \`sudo mars sandbox enable\`; \`sudo mars sandbox enable --undo\` removes it.
abi <abi/4.0>,
include <tunables/global>

profile mars-bwrap ${bwrap} flags=(unconfined) {
  userns,

  include if exists <local/mars-bwrap>
}
`;
}
