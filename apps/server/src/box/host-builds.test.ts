// macOS / Windows folders with this computer's builds (host-builds.ts, the
// CLI's host-builds.js on the same host-builds.json): a project only the
// server's default would put in the Linux box stays here with one line; one
// the user turned on goes in with a warning. Fixtures carry real Mach-O / PE
// / ELF headers. The CLI's test/box-host-builds.test.js covers the same cases.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { rememberServerDefault } from "./launch.js";
import { HOST_BUILD_RULES, binaryFormat, hostBuildThings, hostBuilds, hostBuildsNotice, hostPath, scanHostBuilds } from "./host-builds.js";
import { BoxService, type BoxWorkspace } from "./service.js";

const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01, 0, 0, 0, 0, 2, 0, 0, 0]);
const MACHO_FAT = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2, 0x01, 0, 0, 0x07]);
const JAVA_CLASS = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0x34]);
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const PE = (() => {
  const buf = Buffer.alloc(0x100);
  buf.write("MZ", 0, "latin1");
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write("PE\0\0", 0x80, "latin1");
  return buf;
})();
const SCRIPT = Buffer.from("#!/usr/bin/env node\nrequire('../lib/cli.js')\n");

function tmp(prefix = "mars-hostbuilds-"): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}
function put(root: string, rel: string, content: Buffer | string, mode = 0o644): string {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, { mode });
  return file;
}
function darwinNodeProject(root = tmp()): string {
  put(root, "package.json", "{}");
  put(root, "node_modules/esbuild/bin/esbuild", MACHO, 0o755);
  put(root, "node_modules/@esbuild/darwin-arm64/bin/esbuild", MACHO, 0o755);
  put(root, "node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node", MACHO);
  put(root, "node_modules/better-sqlite3/build/Release/better_sqlite3.node", MACHO);
  mkdirSync(path.join(root, "node_modules/.bin"), { recursive: true });
  symlinkSync("../esbuild/bin/esbuild", path.join(root, "node_modules/.bin/esbuild"));
  return root;
}

describe("host builds: detection", () => {
  test("formats: Mach-O (thin, universal), PE, ELF; Java classes and scripts are none", () => {
    expect(binaryFormat(MACHO)).toBe("macho");
    expect(binaryFormat(MACHO_FAT)).toBe("macho");
    expect(binaryFormat(JAVA_CLASS)).toBeNull();
    expect(binaryFormat(PE)).toBe("pe");
    expect(binaryFormat(ELF)).toBe("elf");
    expect(binaryFormat(SCRIPT)).toBeNull();
  });

  test("venv homes: macOS and Windows interpreters are the host's; a box-made /usr/bin one is not", () => {
    expect(hostPath("/Library/Developer/CommandLineTools/usr/bin", "darwin")).toBe(true);
    expect(hostPath("/opt/homebrew/opt/python@3.12/bin", "darwin")).toBe(true);
    expect(hostPath("/usr/bin", "darwin")).toBe(false);
    expect(hostPath("C:\\Users\\sam\\AppData\\Local\\Programs\\Python\\Python312", "win32")).toBe(true);
    expect(hostPath("/Library/Frameworks", "linux")).toBe(false);
  });

  test("macOS: darwin node_modules, a Mac venv and a Mach-O bin/app are named; the box's Linux builds are not", () => {
    const root = darwinNodeProject();
    put(root, ".venv/pyvenv.cfg", "home = /Library/Developer/CommandLineTools/usr/bin\nversion = 3.9.6\n");
    put(root, "bin/app", MACHO, 0o755);
    const r = scanHostBuilds(root, { platform: "darwin" });
    expect(r.hits.map((h) => [h.kind, h.path])).toEqual([["venv", ".venv"], ["node_modules", "node_modules/@esbuild/darwin-arm64"], ["binary", "bin/app"]]);
    expect(hostBuildThings(r)).toBe("node_modules, .venv, bin/app");
    expect(hostBuildsNotice("native", { platform: "darwin", result: r })).toBe("This folder has Mac builds (node_modules, .venv, bin/app) that won't run in the Linux sandbox, so its chats run on this Mac. Turn the sandbox on for this project to use it anyway.");

    const addon = tmp();
    put(addon, "node_modules/better-sqlite3/build/Release/better_sqlite3.node", MACHO);
    expect(scanHostBuilds(addon, { platform: "darwin" }).hits[0]?.why).toBe("native addon");

    const linux = tmp();
    put(linux, "node_modules/@esbuild/linux-arm64/bin/esbuild", ELF, 0o755);
    put(linux, "node_modules/better-sqlite3/build/Release/better_sqlite3.node", ELF);
    put(linux, ".venv/pyvenv.cfg", "home = /usr/bin\nversion = 3.11.2\n");
    put(linux, "bin/app", ELF, 0o755);
    put(linux, "target/debug/deps/app-1", MACHO, 0o755);
    expect(scanHostBuilds(linux, { platform: "darwin" }).found).toBe(false);
  });

  test("Windows: win32 packages, a C:\\ venv or Scripts\\python.exe, PE programs; Mac builds do not count", () => {
    const node = tmp();
    put(node, "node_modules/@esbuild/win32-x64/esbuild.exe", PE);
    expect(scanHostBuilds(node, { platform: "win32" }).hits[0]?.path).toBe("node_modules/@esbuild/win32-x64");
    const venv = tmp();
    put(venv, ".venv/pyvenv.cfg", "home = C:\\Python312\r\n");
    expect(scanHostBuilds(venv, { platform: "win32" }).hits[0]?.kind).toBe("venv");
    const scripts = tmp();
    put(scripts, "venv/pyvenv.cfg", "home = /x\n");
    put(scripts, "venv/Scripts/python.exe", PE);
    expect(scanHostBuilds(scripts, { platform: "win32" }).hits[0]?.why).toBe("Scripts/python.exe");
    const exe = tmp();
    put(exe, "dist/app.exe", PE);
    expect(scanHostBuilds(exe, { platform: "win32" }).hits.map((h) => h.path)).toEqual(["dist/app.exe"]);
    expect(scanHostBuilds(darwinNodeProject(), { platform: "win32" }).found).toBe(false);
  });

  test("Linux is never checked; bounded; cached until a folder it reads changes", () => {
    expect(scanHostBuilds(darwinNodeProject(), { platform: "linux" }).found).toBe(false);
    const big = tmp();
    for (let i = 0; i < 1200; i++) mkdirSync(path.join(big, "node_modules", `pkg-${i}`), { recursive: true });
    put(big, "bin/app", MACHO, 0o755);
    expect(scanHostBuilds(big, { platform: "darwin", limits: { ...HOST_BUILD_RULES.limits, entries: 300 } }).truncated).toBe(true);
    const full = scanHostBuilds(big, { platform: "darwin" });
    expect(full.found).toBe(true);
    expect(full.ms).toBeLessThan(1_000);

    const state = tmp();
    const root = tmp();
    put(root, "bin/app", ELF, 0o755);
    expect(hostBuilds(root, { platform: "darwin", stateDir: state }).found).toBe(false);
    expect(hostBuilds(root, { platform: "darwin", stateDir: state }).cached).toBe(true);
    put(root, "bin/app2", MACHO, 0o755);
    utimesSync(path.join(root, "bin"), new Date(), new Date(Date.now() + 5_000));
    const again = hostBuilds(root, { platform: "darwin", stateDir: state });
    expect(again.cached).toBeUndefined();
    expect(again.found).toBe(true);
  });
});

describe("host builds: the desktop's projects", () => {
  type Settings = Map<string, { mode: "on" | "off" | null; offered: boolean }>;
  function service(stateDir: string, workspace: BoxWorkspace, settings: Settings, platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}) {
    return new BoxService({
      stateDir,
      readSettings: async (id) => settings.get(id) ?? { mode: null, offered: false },
      writeSettings: async (id, update) => {
        const current = settings.get(id) ?? { mode: null, offered: false };
        settings.set(id, { mode: update.mode === undefined ? current.mode : update.mode, offered: update.offered ?? current.offered });
      },
      workspaces: () => [workspace],
      pluginPath: () => "/plugins/mars-box.js",
      env: { MARS_BOX_HOME: tmp("boxhome-"), PATH: "", MARS_BOX_RUNTIME: "/nonexistent/docker", ...env },
      platform,
    });
  }

  test("the server's default leaves a Mac-built project on this Mac; turned on by the user it goes in, with the warning", async () => {
    const stateDir = tmp("state-");
    const root = darwinNodeProject();
    rememberServerDefault(stateDir, { local_box: { default: "on" } });
    const workspace: BoxWorkspace = { id: "ws_mac", path: root, workspaceType: "local" };
    const settings: Settings = new Map();
    const boxes = service(stateDir, workspace, settings, "darwin");
    const status = await boxes.status(workspace);
    expect(status).toMatchObject({ mode: null, on: false, source: "host-builds", state: "off", boxNotice: null });
    expect(status.hostBuilds).toEqual({ native: true, things: "node_modules", notice: "This folder has Mac builds (node_modules) that won't run in the Linux sandbox, so its chats run on this Mac. Turn the sandbox on for this project to use it anyway." });
    expect(status.notice).toBe(status.hostBuilds!.notice);
    expect(await boxes.ensure(workspace)).toBeNull();
    expect(await boxes.listedProjects()).toEqual([]);
    expect(await boxes.beforePrompt("ses_hostbuilds_1", workspace)).toBeNull();
    // The project's own switch: in the box (none runs here, so "unavailable"), with the warning.
    const on = await boxes.setMode(workspace, "on");
    expect(on).toMatchObject({ mode: "on", on: true, source: "project" });
    expect(on.hostBuilds).toEqual({ native: false, things: "node_modules", notice: "This folder has Mac builds (node_modules) that won't run in the Linux sandbox; rebuilding them there replaces them with Linux builds that won't run on this Mac." });
    expect(on.boxNotice).toBe("Chats here run in a Linux sandbox, not on this Mac; turn it off for this project in Settings to run them here.");
    // MARS_BOX=1 is the user's choice too; the off switch for the rule leaves the server's default as it was.
    expect(await service(stateDir, workspace, new Map(), "darwin", { MARS_BOX: "1" }).status(workspace)).toMatchObject({ on: true, source: "env", hostBuilds: { native: false } });
    expect(await service(stateDir, workspace, new Map(), "darwin", { MARS_BOX_KEEP_NATIVE: "off" }).status(workspace)).toMatchObject({ on: true, source: "server", hostBuilds: null });
  });

  test("a clean project gets the box with the one line on macOS / Windows; Linux is unchanged", async () => {
    const stateDir = tmp("state-");
    const root = tmp();
    put(root, "README.md", "# x\n");
    rememberServerDefault(stateDir, { local_box: { default: "on" } });
    const workspace: BoxWorkspace = { id: "ws_clean", path: root, workspaceType: "local" };
    const mac = await service(stateDir, workspace, new Map(), "darwin").status(workspace);
    expect(mac).toMatchObject({ on: true, source: "server", hostBuilds: null });
    expect(mac.boxNotice).toMatch(/^Chats here run in a Linux sandbox, not on this Mac/);
    expect((await service(stateDir, workspace, new Map(), "win32").status(workspace)).boxNotice).toMatch(/not on this PC/);
    const built = darwinNodeProject();
    const linux = await service(stateDir, { id: "ws_l", path: built, workspaceType: "local" }, new Map(), "linux").status({ id: "ws_l", path: built, workspaceType: "local" });
    expect(linux).toMatchObject({ on: true, source: "server", hostBuilds: null, boxNotice: null });
  });
});
