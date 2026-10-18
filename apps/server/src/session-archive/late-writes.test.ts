import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { CaptureHost } from "../capture-host.js";
import {
  createSessionObservers,
  observeUploadedSession,
  turnEndedAt,
  type EngineTarget,
  type ObservedUploader,
  type ObserverTiming,
} from "../session-upload-observer.js";
import { SessionArchiver, type CaptureResult } from "./index.js";
import { lateWriters, settleLateWriters } from "./late-writes.js";
import { ProjectArchiveLifecycle, promptTurnAt, type ArchiveEngineReads, type LateWrites, type ProjectArchiver } from "./lifecycle.js";
import { openSealedBuffer, SEAL_ALG, sealKeyring } from "./seal.js";
import { readTar } from "./test-helpers.js";
import { toolStartTime, watchToolStarts } from "./tool-start.js";
import { turnWriters } from "./turn-writers.js";

// Turn boundaries, the desktop's side of mars-cli's late-writes test: a
// turn's start is taken from the workspace as its first tool call found it,
// after the turn before's background processes finished writing; what they
// wrote after that turn ended is marked late; and the files the root session
// and its sub-agents both wrote in a turn are named.

const cleanups: string[] = [];
const stops: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (stops.length) await stops.pop()?.();
});
afterAll(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

const linux = process.platform === "linux";
const sleep = (ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=main", "-c", "commit.gpgSign=false", ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString();
}
function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(dir);
  return dir;
}
function write(file: string, content: string, mtimeMs?: number): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mtimeMs !== undefined) utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
}

type Entry = { path: string };
type Opened = { manifest: { reason?: string; files: Entry[] }; state: { state: { kind: string; turn: number; reason?: string } } };

function rig() {
  const stateDir = temp("mars-late-state-");
  const keyring = sealKeyring([randomBytes(32)]);
  const { publicRaw, kid } = [...keyring.values()][0]!;
  const request = async (route: string) => route === "archives/key"
    ? Response.json({ public_key: publicRaw.toString("base64"), kid, alg: SEAL_ALG, policy: { all_folders: true, touched_files: true, capture_v2: true } })
    : new Response("{}", { status: 404 });
  const archiver = new SessionArchiver({ stateDir, request, excludedDirs: [stateDir], log: () => undefined, touchedFlushMs: 10 });
  stops.push(() => archiver.stop({ budgetMs: 1000 }));
  const open = async (result: CaptureResult): Promise<Opened> => {
    if (result.status !== "queued") throw new Error(`not queued: ${JSON.stringify(result)}`);
    const sealed = readFileSync(join(stateDir, "mars-archive", "pending", `${result.archiveId}.orseal`));
    const members = readTar(zstdDecompressSync(await openSealedBuffer(sealed, keyring)));
    const json = (name: string) => JSON.parse(members.find((member) => member.name === name)!.content.toString("utf8"));
    return { manifest: json("__mars__/manifest.json"), state: json("__mars__/state.json") };
  };
  return { archiver, open };
}

/** A project archiver whose pre_tool states report one late file; every capture is recorded. */
function fakeArchiver(calls: unknown[][]): ProjectArchiver {
  return {
    captureBase: async (_id: string, _root: string, turn = 0) => (calls.push(["base", turn]), { status: "queued", archiveId: "b", kind: "base", sequence: 0, size: 1 }),
    captureDelta: async (_id: string, _root: string, turn: number | null) => (calls.push(["delta", turn]), { status: "queued", archiveId: "d", kind: "delta", sequence: 1, size: 1 }),
    captureFinal: async () => ({ status: "skipped", reason: "unchanged" }),
    startFinalCandidates: async () => [],
    recordTouched: () => undefined,
    forgetTouched: () => undefined,
    drain: async () => ({ uploaded: 0, pending: 0, dropped: 0, blocked: null, disabled: false }),
    signOut: async () => undefined,
    stop: async () => undefined,
    startManifest: async () => "complete",
    hasStartManifest: () => true,
    captureState: async (_id: string, stateTurn: number, options?: unknown) => (calls.push(["pre_tool", stateTurn, options]), { status: "queued", archiveId: "p", kind: "delta", sequence: 2, size: 1, late: ["late.txt"] }),
  } as ProjectArchiver;
}

type Message = { info: Record<string, unknown>; parts: unknown[] };

describe("late writes: the archive", () => {
  test("a pre_tool state is the folder as the first tool call found it: late writes in, marked; the tool's own writes out", async () => {
    const { archiver, open } = rig();
    const root = temp("mars-late-ws-");
    write(join(root, "a.txt"), "turn one\n");
    write(join(root, "edit.txt"), "v1\n");
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-qm", "init");
    const sessionId = "ses_late_pre_tool";
    await archiver.startManifest(sessionId, root);
    await open(await archiver.captureBase(sessionId, root, 0));
    const ended = Date.now() - 5_000;
    const toolStart = Date.now() - 1_000;
    // The turn before's background job, after that turn ended and before this turn's first tool call.
    write(join(root, "late.txt"), "late from turn 1\n", toolStart - 2_000);
    // The first tool call's own writes, racing the state: a new file and an edit.
    write(join(root, "tool.txt"), "written by the tool\n", toolStart + 10);
    write(join(root, "edit.txt"), "v2 by the tool\n", toolStart + 20);
    const result = await archiver.captureState(sessionId, 2, { before: toolStart, lateAfter: ended });
    expect(result.status === "queued" ? result.late : null).toEqual(["late.txt"]);
    const pre = await open(result);
    expect(pre.state.state).toEqual({ kind: "pre_tool", turn: 2 });
    expect(pre.manifest.reason).toBe("late_writes");
    // The tool's own writes are left to the turn's delta.
    expect(pre.manifest.files.map((entry) => entry.path)).toEqual(["late.txt"]);
    // The turn's delta then carries them.
    const after = await open(await archiver.captureDelta(sessionId, root, 2));
    expect(after.manifest.files.map((entry) => entry.path).sort()).toEqual(["edit.txt", "tool.txt"]);
    expect(after.manifest.reason).toBeUndefined();
  });

  test("a pre_tool state with no late write carries no reason", async () => {
    const { archiver, open } = rig();
    const root = temp("mars-late-ws-");
    write(join(root, "a.txt"), "x\n");
    const sessionId = "ses_late_none";
    await archiver.startManifest(sessionId, root);
    await open(await archiver.captureBase(sessionId, root, 0));
    const ended = Date.now();
    write(join(root, "user.txt"), "the user's edit before the turn ended\n", ended - 3_000);
    const result = await archiver.captureState(sessionId, 2, { before: Date.now() + 1_000, lateAfter: ended });
    const pre = await open(result);
    expect(result.status === "queued" ? result.late : "not queued").toBeUndefined();
    expect(pre.manifest.reason).toBeUndefined();
  });
});

describe("late writes: the lifecycle", () => {
  test("a prompt sent before the turn before settled is a turn of its own; its pre_tool state is cut at the tool's start and late after the turn before ended", async () => {
    const calls: unknown[][] = [];
    const reported: LateWrites[] = [];
    let clock = 1_000_000;
    const prompts: Message[] = [];
    const engine: ArchiveEngineReads = { session: async () => ({ id: "ses_quick" }), messages: async () => prompts };
    const lifecycle = new ProjectArchiveLifecycle({ archiver: fakeArchiver(calls), enabled: true, log: () => undefined, now: () => clock, onLateWrites: (item) => reported.push(item) });
    stops.push(() => lifecycle.stop({ finals: false }));
    prompts.push({ info: { id: "u1", role: "user", time: { created: clock } }, parts: [{ type: "text", text: "one" }] });
    lifecycle.sessionStarted({ sessionId: "ses_quick", root: tmpdir(), engine });
    clock += 100;
    lifecycle.toolStarted("ses_quick", clock);
    await lifecycle.settled();
    expect(calls.at(-1)).toEqual(["pre_tool", 1, { before: 1_000_100 }]);
    // Turn 1 settles (its end), then a second prompt; and a third one sent into turn 2 before it settled.
    clock += 1_000;
    const answered = [...prompts, { info: { id: "a1", role: "assistant", time: { completed: clock } }, parts: [{ type: "step-finish" }] }];
    lifecycle.turnCompleted("ses_quick", answered);
    prompts.push(answered[1]!);
    const endedAt = clock;
    clock += 2_000;
    prompts.push({ info: { id: "u2", role: "user", time: { created: clock } }, parts: [{ type: "text", text: "two" }] });
    lifecycle.sessionStarted({ sessionId: "ses_quick", root: tmpdir(), engine });
    clock += 500;
    lifecycle.toolStarted("ses_quick", clock);
    await lifecycle.settled();
    expect(calls.at(-1)).toEqual(["pre_tool", 2, { before: clock, lateAfter: endedAt }]);
    expect(reported.at(-1)).toEqual({ sessionId: "ses_quick", turn: 2, after: endedAt, toolStartAt: clock, paths: ["late.txt"] });
    const thirdAt = clock + 100;
    clock = thirdAt;
    prompts.push({ info: { id: "u3", role: "user", time: { created: clock } }, parts: [{ type: "text", text: "three" }] });
    lifecycle.sessionStarted({ sessionId: "ses_quick", root: tmpdir(), engine });
    clock += 300;
    lifecycle.toolStarted("ses_quick", clock);
    await lifecycle.settled();
    // Turn 2 never settled (no turnCompleted): turn 3 by the engine's prompts, late after its own prompt.
    expect(calls.at(-1)).toEqual(["pre_tool", 3, { before: clock, lateAfter: thirdAt }]);
  });

  test("a turn the next prompt cut settles after that prompt: its writes are late from the prompt on", async () => {
    const calls: unknown[][] = [];
    let clock = 2_000_000;
    const prompts: Message[] = [];
    const engine: ArchiveEngineReads = { session: async () => ({ id: "ses_cut" }), messages: async () => prompts };
    const lifecycle = new ProjectArchiveLifecycle({ archiver: fakeArchiver(calls), enabled: true, log: () => undefined, now: () => clock });
    stops.push(() => lifecycle.stop({ finals: false }));
    prompts.push({ info: { id: "u1", role: "user", time: { created: clock } }, parts: [{ type: "text", text: "one" }] });
    lifecycle.sessionStarted({ sessionId: "ses_cut", root: tmpdir(), engine });
    clock += 100;
    lifecycle.toolStarted("ses_cut", clock);
    await lifecycle.settled();
    // The second prompt goes out first; the observer settles turn 1 (cut) a moment later.
    clock += 1_000;
    const secondAt = clock;
    prompts.push({ info: { id: "u2", role: "user", time: { created: clock } }, parts: [{ type: "text", text: "two" }] });
    lifecycle.sessionStarted({ sessionId: "ses_cut", root: tmpdir(), engine });
    clock += 400;
    lifecycle.turnCompleted("ses_cut", prompts.slice(0, 1));
    clock += 200;
    lifecycle.toolStarted("ses_cut", clock);
    await lifecycle.settled();
    expect(calls.at(-1)).toEqual(["pre_tool", 2, { before: clock, lateAfter: secondAt }]);
  });

  test("without readable messages a pre_tool state takes the completed turns plus one", async () => {
    const calls: unknown[][] = [];
    let reads = 0;
    // Readable at the session's start, not at its tool call.
    const engine: ArchiveEngineReads = {
      session: async () => ({ id: "ses_unread" }),
      messages: async () => {
        if ((reads += 1) > 1) throw new Error("down");
        return [];
      },
    };
    const lifecycle = new ProjectArchiveLifecycle({ archiver: fakeArchiver(calls), enabled: true, log: () => undefined });
    stops.push(() => lifecycle.stop({ finals: false }));
    lifecycle.sessionStarted({ sessionId: "ses_unread", root: tmpdir(), engine });
    lifecycle.toolStarted("ses_unread", 5);
    await lifecycle.settled();
    expect(calls.at(-1)?.[1]).toBe(1);
  });

  test("promptTurnAt counts the prompts sent up to a moment, not synthetic or compaction messages", () => {
    const messages = [
      { info: { role: "user", time: { created: 10 } }, parts: [{ type: "text", text: "a" }] },
      { info: { role: "assistant", time: { created: 11, completed: 12 } }, parts: [] },
      { info: { role: "user", time: { created: 13 } }, parts: [{ type: "text", text: "background result", synthetic: true }] },
      { info: { role: "user", agent: "compaction", time: { created: 14 } }, parts: [{ type: "text", text: "summarize" }] },
      { info: { role: "user", time: { created: 20 } }, parts: [{ type: "text", text: "b" }] },
      { info: { role: "user", time: { created: 30 } }, parts: [{ type: "text", text: "c" }] },
    ];
    expect(promptTurnAt(messages, 25)).toBe(2);
    expect(promptTurnAt(messages, 30)).toBe(3);
    expect(promptTurnAt(messages, 5)).toBeNull();
    expect(promptTurnAt(null, 5)).toBeNull();
  });
});

describe("late writes: tool start", () => {
  test("the tool-start time: the event's own time, the earliest of the event and the part's start", () => {
    expect(toolStartTime({ type: "message.part.updated", properties: { part: { type: "tool", state: { status: "pending" } }, time: 1_791_734_333_976 } })).toBe(1_791_734_333_976);
    expect(toolStartTime({ type: "message.part.updated", properties: { part: { type: "tool", state: { status: "running", time: { start: 1_791_734_333_981 } } }, time: 1_791_734_333_990 } })).toBe(1_791_734_333_981);
    expect(toolStartTime({ payload: { type: "session.tool.called", data: { sessionID: "s", timestamp: "2026-10-11T16:00:00.000Z" } } })).toBe(Date.parse("2026-10-11T16:00:00.000Z"));
    // Not epoch milliseconds.
    expect(toolStartTime({ type: "message.part.updated", properties: { time: 12 } })).toBeNull();
    expect(toolStartTime(null)).toBeNull();
  });

  test("the tool-start hook passes when the call started", async () => {
    const frame = { type: "message.part.updated", properties: { part: { type: "tool", sessionID: "ses_t", state: { status: "pending" } }, time: 1_791_000_000_000 } };
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify(frame)}\n\n`);
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    stops.push(() => { server.closeAllConnections(); server.close(); });
    const seen: number[] = [];
    await watchToolStarts({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/event`,
      headers: new Headers(),
      sessionId: "ses_t",
      signal: AbortSignal.timeout(5_000),
      fetch: (url, init) => fetch(url, init),
      onToolStart: (at) => seen.push(at),
    });
    expect(seen).toEqual([1_791_000_000_000]);
  });
});

/** Starts `script` in `cwd` in a shell that exits at once: the job is orphaned, as a tool's `cmd &` is once its shell ends. Returns the job's pid. */
function orphan(cwd: string, script: string): number {
  const pid = Number(execFileSync("sh", ["-c", `(${script}) >/dev/null 2>&1 </dev/null & echo $!`], { cwd }).toString().trim());
  stops.push(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone.
    }
  });
  return pid;
}

describe("late writes: the processes", () => {
  test.skipIf(!linux)("late writers: the turn's background processes in the workspace, waited for until they exit, never past the cap", async () => {
    const root = temp("mars-late-proc-");
    const outside = temp("mars-late-out-");
    const since = Date.now() - 1_000;
    const job = spawn("sh", ["-c", "sleep 1.2; echo late > late.txt"], { cwd: root, detached: true, stdio: "ignore" });
    const elsewhere = spawn("sh", ["-c", "sleep 5"], { cwd: outside, detached: true, stdio: "ignore" });
    const excluded = spawn("sh", ["-c", "sleep 5"], { cwd: root, detached: true, stdio: "ignore" });
    stops.push(() => {
      for (const child of [job, elsewhere, excluded]) {
        try {
          process.kill(child.pid!, "SIGKILL");
        } catch {
          // Gone.
        }
      }
    });
    await sleep(100);
    const found = await lateWriters({ root, since, exclude: [excluded.pid!] });
    expect(found.some((item) => item.pid === job.pid)).toBe(true);
    // Working outside the workspace.
    expect(found.some((item) => item.pid === elsewhere.pid)).toBe(false);
    // Excluded (the engine's tree).
    expect(found.some((item) => item.pid === excluded.pid)).toBe(false);
    // Started before the turn.
    expect(await lateWriters({ root, since: Date.now() + 60_000, exclude: [] })).toEqual([]);

    const started = Date.now();
    const settled = await settleLateWriters({ root, since, exclude: [excluded.pid!], endedAt: Date.now(), capMs: 5_000 });
    expect(settled.settled).toBe(true);
    expect(settled.processes.some((item) => item.pid === job.pid)).toBe(true);
    // The late write landed before the wait ended.
    expect(readFileSync(join(root, "late.txt"), "utf8")).toBe("late\n");
    expect(Date.now() - started).toBeLessThan(4_000);

    const capped = Date.now();
    const stuck = await settleLateWriters({ root, since, exclude: [], endedAt: Date.now() - 9_700, capMs: 10_000 });
    // A process still running at the cap (a dev server).
    expect(stuck.settled).toBe(false);
    // The cap counts from the turn's end.
    expect(Date.now() - capped).toBeLessThan(1_500);
    // Linux only.
    expect(await lateWriters({ root, since, exclude: [], platform: "darwin" })).toEqual([]);
  });
});

describe("late writes: turn writers", () => {
  test("the files the root and a sub-agent both wrote are the overlap; none without a sub-agent's write", () => {
    const root = "/work/app";
    const tool = (name: string, input: Record<string, unknown>, start: number, end: number) => ({ type: "tool", tool: name, state: { status: "completed", input, time: { start, end } } });
    const rootMessages = [{ info: { role: "assistant" }, parts: [
      tool("write", { filePath: "/work/app/shared.txt" }, 1_000, 1_001),
      tool("task", { prompt: "help" }, 1_002, 1_500),
      tool("apply_patch", { patchText: "*** Begin Patch\n*** Update File: shared.txt\n@@\n-a\n+b\n*** Add File: root-only.txt\n+x\n*** End Patch" }, 1_600, 1_601),
      tool("bash", { command: "echo > ignored.txt" }, 1_700, 1_701),
    ] }];
    const child = [{ info: { role: "assistant" }, parts: [
      tool("write", { filePath: "sub.txt" }, 1_100, 1_101),
      tool("edit", { filePath: "/work/app/shared.txt" }, 1_200, 1_201),
      tool("write", { filePath: "/elsewhere/out.txt" }, 1_300, 1_301),
      { type: "tool", tool: "write", state: { status: "error", input: { filePath: "failed.txt" } } },
    ] }];
    const result = turnWriters(root, [{ sessionId: "ses_root", role: "root", depth: 0, messages: rootMessages }, { sessionId: "ses_child", role: "child", depth: 1, messages: child }])!;
    expect(result.overlap).toEqual(["shared.txt"]);
    expect(result.files.map((file) => file.path)).toEqual(["root-only.txt", "shared.txt", "sub.txt"]);
    const shared = result.files.find((file) => file.path === "shared.txt")!;
    expect(shared.sessions.map((s) => [s.session_id, s.role, s.calls])).toEqual([["ses_root", "root", 2], ["ses_child", "child", 1]]);
    expect(shared.sessions[1]!.first_at).toBe(new Date(1_200).toISOString());
    expect(turnWriters(root, [{ sessionId: "ses_root", role: "root", depth: 0, messages: rootMessages }])).toBeNull();
  });
});

const SESSION = "ses_late_observed";

/** A fake v1 engine holding one session (and its children): its status and messages. */
function startEngine() {
  const control = {
    status: "busy" as string,
    messages: [] as Message[],
    children: [] as Array<{ id: string }>,
    childMessages: {} as Record<string, Message[]>,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/session/status") return Response.json(control.status === "idle" ? {} : { [SESSION]: { type: control.status } });
      if (url.pathname === `/session/${SESSION}/message`) return Response.json(control.messages);
      if (url.pathname === `/session/${SESSION}/children`) return Response.json(control.children);
      const child = /^\/session\/([^/]+)\/(message|children)$/.exec(url.pathname);
      if (child && child[1]! in control.childMessages) return Response.json(child[2] === "message" ? control.childMessages[child[1]!] : []);
      if (url.pathname === `/session/${SESSION}`) return Response.json({ id: SESSION });
      return Response.json({ code: "not_found" }, { status: 404 });
    },
  });
  stops.push(() => server.stop(true));
  const target: EngineTarget = { baseUrl: `http://127.0.0.1:${server.port}`, headers: [], search: "", engine: "v1" };
  return { control, target };
}

/** A clock that moves only when the observer waits (each wait yields to the event loop for a moment). */
function stepClock() {
  let now = Date.parse("2026-10-11T12:00:00.000Z");
  const timing: Partial<ObserverTiming> = {
    now: () => now,
    sleep: async (ms, signal) => {
      if (signal.aborted) throw signal.reason;
      now += ms;
      await sleep(5);
      if (signal.aborted) throw signal.reason;
    },
  };
  return { timing, now: () => now };
}

class TraceUploader implements ObservedUploader {
  readonly enabled = true;
  readonly traces: Array<{ type: string; data?: unknown }> = [];
  async sessionCheckpoint() { return { resumed: false }; }
  async setSessionCheckpoint() {}
  recordTrace(_sessionId: string, type: string, data?: unknown) { this.traces.push({ type, data }); }
  recordSessionModel() {}
  async childCheckpoints() { return {}; }
  async childSessionIds() { return []; }
  recordChildSession() {}
  noteChildSessionIds(_sessionId: string, ids: readonly string[]) { return ids.length; }
  captureSnapshot() {}
  flushTrace() {}
}

const fakeObservedArchive = () => ({ turnFollowed: () => undefined, turnCompleted: () => undefined, turnIncomplete: () => undefined });

describe("late writes: the observer", () => {
  test("the turn's end: none while it runs, the first idle read once the engine stops, kept once it settles", async () => {
    const engine = startEngine();
    const clock = stepClock();
    const observers = createSessionObservers();
    stops.push(() => observers.controller.abort());
    engine.control.messages = [{ info: { id: "m1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "one" }] }];
    const watching = observeUploadedSession({ sessionUploader: new TraceUploader(), archive: fakeObservedArchive(), observers, sessionId: SESSION, target: engine.target, timing: clock.timing });
    while (!observers.sessions.get(SESSION)?.turn) await sleep(5);
    await sleep(50);
    // Running: a prompt typed now waits for nothing.
    expect(turnEndedAt(observers, SESSION)).toBeNull();
    engine.control.messages.push({ info: { id: "m2", role: "assistant", finish: "stop", time: { created: 2, completed: 3 } }, parts: [{ type: "step-finish" }] });
    engine.control.status = "idle";
    let idleAt: number | null = null;
    while (idleAt === null && observers.sessions.has(SESSION)) {
      idleAt = turnEndedAt(observers, SESSION);
      await sleep(1);
    }
    expect(idleAt).not.toBeNull();
    await watching;
    // Settled: the end is the first idle read, not the settle.
    expect(turnEndedAt(observers, SESSION)).toBe(idleAt);
    expect(idleAt!).toBeLessThan(clock.now());
  });

  test("a settled turn whose sub-agent wrote files records who wrote what (turn.writers)", async () => {
    const engine = startEngine();
    const clock = stepClock();
    const root = temp("mars-late-writers-");
    const tool = (name: string, filePath: string, start: number) => ({ type: "tool", tool: name, state: { status: "completed", input: { filePath }, time: { start, end: start + 1 } } });
    engine.control.status = "idle";
    engine.control.messages = [
      { info: { id: "m1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "one" }] },
      { info: { id: "m2", role: "assistant", finish: "stop", time: { created: 2, completed: 3 } }, parts: [tool("write", join(root, "shared.txt"), 1_000), { type: "step-finish" }] },
    ];
    engine.control.children = [{ id: "ses_late_child" }];
    engine.control.childMessages = { ses_late_child: [{ info: { id: "c1", role: "assistant", time: { created: 2, completed: 3 } }, parts: [tool("edit", join(root, "shared.txt"), 1_200), tool("write", "sub.txt", 1_300)] }] };
    const uploader = new TraceUploader();
    const observers = createSessionObservers();
    stops.push(() => observers.controller.abort());
    await observeUploadedSession({ sessionUploader: uploader, archive: fakeObservedArchive(), turnFiles: { root }, observers, sessionId: SESSION, target: engine.target, timing: clock.timing });
    const writers = uploader.traces.filter((trace) => trace.type === "turn.writers").map((trace) => trace.data as { overlap: string[]; files: Array<{ path: string }> });
    expect(writers).toHaveLength(1);
    expect(writers[0]!.overlap).toEqual(["shared.txt"]);
    expect(writers[0]!.files.map((file) => file.path)).toEqual(["shared.txt", "sub.txt"]);
  });
});

/** A capture host with an upload hook that accepts everything; its traces are recorded. */
function captureHost() {
  const stateDir = temp("mars-late-host-");
  const host = new CaptureHost({
    stateDir,
    appVersion: "test",
    engineVersion: "test",
    log: () => undefined,
    sessionUploader: { upload: async () => new Response("{}", { status: 200 }), context: false },
    archive: { enabled: false, excludedDirs: [] },
  });
  stops.push(() => host.stop({ archiveFinals: false }));
  const traces: Array<{ type: string; data?: unknown }> = [];
  const record = host.sessionUploader.recordTrace.bind(host.sessionUploader);
  host.sessionUploader.recordTrace = (sessionId, type, data) => {
    traces.push({ type, data });
    record(sessionId, type, data);
  };
  return { host, traces };
}

/** Waits until the observer saw the session idle (a status read every second). */
async function untilIdleSeen(host: CaptureHost): Promise<void> {
  const observers = (host as unknown as { observers: ReturnType<typeof createSessionObservers> }).observers;
  for (let waited = 0; turnEndedAt(observers, SESSION) === null; waited += 50) {
    if (waited > 8_000) throw new Error("the observer never saw the session idle");
    await sleep(50);
  }
}

describe("late writes: the prompt hold", () => {
  test.skipIf(!linux)("a prompt after the turn before ended waits for that turn's background job, then goes out", async () => {
    const engine = startEngine();
    const root = temp("mars-late-hold-");
    const { host, traces } = captureHost();
    host.startSession(SESSION, "ws", root);
    await host.archiveStartGate(SESSION, root, { exclude: [] });
    host.observeSession(SESSION, engine.target);
    // The turn's `cmd &`, started a while into the turn (/proc start times are whole-second precise): still writing after the turn ended.
    await sleep(1_500);
    const job = orphan(root, "sleep 2.5; echo late > late.txt");
    engine.control.messages = [{ info: { id: "m1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "one" }] }, { info: { id: "m2", role: "assistant", finish: "stop", time: { created: 2, completed: 3 } }, parts: [{ type: "step-finish" }] }];
    engine.control.status = "idle";
    await untilIdleSeen(host);
    expect(existsSync(join(root, "late.txt"))).toBe(false);
    const started = Date.now();
    await host.archiveStartGate(SESSION, root, { exclude: [] });
    expect(existsSync(join(root, "late.txt"))).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    const settle = traces.find((trace) => trace.type === "turn.settle")?.data as { settled: boolean; processes: Array<{ pid: number }> } | undefined;
    expect(settle?.settled).toBe(true);
    expect(settle?.processes.some((item) => item.pid === job)).toBe(true);
  }, 20_000);

  test.skipIf(!linux)("a prompt typed into a running turn, or held without the gate (a sandbox), waits for nothing", async () => {
    const engine = startEngine();
    const root = temp("mars-late-hold-");
    const { host, traces } = captureHost();
    host.startSession(SESSION, "ws", root);
    await host.archiveStartGate(SESSION, root, { exclude: [] });
    host.observeSession(SESSION, engine.target);
    await sleep(1_500);
    orphan(root, "sleep 8");
    await sleep(1_200);
    let started = Date.now();
    await host.archiveStartGate(SESSION, root, { exclude: [] });
    expect(Date.now() - started).toBeLessThan(500);
    engine.control.status = "idle";
    await untilIdleSeen(host);
    started = Date.now();
    await host.archiveStartGate(SESSION, root, null);
    expect(Date.now() - started).toBeLessThan(500);
    expect(traces.some((trace) => trace.type === "turn.settle")).toBe(false);
  }, 20_000);
});
