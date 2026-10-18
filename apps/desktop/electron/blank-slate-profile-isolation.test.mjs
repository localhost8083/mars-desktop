import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  BLANK_SLATE_PATH_ENV_KEYS,
  prepareBlankSlateProfile,
  resolveBlankSlateLaunch,
} from "./blank-slate-profile.mjs";

test("any desktop build can launch with an isolated blank-slate profile", async () => {
  const normalEnv = {
    HOME: "/Users/installed",
    MARS_DESKTOP_BOOTSTRAP_PATH: "/Users/installed/.config/mars/desktop-bootstrap.json",
  };
  const originalNormalEnv = { ...normalEnv };
  const normalProfile = prepareBlankSlateProfile({ argv: [], env: normalEnv });
  const normal = resolveBlankSlateLaunch({ appName: "MarsAI Enterprise", profile: normalProfile });
  assert.deepEqual(normal, { enabled: false, appName: "MarsAI Enterprise", userDataPath: null });
  assert.deepEqual(normalEnv, originalNormalEnv);

  const firstEnv = { MARS_DESKTOP_DISTRIBUTION: "enterprise" };
  /** @type {NodeJS.ProcessEnv} */
  const secondEnv = {};
  const firstProfile = prepareBlankSlateProfile({ argv: ["--blank-slate"], env: firstEnv });
  const secondProfile = prepareBlankSlateProfile({ argv: ["--blank-slate"], env: secondEnv });
  const first = resolveBlankSlateLaunch({ appName: "MarsAI Enterprise", profile: firstProfile });
  const second = resolveBlankSlateLaunch({ appName: "MarsAI Enterprise", profile: secondProfile });

  try {
    assert.equal(first.enabled, true);
    assert.equal(first.appName, "MarsAI Enterprise - Test profile");
    assert.notEqual(first.rootPath, second.rootPath);
    assert.ok(!first.userDataPath.includes("ai.marsai.desktop"));

    for (const key of BLANK_SLATE_PATH_ENV_KEYS) {
      const value = firstEnv[key];
      assert.ok(value, `${key} was not overridden`);
      const relative = path.relative(first.rootPath, value);
      assert.ok(
        relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
        `${key} escaped the blank-slate root`,
      );
    }
    assert.equal(
      firstEnv.MARS_DESKTOP_BOOTSTRAP_PATH,
      first.environment.MARS_DESKTOP_BOOTSTRAP_PATH,
    );
    assert.equal(firstEnv.MARS_DESKTOP_DISTRIBUTION, "enterprise");
    assert.equal("MARS_DEV_MODE" in firstEnv, false);
    assert.ok(first.appName.startsWith("MarsAI Enterprise"));
    assert.equal(normal.userDataPath, null);
    assert.equal(normal.appName, "MarsAI Enterprise");
    assert.equal(
      normalEnv.MARS_DESKTOP_BOOTSTRAP_PATH,
      originalNormalEnv.MARS_DESKTOP_BOOTSTRAP_PATH,
    );
  } finally {
    await Promise.all([
      rm(first.rootPath, { recursive: true, force: true }),
      rm(second.rootPath, { recursive: true, force: true }),
    ]);
  }
});
