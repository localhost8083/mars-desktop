import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { KEEP_AWAKE_FILE, createKeepAwake, keepAwakeSkipReason, readKeepAwakeSetting, writeKeepAwakeSetting } from "./keep-awake.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Electron's powerSaveBlocker, recorded. */
function fakeBlocker() {
  const started = new Set();
  const calls = [];
  let next = 1;
  return {
    calls,
    started,
    start(type) {
      calls.push(["start", type]);
      const id = next++;
      started.add(id);
      return id;
    },
    stop(id) {
      calls.push(["stop", id]);
      started.delete(id);
    },
    isStarted: (id) => started.has(id),
  };
}

/** @param {{ env?: NodeJS.ProcessEnv, saved?: boolean }} [options] */
async function setup({ env = {}, saved } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "keep-awake-"));
  const settingFile = path.join(dir, KEEP_AWAKE_FILE);
  if (saved !== undefined) await writeKeepAwakeSetting(settingFile, saved);
  const blocker = fakeBlocker();
  const lines = [];
  const awake = createKeepAwake({ powerSaveBlocker: blocker, settingFile, env, log: (line) => lines.push(line) });
  await awake.loaded;
  return { awake, blocker, lines, settingFile };
}

test("prevent-app-suspension only while a turn runs (system sleep only, never the display)", async () => {
  const { awake, blocker, lines } = await setup();
  assert.equal(blocker.calls.length, 0, "an idle open chat holds nothing");
  awake.setTurnRunning(true);
  assert.deepEqual(blocker.calls, [["start", "prevent-app-suspension"]]);
  assert.equal(blocker.started.size, 1);
  awake.setTurnRunning(true);
  assert.equal(blocker.calls.length, 1, "one blocker for every running turn");
  awake.setTurnRunning(false);
  assert.deepEqual(blocker.calls.at(-1), ["stop", 1]);
  assert.equal(blocker.started.size, 0);
  assert.deepEqual(lines, ["[keep-awake] started id=1 isStarted=true", "[keep-awake] stopped id=1 isStarted=false"]);
  assert.ok(!blocker.calls.some(([, type]) => type === "prevent-display-sleep"));
});

test("held while the app finishes as it quits, then released", async () => {
  const { awake, blocker } = await setup();
  awake.setTurnRunning(true);
  const release = awake.hold();
  awake.setTurnRunning(false);
  assert.equal(blocker.started.size, 1, "still held for the quit");
  release();
  release();
  assert.equal(blocker.started.size, 0);
  const again = awake.hold();
  assert.equal(blocker.started.size, 1, "a quit with no turn running holds it too");
  awake.stop();
  assert.equal(blocker.started.size, 0);
  again();
  awake.setTurnRunning(true);
  assert.equal(blocker.started.size, 0, "nothing after stop");
});

test("the setting: on by default, saved off, toggled live", async () => {
  const { awake, blocker, settingFile } = await setup();
  assert.deepEqual(await awake.status(), { enabled: true, active: false, available: true, forcedOff: false });
  awake.setTurnRunning(true);
  assert.equal((await awake.status()).active, true);
  // Turned off mid-turn: released at once, and saved.
  assert.deepEqual(await awake.setEnabled(false), { enabled: false, active: false, available: true, forcedOff: false });
  assert.equal(blocker.started.size, 0);
  assert.deepEqual(JSON.parse(await readFile(settingFile, "utf8")), { enabled: false });
  if (process.platform !== "win32") assert.equal((await stat(settingFile)).mode & 0o777, 0o600);
  // Back on while the turn still runs: held again.
  assert.equal((await awake.setEnabled(true)).active, true);
  assert.equal(await readKeepAwakeSetting(settingFile), true);

  const off = await setup({ saved: false });
  off.awake.setTurnRunning(true);
  off.awake.hold();
  assert.equal(off.blocker.calls.length, 0);
  assert.equal((await off.awake.status()).enabled, false);
  assert.equal(await readKeepAwakeSetting(path.join(os.tmpdir(), "missing-keep-awake.json")), true);
});

test("skipped over SSH, in CI and with MARS_KEEP_AWAKE=0", async () => {
  assert.equal(keepAwakeSkipReason({}), null);
  assert.equal(keepAwakeSkipReason({ SSH_CONNECTION: "1 2 3 4" }), "ssh");
  assert.equal(keepAwakeSkipReason({ SSH_TTY: "/dev/pts/1" }), "ssh");
  assert.equal(keepAwakeSkipReason({ CI: "true" }), "ci");
  assert.equal(keepAwakeSkipReason({ CI: "false" }), null);
  assert.equal(keepAwakeSkipReason({ MARS_KEEP_AWAKE: "0" }), "env");
  for (const env of [{ SSH_CONNECTION: "x" }, { CI: "1" }, { MARS_KEEP_AWAKE: "off" }]) {
    const { awake, blocker } = await setup({ env });
    awake.setTurnRunning(true);
    awake.hold();
    assert.equal(blocker.calls.length, 0, JSON.stringify(env));
  }
  assert.deepEqual(await (await setup({ env: { SSH_CONNECTION: "x" } })).awake.status(), { enabled: true, active: false, available: false, forcedOff: false });
  assert.deepEqual(await (await setup({ env: { MARS_KEEP_AWAKE: "0" } })).awake.status(), { enabled: true, active: false, available: true, forcedOff: true });
});

test("a blocker that cannot start never fails the turn", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "keep-awake-"));
  const lines = [];
  const awake = createKeepAwake({
    powerSaveBlocker: { start: () => { throw new Error("no power manager"); }, stop: () => undefined, isStarted: () => false },
    settingFile: path.join(dir, KEEP_AWAKE_FILE),
    env: {},
    log: (line) => lines.push(line),
  });
  await awake.loaded;
  assert.doesNotThrow(() => awake.setTurnRunning(true));
  assert.match(lines.join("\n"), /could not start: no power manager/);
});

test("main wires the server's turn activity, the quit and the settings commands", () => {
  const main = readFileSync(path.join(here, "main.mjs"), "utf8");
  assert.ok(main.includes("onTurnActivity: (running) => keepAwake.setTurnRunning(running)"));
  assert.ok(main.includes("const releaseKeepAwake = keepAwake.hold();"));
  assert.ok(main.includes('"keepAwakeStatus": async (event) => keepAwake.status()'));
  assert.ok(main.includes('"keepAwakeSet": async (event, ...args) => keepAwake.setEnabled(args[0] === true)'));
  const runtime = readFileSync(path.join(here, "runtime.mjs"), "utf8");
  assert.ok(runtime.includes('...(typeof onTurnActivity === "function" ? { onTurnActivity } : {}),'));
});
