import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createManagedOpencodeServer, type ManagedOpencodeServer } from "./managed-opencode.js";
import {
  marsAnthropicToolSchemaPluginPath,
  marsMcpPolicyPluginPath,
  marsTitleRecoveryPluginPath,
} from "./mars-extensions-plugin-path.js";

/**
 * Mars plugins that patch the global fetch the engine sends model
 * requests through, on the real engine (the bundled sidecar, started as the
 * app starts it, the plugins listed in its config) against a mock provider:
 *
 *   - title recovery: the private x-mars-title-attempt header never
 *     reaches the provider, and a rejected optional title parameter
 *     (`reasoning_effort`, `temperature`, `top_p`) is retried without it, so the session
 *     still gets its title;
 *   - MCP policy: a configured local MCP is removed before the supported
 *     engine exposes its inventory or sends provider tools.
 *
 * Skipped when the sidecar binary is not present (prepare:sidecar not run).
 */

const repoRoot = resolve(import.meta.dir, "../../..");
const sidecarDir = join(repoRoot, "apps/desktop/resources/sidecars");
function findSidecar(): string | null {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const name = process.platform === "darwin" ? `opencode-${arch}-apple-darwin` : process.platform === "linux" ? `opencode-${arch}-unknown-linux-gnu` : "";
  const candidate = join(sidecarDir, name);
  return name && existsSync(candidate) ? candidate : null;
}
const enginePath = findSidecar();
const describeMaybe = enginePath ? describe : describe.skip;

const HEADER = "x-mars-title-attempt";
/** Optional title-request parameters the mock refuses (title recovery retries without them). */
const OPTIONAL_TITLE_PARAMETERS = ["reasoning_effort", "temperature", "top_p"];
const TITLE = "Recovered title from the mock";

type Seen = { path: string; headers: Record<string, string>; body: Record<string, any> };

function chatStream(content: string): Response {
  const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const body = chunk({ role: "assistant", content: "" }) + chunk({ content }) + chunk({}, "stop")
    + `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\ndata: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function chatJson(content: string): Response {
  return Response.json({ id: "c", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } });
}

describeMaybe("Mars fetch plugins on the bundled engine (mock provider)", () => {
  let engine: ManagedOpencodeServer;
  let provider: ReturnType<typeof Bun.serve>;
  let work = "";
  let data = "";
  const seen: Seen[] = [];

  const engineFetch = async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}`);
    headers.set("x-opencode-directory", encodeURIComponent(work));
    return fetch(`${engine.url}${path}`, { ...init, headers });
  };
  const waitFor = async <T>(read: () => Promise<T | null | undefined | false>, label: string, ms = 60_000): Promise<T> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = await read().catch(() => null);
      if (value) return value as T;
      await Bun.sleep(250);
    }
    throw new Error(`timed out waiting for ${label}; seen=${JSON.stringify(seen.map((s) => [s.path, Object.keys(s.body)]))}`);
  };
  const prompt = async (model: { providerID: string; modelID: string }, text: string, variant?: string) => {
    const session = (await (await engineFetch("/session", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as { id: string };
    const sent = await engineFetch(`/session/${session.id}/prompt_async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, ...(variant ? { variant } : {}), parts: [{ type: "text", text }] }),
    });
    expect(sent.status).toBe(204);
    return session.id;
  };

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "plugin-bridge-ws-"));
    data = mkdtempSync(join(tmpdir(), "plugin-bridge-data-"));
    provider = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, any>) : {};
        // The Mars server endpoints the plugins call (policy allows everything here).
        if (url.pathname.startsWith("/managed-policy")) return Response.json({ allowed: true, approvalMode: "full" });
        if (!url.pathname.startsWith("/v1/")) return Response.json({});
        seen.push({ path: url.pathname, headers: Object.fromEntries(request.headers), body });
        if (url.pathname === "/v1/messages") {
          return Response.json({ type: "error", error: { type: "invalid_request_error", message: "stop here" } }, { status: 400 });
        }
        const titleRequest = !Array.isArray(body.tools) || body.tools.length === 0;
        const rejected = titleRequest ? OPTIONAL_TITLE_PARAMETERS.find((key) => key in body) : undefined;
        if (rejected) {
          return Response.json({ error: { code: "unsupported_parameter", param: rejected, message: `Unsupported parameter: ${rejected}` } }, { status: 400 });
        }
        if (titleRequest) return body.stream ? chatStream(TITLE) : chatJson(TITLE);
        return body.stream ? chatStream("Done.") : chatJson("Done.");
      },
    });
    const base = `http://127.0.0.1:${provider.port}`;
    // A local MCP server that must be rejected by the policy plugin before the
    // supported engine can expose or execute its tool.
    const mcpScript = join(data, "anyof-mcp.mjs");
    writeFileSync(mcpScript, `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "anyof", version: "1.0.0" } } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "export_batch", description: "Export a batch", inputSchema: { type: "object", anyOf: [{ properties: { id: { type: "string" } }, required: ["id"] }, { properties: { name: { type: "string" } }, required: ["name"] }] } }] } });
  send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }] } });
});
`);
    // MCP servers another tool left in the user's global config and in the
    // project config: launching either one writes its marker file.
    const userMcp = (marker: string) => ({ type: "local", command: ["node", "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "")`], enabled: true });
    mkdirSync(join(data, "xdg-config", "opencode"), { recursive: true });
    writeFileSync(join(data, "xdg-config", "opencode", "opencode.jsonc"), `// another tool\n${JSON.stringify({ mcp: { blender: userMcp(join(data, "blender-started")) } })}`);
    writeFileSync(join(work, "opencode.json"), JSON.stringify({ mcp: { supabase: userMcp(join(data, "supabase-started")) } }));
    const configPath = join(data, "runtime-opencode-config.json");
    writeFileSync(configPath, JSON.stringify({
      model: "mock/mock-model",
      permission: { "*": "allow" },
      provider: {
        mock: { name: "Mock", npm: "@ai-sdk/openai-compatible", options: { baseURL: `${base}/v1`, apiKey: "mock-key" }, models: { "mock-model": { name: "Mock", tool_call: true, limit: { context: 100_000, output: 4_000 } } } },
        anth: { name: "Anth", npm: "@ai-sdk/anthropic", options: { baseURL: `${base}/v1`, apiKey: "mock-key" }, models: { "claude-mock": { name: "Claude mock", tool_call: true, limit: { context: 100_000, output: 4_000 } } } },
      },
      mcp: { anyof: { type: "local", command: ["node", mcpScript], enabled: true } },
      plugin: [
        marsTitleRecoveryPluginPath(),
        marsAnthropicToolSchemaPluginPath(),
        marsMcpPolicyPluginPath(),
      ],
    }));
    engine = await createManagedOpencodeServer({
      bin: enginePath!,
      cwd: work,
      env: {
        OPENCODE_CONFIG: configPath,
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        MARS_SERVER_URL: base,
        MARS_POLICY_TOKEN: "policy",
        MARS_SERVER_TOKEN: "server",
        HOME: join(data, "home"),
        OPENCODE_TEST_HOME: join(data, "home"),
        XDG_DATA_HOME: join(data, "xdg-data"),
        XDG_CONFIG_HOME: join(data, "xdg-config"),
        XDG_STATE_HOME: join(data, "xdg-state"),
        XDG_CACHE_HOME: join(data, "xdg-cache"),
      },
    });
    await waitFor(async () => (await engineFetch("/mcp")).ok, "engine");
  }, 120_000);

  afterAll(async () => {
    await engine?.close();
    provider?.stop(true);
    rmSync(work, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }, 30_000);

  test("the title marker never reaches the provider, and a rejected optional parameter is retried without it", async () => {
    seen.length = 0;
    const sessionID = await prompt({ providerID: "mock", modelID: "mock-model" }, "Say done.", "high");
    const titled = await waitFor(async () => {
      const info = (await (await engineFetch(`/session/${sessionID}`)).json()) as { title?: string };
      return info.title?.startsWith(TITLE) ? info : null;
    }, "the recovered title");
    expect(titled.title).toStartWith(TITLE);
    // The turn itself (with tools) goes out too.
    await waitFor(async () => seen.some((request) => Array.isArray(request.body.tools) && request.body.tools.length > 0), "the turn's request");
    const chat = seen.filter((request) => request.path === "/v1/chat/completions");
    for (const request of chat) expect(request.headers[HEADER]).toBeUndefined();
    const titles = chat.filter((request) => !Array.isArray(request.body.tools) || request.body.tools.length === 0);
    // An optional parameter the mock refused is dropped on the one retry; the title request that
    // went through carries none of them.
    const refused = titles.map((request) => OPTIONAL_TITLE_PARAMETERS.filter((key) => key in request.body));
    expect(refused.at(-1)).toEqual([]);
    expect(refused.length).toBeLessThanOrEqual(2);
    if (refused.length === 2) expect(refused[0]!.length).toBeGreaterThan(0);
    console.log("title requests: optional parameters", JSON.stringify(refused));
  }, 90_000);

  test("a configured MCP never reaches the engine inventory or provider tools", async () => {
    seen.length = 0;
    const status = await waitFor(async () => {
      const response = await engineFetch("/mcp");
      if (!response.ok) return null;
      return (await response.json()) as Record<string, unknown>;
    }, "the engine MCP inventory");
    expect(status.anyof).toBeUndefined();
    expect(status.blender).toBeUndefined();
    expect(status.supabase).toBeUndefined();

    await prompt({ providerID: "anth", modelID: "claude-mock" }, "Use the export tool.");
    await waitFor(async () => seen.find((entry) => entry.path === "/v1/messages"), "an Anthropic request");
    const requests = seen.filter((entry) => entry.path === "/v1/messages");
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      const tools = Array.isArray(request.body.tools) ? request.body.tools : [];
      expect(tools.some((entry) => typeof entry === "object" && entry !== null
        && "name" in entry && typeof entry.name === "string" && entry.name.endsWith("export_batch"))).toBe(false);
    }
    expect(existsSync(join(data, "blender-started"))).toBe(false);
    expect(existsSync(join(data, "supabase-started"))).toBe(false);
  }, 90_000);
});
