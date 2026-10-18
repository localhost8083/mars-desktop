import { resolveApprovalMode } from "./approval-mode.js";
import { legacyExecutionPermissions } from "./managed-policy-rules.js";
import { managedPolicyPluginPath } from "./managed-policy-plugin.js";
/**
 * Runtime OpenCode configuration injected via a server-managed config file
 * passed to the engine as OPENCODE_CONFIG.
 *
 * This is the single source of truth for the mars agent definition,
 * plugins, and any other config that should be injected at runtime rather
 * than written to the user's own config files. Both cli.ts and embedded.ts
 * use this.
 *
 * The engine re-reads the OPENCODE_CONFIG file from disk on every instance
 * rebuild (e.g. /instance/dispose), so the file is synchronized on every
 * runtime-DB write — unlike the previous OPENCODE_CONFIG_CONTENT env var,
 * which was frozen at spawn and reverted MCP state on each dispose.
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  marsExtensionsPreviewPluginPath,
  marsCapabilitiesKnowledgePluginPath,
  marsAnthropicAdaptiveThinkingPluginPath,
  marsAnthropicToolSchemaPluginPath,
  marsTitleRecoveryPluginPath,
  marsReasoningEffortPluginPath,
  marsSwarmPluginPath,
  marsMcpPolicyPluginPath,
  marsBudgetWrapPluginPath,
  marsOfficeAttachmentsPluginPath,
  marsSpreadsheetsPluginPath,
  marsBuildathonPluginPath,
  marsChromeDevtoolsPluginPath,
  marsPdfAttachmentsPluginPath,
  marsPluginPath,
} from "./mars-extensions-plugin-path.js";
import type { ServerConfig } from "./types.js";
import { runtimeStorageDir } from "./runtime-db.js";
import {
  onRuntimeOpencodeConfigWrite,
  isEngineGlobalRuntimeConfigId,
  readGlobalRuntimeOpencodeConfig,
  runtimeDisabledProviderList,
  runtimeProviderMap,
  runtimePluginList,
  type RuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import { MARS_AGENT_PROMPT } from "./mars-agent-prompt.js";
import { MARS_SUBAGENT_DEPTH, MARS_SWARM_SKILL_NAME, MARS_SWARM_TOOL_NAME, marsSwarmSkillMarkdown } from "./mars-swarm.js";
import {
  builtinMarsModelCatalog,
  engineModelsFromCatalog,
  marsDefaultModelId,
  readMarsModelCatalog,
  type MarsModelCatalog,
} from "./mars-model-catalog.js";
import { writeFileAtomic } from "./atomic-write.js";
import { boxServiceFor } from "./box/desktop.js";
import { engineConfig as withBoxEngineConfig } from "./box/launch.js";
import {
  MARS_BEST_PRACTICES,
  bestPracticesEnabled,
  marsBestPracticesSkillsDir,
  writeBestPracticesSkills,
} from "./best-practices.js";

const INTERNAL_PROVIDER_ID = "mars";

type InternalGatewayRuntime = {
  baseUrl: string;
};

function resolveInternalGatewayRuntime(
  env: NodeJS.ProcessEnv = process.env,
): InternalGatewayRuntime | undefined {
  const baseUrl = (env.MARS_ENGINE_GATEWAY_URL ?? env.MARS_GATEWAY_URL)?.trim().replace(/\/+$/, "");
  const accessToken = env.MARS_ACCESS_TOKEN?.trim();
  if (!baseUrl || !accessToken) return undefined;

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname))) {
    return undefined;
  }
  return { baseUrl: url.toString().replace(/\/$/, "") };
}

function resolveConfiguredInternalGatewayRuntime(
  config: ServerConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): InternalGatewayRuntime | undefined {
  if (config?.marsGatewayCredentials && config.marsEngineToken) {
    const rawHostname = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
    const hostname = rawHostname.includes(":") && !rawHostname.startsWith("[")
      ? `[${rawHostname}]`
      : rawHostname;
    const baseUrl = `http://${hostname}:${config.port}/mars-gateway/v1`;
    return { baseUrl };
  }
  return resolveInternalGatewayRuntime(env);
}

/** Whether the engine config carries the marsai.click provider (an account is signed in). */
export function marsGatewayConfigured(config: ServerConfig | undefined): boolean {
  return resolveConfiguredInternalGatewayRuntime(config) !== undefined;
}

function internalGatewayProvider(runtime: InternalGatewayRuntime, catalog: MarsModelCatalog): Record<string, unknown> {
  return {
    // The native OpenAI provider uses the Responses API, which preserves
    // reasoning summaries, tool calls, and delegated task events. The generic
    // compatibility provider only emits /chat/completions and loses those
    // capabilities.
    npm: "@ai-sdk/openai",
    name: "MarsAI",
    env: ["MARS_ACCESS_TOKEN"],
    options: { baseURL: runtime.baseUrl },
    // Only models come from the account's catalog; the provider fields above
    // never do, so a catalog cannot route the engine past the local broker.
    models: engineModelsFromCatalog(catalog),
  };
}

export async function buildMarsRuntimeConfigObject(
  config?: ServerConfig,
): Promise<Record<string, unknown>> {
  // Workspace-independent by design: the injected engine config file is
  // rendered from the ENGINE_GLOBAL runtime row, the synced model catalog and
  // static built-ins only, so workspace activation rewrites identical bytes
  // and never varies the engine-pool fingerprint. Per-workspace MCPs reach the
  // engine through the dynamic push path instead.
  const runtimeConfig = config ? await readGlobalRuntimeOpencodeConfig(config) : {};
  const internalGateway = resolveConfiguredInternalGatewayRuntime(config);
  const built = buildMarsRuntimeConfigObjectFromSnapshot(
    runtimeConfig,
    internalGateway,
    process.env,
    internalGateway && config ? await readMarsModelCatalog(config) : undefined,
    config ? marsRuntimeSkillsDir(config) : undefined,
    config ? marsBestPracticesSkillsDir(config) : undefined,
  );
  // The Linux sandbox (box/): the engine's shell is the box shell and the box plugin is
  // loaded once any workspace may use a box; every other project's commands run natively
  // through the same shell. The same bytes whichever workspace is active.
  return config ? withBoxEngineConfig(await boxServiceFor(config).engineBits(), built) : built;
}

/** marsai.click's own engine plugins that go before the user's, in registration order. */
function marsLeadingPluginPaths(): string[] {
  return [
    managedPolicyPluginPath(),
    marsChromeDevtoolsPluginPath(),
    // Registration order is prompt order: the knowledge plugin appends the
    // operating rules first, then the extensions plugin adds app-control
    // mechanics, live Connect steering, and the remote skill and Automation
    // catalogs, so rules precede state and state precedes data.
    marsCapabilitiesKnowledgePluginPath(),
    marsExtensionsPreviewPluginPath(),
    marsBudgetWrapPluginPath(),
    marsOfficeAttachmentsPluginPath(),
    marsSpreadsheetsPluginPath(),
    marsPdfAttachmentsPluginPath(),
    marsAnthropicAdaptiveThinkingPluginPath(),
    marsAnthropicToolSchemaPluginPath(),
    marsReasoningEffortPluginPath(),
    marsTitleRecoveryPluginPath(),
    marsSwarmPluginPath(),
    // Buildathon projects only (the app lists them): the event's reproducibility rules.
    marsBuildathonPluginPath(),
  ];
}

/**
 * Every engine plugin file marsai.click ships. They are bundled and need no
 * npm install, so the engine is told (MARS_PLUGINS_NO_DEPS) not to hold a
 * project's first request until its `.opencode` folder's background install
 * of @opencode-ai/plugin ends: on Windows that install took minutes, and
 * every prompt in a new project failed meanwhile. User plugins still wait.
 */
export function marsOwnPluginPaths(): string[] {
  return [
    ...marsLeadingPluginPaths(),
    managedPolicyPluginPath(true),
    marsMcpPolicyPluginPath(),
    marsPluginPath("mars-box"),
  ];
}

/**
 * The folder of marsai.click's own on-demand skills (the mars-swarm skill),
 * handed to the engine through `skills.paths`. It lives beside the runtime
 * config file, outside every workspace, so it never shows up in a project.
 */
export function marsRuntimeSkillsDir(config: ServerConfig): string {
  return join(runtimeStorageDir(config), "skills");
}

/** Writes the built-in skills the config points at; unchanged files are left alone. */
async function writeMarsRuntimeSkills(config: ServerConfig): Promise<void> {
  const directory = join(marsRuntimeSkillsDir(config), MARS_SWARM_SKILL_NAME);
  const path = join(directory, "SKILL.md");
  const content = marsSwarmSkillMarkdown();
  if ((await readFile(path, "utf8").catch(() => undefined)) === content) return;
  await mkdir(directory, { recursive: true });
  await writeFileAtomic(path, content);
}

export function buildMarsRuntimeConfigObjectFromSnapshot(
  runtimeConfig: RuntimeOpencodeConfig,
  internalGateway?: InternalGatewayRuntime,
  env: NodeJS.ProcessEnv = process.env,
  catalog: MarsModelCatalog = builtinMarsModelCatalog(),
  skillsDir?: string,
  bestPracticesDir?: string,
): Record<string, unknown> {
  const disabledProviders = runtimeDisabledProviderList(runtimeConfig);
  // MARS_APPROVALS in the server environment wins over the persisted setting.
  const permissions = legacyExecutionPermissions(runtimeConfig.managedPolicy?.execution, resolveApprovalMode(runtimeConfig, env).mode);
  const mcpPermission = { "mcp.*": "deny" };
  const { managedPolicy: _managedPolicy, approvals: _approvals, bestPractices: _bestPractices, ...engineConfig } = runtimeConfig;
  const enabled = bestPracticesEnabled(runtimeConfig);
  const skillPaths = [
    ...(skillsDir ? [skillsDir] : []),
    ...(enabled && bestPracticesDir ? [bestPracticesDir] : []),
  ];
  const provider = {
    ...runtimeProviderMap(runtimeConfig),
    ...(internalGateway
      ? { [INTERNAL_PROVIDER_ID]: internalGatewayProvider(internalGateway, catalog) }
      : {}),
  };
  const ownProviders = Object.keys(provider).filter((id) => /^(?:lpr_|mars$)/i.test(id));
  // Signed in, the model picker lists only marsai.click (and org-assigned)
  // models: the engine would otherwise also load providers from the user's
  // own opencode config, whose models bypass the gateway and whose errors
  // name upstream relays. MARS_ALLOW_OTHER_PROVIDERS=1 or an org policy
  // with allowCustomProviders: true lets them back in.
  const onlyOwnProviders = ownProviders.length > 0
    && env.MARS_ALLOW_OTHER_PROVIDERS !== "1"
    && runtimeConfig.managedPolicy?.allowCustomProviders !== true;
  return {
    ...engineConfig,
    ...(internalGateway
      ? { model: `${INTERNAL_PROVIDER_ID}/${marsDefaultModelId(catalog)}` }
      : {}),
    ...(runtimeConfig.managedPolicy?.allowCustomProviders === false ? { enabled_providers: [
      ...ownProviders,
      ...(runtimeConfig.managedPolicy.allowZenModel !== false ? ["opencode"] : []),
    ] } : onlyOwnProviders ? { enabled_providers: ownProviders } : {}),
    permission: { ...engineConfig.permission, ...permissions, ...mcpPermission },
    // marsai.click's own on-demand skills (the swarm procedure).
    ...(skillPaths.length ? { skills: { paths: skillPaths } } : {}),
    default_agent: runtimeConfig.default_agent ?? "mars",
    // Sub-agent swarms: sub-agents may delegate again, up to this many layers
    // below the main session (the engine's default of 1 forbids nesting).
    // The mars-swarm plugin bounds how many run and start.
    subagent_depth: MARS_SUBAGENT_DEPTH,
    agent: {
      mars: {
        description: "marsai.click default agent",
        mode: "primary",
        temperature: 0.2,
        prompt: enabled ? `${MARS_AGENT_PROMPT}\n\n${MARS_BEST_PRACTICES.systemPrompt}` : MARS_AGENT_PROMPT,
        permission: {
          ...permissions,
          ...mcpPermission,
          skill: {
            // MarsAI supplies its own current skill routing and no longer
            // supports these engine or legacy workspace skills.
            "customize-opencode": "deny",
            "get-started": "deny",
            "command-creator": "deny",
            "agent-creator": "deny",
            "plugin-creator": "deny",
          },
          // The swarm plugin's board tool is for sub-agents: the main agent
          // writes and reads the board itself, and never pays for the tool
          // definition on its requests.
          [MARS_SWARM_TOOL_NAME]: "deny",
          // The engine denies its question tool to every agent but its own
          // build and plan agents; the app answers questions, so the main
          // agent may ask (sub-agents still cannot).
          question: "allow",
        },
      },
      // The engine hides the task tool from a sub-agent unless the sub-agent's
      // own permissions mention `task`. Only the general sub-agent gets it;
      // explore stays read-only (a global task rule would reach every agent).
      // Sub-agents never start a swarm (a running swarm's sub-agents get the
      // board note from the swarm plugin), so the swarm skill is not listed
      // in their prompts.
      general: {
        permission: { task: "allow", skill: { [MARS_SWARM_SKILL_NAME]: "deny" } },
      },
    },
    plugin: [
      ...marsLeadingPluginPaths(),
      ...runtimePluginList(runtimeConfig),
      // This must be last: user/runtime plugins may not reintroduce MCP
      // configuration or replace the deny rules.
      marsMcpPolicyPluginPath(),
    ],
    ...(disabledProviders.length ? { disabled_providers: disabledProviders } : {}),
    // MCP is a permanently disabled capability. The policy plugin also
    // strips project/global MCP entries that the engine discovers itself.
    mcp: {},
    ...(Object.keys(provider).length ? { provider } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableJsonValue(value[key])]),
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

export async function buildMarsRuntimeConfig(config?: ServerConfig): Promise<string> {
  return stableStringify(await buildMarsRuntimeConfigObject(config));
}

export function marsRuntimeConfigFilePath(config: ServerConfig): string {
  return join(runtimeStorageDir(config), "runtime-opencode-config.json");
}

// Serialize file writes per path so a slow older write can never land after
// (and clobber) a newer one. Content is built inside the queued job so each
// job reads the latest runtime-DB state.
export interface MarsRuntimeConfigWriteResult {
  path: string;
  changed: boolean;
}

const fileWriteQueue = new Map<string, Promise<MarsRuntimeConfigWriteResult>>();

/**
 * Rebuild the engine-visible runtime config file from the runtime DB.
 * Atomic (temp file + rename) so the engine never reads a partial file
 * mid-dispose.
 */
export async function writeMarsRuntimeConfigFile(
  config: ServerConfig,
): Promise<MarsRuntimeConfigWriteResult> {
  const path = marsRuntimeConfigFilePath(config);
  const job = async () => {
    // The config names the skills folder: write it first, so the engine
    // never loads a config whose built-in skill is missing.
    await writeMarsRuntimeSkills(config);
    if (bestPracticesEnabled(await readGlobalRuntimeOpencodeConfig(config))) {
      await writeBestPracticesSkills(config);
    }
    const content = await buildMarsRuntimeConfig(config);
    const current = await readFile(path, "utf8").catch(() => undefined);
    if (current === content) return { path, changed: false };
    await mkdir(runtimeStorageDir(config), { recursive: true });
    await writeFileAtomic(path, content);
    return { path, changed: true };
  };
  const previous = fileWriteQueue.get(path) ?? Promise.resolve();
  const next = previous.then(job, job);
  fileWriteQueue.set(path, next);
  return await next;
}

/**
 * Keep the runtime config file in sync with the runtime DB so every engine
 * instance rebuild reads fresh state instead of a spawn-time snapshot.
 * Returns an unsubscribe function.
 */
export function keepMarsRuntimeConfigFileFresh(config: ServerConfig): () => void {
  return onRuntimeOpencodeConfigWrite((writeConfig, writtenWorkspaceId) => {
    if (!isEngineGlobalRuntimeConfigId(writtenWorkspaceId)) return;
    void writeMarsRuntimeConfigFile(writeConfig).catch(() => undefined);
  });
}
