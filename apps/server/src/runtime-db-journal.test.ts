import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RuntimeStoreReadonlyError,
  isSqliteReadonlyError,
  readRuntimeSqliteWithRecovery,
} from "./runtime-db.js";
import { listRuntimeOpencodeConfigRows } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

/**
 * A child writes runtime_opencode_configs rows, opens a write transaction
 * that spills pages into the file, and is killed mid-transaction: the
 * `-journal` it leaves is hot, as after an app killed mid-commit.
 */
const WRITER = `
const path = process.argv[process.argv.length - 1];
const open = async () => {
  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(path, { create: true });
    return { exec: (sql) => db.exec(sql), run: (sql, ...args) => db.query(sql).run(...args) };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  return { exec: (sql) => db.exec(sql), run: (sql, ...args) => db.prepare(sql).run(...args) };
};
const db = await open();
db.exec("CREATE TABLE IF NOT EXISTS runtime_opencode_configs (workspace_id TEXT PRIMARY KEY NOT NULL, config_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
for (let i = 0; i < 200; i += 1) db.run("INSERT OR REPLACE INTO runtime_opencode_configs VALUES (?, ?, ?)", "w" + i, JSON.stringify({ note: "x".repeat(4000) }), i);
db.exec("PRAGMA cache_size = 2");
db.exec("BEGIN IMMEDIATE");
for (let i = 0; i < 200; i += 1) db.run("UPDATE runtime_opencode_configs SET config_json = ? WHERE workspace_id = ?", JSON.stringify({ note: "y".repeat(4000) }), "w" + i);
process.stdout.write("ready\\n");
setInterval(() => {}, 1000);
`;

async function leaveHotJournal(root: string, dbPath: string): Promise<void> {
  const script = join(root, "writer.mjs");
  await writeFile(script, WRITER);
  const child = spawn(process.execPath, [script, dbPath], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("ready")) resolve();
    });
    child.on("exit", (code) => reject(new Error(`writer exited early (${code})`)));
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  assert.ok(statSync(`${dbPath}-journal`).size > 0, "the killed writer left a journal");
}

async function readOnlyCount(dbPath: string): Promise<number> {
  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true, create: false });
    try {
      return Number((db.query("SELECT count(*) AS c FROM runtime_opencode_configs").get() as { c: number }).c);
    } finally {
      db.close();
    }
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number((db.prepare("SELECT count(*) AS c FROM runtime_opencode_configs").get() as { c: number }).c);
  } finally {
    db.close();
  }
}

test("a hot journal fails read-only reads until it is rolled back", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-runtime-journal-"));
  try {
    const dbPath = join(root, "runtime.sqlite");
    await leaveHotJournal(root, dbPath);
    // What every start of 3.5.4 hit: SQLITE_READONLY_ROLLBACK on the first read.
    await assert.rejects(() => readOnlyCount(dbPath), (error: unknown) => isSqliteReadonlyError(error));
    assert.equal(await readRuntimeSqliteWithRecovery(dbPath, () => readOnlyCount(dbPath)), 200);
    assert.equal(existsSync(`${dbPath}-journal`), false, "the journal was rolled back");
    assert.equal(await readOnlyCount(dbPath), 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the start's first read of the runtime store recovers from a hot journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-runtime-journal-"));
  const previous = process.env.MARS_RUNTIME_DB;
  try {
    const dbPath = join(root, "runtime.sqlite");
    await leaveHotJournal(root, dbPath);
    process.env.MARS_RUNTIME_DB = dbPath;
    const rows = await listRuntimeOpencodeConfigRows({} as ServerConfig);
    assert.equal(rows.length, 200);
    // The rolled-back transaction's updates are gone: the rows are as last committed.
    assert.equal(JSON.stringify(rows[0]?.value).includes("yyyy"), false);
  } finally {
    if (previous === undefined) delete process.env.MARS_RUNTIME_DB;
    else process.env.MARS_RUNTIME_DB = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a runtime store that cannot be written is reported as read-only", async (t) => {
  if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("root writes read-only files");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "mars-runtime-journal-"));
  const dbPath = join(root, "runtime.sqlite");
  try {
    await leaveHotJournal(root, dbPath);
    // The read-only attribute (Windows) / no write bit: the read-write open falls back to read-only.
    chmodSync(dbPath, 0o444);
    await assert.rejects(
      () => readRuntimeSqliteWithRecovery(dbPath, () => readOnlyCount(dbPath)),
      (error: unknown) => error instanceof RuntimeStoreReadonlyError
        && (error as { code?: string }).code === "SQLITE_READONLY"
        && /readonly database \(runtime store\)/.test((error as Error).message),
    );
  } finally {
    chmodSync(dbPath, 0o644);
    await rm(root, { recursive: true, force: true });
  }
});

test("other read errors pass through untouched", async () => {
  const boom = new Error("no such table: runtime_opencode_configs");
  await assert.rejects(() => readRuntimeSqliteWithRecovery("/nonexistent/runtime.sqlite", () => { throw boom; }), (error) => error === boom);
});
