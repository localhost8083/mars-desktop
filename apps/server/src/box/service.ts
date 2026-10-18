/**
 * The desktop's Linux sandbox ("box", ported from the CLI: see launch.ts):
 * one per server, for every local workspace whose box is on. It keeps
 *
 * - the per-workspace choice in the workspace's Mars settings
 *   (`localBox: { mode: "on" | "off", offered }`; no mode: the server's
 *   default from /collect/capabilities -> local_box.default);
 * - the engine bits (the shell, named bash, and the box plugin) that go
 *   into the one engine config when any workspace may use a box;
 * - <box home>/desktop-projects.json, the projects the plugin routes to
 *   their box (everything else runs natively through the same shell);
 * - each project's run: the per-turn checkpoints and the label its chats'
 *   uploads carry;
 * - the machine's backend setting (`auto`, one backend id, or `native`) in
 *   <state>/box.json, and the server's allowlist of backends
 *   (local_box.backends, remembered in <state>/box-server.json).
 *
 * Nothing here blocks opening a project: probes are bounded, a missing image
 * downloads in the background, a box that cannot start leaves its project
 * on this machine.
 *
 * Not to be confused with the OpenWork worker sandbox (`sandboxBackend`).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { boxHome, boxKey, boxSnapshotsDir, containerName, installShell, listBoxes, mountReplaced, readRecord, resetBox, savedTurns, type BoxLabel, type BoxLog } from "./box.js";
import { LABELS, OPT_IN, backendsFor, driverFor } from "./backends/index.js";
import type { BoxExec } from "./backends/types.js";
import type { BoxEndpoint } from "./client.js";
import { hostBuilds, hostBuildsNotice, hostBuildThings, hostRules } from "./host-builds.js";
import { detectStack, imageFor } from "./images.js";
import { askedBackend, boxRun, planBox, pullLog, pullMarker, pulling, pullInBackground, resolveMode, saveBackend, serverBackends, serverDefault, shimsDir, type BoxRun, type ProjectBoxMode, type ServerBoxDefault } from "./launch.js";
import type { BoxInstallLogPaths } from "./install-log.js";
import { DESKTOP_PROJECTS_FILE } from "./plugin-lib.js";
import { BUILDATHON_OFFER_NOTICE, buildathonBoxFor, buildathonProjectsFile, LESS_REPRO_NOTICE } from "../buildathon-repro.js";
import { layerSizes, pullProgress, type PullProgress } from "./pull-progress.js";
import { detectRuntime, type BackendAlternative, type DetectOptions, type RuntimeResult } from "./runtime.js";

/** What the capture side needs of a chat's box (plain data: it crosses to the capture worker). */
export type BoxCaptureInfo = {
  key: string;
  root: string;
  croot: string;
  container: string;
  runtimeBin: string;
  /** Arguments before the runtime's own (`-e docker` for a WSL engine). */
  runtimeArgs: string[];
  /** The backend id (backends/index.ts). */
  backend: string;
  /** How files-used reads the box when it is not `docker exec` (bubblewrap, Apple container, the WSL distro). */
  exec: BoxExec | null;
  /** environment.sandbox of the chat's uploads. */
  label: BoxLabel;
};

export type BoxWorkspace = { id: string; path: string; directory?: string; workspaceType: string };

export type BoxStatus = {
  /** The project's own choice (null: the server's default). */
  mode: ProjectBoxMode;
  serverDefault: ServerBoxDefault;
  /** Whether the project's chats should run in its box. */
  on: boolean;
  /** "host-builds": the server's default would put it in the box, but its folder has this computer's builds (macOS, Windows). */
  source: "env" | "project" | "server" | "default" | "host-builds" | "buildathon";
  /** The server offers the box and this project was not offered it yet. */
  offer: boolean;
  state: "off" | "unavailable" | "downloading" | "starting" | "ready" | "failed";
  runtime: { ok: boolean; name: string | null; flavor: string | null; version: string | null; reason: string | null } | null;
  /** What runs the box on this machine: the chosen backend, why, and the others (each with why not). */
  backend: BoxBackendView | null;
  /** The machine's backend setting and the values it takes here. */
  backendSetting: { value: string; source: "env" | "setting" | "auto"; choices: Array<{ id: string; label: string }> };
  image: { ref: string; stack: string; present: boolean | null; downloading: boolean } | null;
  /** How far the image download is (while it downloads, when the runtime's output says). */
  progress: PullProgress | null;
  container: { name: string; exists: boolean; running: boolean } | null;
  /** The server's OS (the card's next step when no backend works). */
  platform: NodeJS.Platform;
  /** One line for the user (why it is off, that it is downloading). */
  notice: string | null;
  error: string | null;
  /**
   * macOS / Windows: the folder has this computer's builds (host-builds.ts). `native`: its chats
   * stay on this computer (only the server's default had it on); else it is on by the user's
   * choice and `notice` warns that rebuilding them in the box replaces them. Null otherwise.
   */
  hostBuilds: { native: boolean; things: string; notice: string } | null;
  /** macOS / Windows, while the project's chats run in the box: the one line that says so (null elsewhere). */
  boxNotice: string | null;
};

export type BoxBackendView = {
  /** The chosen backend's id (null when none works here). */
  id: string | null;
  label: string | null;
  version: string | null;
  flavor: string | null;
  /** Why this one (the ranked order, the setting, the server's allowlist), or why none. */
  why: string | null;
  /** Every backend tried here: id, whether it works, one line why not. Empty until the first full check. */
  alternatives: Array<{ id: string; label: string; ok: boolean; reason: string | null }>;
  /** The server limits the backends (local_box.backends). */
  allowed: string[] | null;
};

/** The backend choices of a platform: auto, the ranked ids there, the opt-in ones, native. */
export function backendChoices(platform: NodeJS.Platform = process.platform): Array<{ id: string; label: string }> {
  const optIn = (OPT_IN[platform] ?? []).map((id) => ({ id, label: `${LABELS[id] ?? id} (opt-in)` }));
  return [{ id: "auto", label: "Automatic" }, ...backendsFor(platform).map((id) => ({ id, label: LABELS[id] ?? id })), ...optIn, { id: "native", label: "Off (this computer)" }];
}

export type BoxServiceOptions = {
  /** The capture state dir: the server default is remembered here, snapshots go under sandbox/snapshots. */
  stateDir: string;
  readSettings: (workspaceId: string) => Promise<{ mode: ProjectBoxMode; offered: boolean }>;
  writeSettings: (workspaceId: string, update: { mode?: ProjectBoxMode; offered?: boolean }) => Promise<void>;
  workspaces: () => BoxWorkspace[];
  /** The engine plugin file (opencode-plugins/mars-box). */
  pluginPath: () => string;
  log?: BoxLog;
  env?: NodeJS.ProcessEnv;
  /** Whether a running box's project folder was deleted and made again (box.ts mountReplaced; tests replace it). */
  folderReplaced?: (box: { endpoint: BoxEndpoint; croot: string }) => Promise<boolean>;
  /** The OS whose builds count as this computer's (host-builds.ts; tests set it). */
  platform?: NodeJS.Platform;
};

/** `waitingImage`: planned while its image was downloading (planned again as soon as the image is here). */
type Project = { run: BoxRun | null; notice: string | null; planning: Promise<BoxRun | null> | null; nextPlanAt: number; waitingImage: boolean; why?: PlanWhy | null };

/** Why the project's last plan has no box (the `box.plan` reason), with the runtime's failure in safe words. */
type PlanWhy = { reason: "no_runtime" | "helpers_missing" | "downloading"; runtime?: { name: string | null; code: string | null } };

/**
 * A chat's `box.plan` trace event (once per chat and app run): where its
 * prompts run and why, as the CLI's `client.launch` `box`. `reason`: box,
 * box_failed, off, offer, host_builds, kept_old_chat, no_runtime,
 * helpers_missing, downloading, planning; `source`: what turned the box on or
 * off (project, server, default, flag, host-builds, chat).
 */
export type BoxPlanOutcome = { native: boolean; source: string | null; reason: string; runtime?: { name: string | null; code: string | null } };

/** The backend tried and its failure code (bubblewrap's apparmor, no_bwrap, ...; `timeout`), never its text or a path. */
export function runtimeWhy(runtime: { name?: unknown; code?: unknown; reason?: unknown } | null | undefined): { name: string | null; code: string | null } {
  const code = typeof runtime?.code === "string" && /^[a-z_]{1,32}$/.test(runtime.code) ? runtime.code
    : /did not answer in time/.test(String(runtime?.reason ?? "")) ? "timeout" : null;
  const name = typeof runtime?.name === "string" && /^[a-z-]{1,16}$/.test(runtime.name) ? runtime.name : null;
  return { name, code };
}

/** A project whose image is downloading is planned again at most this often. */
const REPLAN_MS = 15_000;
/** A prompt waits at most this long for its turn's checkpoint. */
const FREEZE_WAIT_MS = 90_000;
/** The full backend check (every backend, for the status card's "others") is reused this long. */
const ALTERNATIVES_MS = 60_000;

export function boxRoot(workspace: BoxWorkspace): string {
  return workspace.directory?.trim() || workspace.path;
}

export class BoxService {
  private readonly projects = new Map<string, Project>();
  private readonly turns = new Map<string, number>();
  /** Each chat's turn number as of its last prompt here (its turns before this run, then one per prompt). */
  private readonly chatTurns = new Map<string, number>();
  /** Chats (and their project's key) that ran on this machine before the server's default turned the box on: they stay here. */
  private readonly nativeChats = new Map<string, string>();
  /** Chats sent to their project's box in this run (a failed checkpoint included). */
  private readonly boxedChats = new Set<string>();
  /** Chats whose box.plan event went out in this run. */
  private readonly outcomeSent = new Set<string>();
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private log: BoxLog;
  private projectsWrite: Promise<void> = Promise.resolve();
  private installLog: BoxInstallLogPaths | null = null;
  private alternatives: { at: number; key: string; list: BackendAlternative[] } | null = null;

  private readonly folderReplaced: NonNullable<BoxServiceOptions["folderReplaced"]>;

  constructor(private readonly options: BoxServiceOptions) {
    this.folderReplaced = options.folderReplaced ?? (({ endpoint, croot }) => mountReplaced({ endpoint }, { croot, readyMs: 1_000 }));
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.home = boxHome(this.env);
    this.log = options.log ?? (() => {});
  }

  /**
   * The install log of box chats (install-log.ts): new boxes mount its
   * folder and put its wrappers on PATH; the plugin points their calls at its
   * raw folder. Set at server start, before any box is planned.
   */
  useInstallLog(paths: BoxInstallLogPaths | null): void {
    this.installLog = paths;
  }

  /** Logs go here from now on (the server's logger, once it exists). */
  useLog(log: BoxLog): void {
    this.log = log;
  }

  get snapshotsDir(): string {
    return boxSnapshotsDir(this.options.stateDir);
  }

  serverDefault(): ServerBoxDefault {
    return serverDefault(this.options.stateDir);
  }

  /** The backend detection's inputs: the setting (or MARS_BOX_BACKEND) and the server's allowlist. */
  private detectOptions(): Pick<DetectOptions, "asked" | "allow"> {
    return { asked: askedBackend({ env: this.env, stateDir: this.options.stateDir }).backend, allow: serverBackends(this.options.stateDir) };
  }

  private detect(extra: DetectOptions = {}): Promise<RuntimeResult> {
    return detectRuntime({ boxHome: this.home, env: this.env, ...this.detectOptions(), ...extra });
  }

  /**
   * Save the machine's backend ("auto", one backend id, "native"). Projects
   * are planned again with it (a running box keeps going until its project
   * is planned again). Throws for an unknown value.
   */
  async setBackend(value: unknown): Promise<string> {
    const saved = saveBackend(this.options.stateDir, value);
    this.alternatives = null;
    const now = await this.detect({ fresh: true });
    const chosen = now.ok ? now.backend ?? now.name : null;
    for (const project of this.projects.values()) {
      if (project.run && project.run.backend === chosen) continue;
      project.run = null;
      project.notice = null;
      project.nextPlanAt = 0;
    }
    await this.writeProjects();
    void this.ensureAll();
    return saved;
  }

  /**
   * The server's backends allowlist changed (box-server.json): a project whose box runs on a
   * backend it no longer allows is planned again (its chats go on natively until then).
   */
  async serverBackendsChanged(): Promise<void> {
    const allow = serverBackends(this.options.stateDir);
    this.alternatives = null;
    // A plan in flight (started with the old allowlist) settles first.
    await Promise.allSettled([...this.projects.values()].map((project) => project.planning));
    for (const project of this.projects.values()) {
      if (!project.run || !allow || allow.includes(project.run.backend)) continue;
      project.run = null;
      project.notice = null;
      project.nextPlanAt = 0;
    }
    await this.writeProjects();
  }

  private async mode(workspace: BoxWorkspace) {
    const settings = await this.options.readSettings(workspace.id).catch(() => ({ mode: null, offered: false }));
    const server = this.serverDefault();
    // A buildathon project (the app lists them): the event's `repro.box` comes before the server's default.
    const buildathon = workspace.workspaceType === "local" ? this.buildathonBox(boxRoot(workspace)) : null;
    const resolved = resolveMode({ env: this.env, project: settings.mode, server, offered: settings.offered, buildathon });
    const gate = workspace.workspaceType === "local" ? this.hostGate(boxRoot(workspace), resolved) : null;
    // A box already running for the project keeps its chats (builds made since do not move them out).
    const running = this.projects.get(boxKey(boxRoot(workspace)))?.run;
    if (gate?.native && !(running && !running.native)) return { settings, server, ...resolved, on: false, source: "host-builds" as const, offer: false, hostBuilds: gate };
    return { settings, server, ...resolved, hostBuilds: gate };
  }

  /**
   * macOS / Windows: a project folder with this computer's builds (node_modules,
   * a venv, Mach-O / PE programs; host-builds.ts). Only the server's default
   * putting it in the box: its chats stay here (`native`); the user's own
   * choice (the project's switch, MARS_BOX=1): in the box, with a warning.
   * Null on Linux, with the box off, or when the folder has none.
   * MARS_BOX_KEEP_NATIVE=off or MARS_BOX_HOST_BUILDS=off skips it.
   */
  private buildathonBox(root: string): "on" | "offer" | "off" | null {
    try {
      return buildathonBoxFor(root, buildathonProjectsFile(this.home));
    } catch {
      return null;
    }
  }

  private hostGate(root: string, mode: { on: boolean; source: string }): { native: boolean; things: string; notice: string } | null {
    if (!mode.on || !hostRules(this.platform)) return null;
    if (String(this.env.MARS_BOX_KEEP_NATIVE ?? "").trim().toLowerCase() === "off") return null;
    let found;
    try {
      found = hostBuilds(root, { platform: this.platform, stateDir: this.options.stateDir, env: this.env });
    } catch (error) {
      this.log("warn", "host builds check failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
    if (!found.found) return null;
    // Only a default (the server's, or the buildathon's) keeps the folder here; the user's own choice does not.
    const native = mode.source === "server" || mode.source === "buildathon";
    return { native, things: hostBuildThings(found), notice: hostBuildsNotice(native ? "native" : "explicit", { platform: this.platform, result: found }) };
  }

  /**
   * The engine config additions (`shell` and the plugin), or null: only when
   * some local workspace has its box on or the server's default is on or
   * offer, and the helpers for this machine are installed.
   */
  async engineBits(): Promise<{ shell: string; plugin: string } | null> {
    let wanted = this.serverDefault() !== "off" || ["1", "on", "true"].includes(String(this.env.MARS_BOX ?? "").trim().toLowerCase());
    for (const workspace of this.options.workspaces()) {
      if (wanted) break;
      if (workspace.workspaceType !== "local") continue;
      wanted = (await this.mode(workspace)).on;
    }
    if (!wanted) return null;
    try {
      return { shell: installShell(this.home, { env: this.env }), plugin: this.options.pluginPath() };
    } catch (error) {
      this.log("info", "box engine bits unavailable", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  /**
   * The project's run when its box is on and can start (planned once, in
   * the background; a downloading image is looked at again later), else null.
   */
  ensure(workspace: BoxWorkspace): Promise<BoxRun | null> {
    if (workspace.workspaceType !== "local") return Promise.resolve(null);
    const root = boxRoot(workspace);
    const key = boxKey(root);
    const project = this.projects.get(key) ?? { run: null, notice: null, planning: null, nextPlanAt: 0, waitingImage: false };
    this.projects.set(key, project);
    if (project.planning) return project.planning;
    project.planning = (async () => {
      const { on, hostBuilds: gate } = await this.mode(workspace);
      if (!on) {
        if (gate?.native && project.notice !== gate.notice) this.log("info", "box: the server's default not applied, the folder has this computer's builds", { key, things: gate.things });
        project.run = null;
        project.notice = gate?.native ? gate.notice : null;
        await this.writeProjects();
        return null;
      }
      if (project.run && !project.run.native) {
        const box = project.run.box;
        // The folder was deleted and made again (a new clone) while its box ran: the box still has the deleted
        // one, where every command fails. Planned again, the box restarts on the new folder (openBox).
        if (!box?.ready || !box.endpoint || !(await this.folderReplaced({ endpoint: box.endpoint, croot: box.croot }).catch(() => false))) return project.run;
        this.log("info", "box folder replaced while it ran: starting it again", { key });
        project.run = null;
        project.nextPlanAt = 0;
      }
      if (Date.now() < project.nextPlanAt) return null;
      const plan = await planBox({ env: this.env, home: this.home, root, log: this.log, shims: shimsDir(this.env), ...this.detectOptions() });
      project.waitingImage = !plan.box && plan.downloading === true;
      project.why = plan.box ? null
        : plan.downloading === true ? { reason: "downloading" }
        : plan.runtime && !plan.runtime.ok ? { reason: "no_runtime", runtime: runtimeWhy(plan.runtime) }
        : { reason: "helpers_missing" };
      if (!plan.box) {
        project.run = null;
        project.notice = plan.notice;
        project.nextPlanAt = Date.now() + REPLAN_MS;
        await this.writeProjects();
        return null;
      }
      project.notice = null;
      project.run = boxRun(plan, {
        log: this.log,
        pkglog: this.installLog ? { root: this.installLog.root, bin: this.installLog.bin, py: this.installLog.py } : null,
        tmpRoot: join(this.home, "pending"),
        onNative: (reason) => {
          project.notice = `Sandbox off for now: ${reason}.`;
          project.nextPlanAt = Date.now() + REPLAN_MS;
          void this.writeProjects();
        },
      });
      await this.writeProjects();
      return project.run;
    })().finally(() => {
      project.planning = null;
    });
    return project.planning;
  }

  /** Plans every local workspace whose box is on (server start, a changed default); never throws. */
  async ensureAll(): Promise<void> {
    await Promise.allSettled(this.options.workspaces().map((workspace) => this.ensure(workspace)));
  }

  /** The projects the plugin routes to their box: on, planned, not gone native. */
  private writeProjects(): Promise<void> {
    const keys = [...this.projects.entries()].filter(([, project]) => project.run && !project.run.native).map(([key]) => key).sort();
    const file = join(this.home, DESKTOP_PROJECTS_FILE);
    const write = async () => {
      const content = `${JSON.stringify({ keys, ...(this.installLog ? { pkglog_dir: this.installLog.raw } : {}), ...(this.nativeChats.size ? { native_chats: [...this.nativeChats.keys()].sort() } : {}), updated: Date.now() })}\n`;
      await mkdir(this.home, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, content, { mode: 0o600 });
      await rename(tmp, file);
    };
    this.projectsWrite = this.projectsWrite.then(write, write).catch((error) => {
      this.log("warn", "box projects file not written", { error: error instanceof Error ? error.message : String(error) });
    });
    return this.projectsWrite;
  }

  /** The keys the plugin reads now (tests). */
  async listedProjects(): Promise<string[]> {
    await this.projectsWrite;
    try {
      const value = JSON.parse(await readFile(join(this.home, DESKTOP_PROJECTS_FILE), "utf8"));
      return Array.isArray(value?.keys) ? value.keys : [];
    } catch {
      return [];
    }
  }

  async setMode(workspace: BoxWorkspace, mode: ProjectBoxMode): Promise<BoxStatus> {
    await this.options.writeSettings(workspace.id, { mode, offered: true });
    const key = boxKey(boxRoot(workspace));
    // Turned on by the user: the project's chats that stayed on this machine move to the box too.
    if (mode === "on" && [...this.nativeChats.values()].includes(key)) {
      for (const [sessionId, chatKey] of this.nativeChats) if (chatKey === key) this.nativeChats.delete(sessionId);
      await this.writeProjects();
    }
    const project = this.projects.get(key);
    if (project) project.nextPlanAt = 0;
    // Planned in the background: a missing image starts downloading now.
    void this.ensure(workspace).catch(() => null);
    return this.status(workspace);
  }

  async status(workspace: BoxWorkspace, { fresh = false }: { fresh?: boolean } = {}): Promise<BoxStatus> {
    const { settings, server, on, source, offer, hostBuilds: gate, lessRepro } = await this.mode(workspace);
    // The server's "offer": shown once per folder (CLI: the tip, once per folder).
    if (offer && workspace.workspaceType === "local") await this.options.writeSettings(workspace.id, { offered: true }).catch(() => undefined);
    const root = boxRoot(workspace);
    const key = boxKey(root);
    const project = this.projects.get(key);
    const base = { mode: settings.mode, serverDefault: server, on, source, offer, error: null, hostBuilds: gate, boxNotice: null };
    const backendSetting = { ...askedBackend({ env: this.env, stateDir: this.options.stateDir }), choices: backendChoices() };
    const setting = { value: backendSetting.backend, source: backendSetting.source, choices: backendSetting.choices };
    if (workspace.workspaceType !== "local") return { ...base, on: false, offer: false, state: "off", runtime: null, backend: null, backendSetting: setting, image: null, progress: null, container: null, platform: this.platform, notice: "The sandbox is for folders on this computer." };
    // The full check (every backend) on a fresh look or once a minute; the cached choice otherwise.
    const { asked, allow } = this.detectOptions();
    const altKey = JSON.stringify([asked, allow]);
    const full = fresh || !this.alternatives || this.alternatives.key !== altKey || Date.now() - this.alternatives.at > ALTERNATIVES_MS;
    const timeout = full ? 10_000 : 4_000;
    const runtime = await Promise.race([
      this.detect(full ? { all: true } : {}),
      new Promise<RuntimeResult>((resolve) => setTimeout(() => resolve({ ok: false, reason: "the sandbox backend did not answer in time" }), timeout)),
    ]);
    if (full && runtime.alternatives) this.alternatives = { at: Date.now(), key: altKey, list: runtime.alternatives };
    const alternatives = (runtime.alternatives ?? this.alternatives?.list ?? []).map((alt) => ({ id: alt.backend, label: LABELS[alt.backend] ?? alt.backend, ok: alt.ok, reason: alt.reason ? alt.reason.split("\n")[0]!.slice(0, 300) : null }));
    const runtimeView = runtime.ok
      ? { ok: true, name: runtime.name, flavor: runtime.flavor, version: runtime.version, reason: null }
      : { ok: false, name: null, flavor: null, version: null, reason: runtime.reason };
    const backendId = runtime.ok ? runtime.backend ?? runtime.name : null;
    const backend: BoxBackendView = {
      id: backendId,
      label: backendId ? LABELS[backendId] ?? backendId : null,
      version: runtime.ok ? runtime.version || null : null,
      flavor: runtime.ok ? runtime.flavor || null : null,
      why: runtime.ok ? runtime.why ?? null : runtime.reason,
      alternatives,
      allowed: allow ?? null,
    };
    const image = imageFor(detectStack(root), { env: this.env });
    const name = containerName(key, this.env);
    let present: boolean | null = null;
    let container: BoxStatus["container"] = null;
    if (runtime.ok) {
      present = Boolean(await driverFor(runtime).imagePresent(runtime, image, { home: this.home, env: this.env }).catch(() => null));
      const mine = (await listBoxes(runtime, { env: this.env, home: this.home }).catch(() => [])).find((box) => box.key === key);
      container = { name, exists: Boolean(mine), running: Boolean(mine?.running) };
    }
    const downloading = runtime.ok && pulling(this.home, runtime, image.pull);
    // The download finished: plan the project now (not at its next chat), so the card goes on to starting and ready.
    if (on && runtime.ok && project?.waitingImage && !downloading && (present || container?.exists)) {
      project.waitingImage = false;
      project.notice = null;
      project.nextPlanAt = 0;
      void this.ensure(workspace).catch(() => null);
    }
    const marker = runtime.ok ? pullMarker(this.home, runtime, image.pull) : null;
    const progress = downloading && marker && runtime.ok ? pullProgress(pullLog(marker), marker, layerSizes(runtime, image)) : null;
    const record = readRecord(this.home, key);
    const run = project?.run ?? null;
    const state: BoxStatus["state"] = !on ? "off"
      : !runtime.ok ? "unavailable"
      : run && !run.native ? (run.box?.ready ? "ready" : run.box?.state === "failed" ? "failed" : "starting")
      : downloading || (!present && !container?.exists) ? "downloading"
      : project?.notice ? "unavailable" : "starting";
    return {
      ...base,
      state,
      runtime: runtimeView,
      backend,
      backendSetting: setting,
      image: { ref: image.pull, stack: image.stack, present, downloading },
      progress,
      container,
      platform: this.platform,
      notice: on ? project?.notice ?? (runtime.ok ? null : `Sandbox off for now: ${runtime.reason}.`)
        : gate?.native ? gate.notice
        : lessRepro ? LESS_REPRO_NOTICE
        : offer && source === "buildathon" ? BUILDATHON_OFFER_NOTICE
        : null,
      error: run?.box?.error ?? (record?.state === "off" || record?.state === "failed" ? record.error || null : null),
      boxNotice: on && hostRules(this.platform) ? hostBuildsNotice("box", { platform: this.platform }) : null,
    };
  }

  /**
   * Try again now (the card's retry): a box that failed to start, or a
   * project that went on without it, is planned again; its container and
   * installs stay. The status after a fresh check.
   */
  async retry(workspace: BoxWorkspace): Promise<BoxStatus> {
    const project = this.projects.get(boxKey(boxRoot(workspace)));
    if (project && (project.run?.native || project.run?.box?.state === "failed")) project.run = null;
    if (project) {
      project.notice = null;
      project.nextPlanAt = 0;
    }
    this.alternatives = null;
    // A runtime started or installed meanwhile: the cached answer (a failure is kept 2 minutes) is asked again.
    await Promise.race([this.detect({ fresh: true }), new Promise((resolve) => setTimeout(resolve, 10_000).unref?.())]);
    await this.writeProjects();
    void this.ensure(workspace).catch(() => null);
    return this.status(workspace, { fresh: true });
  }

  /** Remove the project's container (installs gone); the next chat starts a fresh one. */
  async reset(workspace: BoxWorkspace): Promise<{ removed: boolean }> {
    const root = boxRoot(workspace);
    const key = boxKey(root);
    const runtime = await this.detect();
    const project = this.projects.get(key);
    if (project) {
      project.run = null;
      project.nextPlanAt = 0;
    }
    await this.writeProjects();
    if (!runtime.ok) return { removed: false };
    const result = await resetBox(runtime, root, { env: this.env, home: this.home });
    void this.ensure(workspace).catch(() => null);
    return { removed: result.removed };
  }

  /** Download the project's image now (the toggle turned on with no image here). */
  async pull(workspace: BoxWorkspace): Promise<boolean> {
    const runtime = await this.detect();
    if (!runtime.ok) return false;
    const image = imageFor(detectStack(boxRoot(workspace)), { env: this.env });
    if (await driverFor(runtime).imagePresent(runtime, image, { home: this.home, env: this.env })) return false;
    pullInBackground(runtime, image, this.home, { env: this.env, log: this.log });
    return true;
  }

  private snapshotDir(sessionId: string): string {
    return join(this.snapshotsDir, sessionId);
  }

  /**
   * A prompt of `sessionId` is about to reach the engine: the turn's
   * checkpoint (what the box changed since the chat's previous one) is
   * taken and saved where the project archive reads it, and the chat's box
   * label returned for its uploads. Null when the chat runs natively. Never
   * throws; waits at most FREEZE_WAIT_MS.
   */
  async beforePrompt(sessionId: string, workspace: BoxWorkspace, { capture = true, turnsBefore = 0 }: { capture?: boolean; turnsBefore?: number } = {}): Promise<BoxCaptureInfo | null> {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(sessionId)) return null;
    // The chat's own turn number, counted with the box on or off: a chat that ran natively
    // (reopened, or its box turned on mid-chat) has its first checkpoint (turn-1) before a later
    // turn; the checkpoint names it as session_turn (CLI: the same).
    const turnsSoFar = this.chatTurns.get(sessionId) ?? turnsBefore;
    const chatTurn = capture ? turnsSoFar + 1 : 0;
    if (capture) this.chatTurns.set(sessionId, chatTurn);
    const run = await this.ensure(workspace).catch(() => null);
    if (!run || run.native) return null;
    // A chat with turns but no checkpoint ran on this machine (reopened, or started in this run before the
    // server's default reached the app, or while the image downloaded): when only the server's default
    // turned the box on, it goes on here (new chats get the box); a project turned on by its user moves it.
    if (capture && turnsSoFar > 0 && !this.nativeChats.has(sessionId) && !this.boxedChats.has(sessionId) && !this.turns.has(sessionId) && savedTurns(this.snapshotDir(sessionId)) === 0 && ["server", "buildathon"].includes((await this.mode(workspace)).source)) {
      this.nativeChats.set(sessionId, run.key);
      await this.writeProjects();
      this.log("info", "box: a chat that ran on this machine stays there", { sessionId, turnsBefore });
    }
    if (this.nativeChats.has(sessionId) || !capture) return null;
    this.boxedChats.add(sessionId);
    const turn = (this.turns.get(sessionId) ?? savedTurns(this.snapshotDir(sessionId))) + 1;
    const started = Date.now();
    try {
      const frozen = await Promise.race([
        run.freeze(`turn-${turn}`, { sessionId, turn, sessionTurn: chatTurn, chain: this.snapshotDir(sessionId) }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), FREEZE_WAIT_MS)),
      ]);
      if (frozen) {
        const saved = await frozen.save(this.snapshotDir(sessionId));
        this.turns.set(sessionId, turn);
        run.setTurn(turn);
        this.log("info", "box checkpoint saved", { sessionId, turn, sessionTurn: chatTurn, changed: saved.changed, bytes: saved.bytes, ms: Date.now() - started });
      }
    } catch (error) {
      this.log("warn", "box checkpoint failed", { sessionId, turn, error: error instanceof Error ? error.message : String(error) });
    }
    const label = run.label(sessionId);
    const box = run.box;
    if (!label || !box) return null;
    return { key: run.key, root: run.root, croot: box.croot, container: box.container, runtimeBin: run.runtimeBin, runtimeArgs: run.runtimeArgs, backend: run.backend, exec: run.exec, label };
  }

  /** The chat's box.plan outcome, once per chat and app run (null after that, or for a folder not on this computer). */
  async planOutcome(sessionId: string, workspace: BoxWorkspace): Promise<BoxPlanOutcome | null> {
    if (workspace.workspaceType !== "local" || this.outcomeSent.has(sessionId)) return null;
    this.outcomeSent.add(sessionId);
    const mode = await this.mode(workspace).catch(() => null);
    if (!mode) return { native: true, source: null, reason: "plan_failed" };
    if (this.nativeChats.has(sessionId)) return { native: true, source: "chat", reason: "kept_old_chat" };
    if (this.boxedChats.has(sessionId)) return { native: false, source: mode.source, reason: "box" };
    if (!mode.on) return { native: true, source: mode.source, reason: mode.source === "host-builds" ? "host_builds" : mode.offer ? "offer" : "off" };
    const project = this.projects.get(boxKey(boxRoot(workspace)));
    if (project?.run?.native) return { native: true, source: mode.source, reason: "box_failed" };
    if (project?.why) return { native: true, source: mode.source, reason: project.why.reason, ...(project.why.runtime ? { runtime: project.why.runtime } : {}) };
    // Not planned yet (a plan still running, or waiting for its next try).
    return { native: true, source: mode.source, reason: "planning" };
  }

  /** Whether chats ran in a box during this run (they get a `final` checkpoint at quit). */
  hasChats(): boolean {
    return this.turns.size > 0;
  }

  /** At quit: every chat with checkpoints gets its `final` leaf (bounded); the sessions that got one. */
  async finals({ budgetMs = 20_000 }: { budgetMs?: number } = {}): Promise<string[]> {
    const done: string[] = [];
    const work = (async () => {
      for (const sessionId of this.turns.keys()) {
        const run = [...this.projects.values()].map((project) => project.run).find((candidate) => candidate?.label(sessionId));
        if (!run) continue;
        try {
          const frozen = await run.freeze("final", { sessionId, chain: this.snapshotDir(sessionId) });
          if (frozen) {
            await frozen.save(this.snapshotDir(sessionId));
            done.push(sessionId);
          }
        } catch (error) {
          this.log("warn", "box final checkpoint failed", { sessionId, error: error instanceof Error ? error.message : String(error) });
        }
      }
    })();
    await Promise.race([work, new Promise((resolve) => setTimeout(resolve, budgetMs).unref?.())]);
    return done;
  }
}
