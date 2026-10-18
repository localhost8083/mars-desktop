import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CaptureHost } from "./capture-host.js";
import { SessionUploader } from "./session-uploader.js";
import { turnsBeforeCapture, type EngineTarget } from "./session-upload-observer.js";

// A chat reopened after the app restarted: its turns are numbered on from the
// turns it already had (context.install / context.env_turn), not from 1.

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const user = (id: string) => ({ info: { id, role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "go" }] });
const reply = (id: string) => ({ info: { id, role: "assistant", finish: "stop", time: { created: 2, completed: 3 } }, parts: [{ type: "step-finish" }] });

async function engineWith(messages: unknown[]): Promise<EngineTarget> {
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify((req.url ?? "").includes("/message") ? messages : { id: "ses_reopened_0001" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => server.close());
  const address = server.address();
  return { baseUrl: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`, headers: [], search: "", engine: "v1" } as EngineTarget;
}

describe("a reopened chat", () => {
  test("its earlier completed turns are counted from the engine, once, before the capture starts it", async () => {
    const engine = await engineWith([user("u1"), reply("a1"), user("u2"), reply("a2")]);
    expect(await turnsBeforeCapture({ hasSession: () => false }, "ses_reopened_0001", engine)).toBe(2);
    expect(await turnsBeforeCapture({ hasSession: () => true }, "ses_reopened_0001", engine)).toBe(0);
    expect(await turnsBeforeCapture({ hasSession: () => false }, "ses_new_000001", await engineWith([]))).toBe(0);
  });

  test("the capture host hands the count to the capture context (which numbers on from it: install-log.test.ts)", async () => {
    const root = mkdtempSync(join(tmpdir(), "mars-reopened-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const uploader = new SessionUploader({ upload: async () => Response.json({ ok: true }, { status: 201 }), changeDebounceMs: 60_000, fallbackScanMs: 60_000 });
    cleanups.push(() => uploader.stop());
    const started: Array<[string, number | undefined]> = [];
    (uploader as unknown as { contextOf: () => unknown }).contextOf = () => ({
      sessionStarted: (id: string, _root: string, _after: unknown, turnsBefore?: number) => started.push([id, turnsBefore]),
      turnStarted: () => undefined,
      turnEnded: () => undefined,
      turnMessages: () => undefined,
      sessionEnded: () => undefined,
      settled: async () => undefined,
    });
    const host = Object.create(CaptureHost.prototype) as { sessionRoots: Map<string, string>; sessionUploader: SessionUploader; startSession: CaptureHost["startSession"] };
    host.sessionRoots = new Map();
    host.sessionUploader = uploader;
    host.startSession("ses_reopened_0001", "ws", root, 2);
    host.startSession("ses_new_000001", "ws", root);
    expect(started).toEqual([["ses_reopened_0001", 2], ["ses_new_000001", 0]]);
  });
});
