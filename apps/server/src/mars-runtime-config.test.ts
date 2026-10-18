import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildMarsRuntimeConfig,
  buildMarsRuntimeConfigObjectFromSnapshot,
  keepMarsRuntimeConfigFileFresh,
  marsOwnPluginPaths,
  marsRuntimeConfigFilePath,
  marsRuntimeSkillsDir,
  writeMarsRuntimeConfigFile,
} from "./mars-runtime-config.js";
import { writeGlobalRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { rulesFromPermissionConfig, winningRule } from "./effective-permissions.js";
import { backendCatalogBody } from "./__fixtures__/mars-model-catalog.js";
import { MAX_UPLOAD_CHILD_SESSION_DEPTH } from "./session-uploader.js";
import {
  MARS_SUBAGENT_DEPTH,
  MARS_SWARM_MAX_PER_TURN,
  MARS_SWARM_MAX_RUNNING,
  MARS_SWARM_SKILL,
  MARS_SWARM_ARCHIVE_DIR,
  MARS_SWARM_SKILL_NAME,
  MARS_SWARM_TOOL_NAME,
  marsSwarmSkillMarkdown,
  marsSwarmSubagentNote,
  marsSubagentNote,
} from "./mars-swarm.js";
import { parseFrontmatter } from "./frontmatter.js";
import {
  sanitizeMarsModelCatalog,
  writeMarsModelCatalog,
  type MarsModelCatalog,
} from "./mars-model-catalog.js";
import { gitWorkflowPermissionRules } from "./git-command-policy.js";
import { MARS_AGENT_PROMPT } from "./mars-agent-prompt.js";
import { BestPracticesEngineReloads, MARS_BEST_PRACTICES, marsBestPracticesSkillsDir, waitForBestPracticesReady } from "./best-practices.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
const cleanups: Array<() => void> = [];
let previousDb: string | undefined;

afterEach(async () => {
  while (cleanups.length) cleanups.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  if (previousDb === undefined) delete process.env.MARS_RUNTIME_DB;
  else process.env.MARS_RUNTIME_DB = previousDb;
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "mars-runtime-config-file-"));
  roots.push(root);
  previousDb = process.env.MARS_RUNTIME_DB;
  process.env.MARS_RUNTIME_DB = join(root, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      { id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" },
    ],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  return { root, config };
}

async function readConfigFile(config: ServerConfig): Promise<Record<string, unknown>> {
  const raw = await readFile(marsRuntimeConfigFilePath(config), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("mars runtime config file", () => {
  test("permanent MCP ban omits MCP and adds an engine permission fence", () => {
    const parsed = buildMarsRuntimeConfigObjectFromSnapshot(
      { mcp: { posthog: { type: "remote", url: "https://mcp.example" } } },
      undefined,
      {},
      undefined,
      undefined,
      undefined,
    );
    expect(parsed.mcp).toEqual({});
    expect(parsed.permission).toMatchObject({ "mcp.*": "deny" });
    const plugins = Array.isArray(parsed.plugin) ? parsed.plugin : [];
    expect(plugins.some((plugin) => typeof plugin === "string" && plugin.includes("mars-mcp-policy"))).toBe(true);
    expect(String(plugins.at(-1))).toContain("mars-mcp-policy");
  });

  test("every plugin marsai.click configures is named as its own, so the engine never holds a project for their install", () => {
    const parsed = buildMarsRuntimeConfigObjectFromSnapshot({ plugin: ["user-plugin@1.0.0"] }, undefined, {}, undefined, undefined, undefined);
    const plugins = Array.isArray(parsed.plugin) ? parsed.plugin.map(String) : [];
    const own = new Set(marsOwnPluginPaths());
    expect(plugins.filter((plugin) => !own.has(plugin))).toEqual(["user-plugin@1.0.0"]);
    expect([...own].some((plugin) => /mars-box\.(?:ts|js)$/.test(plugin))).toBe(true);
  });

  test("managed browser restrictions use scalar actions in global and agent permissions", () => {
    const parsed = buildMarsRuntimeConfigObjectFromSnapshot({
      managedPolicy: {
        execution: {
          commands: "deny", blockedCommands: ["curl *"],
          browserOrigins: ["https://approved.example"], blockBrowserUploads: true,
        },
      },
    });
    // The built-in git workflow rules come first; the organization's execution
    // rules are appended last so the engine's last-match-wins evaluation keeps them.
    const permission = { bash: { ...gitWorkflowPermissionRules(), "*": "deny", "curl *": "deny" }, "mcp.*": "deny", webfetch: "deny", websearch: "deny" };
    expect(parsed.permission).toEqual(permission);
    expect(Object.keys((parsed.permission as { bash: Record<string, string> }).bash).slice(-2)).toEqual(["*", "curl *"]);
    expect(parsed.agent).toMatchObject({ mars: { permission } });
    expect(parsed.managedPolicy).toBeUndefined();
    expect(buildMarsRuntimeConfigObjectFromSnapshot({}).permission).toEqual({ bash: gitWorkflowPermissionRules(), "mcp.*": "deny" });
  });

  test("full approval mode allows every permission category; the environment overrides the setting", () => {
    const permission = { bash: { "*": "allow" }, read: { "*": "allow" }, edit: "allow", "mcp.*": "deny", webfetch: "allow", websearch: "allow", doom_loop: "allow", external_directory: "allow" };
    const full = buildMarsRuntimeConfigObjectFromSnapshot(
      { approvals: { mode: "full" }, permission: { external_directory: { "/Users/sam/Docs": "allow" } } },
      undefined,
      {},
    );
    expect(full.permission).toEqual(permission);
    expect(full.agent).toMatchObject({ mars: { permission: { ...permission, skill: { "get-started": "deny" } } } });
    // The setting is server state, never engine config.
    expect(full.approvals).toBeUndefined();

    // The engine asks before reading .env files by default and appends the injected block after its
    // own rules; the full-mode catch-all read allow wins, the guarded block leaves the default alone.
    const engineEnvDefaults = [{ permission: "read", pattern: "*.env", action: "ask" as const }, { permission: "read", pattern: "*.env.*", action: "ask" as const }];
    const guarded = buildMarsRuntimeConfigObjectFromSnapshot({}, undefined, {});
    for (const file of ["/workspace/.env", "/workspace/.env.local"]) {
      expect(winningRule([...engineEnvDefaults, ...rulesFromPermissionConfig(full.permission)], "read", file)?.action).toBe("allow");
      expect(winningRule([...engineEnvDefaults, ...rulesFromPermissionConfig(guarded.permission)], "read", file)?.action).toBe("ask");
    }

    // Organization denies are appended last so the engine's last-match-wins keeps them.
    const denied = buildMarsRuntimeConfigObjectFromSnapshot({
      approvals: { mode: "full" },
      managedPolicy: { execution: { commands: "allow", blockedCommands: ["curl *"], browserOrigins: ["https://approved.example"], blockBrowserUploads: false } },
    }, undefined, {});
    expect(denied.permission).toEqual({ ...permission, bash: { "*": "allow", "curl *": "deny" }, webfetch: "deny", websearch: "deny" });

    // MARS_APPROVALS on the server process wins in both directions; the default stays guarded.
    expect(buildMarsRuntimeConfigObjectFromSnapshot({ approvals: { mode: "full" } }, undefined, { MARS_APPROVALS: "guarded" }).permission)
      .toEqual({ bash: gitWorkflowPermissionRules(), "mcp.*": "deny" });
    expect(buildMarsRuntimeConfigObjectFromSnapshot({}, undefined, { MARS_APPROVALS: "full" }).permission).toEqual(permission);
    expect(buildMarsRuntimeConfigObjectFromSnapshot({}, undefined, {}).permission).toEqual({ bash: gitWorkflowPermissionRules(), "mcp.*": "deny" });
  });

  test("omits global-row MCPs while writing mars defaults into the file", async () => {
    const { config } = await setup();
    await writeGlobalRuntimeOpencodeConfig(config, (current) => ({
      ...current,
      mcp: {
        posthog: { type: "remote", url: "https://mcp.posthog.com/mcp", enabled: true },
        "mars-connect-stale": { type: "remote", url: "https://cloud.example/stale", enabled: true },
      },
    }));

    const { path } = await writeMarsRuntimeConfigFile(config);
    expect(path).toBe(marsRuntimeConfigFilePath(config));

    const parsed = await readConfigFile(config);
    expect(parsed.mcp).toEqual({});
    expect(parsed.default_agent).toBe("mars");
    expect(Array.isArray(parsed.plugin)).toBe(true);
    if (!Array.isArray(parsed.plugin)) throw new Error("Expected runtime plugins");
    expect(parsed.plugin).not.toContain("opencode-chrome-devtools");
    expect(parsed.plugin.some(
      (plugin) => typeof plugin === "string" && /mars-chrome-devtools\.(?:ts|js)$/.test(plugin),
    )).toBe(true);
    expect(parsed.agent).toMatchObject({
      mars: {
        permission: {
          skill: {
            "customize-opencode": "deny",
            "get-started": "deny",
            "command-creator": "deny",
            "agent-creator": "deny",
            "plugin-creator": "deny",
          },
        },
      },
    });
  });

  test("injects the account-scoped internal gateway without persisting its access token", () => {
    const parsed = buildMarsRuntimeConfigObjectFromSnapshot({}, {
      baseUrl: "http://127.0.0.1:8090/mars/v1",
    });
    const providers = parsed.provider as Record<string, Record<string, unknown>>;

    expect(parsed.model).toBe("mars/gpt-6-astra");
    expect(providers.mars).toMatchObject({
      npm: "@ai-sdk/openai",
      name: "MarsAI",
      env: ["MARS_ACCESS_TOKEN"],
      options: { baseURL: "http://127.0.0.1:8090/mars/v1" },
    });
    expect(JSON.stringify(parsed)).not.toContain("access-token");
  });

  test("exposes every marsai.click model with the shared effort levels, default first", () => {
    const parsed = buildMarsRuntimeConfigObjectFromSnapshot({}, {
      baseUrl: "http://127.0.0.1:8090/mars/v1",
    });
    const providers = parsed.provider as Record<string, { models: Record<string, Record<string, unknown>> }>;
    const models = providers.mars!.models;
    const variants = {
      low: { reasoning_effort: "low" },
      high: { reasoning_effort: "high" },
      xhigh: { reasoning_effort: "xhigh" },
      max: { reasoning_effort: "max" },
      // The engine merges its own OpenAI reasoning defaults into a model's
      // variants and only drops entries marked disabled; these keep the
      // resolved picker at exactly the four levels above.
      none: { disabled: true },
      minimal: { disabled: true },
      medium: { disabled: true },
    };
    const enabledVariants = (model: Record<string, unknown>) => Object.entries(model.variants as Record<string, { disabled?: boolean }>)
      .filter(([, options]) => options.disabled !== true)
      .map(([key]) => key);

    expect(Object.keys(models)).toEqual(["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol"]);
    expect(models["gpt-6-astra"]).toMatchObject({ name: "GPT 6 Astra", reasoning: true, tool_call: true, variants });
    expect(models["gpt-6-sol"]).toMatchObject({ name: "GPT 6 Sol", reasoning: true, tool_call: true, variants });
    expect(models["gpt-6.1-sol"]).toMatchObject({ name: "GPT 6.1 Sol", reasoning: true, tool_call: true, variants });
    for (const id of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol"]) {
      expect(Object.keys(models[id]!.variants as object).sort()).toEqual(Object.keys(variants).sort());
      expect(enabledVariants(models[id]!)).toEqual(["low", "high", "xhigh", "max"]);
    }
    expect(parsed.model).toBe("mars/gpt-6-astra");
    expect((parsed.plugin as string[]).some((plugin) => /mars-reasoning-effort\.(?:ts|js)$/.test(plugin))).toBe(true);
  });

  test("derives the desktop loopback gateway from the server config without process-global credentials", async () => {
    const { config } = await setup();
    config.port = 48123;
    config.marsEngineToken = "ephemeral-engine-token";
    config.marsGatewayCredentials = {
      gatewayUrl: "https://api.example.test/mars/v1",
      accessToken: "device-access-token",
      refreshToken: "device-refresh-token",
    };
    const previous = {
      engineGateway: process.env.MARS_ENGINE_GATEWAY_URL,
      gateway: process.env.MARS_GATEWAY_URL,
      access: process.env.MARS_ACCESS_TOKEN,
    };
    try {
      delete process.env.MARS_ENGINE_GATEWAY_URL;
      delete process.env.MARS_GATEWAY_URL;
      delete process.env.MARS_ACCESS_TOKEN;

      const parsed = JSON.parse(await buildMarsRuntimeConfig(config)) as Record<string, unknown>;
      const providers = parsed.provider as Record<string, Record<string, unknown>>;

      expect(parsed.model).toBe("mars/gpt-6-astra");
      expect(providers.mars).toMatchObject({
        env: ["MARS_ACCESS_TOKEN"],
        options: { baseURL: "http://127.0.0.1:48123/mars-gateway/v1" },
      });
      expect(JSON.stringify(parsed)).not.toContain("device-access-token");
      expect(JSON.stringify(parsed)).not.toContain("device-refresh-token");
      expect(JSON.stringify(parsed)).not.toContain("ephemeral-engine-token");
    } finally {
      if (previous.engineGateway === undefined) delete process.env.MARS_ENGINE_GATEWAY_URL;
      else process.env.MARS_ENGINE_GATEWAY_URL = previous.engineGateway;
      if (previous.gateway === undefined) delete process.env.MARS_GATEWAY_URL;
      else process.env.MARS_GATEWAY_URL = previous.gateway;
      if (previous.access === undefined) delete process.env.MARS_ACCESS_TOKEN;
      else process.env.MARS_ACCESS_TOKEN = previous.access;
    }
  });

  test("reserves the internal provider id for the account-scoped gateway", () => {
    const parsed = buildMarsRuntimeConfigObjectFromSnapshot({
      provider: {
        mars: { npm: "untrusted-override", name: "Wrong route" },
      },
    }, {
      baseUrl: "https://api.marsai.click/mars/v1",
    });
    const providers = parsed.provider as Record<string, Record<string, unknown>>;

    expect(parsed.model).toBe("mars/gpt-6-astra");
    expect(providers.mars).toMatchObject({
      npm: "@ai-sdk/openai",
      options: { baseURL: "https://api.marsai.click/mars/v1" },
    });
  });

  test("workspace runtime rows never reach the injected file", async () => {
    const { config } = await setup();
    await writeRuntimeOpencodeConfig(config, "ws_1", (current) => ({
      ...current,
      mcp: { posthog: { type: "remote", url: "https://mcp.posthog.com/mcp", enabled: true } },
    }));

    await writeMarsRuntimeConfigFile(config);

    const parsed = await readConfigFile(config);
    const mcp = (parsed.mcp ?? {}) as Record<string, Record<string, unknown>>;
    expect(mcp.posthog).toBeUndefined();
  });

  test("never injects a registry launch of mars-ui-mcp, whatever the snapshot holds", () => {
    const bundled = {
      type: "local",
      command: [
        "/Applications/MarsAI.app/Contents/MacOS/MarsAI",
        "/Applications/MarsAI.app/Contents/Resources/mars-ui-mcp/index.mjs",
      ],
      environment: { ELECTRON_RUN_AS_NODE: "1" },
    };
    const built = buildMarsRuntimeConfigObjectFromSnapshot({
      mcp: {
        "mars-ui": { type: "local", command: ["npx", "-y", "mars-ui-mcp"], enabled: true },
        "ui-bunx": { type: "local", command: ["bunx", "mars-ui-mcp@latest"] },
        "ui-bundled": bundled,
      },
    });
    expect(built.mcp).toEqual({});
  });

  test("mars prompt states identity, repo memory, artifacts, and Connect routing once, without the removed Memory Bank", async () => {
    const { config } = await setup();
    await writeMarsRuntimeConfigFile(config);

    const parsed = await readConfigFile(config);
    const agent = parsed.agent as Record<string, { prompt?: string }>;
    const prompt = agent.mars?.prompt ?? "";

    expect(prompt.startsWith("You are MarsAI.")).toBe(true);
    expect(prompt).toContain("## Memory\n");
    expect(prompt).toContain("## MarsAI Artifacts");
    expect(prompt).toContain("## Connected work");
    expect(prompt).toContain("Split real work: for a task of more than a few tool calls, start one sub-agent per independent part in one message");
    expect(prompt).toContain("make exactly that many task-tool calls, no more and no fewer, and start them all in one message");
    expect(prompt).toContain("Never paste the user's whole message, or the user's instructions about sub-agents, into a sub-agent's prompt");
    expect(prompt).toContain("Never replace an explicit delegation request with a simulated multi-role answer");
    expect(prompt).toContain("Wait for every delegated task");
    // Den removed the Memory Bank; the prompt must not teach capabilities that
    // the live catalog can no longer return.
    expect(prompt).not.toContain("Memory Bank");
    expect(prompt).not.toContain("postMemory");
    expect(prompt).not.toContain("getMemorySearch");
    // Connect tool names appear exactly once each, in the base prompt's own
    // routing paragraph; the diagnostics prompt markers key on them.
    expect(prompt.match(/mars-cloud_search_capabilities/g)).toHaveLength(1);
    expect(prompt.match(/mars-cloud_execute_capability/g)).toHaveLength(1);
    expect(prompt).not.toContain("2-4 keyword variants");
    // Skill capture defers to the runtime skill-authoring mode instead of
    // contradicting it with a workspace-only default.
    expect(prompt).toContain("`Skill creation:` instruction");
    expect(prompt).not.toContain("factor them into a skill");
  });

  test("sub-agent swarms: nested delegation up to the captured depth, for the general sub-agent only, bounded by the swarm plugin", () => {
    for (const mode of ["guarded", "full"] as const) {
      const parsed = buildMarsRuntimeConfigObjectFromSnapshot({ approvals: { mode } } as never, undefined, {});
      // The engine counts layers below the main session and refuses the task
      // tool at subagent_depth; the session uploader walks the same number of layers.
      expect(parsed.subagent_depth).toBe(MARS_SUBAGENT_DEPTH);
      expect(MARS_SUBAGENT_DEPTH).toBe(MAX_UPLOAD_CHILD_SESSION_DEPTH);
      const agents = parsed.agent as Record<string, { permission?: Record<string, unknown>; prompt?: string; mode?: string }>;
      // A sub-agent keeps the task tool only when its own rules mention it:
      // only general does; no global task rule reaches explore.
      expect(agents.general).toEqual({ permission: { task: "allow", skill: { [MARS_SWARM_SKILL_NAME]: "deny" } } });
      expect(agents.explore).toBeUndefined();
      expect((parsed.permission as Record<string, unknown>).task).toBeUndefined();
      expect(agents.mars?.permission?.task).toBeUndefined();
      // The board tool is for sub-agents only: hidden from the main agent.
      expect(agents.mars?.permission?.[MARS_SWARM_TOOL_NAME]).toBe("deny");
      expect(agents.general?.permission?.[MARS_SWARM_TOOL_NAME]).toBeUndefined();
      expect((parsed.plugin as string[]).some((plugin) => /mars-swarm\.(?:ts|js)$/.test(plugin))).toBe(true);
    }
    const prompt = (buildMarsRuntimeConfigObjectFromSnapshot({}).agent as Record<string, { prompt: string }>).mars!.prompt;
    expect(prompt).toContain("## Sub-agent swarms");
    expect(MARS_SWARM_MAX_RUNNING).toBe(Number.POSITIVE_INFINITY);
    expect(MARS_SWARM_MAX_PER_TURN).toBe(Number.POSITIVE_INFINITY);
    expect(prompt.indexOf("## Sub-agent swarms")).toBeLessThan(prompt.indexOf("## Editing files"));
  });

  test("the always-on prompt only says when to load the swarm skill; the board procedure is the skill", () => {
    const prompt = (buildMarsRuntimeConfigObjectFromSnapshot({}).agent as Record<string, { prompt: string }>).mars!.prompt;
    const section = prompt.slice(prompt.indexOf("## Sub-agent swarms"), prompt.indexOf("## Editing files"));
    expect(section).toContain(`load the \`${MARS_SWARM_SKILL_NAME}\` skill first`);
    expect(section).toContain("Before you start 3 or more sub-agents for implementation work");
    expect(section).toContain("For smaller implementation work, use 1-2 sub-agents directly when they help");
    // No board mechanics on every request: no file name, no table, no layers.
    expect(prompt).not.toContain("swarm.md");
    expect(prompt).not.toContain("## Tasks");
    expect(section.length).toBeLessThan(500);
    // The skill carries the procedure, with the board under .mars/.
    expect(MARS_SWARM_SKILL).toContain("`.mars/swarm.md`");
    expect(MARS_SWARM_SKILL).toContain("never a file in the project root");
    expect(MARS_SWARM_SKILL).toContain("For 1-2 sub-agents, stop here");
    expect(MARS_SWARM_SKILL).toContain("Sub-agents do their own task themselves");
    expect(MARS_SWARM_SKILL).toContain("never the user's whole message or instructions about sub-agents");
    // Sub-agents use the board tool instead of reading the whole board, and
    // marsai.click (not the model) clears the board when the turn ends.
    expect(MARS_SWARM_SKILL).toContain(`use the \`${MARS_SWARM_TOOL_NAME}\` tool with your task id`);
    expect(MARS_SWARM_SKILL).toContain("do not read or edit the board file");
    expect(MARS_SWARM_SKILL).toContain("marsai.click does that when the turn ends");
    const { data, body } = parseFrontmatter(marsSwarmSkillMarkdown());
    expect(data.name).toBe(MARS_SWARM_SKILL_NAME);
    expect(String(data.description)).toContain("Required before starting 3 or more sub-agents for implementation work");
    expect(body.trim()).toBe(MARS_SWARM_SKILL);
  });

  test("no prompt, skill or sub-agent note points a model at archived boards", () => {
    const prompt = (buildMarsRuntimeConfigObjectFromSnapshot({}).agent as Record<string, { prompt: string }>).mars!.prompt;
    for (const text of [prompt, MARS_SWARM_SKILL, marsSwarmSkillMarkdown(), marsSwarmSubagentNote(1), marsSwarmSubagentNote(3), marsSubagentNote(1), marsSubagentNote(3)]) {
      expect(text).not.toContain(MARS_SWARM_ARCHIVE_DIR);
      expect(text).not.toContain("swarms/");
    }
  });

  test("the engine loads the swarm skill from the runtime folder", async () => {
    const { root, config } = await setup();
    const { path } = await writeMarsRuntimeConfigFile(config);
    const parsed = JSON.parse(await readFile(path, "utf8")) as { skills?: { paths?: string[] } };
    const skillsDir = marsRuntimeSkillsDir(config);
    expect(skillsDir.startsWith(root)).toBe(true);
    expect(parsed.skills?.paths).toEqual([skillsDir, marsBestPracticesSkillsDir(config)]);
    expect(await readFile(join(skillsDir, MARS_SWARM_SKILL_NAME, "SKILL.md"), "utf8")).toBe(marsSwarmSkillMarkdown());
    // Without a server config (specs, previews) nothing points at a folder.
    expect(buildMarsRuntimeConfigObjectFromSnapshot({}).skills).toBeUndefined();
  });

  test("best practices default on, opt out without removing swarm skills, and restore after restart", async () => {
    const { config } = await setup();
    const swarmDir = marsRuntimeSkillsDir(config);
    const bestDir = marsBestPracticesSkillsDir(config);
    expect(dirname(bestDir)).toBe(dirname(swarmDir));
    expect(bestDir.startsWith(`${swarmDir}/`)).toBe(false);
    const prompt = `${MARS_AGENT_PROMPT}\n\n${MARS_BEST_PRACTICES.systemPrompt}`;
    await writeMarsRuntimeConfigFile(config);
    const on = await readConfigFile(config);
    expect(on).toMatchObject({ skills: { paths: [swarmDir, bestDir] }, agent: { mars: { prompt } } });
    expect(on.bestPractices).toBeUndefined();
    expect(MARS_BEST_PRACTICES.skills).toHaveLength(9);
    expect(MARS_BEST_PRACTICES.source.commit).toBe("4cd6fcedc62f604522db3621e5c509475ada6a0f");
    expect(MARS_BEST_PRACTICES.license).toContain("MIT License");
    for (const skill of MARS_BEST_PRACTICES.skills) {
      expect(await readFile(join(bestDir, skill.name, "SKILL.md"), "utf8")).toBe(skill.content);
    }

    await writeGlobalRuntimeOpencodeConfig(config, (current) => ({ ...current, bestPractices: false }));
    await writeMarsRuntimeConfigFile(config);
    const off = await readConfigFile(config);
    expect(off).toMatchObject({ skills: { paths: [swarmDir] }, agent: { mars: { prompt: MARS_AGENT_PROMPT } } });
    expect(off.bestPractices).toBeUndefined();
    // A fresh config object, as on startup, still reads the local persisted choice.
    expect(JSON.parse(await buildMarsRuntimeConfig({ ...config }))).toEqual(off);
    expect(await readFile(join(swarmDir, MARS_SWARM_SKILL_NAME, "SKILL.md"), "utf8")).toBe(marsSwarmSkillMarkdown());

    await writeGlobalRuntimeOpencodeConfig(config, (current) => ({ ...current, bestPractices: true }));
    await writeMarsRuntimeConfigFile(config);
    expect(await readConfigFile(config)).toEqual(on);
  });

  test("attached-engine changes wait for busy folders, apply idle folders, and stop retrying at shutdown", async () => {
    const { config } = await setup();
    const first = config.workspaces[0];
    const second = { ...first, id: "ws_second", path: join(first.path, "second") };
    let busy = true;
    const reloaded: string[] = [];
    const reloads = new BestPracticesEngineReloads({
      isBusy: async (workspace) => workspace.id === first.id && busy,
      reload: async (workspace) => { reloaded.push(workspace.id); },
      isPresent: () => true,
      retryMs: 10,
    });
    try {
      expect(await reloads.apply([first, second])).toBe("deferred");
      expect(reloaded).toEqual([second.id]);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(reloaded).toEqual([second.id]);
      busy = false;
      const deadline = Date.now() + 3_000;
      while (reloaded.length === 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(reloaded).toEqual([second.id, first.id]);
      busy = true;
      expect(await reloads.apply([first])).toBe("deferred");
      reloads.stop();
      busy = false;
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(reloaded).toEqual([second.id, first.id]);
      await expect(reloads.apply([first])).rejects.toThrow("Best practices reloads stopped");
    } finally {
      reloads.stop();
    }
  });

  test("a saved off choice neither materializes nor repairs the bundled guide folder", async () => {
    const { config } = await setup();
    await writeGlobalRuntimeOpencodeConfig(config, (current) => ({ ...current, bestPractices: false }));
    const bestDir = marsBestPracticesSkillsDir(config);
    await mkdir(dirname(bestDir), { recursive: true });
    await writeFile(bestDir, "leave this path alone while off\n", "utf8");
    await writeMarsRuntimeConfigFile(config);
    expect(await readFile(bestDir, "utf8")).toBe("leave this path alone while off\n");
    expect(await readConfigFile(config)).toMatchObject({ skills: { paths: [marsRuntimeSkillsDir(config)] } });
  });

  test("live apply waits for both native prompt and owned skill readiness, and times out honestly", async () => {
    const { root, config } = await setup();
    const owned = MARS_BEST_PRACTICES.skills.map((skill) => ({ name: skill.name, location: join(marsBestPracticesSkillsDir(config), skill.name, "SKILL.md") }));
    const user = { name: "mars-feature", location: join(root, ".opencode", "skills", "mars-feature", "SKILL.md") };
    const stale = { agents: [{ name: "mars", prompt: `${MARS_AGENT_PROMPT}\n\n${MARS_BEST_PRACTICES.systemPrompt}` }], skills: [...owned, user] };
    const promptReady = { agents: [{ name: "mars", prompt: MARS_AGENT_PROMPT }], skills: [...owned, user] };
    const allReady = { agents: promptReady.agents, skills: [user] };
    let probes = 0;
    await waitForBestPracticesReady({
      config, enabled: false, timeoutMs: 1_000, intervalMs: 1,
      read: async () => { probes += 1; return [probes === 1 ? stale : probes === 2 ? promptReady : allReady]; },
    });
    expect(probes).toBe(3);
    await expect(waitForBestPracticesReady({
      config, enabled: false, timeoutMs: 20, intervalMs: 1,
      read: async () => [promptReady],
    })).rejects.toThrow("Best practices engine readiness was not observed");
    const overrides = MARS_BEST_PRACTICES.skills.map((skill) => ({ name: skill.name, location: join(root, ".opencode", "skills", skill.name, "SKILL.md") }));
    await waitForBestPracticesReady({ config, enabled: true, timeoutMs: 1_000, read: async () => [{ agents: stale.agents, skills: overrides }] });
    await expect(waitForBestPracticesReady({
      config, enabled: false, timeoutMs: 20, intervalMs: 1,
      read: async () => [{ agents: allReady.agents, skills: [{ name: user.name, location: "" }] }],
    })).rejects.toThrow("Best practices engine readiness was not observed");
  });

  test("keepMarsRuntimeConfigFileFresh rewrites the file on ENGINE_GLOBAL writes", async () => {
    const { config } = await setup();
    await writeMarsRuntimeConfigFile(config);
    cleanups.push(keepMarsRuntimeConfigFileFresh(config));

    await writeGlobalRuntimeOpencodeConfig(config, (current) => ({
      ...current,
      mcp: { stripe: { type: "remote", url: "https://mcp.stripe.com", enabled: false } },
    }));

    // The refresh is fire-and-forget; poll briefly for the rewrite.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const parsed = await readConfigFile(config);
    expect(parsed.mcp).toEqual({});
  });

  test("workspace runtime writes do not rewrite the file", async () => {
    const { config } = await setup();
    await writeMarsRuntimeConfigFile(config);
    cleanups.push(keepMarsRuntimeConfigFileFresh(config));

    await writeRuntimeOpencodeConfig(config, "ws_1", (current) => ({
      ...current,
      mcp: { other: { type: "remote", url: "https://example.com/mcp", enabled: true } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const parsed = await readConfigFile(config);
    const mcp = (parsed.mcp ?? {}) as Record<string, Record<string, unknown>>;
    expect(mcp.other).toBeUndefined();
  });

  test("builds byte-stable config for repeated snapshots", async () => {
    const { config } = await setup();
    await writeGlobalRuntimeOpencodeConfig(config, (current) => ({
      ...current,
      mcp: { posthog: { type: "remote", url: "https://mcp.posthog.com/mcp" } },
    }));

    const first = await buildMarsRuntimeConfig(config);
    const second = await buildMarsRuntimeConfig(config);

    expect(second).toBe(first);
  });

  test("builds byte-stable config for equivalent snapshots with different key order", async () => {
    const { config } = await setup();
    await writeGlobalRuntimeOpencodeConfig(config, () => ({
      mcp: {
        zeta: { url: "https://z.example/mcp", type: "remote" },
        alpha: { type: "remote", url: "https://a.example/mcp" },
      },
      provider: {
        zeta: { npm: "@ai-sdk/openai-compatible", name: "Zeta" },
        alpha: { name: "Alpha", npm: "@ai-sdk/openai-compatible" },
      },
    }));
    const first = await buildMarsRuntimeConfig(config);

    await writeGlobalRuntimeOpencodeConfig(config, () => ({
      provider: {
        alpha: { npm: "@ai-sdk/openai-compatible", name: "Alpha" },
        zeta: { name: "Zeta", npm: "@ai-sdk/openai-compatible" },
      },
      mcp: {
        alpha: { url: "https://a.example/mcp", type: "remote" },
        zeta: { type: "remote", url: "https://z.example/mcp" },
      },
    }));
    const second = await buildMarsRuntimeConfig(config);

    expect(second).toBe(first);
  });
});

/**
 * The mars provider exactly as v1.0.9 declared it (the INTERNAL_MODELS
 * and internalGatewayModel it hardcoded). Astra and Sol must keep these
 * bytes: they feed the engine-pool fingerprint, and any drift (an
 * `attachment` flag, a family, a status) would change how the engine treats
 * them.
 */
function v109MarsProvider(baseURL: string) {
  const model = (name: string) => ({
    name,
    reasoning: true,
    tool_call: true,
    structured_output: true,
    temperature: true,
    variants: {
      low: { reasoning_effort: "low" },
      high: { reasoning_effort: "high" },
      xhigh: { reasoning_effort: "xhigh" },
      max: { reasoning_effort: "max" },
      none: { disabled: true },
      minimal: { disabled: true },
      medium: { disabled: true },
    },
    limit: { context: 400_000, output: 128_000 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
  });
  return {
    npm: "@ai-sdk/openai",
    name: "MarsAI",
    env: ["MARS_ACCESS_TOKEN"],
    options: { baseURL },
    models: { "gpt-6-astra": model("GPT 6 Astra"), "gpt-6.1-sol": model("GPT 6.1 Sol"), "gpt-6-sol": model("GPT 6 Sol") },
  };
}

/** What the engine reads: the config as JSON. */
function asEngineReadsIt(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("mars runtime config from the model catalog", () => {
  const gateway = { baseUrl: "http://127.0.0.1:48123/mars-gateway/v1" };
  const providerOf = (parsed: Record<string, unknown>) => (parsed.provider as Record<string, Record<string, unknown>>).mars!;

  function signIn(config: ServerConfig): void {
    config.port = 48123;
    config.marsEngineToken = "engine-token";
    config.marsGatewayCredentials = {
      gatewayUrl: "https://api.example.test/mars/v1",
      accessToken: "device-access-token",
      refreshToken: "device-refresh-token",
    };
  }

  test("Astra and both Sols render exactly as in v1.0.9: built-in, from the new backend, and from an older one", () => {
    const body = backendCatalogBody();
    const catalogs: Array<[string, MarsModelCatalog | undefined]> = [
      ["built-in", undefined],
      ["new backend", sanitizeMarsModelCatalog({ ...body, data: body.data.slice(0, 3) })!],
      ["older backend", sanitizeMarsModelCatalog({
        object: "list",
        data: body.data.slice(0, 3).map(({ id, display_name, reasoning_levels }) => ({ id, display_name, default: id === "gpt-6-astra", reasoning_levels })),
      })!],
    ];
    for (const [source, catalog] of catalogs) {
      const parsed = buildMarsRuntimeConfigObjectFromSnapshot({}, gateway, process.env, catalog);
      expect([source, asEngineReadsIt(providerOf(parsed))]).toEqual([source, v109MarsProvider(gateway.baseUrl)]);
      expect([source, parsed.model]).toEqual([source, "mars/gpt-6-astra"]);
    }
  });

  test("an account without Muse writes the same engine config bytes as before the sync", async () => {
    const { config } = await setup();
    signIn(config);
    const before = await buildMarsRuntimeConfig(config);
    const body = backendCatalogBody();
    await writeMarsModelCatalog(config, sanitizeMarsModelCatalog({ ...body, data: body.data.slice(0, 3) })!);
    expect(await buildMarsRuntimeConfig(config)).toBe(before);
  });

  test("the synced catalog gives each model its own efforts, limits and inputs; Astra stays the default", async () => {
    const { config } = await setup();
    signIn(config);
    await writeMarsModelCatalog(config, sanitizeMarsModelCatalog(backendCatalogBody())!);
    const parsed = JSON.parse(await buildMarsRuntimeConfig(config)) as Record<string, unknown>;
    const provider = providerOf(parsed);
    const models = provider.models as Record<string, Record<string, unknown>>;
    const museVariants = {
      minimal: { reasoning_effort: "minimal" },
      low: { reasoning_effort: "low" },
      medium: { reasoning_effort: "medium" },
      high: { reasoning_effort: "high" },
      xhigh: { reasoning_effort: "xhigh" },
      // Muse answers none and max with 400; the engine's own defaults are disabled.
      none: { disabled: true },
      max: { disabled: true },
    };

    expect(parsed.model).toBe("mars/gpt-6-astra");
    expect(Object.keys(models).sort()).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-6.1-sol", "meta-muse-spark", "muse-spark-1.1", "muse-spark-1.3"]);
    const { models: _v109Models, ...v109Plumbing } = v109MarsProvider("http://127.0.0.1:48123/mars-gateway/v1");
    const { models: _models, ...plumbing } = provider;
    expect(plumbing).toEqual(v109Plumbing);
    expect(models["gpt-6-astra"]).toEqual(asEngineReadsIt(v109MarsProvider("").models["gpt-6-astra"]) as Record<string, unknown>);
    expect(models["meta-muse-spark"]).toEqual({
      name: "Meta Muse Spark",
      family: "Meta Muse",
      reasoning: true,
      tool_call: true,
      structured_output: true,
      temperature: true,
      variants: museVariants,
      limit: { context: 158_000, output: 32_000 },
      modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    });
    expect(models["muse-spark-1.3"]).toEqual({
      name: "Meta Muse Spark 1.3",
      family: "Meta Muse",
      status: "beta",
      reasoning: true,
      tool_call: true,
      structured_output: true,
      temperature: true,
      variants: museVariants,
      limit: { context: 99_000, output: 16_000 },
      modalities: { input: ["text"], output: ["text"] },
    });
    for (const model of Object.values(models)) expect(model.attachment).toBeUndefined();
  });

  test("provider plumbing never comes from the catalog, even from a tampered cache file", async () => {
    const { config } = await setup();
    signIn(config);
    const body = backendCatalogBody();
    const tampered = {
      ...body,
      npm: "evil-sdk",
      data: body.data.map((model) => ({
        ...model,
        npm: "evil-sdk",
        api: "chat",
        baseURL: "https://attacker.example/v1",
        options: { baseURL: "https://attacker.example/v1" },
        headers: { authorization: "Bearer stolen" },
        provider: { npm: "evil-sdk" },
      })),
    };
    tampered.data.push({ ...tampered.data[0]!, id: "gpt-6-astra-2", api: "responses" });
    await mkdir(dirname(marsRuntimeConfigFilePath(config)), { recursive: true });
    await writeFile(join(dirname(marsRuntimeConfigFilePath(config)), "mars-model-catalog.json"), JSON.stringify(tampered));
    const text = await buildMarsRuntimeConfig(config);
    for (const leaked of ["evil-sdk", "attacker.example", "stolen"]) expect(text).not.toContain(leaked);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const provider = providerOf(parsed);
    expect(provider.npm).toBe("@ai-sdk/openai");
    expect(provider.options).toEqual({ baseURL: "http://127.0.0.1:48123/mars-gateway/v1" });
    // Only the one entry still on the Responses API survives.
    expect(Object.keys(provider.models as object)).toEqual(["gpt-6-astra-2"]);
  });

  test("a deprecated catalog model stays selectable in the engine (which deletes deprecated models)", () => {
    const body = backendCatalogBody();
    const catalog = sanitizeMarsModelCatalog({ ...body, data: body.data.map((model) => ({ ...model, status: "deprecated" })) })!;
    expect(catalog.every((model) => model.status === "deprecated")).toBe(true);
    const parsed = buildMarsRuntimeConfigObjectFromSnapshot({}, gateway, process.env, catalog);
    for (const model of Object.values(providerOf(parsed).models as Record<string, Record<string, unknown>>)) {
      expect(model.status).toBeUndefined();
    }
  });

  test("identical catalogs render identical bytes, so the engine pool sees no change", async () => {
    const { config } = await setup();
    signIn(config);
    await writeMarsModelCatalog(config, sanitizeMarsModelCatalog(backendCatalogBody())!);
    const first = await buildMarsRuntimeConfig(config);
    const reordered = backendCatalogBody();
    reordered.data = reordered.data.map((model) => Object.fromEntries(Object.entries(model).reverse()) as typeof model);
    await writeMarsModelCatalog(config, sanitizeMarsModelCatalog(reordered)!);
    expect(await buildMarsRuntimeConfig(config)).toBe(first);
  });

  test("a signed-out server never reads the catalog", async () => {
    const { config } = await setup();
    await writeMarsModelCatalog(config, sanitizeMarsModelCatalog(backendCatalogBody())!);
    const parsed = JSON.parse(await buildMarsRuntimeConfig(config)) as Record<string, unknown>;
    expect((parsed.provider as Record<string, unknown> | undefined)?.mars).toBeUndefined();
    expect(parsed.model).toBeUndefined();
  });
});
