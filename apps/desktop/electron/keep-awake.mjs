// Keep the computer awake while the agent works.
//
// The local server says when the agent starts and stops working
// (apps/server/src/turn-activity.ts, `onTurnActivity`): from a prompt sent
// until no turn runs any more (finished, stopped or failed). Meanwhile, and
// while the uploads finish as the app quits, Electron's
// powerSaveBlocker 'prevent-app-suspension' holds off system sleep. The
// display still turns off and locks as usual, an idle open chat holds
// nothing, and the blocker goes with the app when it exits or crashes. No
// admin rights, no power setting is changed.
//
// On by default: Settings > General > "Keep this computer awake while the
// agent works" (<userData>/keep-awake.json), or MARS_KEEP_AWAKE=0 for a
// launch. Skipped, silently, over SSH and in CI.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const KEEP_AWAKE_FILE = "keep-awake.json";
const OFF_WORDS = ["0", "off", "false", "no"];

/** Why keep awake never runs in this launch ("env", "ssh", "ci"), or null. */
export function keepAwakeSkipReason(env = process.env) {
  if (OFF_WORDS.includes(String(env.MARS_KEEP_AWAKE ?? "").trim().toLowerCase())) return "env";
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return "ssh";
  const ci = String(env.CI ?? "").trim().toLowerCase();
  if (ci && !OFF_WORDS.includes(ci)) return "ci";
  return null;
}

/** The saved setting: off only for { "enabled": false }. */
export async function readKeepAwakeSetting(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return !(parsed && typeof parsed === "object" && parsed.enabled === false);
  } catch {
    return true;
  }
}

export async function writeKeepAwakeSetting(file, enabled) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify({ enabled: enabled === true })}\n`, { mode: 0o600 });
  await rename(temp, file);
}

/**
 * @param {{
 *   powerSaveBlocker: { start: (type: "prevent-app-suspension") => number, stop: (id: number) => void, isStarted: (id: number) => boolean },
 *   settingFile: string,
 *   env?: NodeJS.ProcessEnv,
 *   log?: (line: string) => void,
 * }} deps
 */
export function createKeepAwake({ powerSaveBlocker, settingFile, env = process.env, log = (line) => console.log(line) }) {
  const skip = keepAwakeSkipReason(env);
  let enabled = true;
  let running = false;
  let holds = 0;
  let stopped = false;
  /** @type {number | null} */
  let blocker = null;
  if (skip) log(`[keep-awake] skipped (${skip})`);

  function sync() {
    const wanted = !stopped && !skip && enabled && (running || holds > 0);
    if (wanted && blocker === null) {
      try {
        blocker = powerSaveBlocker.start("prevent-app-suspension");
        log(`[keep-awake] started id=${blocker} isStarted=${powerSaveBlocker.isStarted(blocker)}`);
      } catch (error) {
        blocker = null;
        log(`[keep-awake] could not start: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (!wanted && blocker !== null) {
      const id = blocker;
      blocker = null;
      try {
        powerSaveBlocker.stop(id);
        log(`[keep-awake] stopped id=${id} isStarted=${powerSaveBlocker.isStarted(id)}`);
      } catch (error) {
        log(`[keep-awake] could not stop: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const loaded = readKeepAwakeSetting(settingFile).then((value) => {
    enabled = value;
    sync();
  });

  function state() {
    return { enabled, active: blocker !== null, available: skip === null || skip === "env", forcedOff: skip === "env" };
  }

  return {
    loaded,
    /** The local server: the agent started (true) or stopped (false) working. */
    setTurnRunning(value) {
      running = value === true;
      sync();
    },
    /** Kept on for other work (the uploads as the app quits); returns its release. */
    hold() {
      holds += 1;
      sync();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
        sync();
      };
    },
    async setEnabled(value) {
      await loaded;
      enabled = value === true;
      await writeKeepAwakeSetting(settingFile, enabled);
      sync();
      return state();
    },
    async status() {
      await loaded;
      return state();
    },
    stop() {
      stopped = true;
      sync();
    },
  };
}
