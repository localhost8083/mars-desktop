/**
 * Parallel chats on one folder: a turn's diff is a whole-workspace
 * comparison, so what another chat's agent wrote during the same window
 * lands in it too. Each turn's window is noted in a small registry per
 * project folder (`<state>/mars-turns/<folder hash>/<session>.json`),
 * shared by every process of the app on this machine (two terminals, the
 * desktop app's chats), and a turn whose window met another session's is
 * marked (`turn.overlap`): which sessions, and which of its changed paths
 * no tool of its own wrote.
 *
 * The same file in mars-cli (assets/extensions/mars/capture/session-archive/)
 * and mars-gui (apps/server/src/session-archive/), listed in PARITY.sha256.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const TURN_OVERLAP_DIRECTORY = "mars-turns";
/** A window older than this is no one's any more (removed when seen). */
const STALE_MS = 24 * 60 * 60_000;
/** An open window whose process is gone counts as ended this long after it was last noted. */
const OPEN_GRACE_MS = 60_000;
const MAX_PATHS = 200;

export type TurnWindow = { session_id: string; pid: number; start: number; end: number | null; noted_at: number };

const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function folderKey(root: string): string {
  return createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 24);
}

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** The registry of one machine's turn windows, per project folder. */
export class TurnWindows {
  constructor(private readonly stateDir: string | null, private readonly now: () => number = Date.now) {}

  private dir(root: string): string | null {
    return this.stateDir ? path.join(this.stateDir, TURN_OVERLAP_DIRECTORY, folderKey(root)) : null;
  }

  private async write(root: string, window: TurnWindow): Promise<void> {
    const dir = this.dir(root);
    if (!dir || !SESSION_ID.test(window.session_id)) return;
    try {
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `${window.session_id}.json`);
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(window));
      await rename(temp, file);
    } catch {
      /* best effort: without it only this process's own sessions are compared */
    }
  }

  /** A turn of `sessionId` on `root` began at `start`. */
  async started(root: string, sessionId: string, start: number): Promise<void> {
    await this.write(root, { session_id: sessionId, pid: process.pid, start, end: null, noted_at: this.now() });
  }

  /** The turn that began at `start` ended at `end`. */
  async ended(root: string, sessionId: string, start: number, end: number): Promise<void> {
    await this.write(root, { session_id: sessionId, pid: process.pid, start, end, noted_at: this.now() });
  }

  /** Every other session whose noted window on `root` met [start, end]. */
  async overlapping(root: string, sessionId: string, start: number, end: number): Promise<string[]> {
    const dir = this.dir(root);
    if (!dir) return [];
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const found: string[] = [];
    for (const name of names.slice(0, 256)) {
      const file = path.join(dir, name);
      let window: TurnWindow;
      try {
        window = JSON.parse(await readFile(file, "utf8")) as TurnWindow;
      } catch {
        continue;
      }
      if (!window || typeof window.session_id !== "string" || window.session_id === sessionId || typeof window.start !== "number") continue;
      const last = typeof window.end === "number" ? window.end : alive(window.pid) ? this.now() : (window.noted_at ?? window.start) + OPEN_GRACE_MS;
      if (this.now() - last > STALE_MS) {
        await rm(file, { force: true }).catch(() => undefined);
        continue;
      }
      if (window.start <= end && last >= start) found.push(window.session_id);
    }
    return found.sort();
  }
}

/**
 * The `turn.overlap` event of a turn whose window met other sessions' on
 * the same folder, or null: the other sessions, and the changed paths no
 * tool of this session wrote (each may be another chat's).
 */
export function turnOverlapEvent(input: { others: readonly string[]; changed: readonly string[]; ownWrites: ReadonlySet<string>; start: number; end: number }): Record<string, unknown> | null {
  const others = [...new Set(input.others)].sort();
  if (others.length === 0) return null;
  const foreign = input.changed.filter((changed) => !input.ownWrites.has(changed));
  return {
    other_session_ids: others.slice(0, 32),
    window: { start: new Date(input.start).toISOString(), end: new Date(input.end).toISOString() },
    changed: input.changed.length,
    not_written_here: foreign.slice(0, MAX_PATHS),
    not_written_here_truncated: foreign.length > MAX_PATHS,
  };
}
