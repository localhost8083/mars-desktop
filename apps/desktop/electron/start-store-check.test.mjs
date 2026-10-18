import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkStoreAccess, isElevated, repairStoreAccess, storeFiles } from "./start-store-check.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "start-store-check-"));
  const userDataPath = path.join(root, "ai.marsai.desktop");
  const configDir = path.join(root, "mars");
  await mkdir(path.join(userDataPath, "engine-data", "mars"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  const env = { MARS_SERVER_CONFIG: path.join(configDir, "server.json") };
  const files = storeFiles({ userDataPath, env, homedir: root });
  return { root, configDir, userDataPath, files };
}

test("store files: the runtime store and the engine's, each with its journal files", async () => {
  const { root, configDir, userDataPath, files } = await fixture();
  try {
    assert.deepEqual(files.runtime.map((file) => path.relative(configDir, file)), [
      "runtime.sqlite", "runtime.sqlite-journal", "runtime.sqlite-wal", "runtime.sqlite-shm",
    ]);
    assert.equal(path.relative(userDataPath, files.engine[0]), path.join("engine-data", "mars", "opencode.db"));
    assert.equal(files.engine.length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a read-only store file is found and Fix clears it", async (t) => {
  if (process.platform !== "win32" && process.getuid?.() === 0) {
    t.skip("root opens read-only files for writing");
    return;
  }
  const { root, files } = await fixture();
  try {
    await writeFile(files.runtime[0], "db");
    await writeFile(files.runtime[1], "journal");
    await writeFile(files.engine[0], "db");
    await chmod(files.runtime[0], 0o444);
    await chmod(files.runtime[1], 0o444);

    const before = await checkStoreAccess({ files, elevated: async () => false });
    assert.deepEqual(before.blockedStores, ["runtime"]);
    assert.equal(before.runtime.readOnlyFlags, 2);
    assert.equal(before.runtime.notWritable, 2);
    assert.equal(before.runtime.hotJournal, true);
    assert.equal(before.engine.readOnlyFlags, 0);
    assert.equal(before.repairable, true);
    assert.equal(before.elevated, false);

    assert.deepEqual(await repairStoreAccess({ files }), { fixed: 2, failed: 0 });
    assert.ok(((await stat(files.runtime[0])).mode & 0o200) !== 0);
    const after = await checkStoreAccess({ files, elevated: async () => null });
    assert.deepEqual(after.blockedStores, []);
    assert.equal(after.repairable, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a store file that cannot be opened for writing without a read-only mark: blocked, not repairable", async () => {
  const { root, files } = await fixture();
  try {
    await writeFile(files.engine[0], "db");
    const denied = async () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    };
    const result = await checkStoreAccess({ files, elevated: async () => true, openImpl: denied });
    assert.deepEqual(result.blockedStores, ["engine"]);
    assert.deepEqual(result.engine.codes, ["EPERM"]);
    assert.equal(result.repairable, false);
    assert.equal(result.elevated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("elevated: Windows integrity label from whoami, root elsewhere", async () => {
  const high = "\"Mandatory Label\\High Mandatory Level\",\"Label\",\"S-1-16-12288\",\"\"";
  const medium = "\"Mandatory Label\\Medium Mandatory Level\",\"Label\",\"S-1-16-8192\",\"\"";
  assert.equal(await isElevated({ platform: "win32", run: async () => high }), true);
  assert.equal(await isElevated({ platform: "win32", run: async () => medium }), false);
  assert.equal(await isElevated({ platform: "win32", run: async () => "" }), null);
  assert.equal(await isElevated({ platform: "win32", run: async () => { throw new Error("no whoami"); } }), null);
  assert.equal(await isElevated({ platform: "linux", getuid: () => 0 }), true);
  assert.equal(await isElevated({ platform: "linux", getuid: () => 1000 }), false);
});
