import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  createEngineV2Preview,
  mapRuntimeProvidersToV2Specs,
  mapRuntimeMcpToV2,
  readEngineV2PreviewState,
  resolveInitialEngineV2PreviewState,
  writeEngineV2PreviewState,
} from "./engine-v2-preview.js";
import type { ServerConfig } from "./types.js";
import { buildMarsV2Instructions, waitForMarsV2Skills } from "./opencode-v2-instructions.js";

const realV2Binary = process.env.MARS_OPENCODE2_BIN?.trim()
  || join(resolve(import.meta.dir, "../../.."), "apps/desktop/resources/sidecars/opencode-x86_64-unknown-linux-gnu");
const realV2Test = existsSync(realV2Binary) ? test : test.skip;

test("v2 app guidance fits the native entry limit and uses the current native tools", () => {
  for (const connected of [true, false]) {
    const value = buildMarsV2Instructions(connected);
    expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBeLessThanOrEqual(7 * 1024);
    expect(value.operatingInstructions).not.toContain("Sub-agent swarms");
    expect(value.operatingInstructions).toContain("## Editing files");
    expect(value.operatingInstructions).not.toContain("mars-cloud_search_capabilities");
    expect(value.operatingInstructions).not.toContain("mars-cloud_execute_capability");
    expect(value.operatingInstructions).toStartWith("You are MarsAI.");
    expect(value.connect.includes("not connected")).toBe(!connected);
  }
});

test("native plugin skills do not block workspace skill synchronization", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-v2-plugin-skills-"));
  try {
    let reads = 0;
    await waitForMarsV2Skills(root, async () => {
      reads++;
      return { data: [{ name: "plugin-skill", description: "Plugin instructions", content: "Current plugin instructions",
        location: join(root, ".opencode", "plugins", "example", "SKILL.md") }] };
    });
    expect(reads).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("maps enabled MCP transports without retaining unknown runtime fields", () => {
  expect(mapRuntimeMcpToV2({ type: "remote", url: "https://example.test/mcp", oauth: false,
    headers: { Authorization: "Bearer fixture", ignored: 3 }, timeout: 2000, enabled: true, privateMetadata: "omit" }))
    .toEqual({ type: "remote", url: "https://example.test/mcp", oauth: false,
      headers: { Authorization: "Bearer fixture" }, timeout: { startup: 2000, catalog: 2000, execution: 2000 } });
  expect(mapRuntimeMcpToV2({ type: "local", command: ["node", "fixture.mjs"], environment: { FIXTURE: "value" } }))
    .toEqual({ type: "local", command: ["node", "fixture.mjs"], environment: { FIXTURE: "value" } });
  for (const value of [null, { type: "remote", url: "file:///secret" }, { type: "local", command: [] },
    { type: "remote", url: "https://example.test/mcp", enabled: false },
    { type: "remote", url: "https://example.test/mcp", disabled: true }]) expect(mapRuntimeMcpToV2(value)).toBeUndefined();
});

function testConfig(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    configPath: join(root, "mars-server.json"),
    approval: { mode: "manual", timeoutMs: 1_000 },
    corsOrigins: [],
    workspaces: [],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}

test("keeps persisted engine v2 preview state when the override is unset", () => {
  const persisted = { enabled: true, chatRouting: false };
  expect(resolveInitialEngineV2PreviewState({}, persisted)).toEqual(persisted);
});

test("enables engine v2 preview and chat routing when the override is 1", () => {
  expect(resolveInitialEngineV2PreviewState(
    { MARS_ENGINE_V2_PREVIEW: "1" },
    { enabled: false, chatRouting: false },
  )).toEqual({ enabled: true, chatRouting: true });
});

test("keeps persisted engine v2 preview state for an invalid override", () => {
  const persisted = { enabled: false, chatRouting: true };
  expect(resolveInitialEngineV2PreviewState(
    { MARS_ENGINE_V2_PREVIEW: "invalid" },
    persisted,
  )).toEqual(persisted);
});

test("round trips enabled and chat routing state and defaults corrupt state", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-engine-v2-preview-"));
  const config = testConfig(root);
  try {
    await writeEngineV2PreviewState(config, { enabled: true, chatRouting: true });
    expect(readEngineV2PreviewState(config)).toEqual({ enabled: true, chatRouting: true });

    await writeFile(join(root, "engine-v2-preview.json"), "{invalid", "utf8");
    expect(readEngineV2PreviewState(config)).toEqual({ enabled: false, chatRouting: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists chat routing and includes it in preview status without starting the engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-engine-v2-preview-"));
  const config = testConfig(root);
  const preview = createEngineV2Preview({ config });
  try {
    expect(preview.status().chatRouting).toBe(false);
    const status = await preview.setChatRouting(true);
    expect(status.chatRouting).toBe(true);
    expect(status.enabled).toBe(false);
    expect(status.running).toBe(false);
    expect(preview.connection()).toBeUndefined();
    expect(readEngineV2PreviewState(config)).toEqual({ enabled: false, chatRouting: true });
  } finally {
    await preview.stop();
    await rm(root, { recursive: true, force: true });
  }
});

realV2Test("removes a configured MCP from the real v2 engine before admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "mars-engine-v2-mcp-ban-"));
  const previousBinary = process.env.MARS_OPENCODE2_BIN;
  await writeEngineV2PreviewState(testConfig(root), { enabled: true, chatRouting: false });
  process.env.MARS_OPENCODE2_BIN = realV2Binary;
  const config = testConfig(root);
  const preview = createEngineV2Preview({ config, deferStart: true });

  try {
    preview.start();
    const deadline = Date.now() + 60_000;
    let connection: ReturnType<typeof preview.connection>;
    while (!(connection = preview.connection()) && Date.now() < deadline) {
      if (preview.status().lastError) throw new Error(preview.status().lastError);
      await Bun.sleep(100);
    }
    if (!connection) throw new Error("Timed out waiting for the real v2 engine");

    const directory = encodeURIComponent(root);
    const request = (path: string, init?: RequestInit) => fetch(
      `${connection!.url}${path}${path.includes("?") ? "&" : "?"}location%5Bdirectory%5D=${directory}`,
      {
        ...init,
        headers: {
          authorization: `Basic ${Buffer.from(`${connection!.username}:${connection!.password}`).toString("base64")}`,
          "content-type": "application/json",
          ...(init?.headers ?? {}),
        },
      },
    );
    const configured = await request("/api/mcp/fixture", {
      method: "PUT",
      body: JSON.stringify({ config: { type: "remote", url: "https://example.invalid/mcp" } }),
    });
    expect(configured.status).toBe(204);

    const before = await (await request("/api/mcp")).json() as { data?: Array<{ name?: string }> };
    expect(before.data?.some((entry) => entry.name === "fixture")).toBe(true);

    await preview.syncWorkspaceMcp("ws_1", root);

    const after = await (await request("/api/mcp")).json() as { data?: Array<{ name?: string }> };
    expect(after.data?.some((entry) => entry.name === "fixture")).toBe(false);
  } finally {
    await preview.stop();
    if (previousBinary === undefined) delete process.env.MARS_OPENCODE2_BIN;
    else process.env.MARS_OPENCODE2_BIN = previousBinary;
    await rm(root, { recursive: true, force: true });
  }
});

test("maps runtime provider fields and models to an OpenCode v2 spec", () => {
  expect(mapRuntimeProvidersToV2Specs({
    example: {
      name: "Example Provider",
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "https://example.test/v1", apiKey: "secret" },
      models: {
        "model-b": {},
        "model-a": { name: "Model A" },
      },
    },
  })).toEqual({
    specs: [{
      id: "example",
      name: "Example Provider",
      baseUrl: "https://example.test/v1",
      package: "@opencode-ai/ai/providers/openai-compatible",
      apiKey: "secret",
      models: [
        { id: "model-a", name: "Model A", config: { name: "Model A" } },
        { id: "model-b", name: "model-b", config: {} },
      ],
    }],
    skippedProviderIds: [],
  });
});

test("skips providers without a non-empty base URL", () => {
  const result = mapRuntimeProvidersToV2Specs({ missing: { options: { apiKey: "secret" } } });
  expect(result.skippedProviderIds).toEqual(["missing"]);
  expect(result.specs).toEqual([]);
});

test("maps providers without an API key using the preview sentinel", () => {
  expect(mapRuntimeProvidersToV2Specs({
    noKey: { options: { baseURL: "https://example.test/v1" } },
  }).specs).toEqual([{
    id: "noKey",
    name: "noKey",
    baseUrl: "https://example.test/v1",
    apiKey: "mars-engine-v2-preview-unset",
    models: [],
  }]);
});

test("skips non-record provider values without throwing", () => {
  expect(mapRuntimeProvidersToV2Specs({ array: [], nil: null, number: 42, text: "provider" })).toEqual({
    specs: [],
    skippedProviderIds: ["array", "nil", "number", "text"],
  });
});

test("sorts mapped and skipped provider IDs deterministically", () => {
  const result = mapRuntimeProvidersToV2Specs({
    zebra: { options: { baseURL: "https://zebra.test/v1" } },
    yak: {},
    alpha: { options: { baseURL: "https://alpha.test/v1" } },
    beta: null,
  });
  expect(result.specs.map((spec) => spec.id)).toEqual(["alpha", "zebra"]);
  expect(result.skippedProviderIds).toEqual(["beta", "yak"]);
});


test("native organization providers retain their transport without an endpoint override", () => {
  const result = mapRuntimeProvidersToV2Specs({
    lpr_openai: { npm: "@ai-sdk/openai", options: { apiKey: "fixture-key" }, models: { coding: { id: "wire-model", name: "Coding", tool_call: false, limit: { context: 1000000, output: 64000 }, modalities: { input: ["text", "image", "pdf"], output: ["text"] } } } },
    lpr_anthropic: { npm: "@ai-sdk/anthropic" },
    lpr_router: { npm: "@openrouter/ai-sdk-provider" },
    unknown: { npm: "untrusted-package", options: { baseURL: "https://example.test" } },
  });
  expect(result.skippedProviderIds).toEqual(["unknown"]);
  expect(result.specs.map((spec) => spec.package)).toEqual([
    "@opencode-ai/ai/providers/anthropic", "@opencode-ai/ai/providers/openai", "@opencode-ai/ai/providers/openrouter",
  ]);
  expect(result.specs.every((spec) => spec.baseUrl === undefined)).toBe(true);
  expect(result.specs[1]?.models[0]?.config).toMatchObject({ id: "wire-model", tool_call: false, limit: { context: 1000000, output: 64000 } });
});

test("native provider api endpoint and headers survive conversion", () => {
  expect(mapRuntimeProvidersToV2Specs({ native: {
    npm: "@ai-sdk/openai", api: "https://api.openai.com/v1", options: { apiKey: "fixture", headers: { "x-tenant": "fixture" } },
  } }).specs[0]).toMatchObject({ baseUrl: "https://api.openai.com/v1", package: "@opencode-ai/ai/providers/openai", headers: { "x-tenant": "fixture" } });
});


test("resolves only each provider's declared stored credential and omits missing credentials", () => {
  const providers = {
    native: { npm: "@ai-sdk/openai", env: ["NATIVE_API_KEY"] },
    missing: { npm: "@ai-sdk/openai", env: ["MISSING_API_KEY"] },
  };
  const first = mapRuntimeProvidersToV2Specs(providers, new Map([["NATIVE_API_KEY", "key-one"], ["DATABASE_URL", "unrelated-secret"]]));
  expect(first.specs[0]?.apiKey).toBe("key-one");
  expect(first.skippedProviderIds).toEqual(["missing"]);
  expect(JSON.stringify(first)).not.toContain("unrelated-secret");
  const rotated = mapRuntimeProvidersToV2Specs(providers, new Map([["NATIVE_API_KEY", "key-two"]]));
  expect(rotated.specs[0]?.apiKey).toBe("key-two");
});


test("catalog api metadata cannot redirect a stored credential off the native trusted origin", () => {
  for (const api of ["http://127.0.0.1/v1", "https://attacker.example/v1", "https://api.openai.com.attacker.example/v1", "https://api.openai.com:444/v1", "https://user@api.openai.com/v1"]) {
    const result = mapRuntimeProvidersToV2Specs({ native: { npm: "@ai-sdk/openai", api, env: ["NATIVE_API_KEY"] } }, new Map([["NATIVE_API_KEY", "private-fixture-key"]]));
    expect(result.skippedProviderIds).toEqual(["native"]);
    expect(result.specs).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private-fixture-key");
  }
});


test("null or empty native endpoint overrides cannot bypass catalog origin validation", () => {
  for (const baseURL of [null, "", "  ", 0, false, {}]) {
    const result = mapRuntimeProvidersToV2Specs({ native: {
      npm: "@ai-sdk/openai", api: "https://untrusted.example/v1",
      options: { baseURL }, env: ["NATIVE_API_KEY"],
    } }, new Map([["NATIVE_API_KEY", "private-fixture-key"]]));
    expect(result.skippedProviderIds).toEqual(["native"]);
    expect(result.specs).toEqual([]);
  }
});
