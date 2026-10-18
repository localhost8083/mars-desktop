type ConfigTarget = {
  mcp?: unknown;
  permission?: unknown;
  permissions?: unknown;
  tools?: unknown;
};

type ToolBeforeInput = {
  tool?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configTarget(input: unknown, output: unknown): ConfigTarget | null {
  if (isRecord(output)) return output;
  return isRecord(input) ? input : null;
}

function serverNamesFromConfig(value: unknown): string[] {
  if (!isRecord(value) || !isRecord(value.mcp)) return [];
  return Object.keys(value.mcp).filter((name) => name.trim().length > 0);
}

function normalizedServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function deniedPatterns(serverNames: Iterable<string>): string[] {
  const patterns = new Set<string>(["mcp.*", "mcp:*", "mcp_*"]);
  for (const name of serverNames) {
    const normalized = normalizedServerName(name);
    patterns.add(`${normalized}_*`);
    patterns.add(`${normalized}___*`);
    patterns.add(`mcp.${name}.*`);
    patterns.add(`mcp:${name}:*`);
    patterns.add(`tool.${normalized}_*`);
  }
  return [...patterns];
}

function withDenyRules(value: unknown, patterns: string[], denied: "deny" | false = "deny"): Record<string, unknown> {
  const existing = isRecord(value) ? value : {};
  return Object.fromEntries([
    ...Object.entries(existing),
    ...patterns.map((pattern) => [pattern, denied] as const),
  ]);
}

function isDeniedMcpTool(tool: string, serverNames: Iterable<string>): boolean {
  if (tool.startsWith("mcp_") || tool.startsWith("mcp.") || tool.startsWith("mcp:")) return true;
  return [...serverNames].some((name) => {
    const normalized = normalizedServerName(name);
    return tool === normalized
      || tool.startsWith(`${normalized}_`)
      || tool.startsWith(`${normalized}___`);
  });
}

/**
 * Engine-side MCP fence. HTTP checks protect Mars routes, while these
 * hooks cover workspace/global config discovery inside a managed v1 engine.
 * The config hook supports both OpenCode hook shapes, and the execution hook
 * catches the actual `<server>_<tool>` IDs rather than relying on `mcp.*`.
 */
export default async function marsMcpPolicy() {
  const serverNames = new Set<string>();
  const applyFence = (input: unknown, output?: unknown): void => {
    const target = configTarget(input, output);
    if (!target) return;
    for (const name of serverNamesFromConfig(target)) serverNames.add(name);
    const patterns = deniedPatterns(serverNames);
    target.mcp = {};
    target.permission = withDenyRules(target.permission, patterns);
    target.permissions = withDenyRules(target.permissions, patterns);
    // Engine config schema types `tools` entries as boolean; string "deny"
    // values fail /config validation. `false` disables the tool on both the
    // managed engine and upstream.
    target.tools = withDenyRules(target.tools, patterns, false);
  };

  return {
    config: async (input: unknown, output?: unknown) => {
      applyFence(input, output);
    },
    "tool.execute.before": async (input: ToolBeforeInput) => {
      if (typeof input.tool !== "string" || !isDeniedMcpTool(input.tool, serverNames)) return;
      throw new Error("MCP tools are disabled in MarsAI.");
    },
  };
}
