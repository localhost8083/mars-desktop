import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { marsRuntimeConfigFilePath } from "../mars-runtime-config.js";
import { readMarsWorkspaceConfig } from "../mars-workspace-config-store.js";
import { policyRequestActions } from "../managed-policy-rules.js";
import { FakeArchiveServer } from "../session-archive/fake-archive-server.js";
import { SessionArchiver } from "../session-archive/index.js";
import { openArchive } from "../session-archive/test-helpers.js";
import { BUNDLED_HARNESS } from "../engine-identity.js";
import { boxEnvironment, type UploadEnvironment } from "../session-uploader.js";
import { startServer } from "../server.js";
import type { ServerConfig } from "../types.js";
import { boxSnapshotsDir, type BoxLabel } from "./box.js";

const WORKSPACE_ID = "ws_box_test";
const savedEnv = { ...process.env };
const dirs: string[] = [];

afterEach(async () => {
  process.env = { ...savedEnv };
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temp(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `mars-box-server-${name}-`));
  dirs.push(dir);
  return dir;
}

function serverConfig(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [],
    workspaces: [{ id: WORKSPACE_ID, name: "Box", path: join(root, "project"), preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  } satisfies ServerConfig;
}

/** The helpers folder layout (sidecars/box): this machine's boxsh, both boxd (stand-ins). */
async function helpers(root: string): Promise<string> {
  const dir = join(root, "box-bin");
  const goos = process.platform === "win32" ? "windows" : process.platform;
  const goarch = process.arch === "arm64" ? "arm64" : "amd64";
  await mkdir(join(dir, `${goos}-${goarch}`), { recursive: true });
  await writeFile(join(dir, `${goos}-${goarch}`, process.platform === "win32" ? "boxsh.exe" : "boxsh"), "#!/bin/sh\n");
  await mkdir(join(dir, `linux-${goarch}`), { recursive: true });
  await writeFile(join(dir, `linux-${goarch}`, "boxd"), "");
  return dir;
}

describe("Linux sandbox through the server", () => {
  test.skipIf(process.platform === "win32")("turning the box on for a workspace gives the engine config the box shell and plugin; off takes them out", async () => {
    const root = await temp("root");
    await mkdir(join(root, "project"), { recursive: true });
    process.env.MARS_RUNTIME_DB = join(root, "runtime.sqlite");
    process.env.OPENCODE_CONFIG_DIR = join(root, "global-opencode");
    process.env.MARS_BOX_HOME = join(root, "box-home");
    process.env.MARS_BOX_BIN_DIR = await helpers(root);
    // No container runtime here: the box is unavailable, which the status says; nothing fails.
    process.env.MARS_BOX_RUNTIME = join(root, "no-docker");
    await mkdir(process.env.OPENCODE_CONFIG_DIR, { recursive: true });
    const config = serverConfig(root);
    const server = await startServer(config) as { port: number; stop: (close?: boolean) => Promise<void> | void };
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: `Bearer ${config.token}`, "content-type": "application/json" };
    const engineConfig = async () => JSON.parse(await readFile(marsRuntimeConfigFilePath(config), "utf8")) as { shell?: string; plugin?: string[] };
    try {
      expect((await fetch(`${base}/workspace/${WORKSPACE_ID}/box`)).status).toBe(401);
      const before = await (await fetch(`${base}/workspace/${WORKSPACE_ID}/box`, { headers })).json();
      expect(before).toMatchObject({ mode: null, on: false, serverDefault: "off", state: "off" });
      for (const payload of [{ mode: "yes" }, {}, { mode: "on", extra: 1 }]) {
        expect((await fetch(`${base}/workspace/${WORKSPACE_ID}/box`, { method: "PUT", headers, body: JSON.stringify(payload) })).status).toBe(400);
      }
      expect(policyRequestActions("PUT", `/workspace/${WORKSPACE_ID}/box`)).toEqual(["settings"]);

      const on = await fetch(`${base}/workspace/${WORKSPACE_ID}/box`, { method: "PUT", headers, body: JSON.stringify({ mode: "on" }) });
      expect(on.status).toBe(200);
      const status = await on.json();
      expect(status).toMatchObject({ mode: "on", on: true, source: "project", state: "unavailable", engine: { status: "unmanaged" } });
      expect(status.runtime.ok).toBe(false);
      expect(status).toMatchObject({ platform: process.platform, progress: null });
      // Try again (the card's retry and Check again): a fresh look; still no runtime here.
      const retried = await fetch(`${base}/workspace/${WORKSPACE_ID}/box/retry`, { method: "POST", headers, body: "{}" });
      expect(retried.status).toBe(200);
      expect(await retried.json()).toMatchObject({ mode: "on", on: true, state: "unavailable" });
      expect(policyRequestActions("POST", `/workspace/${WORKSPACE_ID}/box/retry`)).toEqual(["settings"]);
      expect(await readMarsWorkspaceConfig(config, WORKSPACE_ID)).toMatchObject({ localBox: { mode: "on", offered: true } });
      const withBox = await engineConfig();
      expect(withBox.shell).toBe(join(root, "box-home", "shell-desktop", "bash"));
      expect(withBox.plugin?.filter((entry) => /mars-box\.(?:ts|js)$/.test(entry))).toHaveLength(1);

      const off = await fetch(`${base}/workspace/${WORKSPACE_ID}/box`, { method: "PUT", headers, body: JSON.stringify({ mode: "off" }) });
      expect(await off.json()).toMatchObject({ mode: "off", on: false, state: "off" });
      const without = await engineConfig();
      expect(without.shell).toBeUndefined();
      expect(without.plugin?.some((entry) => /mars-box\.(?:ts|js)$/.test(entry))).toBe(false);
      expect((await fetch(`${base}/workspace/${WORKSPACE_ID}/box/reset`, { method: "POST", headers, body: "{}" })).status).toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("capture: a chat's box checkpoints ride in its project archive, and its environment says linux", async () => {
    const stateDir = await temp("state");
    const project = await temp("project");
    await writeFile(join(project, "app.py"), "print(1)\n");
    // A git project: archived by the default policy.
    for (const args of [["init", "-q", "-b", "main"], ["add", "app.py"], ["commit", "-q", "-m", "initial"]]) {
      execFileSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args]);
    }
    const sessionId = "ses_box_capture_1";
    const folder = join(boxSnapshotsDir(stateDir), sessionId);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "record.json"), JSON.stringify({ kind: "mars-box" }));
    await writeFile(join(folder, "turn-1.json"), JSON.stringify({ label: "turn-1" }));
    await writeFile(join(folder, "turn-1.tar"), Buffer.alloc(1024));
    // Left out: not a checkpoint name.
    await writeFile(join(folder, ".chain.json"), "{}");
    const server = new FakeArchiveServer();
    const archiver = new SessionArchiver({ gatewayUrl: server.gatewayUrl, accessToken: server.token, fetch: server.respond, stateDir, retry: { baseMs: 1, maxMs: 2, attempts: 2 }, sandboxSnapshotsDir: boxSnapshotsDir(stateDir) });
    expect(await archiver.captureBase(sessionId, project)).toMatchObject({ status: "queued", kind: "base" });
    await archiver.drain();
    const names = (await openArchive(server.objects()[0]!.object!)).map((member) => member.name);
    expect(names).toEqual(expect.arrayContaining(["app.py", `__sandbox__/${sessionId}/record.json`, `__sandbox__/${sessionId}/turn-1.json`, `__sandbox__/${sessionId}/turn-1.tar`]));
    expect(names).not.toContain(`__sandbox__/${sessionId}/.chain.json`);

    const label: BoxLabel = { kind: "mars-box", box_id: "box_abc", backend: "docker-desktop", runtime: { name: "docker", flavor: "desktop", version: "27", rootless: false }, image: { ref: "r", digest: null, stack: "base" }, host_os: "darwin", host_arch: "arm64" };
    const environment: UploadEnvironment = { os: "darwin", os_version: "24.0.0", arch: "arm64", app_version: "1", engine_version: "e", harness: { ...BUNDLED_HARNESS }, node_version: "24", shell: "zsh", locale: null, timezone: null, git_version: null };
    expect(boxEnvironment(environment, label)).toEqual({ os: "linux", host_os: "darwin", host_arch: "arm64", host_os_version: "24.0.0", shell: "bash" });
    expect(boxEnvironment(environment, null)).toEqual({});
  });
});
