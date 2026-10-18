// Automatic compaction (auto-compact.ts, byte-identical in the CLI and listed
// in PARITY.sha256). The CLI's test/auto-compact.test.js covers the same
// module; this checks the desktop's glue and the shared decisions.
import { describe, expect, test } from "bun:test";

import { brokerAutoCompactPolicy, desktopAutoCompactEngine } from "../auto-compact-engine.js";
import { compactionSummary, workingOn } from "../turn-steer.js";
import { AutoCompactor, autoCompactPolicy, compactionResult, RETRY_AFTER_TURNS, turnsSinceCompaction, type AutoCompactEngine, type ModelRef } from "./auto-compact.js";
import { completedTurnCount, steerPrompts } from "./turn-prompts.js";

const MODEL: ModelRef = { providerID: "mars", modelID: "astra" };
const user = (id: string, created: number) => ({ info: { id, role: "user", time: { created }, model: MODEL }, parts: [{ type: "text", text: "do it" }] });
const done = (id: string, created: number) => ({ info: { id, role: "assistant", time: { created, completed: created + 1 }, finish: "stop" }, parts: [] });
const compactRequest = (id: string, created: number) => ({ info: { id, role: "user", time: { created }, model: MODEL }, parts: [{ type: "compaction", auto: false }] });
const summary = (id: string, created: number, completed = created + 1) => ({ info: { id, role: "assistant", summary: true, mode: "compaction", agent: "compaction", time: { created, completed }, finish: "stop" }, parts: [] });
const chat = (n: number) => Array.from({ length: n }, (_, i) => [user(`u${i}`, i * 100), done(`a${i}`, i * 100 + 10)]).flat();

function engineOf(messages: () => unknown, { busy = false as boolean | null, parent = null as string | null, fail = false } = {}) {
  const calls = { messages: 0, summarize: [] as ModelRef[] };
  const engine: AutoCompactEngine = {
    messages: async () => { calls.messages += 1; return messages(); },
    session: async () => ({ id: "ses", ...(parent ? { parentID: parent } : {}) }),
    busy: async () => busy,
    summarize: async (model) => { calls.summarize.push(model); if (fail) throw new Error("summarize answered 500"); },
  };
  return { engine, calls };
}

describe("auto compaction", () => {
  test("reads the policy; absent is off", () => {
    expect(autoCompactPolicy({ auto_compact: { enabled: true, after_turns: 40, min_context_tokens: 0 } })).toEqual({ enabled: true, afterTurns: 40, minContextTokens: 0 });
    expect(autoCompactPolicy({ schema_versions: [3] })).toBeNull();
  });

  test("counts prompts since the last compaction; a prompt behind a running compaction opens a turn", () => {
    expect(turnsSinceCompaction([...chat(5), compactRequest("c", 600), summary("s", 601), user("u9", 700)])).toBe(1);
    const queued = [user("u1", 0), done("a1", 10), compactRequest("c", 100), summary("s", 101, 900), user("u2", 500), done("a2", 1_000)];
    expect(steerPrompts(queued).size).toBe(0);
    expect(completedTurnCount(queued)).toBe(2);
    expect(compactionSummary({ info: { role: "assistant", summary: true, time: { created: 1 } } })).toBe(true);
    expect(workingOn({ info: { role: "assistant", mode: "compaction", time: { created: 1 } } })).toBe(false);
  });

  test("compacts a due chat before the prompt, on the prompt's model", async () => {
    const compactor = new AutoCompactor({ policy: async () => ({ enabled: true, afterTurns: 3, minContextTokens: 0 }) });
    const { engine, calls } = engineOf(() => chat(3));
    const outcome = await compactor.beforePrompt("s", engine, new TextEncoder().encode(JSON.stringify({ parts: [], model: { providerID: "mars", modelID: "sol" } })).buffer);
    expect(outcome.action).toBe("compacted");
    expect(calls.summarize).toEqual([{ providerID: "mars", modelID: "sol" }]);
    // The seed (also the check before compacting), then how it ended.
    expect(calls.messages).toBe(2);
    expect(compactor.count("s")).toBe(1);
  });

  test("off, busy, a sub-agent's chat: nothing; a failure is retried later", async () => {
    const off = engineOf(() => chat(9));
    expect((await new AutoCompactor({ policy: async () => ({ enabled: false, afterTurns: 3, minContextTokens: 0 }) }).beforePrompt("s", off.engine)).reason).toBe("off");
    expect(off.calls.messages).toBe(0);
    const policy = async () => ({ enabled: true, afterTurns: 3, minContextTokens: 0 });
    const busy = engineOf(() => chat(9), { busy: true });
    expect((await new AutoCompactor({ policy }).beforePrompt("s", busy.engine)).reason).toBe("busy");
    const child = engineOf(() => chat(9), { parent: "root" });
    expect((await new AutoCompactor({ policy }).beforePrompt("s", child.engine)).reason).toBe("sub_agent");
    const failing = engineOf(() => chat(9), { fail: true });
    const retry = new AutoCompactor({ policy });
    expect((await retry.beforePrompt("s", failing.engine)).action).toBe("failed");
    expect(retry.count("s")).toBe(Math.max(0, 3 - RETRY_AFTER_TURNS) + 1);
    expect(busy.calls.summarize.length + child.calls.summarize.length).toBe(0);
  });

  test("a stopped compaction: its request and broken summary are removed, the held prompt goes, no quick retry", async () => {
    // Left in the chat, the engine would run the stopped compaction again with the next prompt.
    const aborted = { info: { id: "s1", parentID: "c1", role: "assistant", summary: true, mode: "compaction", agent: "compaction", time: { created: 401, completed: 402 }, error: { name: "MessageAbortedError" } }, parts: [] };
    expect(compactionResult([...chat(3), compactRequest("c1", 400), aborted], new Set())).toEqual({ state: "broken", error: "MessageAbortedError", leftovers: ["s1", "c1"] });
    let list: unknown[] = chat(3);
    let release = () => {};
    const removed: string[] = [];
    const engine: AutoCompactEngine = {
      messages: async () => list,
      session: async () => ({ id: "ses" }),
      busy: async () => false,
      summarize: () => new Promise<void>((resolve) => { release = resolve; }),
      removeMessage: async (id) => { removed.push(id); },
    };
    const compactor = new AutoCompactor({ policy: async () => ({ enabled: true, afterTurns: 3, minContextTokens: 0 }) });
    const held = compactor.beforePrompt("s", engine, { model: MODEL });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(compactor.stopped("s")).toBe(true);
    list = [...chat(3), compactRequest("c1", 400), aborted];
    release();
    expect((await held).action).toBe("failed");
    expect(removed).toEqual(["s1", "c1"]);
    expect(compactor.count("s")).toBe(1);
  });

  test("the grace runs out before the engine closed the stopped summary: still broken, removed", async () => {
    let list: unknown[] = chat(3);
    const removed: string[] = [];
    const unclosed = { info: { id: "s1", parentID: "c1", role: "assistant", summary: true, mode: "compaction", agent: "compaction", time: { created: 401 } }, parts: [] };
    const engine: AutoCompactEngine = {
      messages: async () => list,
      session: async () => ({ id: "ses" }),
      busy: async () => false,
      summarize: (_model, signal) => new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
      removeMessage: async (id) => { removed.push(id); },
    };
    const compactor = new AutoCompactor({ policy: async () => ({ enabled: true, afterTurns: 3, minContextTokens: 0 }), stopGraceMs: 20 });
    const held = compactor.beforePrompt("s", engine, { model: MODEL });
    await new Promise((resolve) => setTimeout(resolve, 5));
    list = [...chat(3), compactRequest("c1", 400), unclosed];
    compactor.stopped("s");
    expect((await held).action).toBe("failed");
    expect(removed).toEqual(["s1", "c1"]);
  });
});

describe("the desktop's glue", () => {
  test("the broker policy: fresh asks with maxAgeMs 0, a failure keeps the last answer", async () => {
    const asked: number[] = [];
    let fail = false;
    const policy = brokerAutoCompactPolicy(async ({ maxAgeMs }) => {
      asked.push(maxAgeMs);
      if (fail) throw new Error("down");
      return { schema_versions: [3], canonical_trace: true, auto_compact: { enabled: true, after_turns: 40 } };
    });
    expect((await policy({ fresh: false }))?.afterTurns).toBe(40);
    fail = true;
    expect((await policy({ fresh: true }))?.afterTurns).toBe(40);
    expect(asked).toEqual([60_000, 0]);
  });

  test("the engine calls go to the target with its scope and auth", async () => {
    const seen: { url: string; method: string; auth: string | null; body?: string }[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      seen.push({ url, method: init.method ?? "GET", auth: headers.get("authorization"), ...(init.body ? { body: String(init.body) } : {}) });
      if (url.includes("/session/status")) return Response.json({ ses_1: { type: "busy" } });
      return Response.json(true);
    };
    const engine = desktopAutoCompactEngine({ baseUrl: "http://127.0.0.1:4096", headers: [["authorization", "Basic x"]], search: "?directory=%2Fw", engine: "v1" }, "ses_1", fetchImpl);
    expect(await engine.busy()).toBe(true);
    await engine.summarize(MODEL, new AbortController().signal);
    expect(seen[0]).toEqual({ url: "http://127.0.0.1:4096/session/status?directory=%2Fw", method: "GET", auth: "Basic x" });
    expect(seen[1]).toEqual({ url: "http://127.0.0.1:4096/session/ses_1/summarize?directory=%2Fw", method: "POST", auth: "Basic x", body: JSON.stringify(MODEL) });
    await engine.removeMessage!("msg_1");
    await engine.abort!();
    expect(seen.slice(2).map(({ url, method }) => `${method} ${url}`)).toEqual([
      "DELETE http://127.0.0.1:4096/session/ses_1/message/msg_1?directory=%2Fw",
      "POST http://127.0.0.1:4096/session/ses_1/abort?directory=%2Fw",
    ]);
  });
});
