// Buildathon reproducibility mode (contract "Reproducibility mode"; CLI:
// assets/extensions/mars/buildathon-lib.js, keep the two in step).
//
// The app sends the event's `repro` block and its buildathon projects (a
// folder with a track, or one skipped inside the event) to the server,
// which keeps them in one file next to the box's projects file. Two readers:
// the box service (the project's chats run in its box when `box` is "on")
// and the engine plugin (opencode-plugins/mars-buildathon.ts, which adds
// the agent rules to the chat's instructions). Nothing is written into the
// user's project.
//
// Kept small and free of server imports: the engine plugin bundles it.

import { readFileSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { boxHome, keyOf } from "./box/plugin-lib.js";

/** The server's default rules, word for word (clients embed the same as the fallback). */
export const DEFAULT_AGENT_RULES = "This project is part of the Mars Buildathon and must rebuild from scratch on a clean Linux machine. Keep every file the project needs inside this folder and use git, committing after each working step. Pin the runtime version (.nvmrc / .python-version / go.mod toolchain / rust-toolchain.toml) and always keep a lockfile; install dependencies only into the project (no global installs, no sudo outside the Dockerfile). Maintain a Dockerfile that installs every system package and dependency and can build and run the project, a single test command (e.g. `make test`) that works offline, and a README with exact setup, run, test and deploy steps. Never hard-code absolute paths from this machine or put secrets in files (use .env.example). After each change, run the tests.";

/** The heading the rules go under (the CLI's rules file starts the same way). */
export const AGENT_RULES_HEADING = "# Mars Buildathon: reproducibility";

export const BUILDATHON_PROJECTS_FILE = "buildathon-projects.json";

/** One line on a buildathon project whose sandbox its user turned off. */
export const LESS_REPRO_NOTICE = "This buildathon project runs on this computer (sandbox off here), so it is less reproducible. Turn the Linux sandbox on to run it in the box.";
/** The "offer" for a buildathon project. */
export const BUILDATHON_OFFER_NOTICE = "This buildathon project rebuilds more reliably in the Linux sandbox. Turn it on to run its chats there.";

export type ReproBox = "on" | "offer" | "off";
export type BuildathonReproState = {
  box: ReproBox;
  agentRules: string;
  /** Box keys (box/common.ts boxKey) of the buildathon projects. */
  keys: string[];
  /** After this (the event's deadline) the state no longer applies. */
  until: number | null;
  updated: number;
};

const BOX_MODES = new Set(["on", "offer", "off"]);
const MAX_RULES = 8_000;
const MAX_PROJECTS = 200;

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function buildathonProjectsFile(home: string = boxHome()): string {
  return path.join(home, BUILDATHON_PROJECTS_FILE);
}

/** The `repro` block's box and rules; a missing or partial block falls back to the defaults (box on). */
export function parseReproBlock(block: unknown): { box: ReproBox; agentRules: string } {
  const value = block && typeof block === "object" && !Array.isArray(block) ? block as Record<string, unknown> : {};
  const rules = text(value.agent_rules ?? value.agentRules);
  return {
    box: BOX_MODES.has(value.box as string) ? value.box as ReproBox : "on",
    agentRules: rules && rules.length <= MAX_RULES ? rules : DEFAULT_AGENT_RULES,
  };
}

/** A folder that is never a project of its own: a drive or file-system root, the home folder, the temp folder. */
export function genericFolder(dir: string, { home = os.homedir() }: { home?: string } = {}): boolean {
  const key = path.resolve(dir);
  if (path.dirname(key) === key) return true;
  return [home, os.tmpdir()].filter(Boolean).map((d) => path.resolve(d)).includes(key);
}

/**
 * The app's PUT body ({ repro, projects: [folder paths], deadline_at }) as the
 * state to keep; projects: absolute folders, generic ones left out.
 */
export function reproStateFromBody(body: Record<string, unknown>, { now = Date.now(), home = os.homedir() }: { now?: number; home?: string } = {}): BuildathonReproState {
  const { box, agentRules } = parseReproBlock(body.repro);
  const folders = Array.isArray(body.projects) ? body.projects : [];
  const keys = new Set<string>();
  for (const folder of folders.slice(0, MAX_PROJECTS)) {
    const dir = text(folder);
    if (!dir || !path.isAbsolute(dir) || genericFolder(dir, { home })) continue;
    keys.add(keyOf(dir));
  }
  const until = typeof body.deadline_at === "string" && Number.isFinite(Date.parse(body.deadline_at)) ? Date.parse(body.deadline_at) : null;
  return { box, agentRules, keys: [...keys].sort(), until, updated: now };
}

/** Saves the state (an empty project list removes the file). */
export async function writeReproState(state: BuildathonReproState, file = buildathonProjectsFile()): Promise<void> {
  if (!state.keys.length) {
    await rm(file, { force: true });
    cache = null;
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ box: state.box, agent_rules: state.agentRules, keys: state.keys, until: state.until, updated: state.updated })}\n`, { mode: 0o600 });
  await rename(tmp, file);
  cache = null;
}

let cache: { file: string; mtime: number; state: BuildathonReproState | null } | null = null;

/** The kept state, re-read when the file changes; null when there is none or it is past the deadline. */
export function readReproState(file = buildathonProjectsFile(), now = Date.now()): BuildathonReproState | null {
  let mtime = 0;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    cache = null;
    return null;
  }
  if (!cache || cache.file !== file || cache.mtime !== mtime) {
    let state: BuildathonReproState | null = null;
    try {
      const value = JSON.parse(readFileSync(file, "utf8"));
      const { box, agentRules } = parseReproBlock(value);
      const keys = Array.isArray(value?.keys) ? value.keys.filter((key: unknown): key is string => typeof key === "string") : [];
      state = { box, agentRules, keys, until: typeof value?.until === "number" ? value.until : null, updated: Number(value?.updated) || 0 };
    } catch {
      state = null;
    }
    cache = { file, mtime, state };
  }
  const state = cache.state;
  if (!state || (state.until !== null && now > state.until)) return null;
  return state;
}

/** The buildathon project a folder belongs to: its `box` setting, or null when it is not one. */
export function buildathonBoxFor(root: string, file = buildathonProjectsFile(), now = Date.now()): ReproBox | null {
  const state = readReproState(file, now);
  if (!state) return null;
  return state.keys.includes(keyOf(root)) ? state.box : null;
}

/** The rules for a chat in `dir` (with their heading), or null outside a buildathon project. */
export function agentRulesFor(dir: string, file = buildathonProjectsFile(), now = Date.now()): string | null {
  const state = readReproState(file, now);
  if (!state || !state.keys.includes(keyOf(dir))) return null;
  return `${AGENT_RULES_HEADING}\n\n${state.agentRules}`;
}
