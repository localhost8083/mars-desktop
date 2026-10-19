import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { engineDataDir, engineDataEnv, engineDataHome, engineConfigHomeEnv, userDataHome, userConfigHome } from "./engine-data-home.js";
import { createManagedOpencodeServer } from "./managed-opencode.js";

describe("the desktop engine's data home", () => {
  test("under the app's userData, apart from the CLI's engine data", () => {
    const env = { HOME: "/home/u", MARS_DESKTOP_USER_DATA_DIR: "/home/u/.config/marsai.click" };
    expect(engineDataHome(env)).toBe("/home/u/.config/marsai.click/engine-data");
    expect(engineDataDir(env)).toBe("/home/u/.config/marsai.click/engine-data/mars");
    expect(engineDataEnv(env)).toEqual({ XDG_DATA_HOME: "/home/u/.config/marsai.click/engine-data", MARS_USER_XDG_DATA_HOME: "/home/u/.local/share" });
    expect(userDataHome({ HOME: "/home/u", XDG_DATA_HOME: "/x/data" })).toBe("/x/data");
  });

  test("an explicit MARS_ENGINE_DATA_HOME wins; without either the engine keeps its default", () => {
    expect(engineDataHome({ MARS_ENGINE_DATA_HOME: "/e", MARS_DESKTOP_USER_DATA_DIR: "/u" })).toBe("/e");
    expect(engineDataEnv({ HOME: "/home/u" })).toBeNull();
    expect(engineDataDir({ HOME: "/home/u" })).toBe("/home/u/.local/share/mars");
  });

  test("the config home is the engine's own, and remembers the user's", () => {
    const env = { HOME: "/home/u", MARS_DESKTOP_USER_DATA_DIR: "/home/u/.config/marsai.click" };
    const home = join(env.HOME!, ".config", "marsai.click");
    expect(engineConfigHomeEnv(env)).toEqual({
      XDG_CONFIG_HOME: join(home, "engine-data", "config"),
      MARS_USER_XDG_CONFIG_HOME: join(env.HOME!, ".config"),
    });
    expect(userConfigHome({ HOME: "/home/u", XDG_CONFIG_HOME: "/x/config" })).toBe("/x/config");
    // The standalone server keeps the user's config home.
    expect(engineConfigHomeEnv({ HOME: "/home/u" })).toBeNull();
  });

  test("the managed engine starts with it, and remembers the user's for the commands it runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-data-home-"));
    try {
      const dump = join(dir, "env.json");
      const bin = join(dir, "engine.mjs");
      writeFileSync(bin, [
        "#!/usr/bin/env node",
        "import { writeFileSync } from 'node:fs';",
        `writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ data: process.env.XDG_DATA_HOME, user: process.env.MARS_USER_XDG_DATA_HOME, config: process.env.XDG_CONFIG_HOME, userConfig: process.env.MARS_USER_XDG_CONFIG_HOME, configDir: process.env.OPENCODE_CONFIG_DIR }));`,
        "console.log('opencode server listening on http://127.0.0.1:' + process.argv[process.argv.indexOf('--port') + 1]);",
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"));
      chmodSync(bin, 0o755);
      const server = await createManagedOpencodeServer({
        bin,
        cwd: dir,
        env: { HOME: dir, XDG_DATA_HOME: join(dir, "user-data"), MARS_ENGINE_DATA_HOME: join(dir, "engine-data") },
      });
      await server.close();
      expect(JSON.parse(readFileSync(dump, "utf8"))).toEqual({
        data: join(dir, "engine-data"),
        user: join(dir, "user-data"),
        config: join(dir, "engine-data", "config"),
        userConfig: dir,
        // The engine's own global config directory — never the CLI's
        // ~/.config/opencode, so the CLI config's `model` cannot win.
        configDir: join(dir, "engine-data", "config", "opencode"),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
