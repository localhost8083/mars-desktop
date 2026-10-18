/**
 * Whether marsai.click can write its local databases, for the couldn't-start
 * screen: the runtime store (`<config>/runtime.sqlite`, the embedded
 * server's) and the engine's store (`<userData>/engine-data/mars/
 * opencode.db`), each with its journal files.
 *
 * SQLite opens a file it cannot write read-only without saying so, and the
 * first write then fails with "attempt to write a readonly database". On
 * Windows that is a file with the read-only attribute set, or one whose
 * permissions do not let this user write it (copied or restored from
 * elsewhere, made by another account). Files an elevated ("Run as
 * administrator") start creates inherit the folder's permissions and stay
 * writable; the elevated flag is still reported so the screen can say not
 * to start marsai.click that way.
 *
 * Nothing here leaves the computer: the report keeps only the category.
 */
import { execFile } from "node:child_process";
import { chmod, open, stat } from "node:fs/promises";
import path from "node:path";
import { marsConfigDir } from "@mars/paths";

const SUFFIXES = ["", "-journal", "-wal", "-shm"];

/**
 * The store files, by store.
 *
 * @param {{ userDataPath: string; env?: NodeJS.ProcessEnv; homedir?: string; platform?: NodeJS.Platform }} options
 * @returns {{ runtime: string[]; engine: string[] }}
 */
export function storeFiles({ userDataPath, env = process.env, homedir, platform = process.platform }) {
  const configDir = marsConfigDir({ env, homeDir: homedir, platform });
  const runtimeDb = String(env.MARS_RUNTIME_DB ?? "").trim() || path.join(configDir, "runtime.sqlite");
  const engineDb = path.join(userDataPath, "engine-data", "mars", "opencode.db");
  return {
    runtime: SUFFIXES.map((suffix) => `${runtimeDb}${suffix}`),
    engine: SUFFIXES.map((suffix) => `${engineDb}${suffix}`),
  };
}

/**
 * One file: absent, or present with its read-only flag (Windows' read-only
 * attribute shows as no write bit) and whether opening it for writing works.
 */
async function checkFile(file, { openImpl = open, statImpl = stat } = {}) {
  let info;
  try {
    info = await statImpl(file);
  } catch {
    return { present: false, readOnlyFlag: false, writable: true, code: null };
  }
  if (!info.isFile()) return { present: false, readOnlyFlag: false, writable: true, code: null };
  const readOnlyFlag = (info.mode & 0o222) === 0;
  let handle = null;
  try {
    handle = await openImpl(file, "r+");
    return { present: true, readOnlyFlag, writable: true, code: null };
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
    // EBUSY: another program holds it without sharing (rare for SQLite files).
    return { present: true, readOnlyFlag, writable: false, code };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * @param {string[]} files
 * @param {{ openImpl?: typeof open; statImpl?: typeof stat }} [impl]
 */
async function checkStore(files, impl) {
  const checks = await Promise.all(files.map((file) => checkFile(file, impl)));
  const present = checks.filter((check) => check.present);
  return {
    present: present.length > 0,
    readOnlyFlags: present.filter((check) => check.readOnlyFlag).length,
    notWritable: present.filter((check) => !check.writable).length,
    hotJournal: checks[1]?.present === true,
    codes: [...new Set(present.map((check) => check.code).filter(Boolean))],
  };
}

/**
 * Is this process elevated (Windows: an administrator token, "Run as
 * administrator"; elsewhere: root)? Windows asks `whoami /groups` for the
 * High (S-1-16-12288) or System (S-1-16-16384) integrity label. Null when
 * that cannot be told.
 *
 * @param {{ platform?: NodeJS.Platform; run?: (file: string, args: string[]) => Promise<string>; getuid?: () => number }} [options]
 */
export async function isElevated({ platform = process.platform, run = runText, getuid = process.getuid?.bind(process) } = {}) {
  if (platform !== "win32") return typeof getuid === "function" ? getuid() === 0 : null;
  try {
    const output = await run("whoami", ["/groups", "/fo", "csv", "/nh"]);
    if (/S-1-16-(?:12288|16384)\b/.test(output)) return true;
    if (/S-1-16-\d+/.test(output)) return false;
    return null;
  } catch {
    return null;
  }
}

function runText(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 5_000, maxBuffer: 1 << 20 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });
}

/**
 * What stops marsai.click writing its stores.
 *
 * @param {{ files: { runtime: string[]; engine: string[] }; elevated?: () => Promise<boolean | null>; openImpl?: typeof open; statImpl?: typeof stat }} options
 */
export async function checkStoreAccess({ files, elevated = () => isElevated(), openImpl, statImpl }) {
  const impl = { openImpl, statImpl };
  const [runtime, engine, admin] = await Promise.all([
    checkStore(files.runtime, impl),
    checkStore(files.engine, impl),
    elevated().catch(() => null),
  ]);
  const blocked = (store) => store.readOnlyFlags > 0 || store.notWritable > 0;
  return {
    runtime,
    engine,
    elevated: admin,
    /** Stores with a file that is read-only or cannot be opened for writing. */
    blockedStores: [blocked(runtime) ? "runtime" : null, blocked(engine) ? "engine" : null].filter(Boolean),
    /** Clearing the read-only flag can fix it in place. */
    repairable: runtime.readOnlyFlags + engine.readOnlyFlags > 0,
  };
}

/**
 * Clear the read-only flag (Windows: the read-only attribute) of every store
 * file that has it. Never throws; returns how many were fixed and failed.
 *
 * @param {{ files: { runtime: string[]; engine: string[] }; chmodImpl?: typeof chmod; statImpl?: typeof stat }} options
 */
export async function repairStoreAccess({ files, chmodImpl = chmod, statImpl = stat }) {
  let fixed = 0;
  let failed = 0;
  for (const file of [...files.runtime, ...files.engine]) {
    let info;
    try {
      info = await statImpl(file);
    } catch {
      continue;
    }
    if (!info.isFile() || (info.mode & 0o200) !== 0) continue;
    try {
      await chmodImpl(file, (info.mode & 0o777) | 0o600);
      fixed += 1;
    } catch {
      failed += 1;
    }
  }
  return { fixed, failed };
}
