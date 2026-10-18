import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { marsConfigDir } from "@mars/paths";
import type { Database as BunDatabase } from "bun:sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { DatabaseSync } from "node:sqlite";
import type { ServerConfig } from "./types.js";
import { ensureDir } from "./utils.js";

export type RuntimeBunSqliteDatabase = {
  kind: "bun";
  sqlite: BunDatabase;
  db: BunSQLiteDatabase;
  close: () => void;
};

export type RuntimeNodeSqliteDatabase = {
  kind: "node";
  sqlite: DatabaseSync;
  close: () => void;
};

export type RuntimeSqliteDatabase = RuntimeBunSqliteDatabase | RuntimeNodeSqliteDatabase;

/**
 * Kept opaque so Bun's loader never eagerly pre-resolves the Node-only
 * builtin (Bun lacks node:sqlite and its speculative resolution can surface
 * as an unhandled rejection even though the guarded branch never runs).
 */
export const NODE_SQLITE_SPECIFIER = "node:sqlite";

export function importNodeSqlite(): Promise<typeof import("node:sqlite")> {
  return import(NODE_SQLITE_SPECIFIER);
}

export function runtimeDbPath(config: ServerConfig): string {
  const override = process.env.MARS_RUNTIME_DB?.trim();
  if (override) return resolve(override);
  const configPath = config.configPath?.trim();
  const configDir = configPath ? dirname(configPath) : marsConfigDir();
  return join(configDir, "runtime.sqlite");
}

/** Directory holding runtime state (the SQLite DB and derived files). */
export function runtimeStorageDir(config: ServerConfig): string {
  return dirname(runtimeDbPath(config));
}

export async function openRuntimeSqliteDatabase(path: string): Promise<RuntimeSqliteDatabase> {
  await ensureDir(dirname(path));
  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    const { drizzle } = await import("drizzle-orm/bun-sqlite");
    const sqlite = new Database(path, { create: true });
    return {
      kind: "bun",
      sqlite,
      db: drizzle(sqlite),
      close: () => sqlite.close(),
    };
  }

  const { DatabaseSync } = await importNodeSqlite();
  const sqlite = new DatabaseSync(path);
  return {
    kind: "node",
    sqlite,
    close: () => sqlite.close(),
  };
}

/** SQLite's primary result code (8 = SQLITE_READONLY) of a node:sqlite or bun:sqlite error, else null. */
export function sqlitePrimaryCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const record = error as { errcode?: unknown; errno?: unknown; code?: unknown };
  if (typeof record.errcode === "number" && Number.isInteger(record.errcode)) return record.errcode & 0xff;
  if (typeof record.code === "string" && record.code.startsWith("SQLITE_") && typeof record.errno === "number") return record.errno & 0xff;
  return null;
}

/** "attempt to write a readonly database": a read-only file, or a read-only connection that met a hot journal. */
export function isSqliteReadonlyError(error: unknown): boolean {
  if (sqlitePrimaryCode(error) === 8) return true;
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string" && code.startsWith("SQLITE_READONLY")) return true;
  return error instanceof Error && /attempt to write a readonly database/i.test(error.message);
}

/**
 * A write cut short (the app killed or the PC shut down mid-commit, or on
 * Windows a journal an antivirus held open so it could not be deleted) leaves
 * a hot `<db>-journal`. Only a read-write connection rolls it back; every
 * read-only connection fails with SQLITE_READONLY_ROLLBACK ("attempt to write
 * a readonly database") until one does. Opening the file read-write and
 * reading once rolls it back. Throws what that open threw (for instance when
 * the file itself cannot be written).
 */
/** How long the rollback open waits for another connection's lock (a write in progress elsewhere). */
const ROLLBACK_BUSY_TIMEOUT_MS = 2_000;

export async function rollBackRuntimeSqliteJournal(path: string): Promise<void> {
  if (!existsSync(path)) return;
  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    const sqlite = new Database(path, { create: false, readwrite: true });
    try {
      sqlite.exec(`PRAGMA busy_timeout = ${ROLLBACK_BUSY_TIMEOUT_MS}`);
      sqlite.query("SELECT count(*) FROM sqlite_master").get();
    } finally {
      sqlite.close();
    }
    return;
  }
  const { DatabaseSync } = await importNodeSqlite();
  const sqlite = new DatabaseSync(path);
  try {
    sqlite.exec(`PRAGMA busy_timeout = ${ROLLBACK_BUSY_TIMEOUT_MS}`);
    sqlite.prepare("SELECT count(*) FROM sqlite_master").get();
    // The rollback ran if the connection could write; a file that is itself read-only opens read-only.
    sqlite.exec("BEGIN IMMEDIATE; ROLLBACK;");
  } finally {
    sqlite.close();
  }
}

/** The runtime store cannot be written: kept recognizable for the desktop's start report. */
export class RuntimeStoreReadonlyError extends Error {
  readonly code = "SQLITE_READONLY";
  readonly store = "runtime";
  constructor(cause: unknown) {
    super("attempt to write a readonly database (runtime store)", { cause });
    this.name = "Error";
  }
}

/**
 * Run a read-only read of the runtime store; when it fails as read-only,
 * roll back a hot journal through a read-write open and read once more.
 * A store that still cannot be written throws RuntimeStoreReadonlyError.
 */
export async function readRuntimeSqliteWithRecovery<T>(path: string, read: () => Promise<T> | T): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!isSqliteReadonlyError(error)) throw error;
    try {
      await rollBackRuntimeSqliteJournal(path);
    } catch (recoveryError) {
      if (isSqliteReadonlyError(recoveryError)) throw new RuntimeStoreReadonlyError(recoveryError);
      throw error;
    }
    try {
      return await read();
    } catch (retryError) {
      if (isSqliteReadonlyError(retryError)) throw new RuntimeStoreReadonlyError(retryError);
      throw retryError;
    }
  }
}
