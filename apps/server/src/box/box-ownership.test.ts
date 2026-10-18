// Ported from the CLI (mars-cli #216, #217): a box whose folder was replaced
// is restarted, and gc removes only this home's own boxes no other live process uses.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gcBoxes, mountReplaced } from "./box.js";

const DAY = 86_400_000;

describe("gcBoxes", () => {
  test("removes only this home's own boxes no other process uses; never another user's, even when its folder looks gone", async () => {
    const home = mkdtempSync(join(tmpdir(), "box-gc-"));
    mkdirSync(join(home, "boxes"), { recursive: true });
    const now = Date.now();
    const dead = 2 ** 22 + 12345;
    const boxes: Record<string, { root: string; rec: Record<string, unknown> | null }> = {
      gone: { root: "/home/me/deleted", rec: { updated: now, pid: dead } },
      idle: { root: "/home/me/old", rec: { updated: now - 40 * DAY, pid: dead } },
      fresh: { root: "/home/me/live", rec: { updated: now, pid: dead } },
      mine: { root: "/home/me/gone-mine", rec: { updated: now, pid: process.pid } },
      other: { root: "/home/alice/proj", rec: null },
      moved: { root: "/home/bob/same-key", rec: { root: "/home/me/elsewhere", updated: now - 40 * DAY, pid: dead } },
    };
    for (const [key, b] of Object.entries(boxes)) {
      if (b.rec) writeFileSync(join(home, "boxes", `${key}.json`), JSON.stringify({ key, root: (b.rec.root as string | undefined) ?? b.root, ...b.rec }));
    }
    const removed: string[] = [];
    const run = async (_bin: string, args: string[]) => {
      if (args[0] === "ps") return { code: 0, stdout: Object.entries(boxes).map(([key, b]) => JSON.stringify({ Names: `mars-box-${key}`, Labels: `ai.mars.box=1,ai.mars.box.key=${key},ai.mars.box.root=${b.root}`, Status: "Up 3 hours", Image: "ghcr.io/omnirush-ai/box-base@sha256:x" })).join("\n"), stderr: "" };
      if (args[0] === "rm") { removed.push(String(args.at(-1))); return { code: 0, stdout: "", stderr: "" }; }
      if (args[0] === "images") return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    const exists = (p: string) => !["/home/me/deleted", "/home/me/gone-mine", "/home/alice/proj", "/home/bob/same-key"].includes(p);
    // The desktop's own records carry its own pid: a folder of its own that is gone is still collected.
    const out = await gcBoxes({ name: "docker", backend: "docker", bin: "docker" } as never, { home, run: run as never, exists, now, pins: { images: {} } as never });
    expect(removed.sort()).toEqual(["mars-box-gone", "mars-box-idle", "mars-box-mine"]);
    expect(out.map((r) => `${r.name}:${r.reason}`).sort()).toEqual(["mars-box-gone:folder gone", "mars-box-idle:unused", "mars-box-mine:folder gone"]);
  });
});

describe("mountReplaced", () => {
  const opened = { endpoint: { host: "127.0.0.1", port: 1, token: "t" } };
  const ping = (async () => ({ uid: 1000 })) as never;

  test("a project folder with no links left (deleted, made again) is replaced; asked from /", async () => {
    const seen: Array<{ argv: string[]; cwd?: string }> = [];
    const exec = (async (_way: unknown, argv: string[], opts: { cwd?: string }) => { seen.push({ argv, cwd: opts.cwd }); return { code: 0, stdout: "0\n", stderr: "" }; }) as never;
    expect(await mountReplaced(opened as never, { croot: "/home/u/proj", exec, ping })).toBe(true);
    expect(seen).toEqual([{ argv: ["stat", "-c", "%h", "/home/u/proj"], cwd: "/" }]);
  });

  test("a live folder, a failed stat or no answer is not replaced", async () => {
    expect(await mountReplaced(opened as never, { croot: "/p", exec: (async () => ({ code: 0, stdout: "2\n", stderr: "" })) as never, ping })).toBe(false);
    expect(await mountReplaced(opened as never, { croot: "/p", exec: (async () => ({ code: 1, stdout: "", stderr: "x" })) as never, ping })).toBe(false);
    expect(await mountReplaced(opened as never, { croot: "/p", exec: (async () => { throw new Error("closed"); }) as never, ping })).toBe(false);
    expect(await mountReplaced(opened as never, { croot: "/p", exec: (async () => ({ code: 0, stdout: "0", stderr: "" })) as never, ping: (async () => null) as never, readyMs: 120 })).toBe(false);
  });
});
