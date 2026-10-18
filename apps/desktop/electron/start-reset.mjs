/**
 * "Reset app data" on the couldn't-start screen: the app's local start
 * state (workspace list, embedded server registry and runtime database,
 * port and token state) is moved into a backup folder, never deleted, and
 * the app restarts with a fresh state. Sign-in, Chromium storage, the
 * user's own config files and env.json stay. The engine's data (chat
 * history and sessions not yet uploaded) stays too, unless the failure
 * points at the engine's store.
 *
 * Files that belong together (runtime.sqlite with its -journal/-wal/-shm) move all
 * together or not at all. "Restore previous app data" moves a backup back.
 *
 * Both happen on the next launch, before anything opens those files
 * (Windows cannot rename what a running engine or database holds), so the
 * request only writes a marker and relaunches.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { marsConfigDir } from "@mars/paths";

export const START_RESET_PENDING = ".start-reset-pending.json";
export const START_RESTORE_PENDING = ".start-restore-pending.json";
export const START_RESET_BACKUP_PREFIX = "start-reset-";
export const START_RESET_RECEIPT = "reset.json";

/** @typedef {{ label: string; paths: string[] }} StartResetTarget */

function stamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
}

/**
 * What a reset moves, in groups that move together. `engine-data` (chat
 * history, sessions not yet uploaded) only with `includeEngineData`.
 *
 * @param {{ userDataPath: string; env?: NodeJS.ProcessEnv; homedir?: string; platform?: NodeJS.Platform; includeEngineData?: boolean }} options
 * @returns {StartResetTarget[]}
 */
export function startResetTargets({ userDataPath, env = process.env, homedir, platform = process.platform, includeEngineData = false }) {
  const configDir = marsConfigDir({ env, homeDir: homedir, platform });
  const app = (name) => ({ label: `app/${name}`, paths: [path.join(userDataPath, name)] });
  const config = (name) => ({ label: `config/${name}`, paths: [path.join(configDir, name)] });
  return [
    app("mars-workspaces.json"),
    app("workspace-state.json"),
    app("mars-server-tokens.json"),
    app("mars-server-state.json"),
    app("managed-opencode-workdir"),
    ...(includeEngineData ? [app("engine-data")] : []),
    config("server.json"),
    {
      label: "config/runtime.sqlite",
      // The journal too: a hot one left next to a fresh store would be played into it.
      paths: ["runtime.sqlite", "runtime.sqlite-journal", "runtime.sqlite-wal", "runtime.sqlite-shm"].map((name) => path.join(configDir, name)),
    },
    config("runtime-opencode-config.json"),
    config("engine-instances.json"),
  ];
}

/**
 * Ask for a reset on the next launch. Returns the backup folder it will use,
 * so the screen can name it before the restart.
 *
 * @param {{ userDataPath: string; includeEngineData?: boolean; now?: () => Date }} options
 */
export async function scheduleStartReset({ userDataPath, includeEngineData = false, now = () => new Date() }) {
  const backupDir = path.join(userDataPath, `${START_RESET_BACKUP_PREFIX}${stamp(now())}`);
  await mkdir(userDataPath, { recursive: true });
  await writeFile(
    path.join(userDataPath, START_RESET_PENDING),
    `${JSON.stringify({ requestedAt: now().toISOString(), backupDir, includeEngineData })}\n`,
    { mode: 0o600 },
  );
  return { backupDir };
}

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Move every file of a group, or none: a failure moves the ones already
 * moved back. Returns the moves made ({ from, to }), or throws with `code`.
 */
async function moveGroup(moves, renameImpl) {
  const done = [];
  try {
    for (const move of moves) {
      await mkdir(path.dirname(move.to), { recursive: true });
      await renameImpl(move.from, move.to);
      done.push(move);
    }
    return done;
  } catch (error) {
    for (const move of done.reverse()) await renameImpl(move.to, move.from).catch(() => undefined);
    throw error;
  }
}

/**
 * On launch: when a reset was asked for, move each target group that
 * exists into the backup folder (or, across drives, beside itself with a
 * `.mars-reset-<time>` suffix). Never throws; returns what moved and
 * writes the receipt a restore reads.
 *
 * @param {{
 *   userDataPath: string;
 *   targetsFor: (options: { includeEngineData: boolean }) => StartResetTarget[];
 *   now?: () => Date;
 *   renameImpl?: (from: string, to: string) => Promise<void>;
 *   log?: (message: string) => void;
 * }} options
 */
export async function applyPendingStartReset({ userDataPath, targetsFor, now = () => new Date(), renameImpl = rename, log = () => {} }) {
  const marker = path.join(userDataPath, START_RESET_PENDING);
  if (!existsSync(marker)) return { ran: false, moved: [], failed: [] };
  const request = await readJson(marker);
  const time = stamp(now());
  const backupDir = typeof request?.backupDir === "string" && path.dirname(request.backupDir) === userDataPath
    ? request.backupDir
    : path.join(userDataPath, `${START_RESET_BACKUP_PREFIX}${time}`);
  const moved = [];
  const failed = [];
  await mkdir(backupDir, { recursive: true }).catch(() => undefined);
  for (const target of targetsFor({ includeEngineData: request?.includeEngineData === true })) {
    const present = target.paths.filter((entry) => existsSync(entry));
    if (present.length === 0) continue;
    const intoBackup = present.map((from) => ({
      from,
      to: path.join(backupDir, ...target.label.split("/").slice(0, -1), path.basename(from)),
    }));
    try {
      moved.push({ label: target.label, moves: await moveGroup(intoBackup, renameImpl) });
    } catch {
      try {
        const beside = present.map((from) => ({ from, to: `${from}.mars-reset-${time}` }));
        moved.push({ label: target.label, moves: await moveGroup(beside, renameImpl) });
      } catch (error) {
        failed.push({ label: target.label, code: error?.code ?? "error" });
      }
    }
  }
  await writeFile(
    path.join(backupDir, START_RESET_RECEIPT),
    `${JSON.stringify({ resetAt: now().toISOString(), moved, failed }, null, 2)}\n`,
  ).catch(() => undefined);
  await rm(marker, { force: true }).catch(() => undefined);
  log(`[start-reset] moved ${moved.length} item(s) aside${failed.length ? `, ${failed.length} could not be moved` : ""}`);
  return { ran: true, backupDir, moved: moved.map((entry) => entry.label), failed };
}

/**
 * Ask to move a reset's backup back on the next launch.
 *
 * @param {{ userDataPath: string; backupDir: string }} options
 */
export async function scheduleStartRestore({ userDataPath, backupDir }) {
  await writeFile(path.join(userDataPath, START_RESTORE_PENDING), `${JSON.stringify({ backupDir })}\n`, { mode: 0o600 });
}

/**
 * On launch: when a restore was asked for, put every group of the backup's
 * receipt back. What the fresh start created in its place is kept, in the
 * backup folder under `replaced-<time>/`. Never throws.
 *
 * @param {{
 *   userDataPath: string;
 *   now?: () => Date;
 *   renameImpl?: (from: string, to: string) => Promise<void>;
 *   log?: (message: string) => void;
 * }} options
 */
export async function applyPendingStartRestore({ userDataPath, now = () => new Date(), renameImpl = rename, log = () => {} }) {
  const marker = path.join(userDataPath, START_RESTORE_PENDING);
  if (!existsSync(marker)) return { ran: false, restored: [], failed: [] };
  const request = await readJson(marker);
  await rm(marker, { force: true }).catch(() => undefined);
  const backupDir = typeof request?.backupDir === "string" ? request.backupDir : "";
  const receipt = backupDir && path.dirname(backupDir) === userDataPath ? await readJson(path.join(backupDir, START_RESET_RECEIPT)) : null;
  if (!receipt || !Array.isArray(receipt.moved)) return { ran: true, backupDir, restored: [], failed: [{ label: "receipt", code: "missing" }] };
  const replacedDir = path.join(backupDir, `replaced-${stamp(now())}`);
  const restored = [];
  const failed = [];
  for (const entry of receipt.moved) {
    const moves = Array.isArray(entry?.moves) ? entry.moves.filter((move) => typeof move?.from === "string" && typeof move?.to === "string") : [];
    if (moves.length === 0 || !moves.every((move) => existsSync(move.to))) {
      failed.push({ label: String(entry?.label ?? "?"), code: "missing" });
      continue;
    }
    const current = moves
      .filter((move) => existsSync(move.from))
      .map((move) => ({ from: move.from, to: path.join(replacedDir, ...String(entry.label).split("/").slice(0, -1), path.basename(move.from)) }));
    try {
      const setAside = await moveGroup(current, renameImpl);
      try {
        await moveGroup(moves.map((move) => ({ from: move.to, to: move.from })), renameImpl);
        restored.push(entry.label);
      } catch (error) {
        for (const move of setAside.reverse()) await renameImpl(move.to, move.from).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      failed.push({ label: String(entry.label), code: error?.code ?? "error" });
    }
  }
  log(`[start-reset] restored ${restored.length} item(s)${failed.length ? `, ${failed.length} could not be restored` : ""}`);
  return { ran: true, backupDir, restored, failed };
}
