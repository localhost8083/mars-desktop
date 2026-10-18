// Buildathon reproducibility mode (contract "Reproducibility mode"; the CLI's
// test/buildathon.test.js covers the same cases): the app's buildathon
// projects get the event's rules in the engine's instructions and, with
// `repro.box` on, the Linux sandbox; the project's own switch and the
// macOS / Windows host-builds rule still win.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { rememberServerDefault, resolveMode } from "./box/launch.js";
import { BoxService, type BoxWorkspace } from "./box/service.js";
import {
  AGENT_RULES_HEADING,
  BUILDATHON_OFFER_NOTICE,
  BUILDATHON_PROJECTS_FILE,
  DEFAULT_AGENT_RULES,
  LESS_REPRO_NOTICE,
  agentRulesFor,
  buildathonBoxFor,
  parseReproBlock,
  readReproState,
  reproStateFromBody,
  writeReproState,
} from "./buildathon-repro.js";
import { MarsBuildathon } from "./opencode-plugins/mars-buildathon.js";

const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01, 0, 0, 0, 0, 2, 0, 0, 0]);
const savedBoxHome = process.env.MARS_BOX_HOME;

afterEach(() => {
  if (savedBoxHome === undefined) delete process.env.MARS_BOX_HOME;
  else process.env.MARS_BOX_HOME = savedBoxHome;
});

function tmp(prefix = "mars-bt-"): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function put(root: string, rel: string, content: Buffer | string, mode = 0o644): void {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, { mode });
}

const later = new Date(Date.now() + 5 * 86_400_000).toISOString();

async function listProjects(home: string, projects: unknown[], repro: unknown = undefined, deadline = later): Promise<void> {
  await writeReproState(reproStateFromBody({ repro, projects, deadline_at: deadline }), path.join(home, BUILDATHON_PROJECTS_FILE));
}

describe("buildathon repro: state", () => {
  test("the repro block: the server's values, else the contract's defaults (box on)", () => {
    expect(parseReproBlock(undefined)).toEqual({ box: "on", agentRules: DEFAULT_AGENT_RULES });
    expect(parseReproBlock({ box: "offer", agent_rules: "Use make." })).toEqual({ box: "offer", agentRules: "Use make." });
    expect(parseReproBlock({ box: "maybe", agent_rules: "" }).box).toBe("on");
  });

  test("projects: absolute folders, never home, temp or a root; past the deadline nothing applies", async () => {
    const home = tmp("boxhome-");
    const project = tmp();
    await listProjects(home, [project, os.homedir(), os.tmpdir(), "/", "relative/x", 7], { box: "on" });
    const file = path.join(home, BUILDATHON_PROJECTS_FILE);
    expect(readReproState(file)!.keys.length).toBe(1);
    expect(buildathonBoxFor(project, file)).toBe("on");
    expect(buildathonBoxFor(path.join(project, "..", path.basename(project)), file)).toBe("on");
    expect(buildathonBoxFor(tmp(), file)).toBeNull();
    expect(buildathonBoxFor(project, file, Date.now() + 6 * 86_400_000)).toBeNull();
    // An empty list removes the file.
    await listProjects(home, []);
    expect(readReproState(file)).toBeNull();
  });

  test("the rules for a chat: in a listed project only, under the heading, the server's text or the default", async () => {
    const home = tmp("boxhome-");
    const project = tmp();
    const file = path.join(home, BUILDATHON_PROJECTS_FILE);
    await listProjects(home, [project]);
    expect(agentRulesFor(project, file)).toBe(`${AGENT_RULES_HEADING}\n\n${DEFAULT_AGENT_RULES}`);
    expect(agentRulesFor(tmp(), file)).toBeNull();
    await listProjects(home, [project], { agent_rules: "Keep a Makefile." });
    expect(agentRulesFor(project, file)).toBe(`${AGENT_RULES_HEADING}\n\nKeep a Makefile.`);
  });
});

describe("buildathon repro: the engine plugin", () => {
  test("adds the rules to a listed project's system prompt once; other folders are left alone", async () => {
    const home = tmp("boxhome-");
    process.env.MARS_BOX_HOME = home;
    const project = tmp();
    await listProjects(home, [project]);
    const hooks = await MarsBuildathon({ directory: project });
    const output = { system: ["You are the agent."] };
    await hooks["experimental.chat.system.transform"]({}, output);
    await hooks["experimental.chat.system.transform"]({}, output);
    expect(output.system).toEqual(["You are the agent.", `${AGENT_RULES_HEADING}\n\n${DEFAULT_AGENT_RULES}`]);

    const other = { system: ["You are the agent."] };
    await (await MarsBuildathon({ directory: tmp() }))["experimental.chat.system.transform"]({}, other);
    expect(other.system).toEqual(["You are the agent."]);
  });
});

describe("buildathon repro: the box", () => {
  test("resolveMode: the env flag, then the project's switch (off: less reproducible), then repro.box, then the server", () => {
    expect(resolveMode({ env: {}, project: null, server: "off", buildathon: "on" })).toEqual({ on: true, source: "buildathon", offer: false });
    expect(resolveMode({ env: {}, project: null, server: "offer", buildathon: "on" })).toEqual({ on: true, source: "buildathon", offer: false });
    expect(resolveMode({ env: {}, project: "off", server: "on", buildathon: "on" })).toEqual({ on: false, source: "project", offer: false, lessRepro: true });
    expect(resolveMode({ env: { MARS_BOX: "0" }, project: null, server: "on", buildathon: "on" })).toEqual({ on: false, source: "env", offer: false, lessRepro: true });
    expect(resolveMode({ env: {}, project: null, server: "off", buildathon: "offer" })).toEqual({ on: false, source: "buildathon", offer: true });
    expect(resolveMode({ env: {}, project: null, server: "on", buildathon: "offer" })).toEqual({ on: true, source: "server", offer: false });
    expect(resolveMode({ env: {}, project: null, server: "off", buildathon: "off" })).toEqual({ on: false, source: "default", offer: false });
    expect(resolveMode({ env: {}, project: null, server: "off", buildathon: null })).toEqual({ on: false, source: "default", offer: false });
  });

  type Settings = Map<string, { mode: "on" | "off" | null; offered: boolean }>;
  function service(stateDir: string, home: string, workspace: BoxWorkspace, settings: Settings, platform: NodeJS.Platform) {
    return new BoxService({
      stateDir,
      readSettings: async (id) => settings.get(id) ?? { mode: null, offered: false },
      writeSettings: async (id, update) => {
        const current = settings.get(id) ?? { mode: null, offered: false };
        settings.set(id, { mode: update.mode === undefined ? current.mode : update.mode, offered: update.offered ?? current.offered });
      },
      workspaces: () => [workspace],
      pluginPath: () => "/plugins/mars-box.js",
      env: { MARS_BOX_HOME: home, PATH: "", MARS_BOX_RUNTIME: "/nonexistent/docker" },
      platform,
    });
  }

  test("a buildathon project's chats go in the box over the server's off; its own switch keeps them here with one line", async () => {
    const stateDir = tmp("state-");
    const home = tmp("boxhome-");
    const root = tmp();
    put(root, "README.md", "# x\n");
    rememberServerDefault(stateDir, { local_box: { default: "off" } });
    const workspace: BoxWorkspace = { id: "ws_bt", path: root, workspaceType: "local" };
    const settings: Settings = new Map();
    expect(await service(stateDir, home, workspace, settings, "linux").status(workspace)).toMatchObject({ on: false, source: "default" });
    await listProjects(home, [root], { box: "on" });
    const boxes = service(stateDir, home, workspace, settings, "linux");
    expect(await boxes.status(workspace)).toMatchObject({ on: true, source: "buildathon", hostBuilds: null });
    const off = await boxes.setMode(workspace, "off");
    expect(off).toMatchObject({ mode: "off", on: false, source: "project", notice: LESS_REPRO_NOTICE });
    // Back to the default: the box again.
    expect(await boxes.setMode(workspace, null)).toMatchObject({ on: true, source: "buildathon" });
  });

  test("repro.box offer: the offer with its own line; off: the server's default as before", async () => {
    const stateDir = tmp("state-");
    const home = tmp("boxhome-");
    const root = tmp();
    rememberServerDefault(stateDir, { local_box: { default: "off" } });
    const workspace: BoxWorkspace = { id: "ws_offer", path: root, workspaceType: "local" };
    await listProjects(home, [root], { box: "offer" });
    expect(await service(stateDir, home, workspace, new Map(), "linux").status(workspace)).toMatchObject({ on: false, source: "buildathon", offer: true, notice: BUILDATHON_OFFER_NOTICE });
    await listProjects(home, [root], { box: "off" });
    expect(await service(stateDir, home, workspace, new Map(), "linux").status(workspace)).toMatchObject({ on: false, source: "default", offer: false, notice: null });
  });

  test("host builds still win on macOS: a Mac-built buildathon project stays on this Mac", async () => {
    const stateDir = tmp("state-");
    const home = tmp("boxhome-");
    const root = tmp();
    put(root, "package.json", "{}");
    put(root, "node_modules/esbuild/bin/esbuild", MACHO, 0o755);
    put(root, "node_modules/@esbuild/darwin-arm64/bin/esbuild", MACHO, 0o755);
    put(root, "node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node", MACHO);
    put(root, "node_modules/better-sqlite3/build/Release/better_sqlite3.node", MACHO);
    mkdirSync(path.join(root, "node_modules/.bin"), { recursive: true });
    symlinkSync("../esbuild/bin/esbuild", path.join(root, "node_modules/.bin/esbuild"));
    rememberServerDefault(stateDir, { local_box: { default: "off" } });
    await listProjects(home, [root], { box: "on" });
    const workspace: BoxWorkspace = { id: "ws_macbt", path: root, workspaceType: "local" };
    const status = await service(stateDir, home, workspace, new Map(), "darwin").status(workspace);
    expect(status).toMatchObject({ on: false, source: "host-builds", hostBuilds: { native: true } });
    expect(status.notice).toBe(status.hostBuilds!.notice);
  });
});
