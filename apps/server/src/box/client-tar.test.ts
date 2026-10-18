import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { request, tarTo, type BoxEndpoint } from "./client.js";

// The box client's tar stream (tarTo): a large tar goes to disk with
// backpressure, and the connection waits while the consumer catches up.
// A fake boxd speaks the wire format over TCP.

const frame = (kind: number, payload: Buffer) => {
  const head = Buffer.alloc(5);
  head[0] = kind;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
};

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** A boxd that answers any op with `count` data frames of `size` bytes, then exit 0, as fast as the socket lets it. */
async function streamingBoxd(count: number, size: number): Promise<{ box: BoxEndpoint; sent: { frames: number } }> {
  const sent = { frames: 0 };
  const server = net.createServer((socket) => {
    socket.on("error", () => undefined);
    socket.once("data", async () => {
      for (let index = 0; index < count; index += 1) {
        sent.frames += 1;
        if (!socket.write(frame(0x64, Buffer.alloc(size, index % 251)))) await new Promise((resolve) => socket.once("drain", resolve));
        if (socket.destroyed) return;
      }
      socket.end(frame(0x78, Buffer.from(JSON.stringify({ code: 0, ms: 1 }))));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => server.close());
  const address = server.address();
  return { box: { host: "127.0.0.1", port: typeof address === "object" && address ? address.port : 0, token: "t" }, sent };
}

describe("box client tar", () => {
  test("tarTo streams a large tar to disk, whole and hashed", async () => {
    const count = 256;
    const size = 256 * 1024;
    const { box } = await streamingBoxd(count, size);
    const dir = mkdtempSync(path.join(os.tmpdir(), "mars-tar-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, "turn.tar");
    const result = await tarTo(box, ["/opt"], file);
    const written = readFileSync(file);
    expect(result.bytes).toBe(count * size);
    expect(written.length).toBe(count * size);
    expect(result.sha256).toBe(createHash("sha256").update(written).digest("hex"));
  });

  test("an onData promise holds the connection until it settles", async () => {
    const { box, sent } = await streamingBoxd(400, 64 * 1024);
    let calls = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const done = request(box, { op: "tar", paths: [] }, { onData: () => ((calls += 1) === 1 ? held : undefined) });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls).toBeLessThan(400);
    expect(sent.frames).toBeLessThan(400);
    release();
    const result = await done;
    expect(result.exit.code).toBe(0);
    expect(calls).toBe(400);
  });

  test("tarTo fails with the file's error when the file cannot be written", async () => {
    const { box } = await streamingBoxd(4, 1024);
    await expect(tarTo(box, ["/opt"], path.join(os.tmpdir(), "mars-no-such-dir", "x", "turn.tar"))).rejects.toThrow(/ENOENT/);
  });
});
