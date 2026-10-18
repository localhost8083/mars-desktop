import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import * as lifecycle from "./session-archive/lifecycle.js";
import * as prompts from "./session-archive/turn-prompts.js";
import { SessionUploader } from "./session-uploader.js";
import type { EngineTarget } from "./session-upload-observer.js";
import { claimSteerId, claimedSteerIds, createSteerTracker, steerRecord, toolsAround, workingOn } from "./turn-steer.js";

// Steering: a prompt sent while the agent works goes through at once and
// steers the running turn; the turn numbers every client writes skip it.

type Message = { info: Record<string, unknown>; parts: unknown[] };
const user = (id: string, created: number, text = "do it", extra: Record<string, unknown> = {}): Message => ({ info: { id, role: "user", time: { created }, ...extra }, parts: [{ type: "text", text }] });
const step = (id: string, parentID: string, created: number, completed: number | undefined, finish: string | undefined, extra: Record<string, unknown> = {}): Message => ({
  info: { id, role: "assistant", parentID, time: { created, ...(completed !== undefined ? { completed } : {}) }, ...(finish ? { finish } : {}), ...extra },
  parts: [],
});

describe("turn numbering with steers (session-archive/turn-prompts.ts)", () => {
  test("a prompt sent while a tool runs steers the turn: one turn, numbered as one", () => {
    const messages = [
      user("u1", 1_000),
      step("a1", "u1", 1_100, 9_000, "tool-calls"),
      user("u2", 5_000, "actually use port 8080"),
      step("a2", "u2", 9_010, 12_000, "stop"),
    ];
    expect([...prompts.steerPrompts(messages)]).toEqual(["u2"]);
    expect(prompts.completedTurnCount(messages)).toBe(1);
    expect(prompts.promptTurnAt(messages, 9_500)).toBe(1);
    // lifecycle re-exports the same numbering
    expect(lifecycle.completedTurnCount(messages)).toBe(1);
    expect(lifecycle.promptTurnAt(messages, 9_500)).toBe(1);
    expect(lifecycle.isPromptMessage(messages[2]!)).toBe(true);
  });

  test("a prompt sent while a sub-agent runs steers the turn; the next prompt after it ended is turn 2", () => {
    const messages = [
      user("u1", 1_000),
      step("a1", "u1", 1_100, 30_000, "tool-calls"),
      user("u2", 12_000, "skip the tests"),
      step("a2", "u2", 30_010, 31_000, "stop"),
      user("u3", 40_000, "next thing"),
      step("a3", "u3", 40_100, 41_000, "stop"),
    ];
    expect([...prompts.steerPrompts(messages)]).toEqual(["u2"]);
    expect(prompts.completedTurnCount(messages)).toBe(2);
    expect(prompts.promptTurnAt(messages, 40_500)).toBe(2);
  });

  test("between two steps is still the running turn; after the turn ended, Stop or a crash, a prompt opens a turn", () => {
    expect([...prompts.steerPrompts([user("u1", 1_000), step("a1", "u1", 1_100, 2_000, "tool-calls"), user("u2", 2_300), step("a2", "u2", 2_400, 3_000, "stop")])]).toEqual(["u2"]);
    const answered = [user("u1", 1_000), step("a1", "u1", 1_100, 2_000, "stop"), user("u2", 2_500), step("a2", "u2", 2_600, 3_000, "stop")];
    expect(prompts.steerPrompts(answered).size).toBe(0);
    expect(prompts.completedTurnCount(answered)).toBe(2);
    const stopped = [user("u1", 1_000), step("a1", "u1", 1_100, 2_000, "tool-calls", { error: { name: "MessageAbortedError" } }), user("u2", 2_200), step("a2", "u2", 2_300, 3_000, "stop")];
    expect(prompts.steerPrompts(stopped).size).toBe(0);
    expect(prompts.completedTurnCount(stopped)).toBe(2);
    const crashed = [user("u1", 1_000), step("a1", "u1", 1_100, undefined, undefined), user("u2", 60_000), step("a2", "u2", 60_100, 61_000, "stop")];
    expect(prompts.steerPrompts(crashed).size).toBe(0);
    expect(prompts.promptTurnAt(crashed, 60_500)).toBe(2);
  });

  test("two prompts before any answer are two turns; engine notes are neither turns nor steers", () => {
    const together = [user("u1", 1_000), user("u2", 1_200), step("a1", "u2", 1_300, 2_000, "stop")];
    expect(prompts.steerPrompts(together).size).toBe(0);
    expect(prompts.completedTurnCount(together)).toBe(2);
    const notes = [
      user("u1", 1_000),
      step("a1", "u1", 1_100, 5_000, "tool-calls"),
      { info: { id: "c1", role: "user", agent: "compaction", time: { created: 3_000 } }, parts: [{ type: "compaction" }] },
      { info: { id: "n1", role: "user", time: { created: 4_000 } }, parts: [{ type: "text", text: "background job done", synthetic: true }] },
      step("a2", "u1", 5_010, 6_000, "stop"),
    ];
    expect(prompts.steerPrompts(notes).size).toBe(0);
    expect(prompts.completedTurnCount(notes)).toBe(1);
  });
});

const target: EngineTarget = { baseUrl: "http://127.0.0.1:9", headers: [["authorization", "Basic x"]], search: "?directory=%2Fw", engine: "v1" };
function engine(routes: Array<[RegExp, unknown]>) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    calls.push(path);
    for (const [pattern, answer] of routes) if (pattern.test(path)) return typeof answer === "function" ? (answer as () => Response)() : Response.json(answer);
    return Response.json({ error: "not found" }, { status: 404 });
  };
  return { calls, tracker: createSteerTracker(target, { fetchImpl, delays: [0, 0] }) };
}

describe("classify", () => {
  test("idle opens a turn with one small read; a busy session at work takes a steer, never reading the whole history", async () => {
    const idle = engine([[/^\/session\/status/, {}]]);
    expect(await idle.tracker.classify("ses_1")).toEqual({ steer: false, busy: false, reason: "idle" });
    expect(idle.calls).toEqual(["/session/status?directory=%2Fw"]);
    const working = engine([[/^\/session\/status/, { ses_1: { type: "busy" } }], [/\/session\/ses_1\/message\?.*limit=1/, [step("a1", "u1", 1, undefined, undefined)]]]);
    expect((await working.tracker.classify("ses_1")).steer).toBe(true);
    expect(working.calls.filter((call) => call.includes("/message")).every((call) => call.includes("limit=1"))).toBe(true);
    const retry = engine([[/^\/session\/status/, { ses_1: { type: "retry" } }], [/limit=1/, [step("a1", "u1", 1, 2, "tool-calls")]]]);
    expect(await retry.tracker.classify("ses_1")).toEqual({ steer: true, busy: true, reason: "working" });
  });

  test("busy with nothing answered yet, or ending, opens a turn; an unreadable status is a turn; busy and unreadable is a steer", async () => {
    const fresh = engine([[/^\/session\/status/, { ses_1: { type: "busy" } }], [/limit=1/, [user("u1", 1)]]]);
    expect(await fresh.tracker.classify("ses_1")).toEqual({ steer: false, busy: true, reason: "not_started" });
    const ending = engine([[/^\/session\/status/, { ses_1: { type: "busy" } }], [/limit=1/, [step("a1", "u1", 1, 2, "stop")]]]);
    expect((await ending.tracker.classify("ses_1")).reason).toBe("ending");
    const stopped = engine([[/^\/session\/status/, { ses_1: { type: "busy" } }], [/limit=1/, [step("a1", "u1", 1, 2, "tool-calls", { error: { name: "MessageAbortedError" } })]]]);
    expect((await stopped.tracker.classify("ses_1")).steer).toBe(false);
    const down = engine([[/^\/session\/status/, () => Response.json({}, { status: 500 })]]);
    expect(await down.tracker.classify("ses_1")).toMatchObject({ steer: false, busy: null, reason: "status_unreadable" });
    const garbled = engine([[/^\/session\/status/, () => new Response("not json")]]);
    expect((await garbled.tracker.classify("ses_1")).reason).toBe("status_unreadable");
    const unread = engine([[/^\/session\/status/, { ses_1: { type: "busy" } }], [/limit=1/, () => Response.json({}, { status: 500 })]]);
    expect(await unread.tracker.classify("ses_1")).toMatchObject({ steer: true, busy: true, reason: "busy_unread" });
  });

  test("a read that hangs is given up after the timeout: the prompt is a turn of its own", async () => {
    const hanging = createSteerTracker(target, {
      timeoutMs: 50,
      fetchImpl: (_url, init) => new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    });
    const started = Date.now();
    expect((await hanging.classify("ses_1")).reason).toBe("status_unreadable");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("describe and the turn.steer record", () => {
  const tool = (callID: string, name: string, start: number, end: number | undefined, metadata?: Record<string, unknown>) => ({
    type: "tool", tool: name, callID, state: { status: end ? "completed" : "running", time: { start, ...(end ? { end } : {}) }, ...(metadata ? { metadata } : {}) },
  });

  test("the steer's message id, the tools running when it arrived, the last one started; a claimed id is never named again", async () => {
    const a1 = step("a1", "u1", 1_100, undefined, undefined);
    a1.parts = [tool("c1", "write", 1_200, 1_300), tool("c2", "task", 1_400, undefined, { sessionId: "ses_child" })];
    const sentAt = Date.now();
    const steer = user("u2", sentAt + 5, "stop the sub-agent and use plan B");
    const { tracker, calls } = engine([[/limit=6/, [user("u1", 1_000), a1, steer]]]);
    const found = await tracker.describe("ses_1", sentAt);
    expect(found?.message_id).toBe("u2");
    expect(found?.running.map((call) => [call.call_id, call.sub_agent ?? null])).toEqual([["c2", "ses_child"]]);
    expect(found?.after_call?.call_id).toBe("c2");
    expect(calls.every((call) => call.includes("limit=6"))).toBe(true);
    expect(await tracker.describe("ses_1", sentAt, { known: new Set(["u2"]) })).toBeNull();
    expect(await tracker.describe("ses_1", sentAt, { stopped: () => true })).toBeNull();

    expect(steerRecord(found, sentAt, "working")).toEqual({
      message_id: "u2",
      sent_at: new Date(sentAt).toISOString(),
      created_at: new Date(sentAt + 5).toISOString(),
      running: found!.running,
      after_call: found!.after_call,
      delivery: "next_step",
      classified: "working",
    });
    expect(steerRecord(null, sentAt, "busy_unread")).toEqual({ message_id: null, sent_at: new Date(sentAt).toISOString(), delivery: "next_step", classified: "busy_unread" });
  });

  test("claimed ids are kept per session and bounded", () => {
    const known = claimedSteerIds("ses_claims");
    for (let index = 0; index < 100; index += 1) claimSteerId(known, `m${index}`);
    expect(known.size).toBe(64);
    expect(claimedSteerIds("ses_claims")).toBe(known);
    expect(known.has("m99")).toBe(true);
  });

  test("toolsAround and workingOn read only what they are given", () => {
    expect(workingOn(step("a", "u", 1, undefined, undefined))).toBe(true);
    expect(workingOn(step("a", "u", 1, 2, "tool-calls"))).toBe(true);
    expect(workingOn(step("a", "u", 1, 2, "stop"))).toBe(false);
    expect(workingOn(step("a", "u", 1, 2, "tool-calls", { error: { name: "MessageAbortedError" } }))).toBe(false);
    expect(workingOn(user("u", 1))).toBe(false);
    expect(workingOn(undefined)).toBe(false);
    expect(toolsAround([], 5)).toEqual({ running: [], last: null });
  });
});

describe("SessionUploader.steerTurn", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("records turn.steer (schema 1) with the running turn's start, and takes no snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "mars-steer-"));
    roots.push(root);
    const envelopes: Array<Record<string, unknown>> = [];
    const sessionUploader = new SessionUploader({
      upload: async (_sessionId, compressed) => {
        const envelope = JSON.parse(zstdDecompressSync(compressed).toString("utf8")) as Record<string, unknown>;
        const files = Array.isArray(envelope.files) ? envelope.files as Array<{ path?: string; content?: string }> : [];
        const traceFile = files.find((file) => file.path === "__mars__/trace.json");
        envelopes.push(traceFile?.content && envelope.trace === undefined ? { ...envelope, trace: (JSON.parse(traceFile.content) as { events?: unknown[] }).events ?? [] } : envelope);
        return Response.json({ ok: true }, { status: 201 });
      },
      changeDebounceMs: 10,
      fallbackScanMs: 60_000,
    });
    const sessionId = "session-steer-1234";
    sessionUploader.startSession(sessionId, "workspace-test", root);
    sessionUploader.captureSnapshot(sessionId, "prompt");
    sessionUploader.steerTurn(sessionId, steerRecord({ message_id: "msg_2", created_at: new Date(2_000).toISOString(), running: [], after_call: null }, 1_990, "working"));
    // A session the uploader does not track records nothing.
    sessionUploader.steerTurn("session-unknown-1234", steerRecord(null, 1_990, "working"));
    await sessionUploader.idle(sessionId);
    sessionUploader.flushTrace(sessionId);
    await sessionUploader.stop();

    const events = envelopes.flatMap((envelope) => (Array.isArray(envelope.trace) ? envelope.trace : []) as Array<{ type: string; data?: Record<string, unknown> }>);
    const steers = events.filter((event) => event.type === "turn.steer");
    expect(steers).toHaveLength(1);
    expect(steers[0]!.data).toMatchObject({ schema: 1, message_id: "msg_2", sent_at: new Date(1_990).toISOString(), delivery: "next_step", classified: "working" });
    expect(typeof steers[0]!.data?.turn_started_at).toBe("string");
    expect(events.filter((event) => event.type === "collector.trigger" && event.data?.trigger === "prompt")).toHaveLength(1);
    expect(envelopes.filter((envelope) => envelope.trigger === "prompt").length).toBeLessThanOrEqual(1);
  });
});
