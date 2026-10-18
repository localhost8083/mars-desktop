import { ApiError } from "./errors.js";

/** MCP is disabled for every MarsAI server configuration. */
export type McpPolicyMode = "disabled";

export const MCP_DISABLED_MESSAGE =
  "MCP servers are disabled in MarsAI.";

export function mcpPolicyForConfig(_config: unknown): McpPolicyMode {
  return "disabled";
}

export function mcpAllowed(_config: unknown): false {
  return false;
}

export function assertMcpAllowed(_config: unknown): never {
  throw new ApiError(403, "mcp_disabled", MCP_DISABLED_MESSAGE);
}
