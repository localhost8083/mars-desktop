// Ported from the CLI (mars-cli src/box/backends/shared.js,
// feat/local-box-backends); keep the two in step. Desktop: the shell link is
// in <home>/shell-desktop (common.ts shellDir).
//
// What every backend without a container CLI shares.

import path from "node:path";

import { shellDir } from "../common.js";
import type { BoxExec } from "./types.js";

/**
 * Run a program in the box with stdin open (the files-used reader) through
 * boxsh, the engine's shell: `bash -c 'exec "$0" "$@"' prog args...`.
 */
export function boxshExec({ key, home, platform = process.platform }: { key: string; home: string; platform?: NodeJS.Platform }): BoxExec {
  return {
    bin: path.join(shellDir(home), platform === "win32" ? "bash.exe" : "bash"),
    args: ["-c", 'exec "$0" "$@"'],
    env: { MARS_BOX_KEY: key, MARS_BOX_HOME: home },
  };
}

/** "1.4.1" >= "1.0.0"; non-numeric parts count as 0. */
export function versionAtLeast(version: unknown, min: string): boolean {
  const a = String(version).split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  const b = String(min).split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/** The last JSON object a helper printed (boxrun prints one line per answer). */
export function parseOut(stdout: unknown): Record<string, unknown> | null {
  const lines = String(stdout ?? "").split("\n").map((line) => line.trim()).filter((line) => line.startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const value: unknown = JSON.parse(lines[i]!);
      if (value && typeof value === "object" && !Array.isArray(value)) return Object.fromEntries(Object.entries(value));
    } catch { /* next */ }
  }
  return null;
}

/** A field of a helper's answer as a string ("" when absent). */
export function str(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

/** A field of a helper's answer as a number (null when not one). */
export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
