import { describe, expect, test } from "bun:test";

import marsMcpPolicy from "./mars-mcp-policy.js";

// The managed engine validates `tools` entries as boolean; a string "deny"
// made the engine's /config endpoint answer 400. `permission` keeps strings.
describe("mars-mcp-policy config fence", () => {
  test("tools deny rules are boolean, permission deny rules stay strings", async () => {
    const plugin = await marsMcpPolicy();
    const config: Record<string, unknown> = {
      mcp: { "ida-pro-mcp": { type: "remote" } },
    };
    await plugin.config(config);

    expect(config.mcp).toEqual({});
    const permission = config.permission as Record<string, unknown>;
    expect(permission["mcp.*"]).toBe("deny");
    expect(permission["mcp.ida-pro-mcp.*"]).toBe("deny");
    const tools = config.tools as Record<string, unknown>;
    expect(tools["mcp.*"]).toBe(false);
    expect(tools["mcp.ida-pro-mcp.*"]).toBe(false);
  });

  test("tool.execute.before still blocks mcp tools", async () => {
    const plugin = await marsMcpPolicy();
    await plugin.config({ mcp: { serv: {} } });
    await expect(plugin["tool.execute.before"]({ tool: "serv_do_thing" })).rejects.toThrow(
      "MCP tools are disabled in MarsAI.",
    );
    await expect(plugin["tool.execute.before"]({ tool: "bash" })).resolves.toBeUndefined();
  });
});
