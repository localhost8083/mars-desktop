import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  electronProfilePaths,
  electronSurfaceEnv,
  liveSharedProductionStateEnv,
  removeOwnedSurfaceFiles,
  resolveInstalledProductionDesktopState,
} from "@mars/hosts";
import {
  test,
} from "@mars/testkit";
import { desktopProductionLive } from "../../worlds/desktop-prod-live.ts";

test("live shared production desktop state requires consent and selects state without mutating it", async ({ evidence }) => {
  let stateAcquisitions = 0;
  await assert.rejects(
    () => Reflect.apply(desktopProductionLive, undefined, [{
      resolveInstalledProductionState: async () => {
        stateAcquisitions += 1;
        throw new Error("Installed production state must not be acquired without consent.");
      },
    }]),
    /without explicit allowSharedState: true consent/,
  );
  assert.equal(stateAcquisitions, 0);

  const fixtureRoot = await mkdtemp(join(tmpdir(), "mars-prod-live-state-"));
  try {
    const homeDir = join(fixtureRoot, "home");
    const dataDir = join(homeDir, ".mars", "mars-server");
    const configDir = join(homeDir, ".config", "mars");
    const opencodeConfigDir = join(homeDir, ".config", "opencode");
    const userDataDir = join(homeDir, "Library", "Application Support", "ai.marsai.desktop");
    const opencodeDb = join(homeDir, "Library", "Application Support", "opencode", "opencode.db");
    await mkdir(dataDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await mkdir(opencodeConfigDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    await mkdir(dirname(opencodeDb), { recursive: true });
    await writeFile(opencodeDb, "fixture", "utf8");
    for (const path of [
      join(configDir, "desktop-bootstrap.json"),
      join(configDir, "env.json"),
      join(configDir, "server.json"),
      join(userDataDir, "mars-server-state.json"),
      join(userDataDir, "mars-server-tokens.json"),
      join(userDataDir, "mars-workspaces.json"),
    ]) {
      await writeFile(path, "{}\n", "utf8");
    }

    const resolved = await resolveInstalledProductionDesktopState({
      env: {},
      homeDir,
      platform: "darwin",
    });
    assert.deepEqual(resolved, {
      bootstrapPath: join(configDir, "desktop-bootstrap.json"),
      dataDir,
      envStorePath: join(configDir, "env.json"),
      homeDir,
      opencodeDb,
      opencodeConfigDir,
      serverConfigPath: join(configDir, "server.json"),
      serverStatePath: join(userDataDir, "mars-server-state.json"),
      serverTokenStorePath: join(userDataDir, "mars-server-tokens.json"),
      workspaceStatePath: join(userDataDir, "mars-workspaces.json"),
    });

    const isolatedProfile = join(fixtureRoot, "isolated-eval-profile");
    const profilePaths = electronProfilePaths(isolatedProfile);
    await mkdir(profilePaths.userDataDir, { recursive: true });
    const launchEnv = electronSurfaceEnv(
      profilePaths,
      {
        appName: "MarsAI Eval production-live",
        appIdentifier: "ai.marsai.desktop.eval.production-live",
        port: 31_001,
        cdpPort: 31_002,
      },
      liveSharedProductionStateEnv(resolved),
    );
    assert.equal(launchEnv.MARS_DATA_DIR, dataDir);
    assert.equal(launchEnv.OPENCODE_DB, opencodeDb);
    assert.equal(launchEnv.MARS_DESKTOP_WORKSPACE_STATE_PATH, join(userDataDir, "mars-workspaces.json"));
    assert.equal(launchEnv.MARS_SERVER_TOKEN_STORE_PATH, join(userDataDir, "mars-server-tokens.json"));
    assert.equal(launchEnv.MARS_SERVER_STATE_PATH, join(userDataDir, "mars-server-state.json"));
    assert.equal(launchEnv.MARS_ENV_STORE, join(configDir, "env.json"));
    assert.equal(launchEnv.MARS_SERVER_CONFIG, join(configDir, "server.json"));
    assert.equal(launchEnv.MARS_DEV_SHARED_STATE, "1");
    assert.equal(launchEnv.MARS_ELECTRON_USERDATA, profilePaths.userDataDir);
    assert.notEqual(launchEnv.MARS_ELECTRON_USERDATA, dataDir);
    assert.equal(launchEnv.MARS_ELECTRON_APP_IDENTIFIER, "ai.marsai.desktop.eval.production-live");
    assert.equal(launchEnv.MARS_ELECTRON_REMOTE_DEBUG_PORT, "31002");

    await removeOwnedSurfaceFiles({
      name: "production-live",
      kind: "electron",
      hostKind: "local",
      cdpUrl: "http://127.0.0.1:31002",
      profileDir: isolatedProfile,
      meta: { profileOwner: "host" },
    });
    await assert.rejects(() => access(isolatedProfile));
    await access(dataDir);
    await access(opencodeDb);
    assert.equal(await readFile(opencodeDb, "utf8"), "fixture");
    assert.equal(await readFile(join(configDir, "desktop-bootstrap.json"), "utf8"), "{}\n");

    evidence.recordAssertionEvidence(
      "Live production state requires explicit consent before state acquisition",
      "The direct builder refused an omitted allowSharedState: true value without invoking its installed-state resolver.",
      true,
    );
    evidence.recordAssertionEvidence(
      "Dev Electron points at installed production stores from an isolated profile",
      "The launch environment selected production MarsAI, OpenCode, workspace, config, and token paths while retaining an isolated Electron userData directory.",
      true,
    );
    evidence.recordAssertionEvidence(
      "Cleanup owns only the isolated dev profile and does not mutate selected production state",
      "Cleanup removed the eval profile while preserving the production bootstrap content and OpenCode database bytes.",
      true,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
